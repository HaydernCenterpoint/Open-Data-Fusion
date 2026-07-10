import type { LogLevel, StructuredLogger } from "./types.js";
import { safeError } from "./redact.js";

function safeFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/password|secret|token|credential|private.?key|authorization/i.test(key)) result[key] = "[REDACTED]";
    else if (value instanceof Error) result[key] = safeError(value);
    else result[key] = value;
  }
  return result;
}

export class JsonLogger implements StructuredLogger {
  constructor(private readonly component: string, private readonly workerId: string) {}

  log(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      event,
      workerId: this.workerId,
      ...safeFields(fields),
    });
    if (level === "error") console.error(record);
    else if (level === "warn") console.warn(record);
    else console.log(record);
  }
}

export class NullLogger implements StructuredLogger {
  log(): void {}
}
