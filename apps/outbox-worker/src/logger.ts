import { OtlpLogEmitter, type OtlpLogLevel } from "./otlp-logs.js";

const SENSITIVE_FIELD = /password|passwd|secret|token|api.?key|access.?key|credential|private.?key|authorization|cookie/iu;
const SENSITIVE_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|private[_ -]?key|authorization|cookie)\b\s*[:=]\s*(?:Bearer\s+)?("[^"]*"|'[^']*'|[^\s,;]+)/giu;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^@\s/]+@/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/giu;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 2_000;

function redactedText(value: string): string {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
    .replace(URL_CREDENTIAL, "$1[REDACTED]@")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .slice(0, MAX_STRING_LENGTH);
}

function redactedValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return redactedText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (value instanceof Error) return { name: redactedText(value.name), message: redactedText(value.message) };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "[BINARY]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactedValue(item, depth + 1, seen));
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return "[UNSERIALIZABLE]";
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactedValue(nested, depth + 1, seen);
  }
  return result;
}

export function redactedOutboxFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const value = redactedValue(fields, 0, new WeakSet<object>());
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class OutboxLogger {
  private readonly otlp: OtlpLogEmitter | null;

  constructor(
    private readonly workerId: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.otlp = OtlpLogEmitter.create("open-data-fusion-outbox-worker", environment);
  }

  log(level: OtlpLogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const serialized = JSON.stringify({
      ...redactedOutboxFields(fields),
      timestamp: new Date().toISOString(),
      level,
      component: "outbox",
      event,
      workerId: this.workerId,
    });
    this.otlp?.emit(level, event, serialized);
    if (level === "error") process.stderr.write(`${serialized}\n`);
    else process.stdout.write(`${serialized}\n`);
  }

  shutdown(): Promise<void> {
    return this.otlp?.shutdown() ?? Promise.resolve();
  }
}
