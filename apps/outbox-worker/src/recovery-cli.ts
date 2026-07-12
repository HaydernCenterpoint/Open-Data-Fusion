import { loadEnvFile } from "node:process";
import { readFileSync } from "node:fs";

import { Pool } from "pg";

import { PostgresOutboxRepository } from "./postgres.js";

try {
  loadEnvFile();
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

interface ParsedArguments {
  command: "list" | "requeue";
  limit: number;
  eventId?: string;
  reason?: string;
  apply: boolean;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  recovery-cli list [--limit 100]",
    "  recovery-cli requeue --event-id <numeric-id> --reason <text> [--apply]",
    "Requeue is a dry-run unless --apply is supplied.",
  ].join("\n"));
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

export function parseRecoveryArguments(args: readonly string[]): ParsedArguments {
  const command = args[0];
  if (command !== "list" && command !== "requeue") usage();
  const rawLimit = option(args, "--limit") ?? "100";
  const limit = Number.parseInt(rawLimit, 10);
  if (!/^\d+$/u.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }
  const apply = args.includes("--apply");
  if (command === "list") {
    if (apply || args.includes("--event-id") || args.includes("--reason")) usage();
    return { command, limit, apply: false };
  }
  const eventId = option(args, "--event-id");
  const reason = option(args, "--reason")?.replace(/[\r\n\t]+/gu, " ").trim();
  if (!eventId || !/^\d+$/u.test(eventId)) throw new Error("--event-id must be a numeric outbox event ID");
  if (!reason) throw new Error("--reason is required for requeue");
  return { command, limit, eventId, reason: reason.slice(0, 500), apply };
}

function requiredEnvironment(name: string): string {
  const literal = process.env[name]?.trim();
  const file = process.env[`${name}_FILE`]?.trim();
  if (literal && file) throw new Error(`${name} and ${name}_FILE cannot both be set`);
  const value = file ? readFileSync(file, "utf8").trim() : literal;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = parseRecoveryArguments(process.argv.slice(2));
  const pool = new Pool({
    connectionString: requiredEnvironment("ODF_POSTGRES_URL"),
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "open-data-fusion-outbox-recovery",
  });
  try {
    const repository = new PostgresOutboxRepository(pool);
    if (args.command === "list") {
      const events = await repository.listDeadLetters(args.limit);
      process.stdout.write(`${JSON.stringify({ mode: "read_only", count: events.length, events }, null, 2)}\n`);
      return;
    }
    if (!args.apply) {
      process.stdout.write(`${JSON.stringify({
        mode: "dry_run",
        eventId: args.eventId,
        reason: args.reason,
        message: "No database change was made; repeat with --apply after validating aggregate ordering and broker health.",
      }, null, 2)}\n`);
      return;
    }
    const requeued = await repository.requeueDeadLetter(args.eventId!, args.reason!);
    if (!requeued) throw new Error(`Dead-lettered event '${args.eventId}' was not found or is no longer recoverable`);
    process.stdout.write(`${JSON.stringify({ mode: "applied", eventId: args.eventId, reason: args.reason })}\n`);
  } finally {
    await pool.end();
  }
}

const invokedAsCli = process.argv[1]?.endsWith("recovery-cli.js") || process.argv[1]?.endsWith("recovery-cli.ts");
if (invokedAsCli) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown outbox recovery error"}\n`);
    process.exitCode = 1;
  });
}
