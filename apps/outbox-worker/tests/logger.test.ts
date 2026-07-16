import { describe, expect, it } from "vitest";

import { redactedOutboxFields } from "../src/logger.js";

describe("outbox structured logger", () => {
  it("bounds and redacts nested credential-shaped values before an OTLP export", () => {
    const fields = redactedOutboxFields({
      password: "not-for-logs",
      nested: {
        authorization: "Bearer not-for-logs",
        endpoint: "redis://worker:not-for-logs@redis.example:6379/0",
        message: "token=not-for-logs",
      },
    });

    expect(fields.password).toBe("[REDACTED]");
    expect(fields.nested).toEqual({
      authorization: "[REDACTED]",
      endpoint: "redis://worker:[REDACTED]@redis.example:6379/0",
      message: "token=[REDACTED]",
    });
  });
});
