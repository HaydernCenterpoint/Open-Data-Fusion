import type {
  JsonObject,
  JsonValue,
  PipelineExecutionRequest,
  PipelineExecutionResult,
  PipelineExecutor,
  QualityRule,
} from "./types.js";

const MAX_STEPS = 100;
const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIELD_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type StepKind = "noop" | "quality" | "validate";

interface Step {
  id: string;
  kind: StepKind;
  dependsOn: string[];
  configuration: JsonObject;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asJsonObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function stringArray(value: unknown, label: string, maximum = MAX_STEPS): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of at most ${maximum} strings`);
  }
  return value.map((entry) => entry.trim());
}

function parseSteps(definition: JsonObject): Step[] {
  const rawSteps = definition.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > MAX_STEPS) {
    throw new Error(`pipeline definition must contain between 1 and ${MAX_STEPS} steps`);
  }
  const steps = rawSteps.map((raw, index): Step => {
    if (!isObject(raw)) throw new Error(`steps[${index}] must be an object`);
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!STEP_ID_PATTERN.test(id)) throw new Error(`steps[${index}].id is invalid`);
    if (raw.kind !== "noop" && raw.kind !== "quality" && raw.kind !== "validate") {
      throw new Error(`steps[${index}].kind is not supported by the built-in executor`);
    }
    const dependsOn = raw.dependsOn === undefined ? [] : stringArray(raw.dependsOn, `steps[${index}].dependsOn`);
    const configuration = raw.configuration === undefined ? {} : asJsonObject(raw.configuration, `steps[${index}].configuration`);
    return { id, kind: raw.kind, dependsOn, configuration };
  });
  const byId = new Map<string, Step>();
  for (const step of steps) {
    if (byId.has(step.id)) throw new Error(`duplicate pipeline step id '${step.id}'`);
    byId.set(step.id, step);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`step '${step.id}' depends on unknown step '${dependency}'`);
      if (dependency === step.id) throw new Error(`step '${step.id}' cannot depend on itself`);
    }
  }

  // Stable Kahn ordering makes the same immutable version produce the same
  // execution order on every worker.
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn)]));
  const ordered: Step[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort((left, right) => left.localeCompare(right));
    if (ready.length === 0) throw new Error("pipeline definition contains a dependency cycle");
    for (const id of ready) {
      const step = byId.get(id);
      if (!step) throw new Error("pipeline step graph became inconsistent");
      ordered.push(step);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return ordered;
}

function valueAtPath(input: JsonObject, path: string): JsonValue | undefined {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0 || segments.length > 20 || segments.some((segment) => !FIELD_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`field path '${path}' is invalid`);
  }
  let current: JsonValue = input;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[segment] as JsonValue;
  }
  return current;
}

function isPresent(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null && value !== "";
}

function evaluateRule(input: JsonObject, rule: QualityRule): boolean {
  if (!rule.fieldName) throw new Error(`quality rule '${rule.externalId}' requires fieldName`);
  const actual = valueAtPath(input, rule.fieldName);
  if (rule.ruleKind === "required") return isPresent(actual);
  if (rule.ruleKind === "range") {
    const minimum = rule.configuration.minimum;
    const maximum = rule.configuration.maximum;
    if (minimum !== undefined && typeof minimum !== "number") throw new Error(`quality rule '${rule.externalId}' minimum must be numeric`);
    if (maximum !== undefined && typeof maximum !== "number") throw new Error(`quality rule '${rule.externalId}' maximum must be numeric`);
    if (minimum === undefined && maximum === undefined) throw new Error(`quality rule '${rule.externalId}' requires minimum or maximum`);
    if (typeof actual !== "number" || !Number.isFinite(actual)) return false;
    return (minimum === undefined || actual >= minimum) && (maximum === undefined || actual <= maximum);
  }
  // Regex, uniqueness, and reference checks need dedicated bounded engines or
  // data access. The built-in worker never interprets their configuration.
  throw new Error(`quality rule kind '${rule.ruleKind}' is not supported by the built-in executor`);
}

function assertAllowedKeys(configuration: JsonObject, allowed: readonly string[], label: string): void {
  const unsupported = Object.keys(configuration).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new Error(`${label} contains unsupported field '${unsupported[0]}'`);
}

function inputFor(request: PipelineExecutionRequest): JsonObject {
  const input = request.run.summary.input;
  return isObject(input) ? input as JsonObject : {};
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("pipeline execution was aborted during shutdown");
}

export class BuiltinDagExecutor implements PipelineExecutor {
  readonly name = "builtin-dag-v1";

  async execute(request: PipelineExecutionRequest): Promise<PipelineExecutionResult> {
    const steps = parseSteps(request.version.definition);
    const input = inputFor(request);
    const stepResults: JsonValue[] = [];

    for (const step of steps) {
      throwIfAborted(request.signal);
      if (step.kind === "noop") {
        assertAllowedKeys(step.configuration, [], `step '${step.id}' configuration`);
        stepResults.push({ id: step.id, kind: step.kind, status: "succeeded" });
        continue;
      }
      if (step.kind === "validate") {
        assertAllowedKeys(step.configuration, ["requiredFields"], `step '${step.id}' configuration`);
        const requiredFields = stringArray(step.configuration.requiredFields, `step '${step.id}' requiredFields`, 200);
        const missing = requiredFields.filter((field) => !isPresent(valueAtPath(input, field)));
        if (missing.length > 0) throw new Error(`validation step '${step.id}' failed for ${missing.length} required field(s)`);
        stepResults.push({ id: step.id, kind: step.kind, status: "succeeded", checkedFields: requiredFields.length });
        continue;
      }

      assertAllowedKeys(step.configuration, ["ruleExternalIds", "failOnError"], `step '${step.id}' configuration`);
      const selectedIds = step.configuration.ruleExternalIds === undefined
        ? null
        : new Set(stringArray(step.configuration.ruleExternalIds, `step '${step.id}' ruleExternalIds`, 1_000));
      const failOnError = step.configuration.failOnError === undefined ? true : step.configuration.failOnError;
      if (typeof failOnError !== "boolean") throw new Error(`step '${step.id}' failOnError must be boolean`);
      const rules = request.qualityRules
        .filter((rule) => rule.enabled && (!selectedIds || selectedIds.has(rule.externalId)))
        .sort((left, right) => left.externalId.localeCompare(right.externalId));
      if (selectedIds) {
        const available = new Set(rules.map((rule) => rule.externalId));
        const missing = [...selectedIds].filter((id) => !available.has(id));
        if (missing.length > 0) throw new Error(`quality step '${step.id}' references unknown enabled rule '${missing.sort()[0]}'`);
      }
      let passed = 0;
      const failedErrorRules: string[] = [];
      for (const rule of rules) {
        throwIfAborted(request.signal);
        if (evaluateRule(input, rule)) passed += 1;
        else if (rule.severity === "error") failedErrorRules.push(rule.externalId);
      }
      if (failOnError && failedErrorRules.length > 0) {
        throw new Error(`quality step '${step.id}' failed ${failedErrorRules.length} error-severity rule(s)`);
      }
      stepResults.push({
        id: step.id,
        kind: step.kind,
        status: "succeeded",
        totalRules: rules.length,
        passedRules: passed,
        failedRules: rules.length - passed,
      });
    }

    return {
      output: {
        executionSchema: "builtin-dag-v1",
        stepCount: steps.length,
        steps: stepResults,
      },
    };
  }
}
