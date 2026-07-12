import { describe, expect, it } from "vitest";

import { parseRecoveryArguments } from "../src/recovery-cli.js";

describe("outbox recovery CLI arguments", () => {
  it("keeps requeue in dry-run mode unless apply is explicit", () => {
    expect(parseRecoveryArguments(["requeue", "--event-id", "42", "--reason", "broker recovered"]))
      .toEqual({ command: "requeue", limit: 100, eventId: "42", reason: "broker recovered", apply: false });
    expect(parseRecoveryArguments(["requeue", "--event-id", "42", "--reason", "broker recovered", "--apply"]).apply)
      .toBe(true);
  });

  it("rejects malformed identifiers and unbounded listings", () => {
    expect(() => parseRecoveryArguments(["requeue", "--event-id", "42 OR 1=1", "--reason", "no"])).toThrow(/numeric/u);
    expect(() => parseRecoveryArguments(["list", "--limit", "501"])).toThrow(/between 1 and 500/u);
  });
});
