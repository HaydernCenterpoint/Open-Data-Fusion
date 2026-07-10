import type { JsonObject, JsonValue } from "./types.js";

const SENSITIVE_KEY = /password|passwd|secret|token|api.?key|credential|private.?key|authorization|cookie/i;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 2_000;
const MAX_SERIALIZED_LENGTH = 64 * 1024;

function safeValue(value: unknown, depth: number): JsonValue {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.replace(/[\r\n\t]+/g, " ").slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, nested] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : safeValue(nested, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, MAX_STRING_LENGTH);
}

export function redactedSummary(value: unknown): JsonObject {
  const safe = safeValue(value, 0);
  const object = safe && typeof safe === "object" && !Array.isArray(safe) ? safe as JsonObject : { value: safe };
  const serialized = JSON.stringify(object);
  if (serialized.length <= MAX_SERIALIZED_LENGTH) return object;
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_SERIALIZED_LENGTH),
  };
}

export function safeError(error: unknown): JsonObject {
  if (error instanceof Error) {
    const message = error.message
      .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization|credential)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, "$1[REDACTED]@");
    return redactedSummary({ name: error.name, message });
  }
  return redactedSummary({ name: "Error", message: "Unknown pipeline execution error" });
}
