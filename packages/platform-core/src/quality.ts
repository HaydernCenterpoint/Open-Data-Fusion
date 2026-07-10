import type { QualityRule, QualityRuleKind } from "@open-data-fusion/contracts";

export interface QualityRecord {
  externalId: string;
  properties: Record<string, unknown>;
}

export interface QualityFailure {
  externalId: string;
  field: string | null;
  reason: string;
  value: unknown;
}

export interface QualityEvaluation {
  ruleId: string;
  passed: boolean;
  checkedRecords: number;
  failedRecords: number;
  failures: QualityFailure[];
}

export class QualityRuleConfigurationError extends Error {}

function fieldValue(record: QualityRecord, field: string | null): unknown {
  if (!field) return record.properties;
  return field.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, record.properties);
}

function numberConfiguration(configuration: Record<string, unknown>, key: string): number | undefined {
  const value = configuration[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function evaluateRecord(rule: QualityRule, record: QualityRecord, value: unknown): string | null {
  const kind: QualityRuleKind = rule.kind;
  if (kind === "required") return value === null || value === undefined || value === "" ? "Value is required" : null;
  if (kind === "range") {
    const minimum = numberConfiguration(rule.configuration, "min");
    const maximum = numberConfiguration(rule.configuration, "max");
    if (minimum === undefined && maximum === undefined) throw new QualityRuleConfigurationError("Range rule requires min or max");
    if (typeof value !== "number" || !Number.isFinite(value)) return "Value is not a finite number";
    if (minimum !== undefined && value < minimum) return `Value is below minimum ${minimum}`;
    if (maximum !== undefined && value > maximum) return `Value is above maximum ${maximum}`;
    return null;
  }
  if (kind === "regex") {
    const pattern = rule.configuration.pattern;
    if (typeof pattern !== "string") throw new QualityRuleConfigurationError("Regex rule requires a pattern");
    let expression: RegExp;
    try {
      expression = new RegExp(pattern, "u");
    } catch {
      throw new QualityRuleConfigurationError("Regex rule contains an invalid pattern");
    }
    return typeof value === "string" && expression.test(value) ? null : "Value does not match the required pattern";
  }
  if (kind === "reference") {
    const allowedValues = rule.configuration.allowedValues;
    if (!Array.isArray(allowedValues)) throw new QualityRuleConfigurationError("Reference rule requires allowedValues");
    return allowedValues.some((candidate) => Object.is(candidate, value)) ? null : "Value does not reference an allowed target";
  }
  return null;
}

export function evaluateQualityRule(rule: QualityRule, records: readonly QualityRecord[], failureLimit = 100): QualityEvaluation {
  const failures: QualityFailure[] = [];
  if (rule.kind === "unique") {
    const seen = new Map<unknown, string>();
    for (const record of records) {
      const value = fieldValue(record, rule.field);
      const previous = seen.get(value);
      if (previous !== undefined && failures.length < failureLimit) {
        failures.push({ externalId: record.externalId, field: rule.field, reason: `Value duplicates record '${previous}'`, value });
      } else if (previous === undefined) {
        seen.set(value, record.externalId);
      }
    }
  } else {
    for (const record of records) {
      const value = fieldValue(record, rule.field);
      const reason = evaluateRecord(rule, record, value);
      if (reason && failures.length < failureLimit) failures.push({ externalId: record.externalId, field: rule.field, reason, value });
    }
  }
  return {
    ruleId: rule.id,
    passed: failures.length === 0,
    checkedRecords: records.length,
    failedRecords: failures.length,
    failures,
  };
}
