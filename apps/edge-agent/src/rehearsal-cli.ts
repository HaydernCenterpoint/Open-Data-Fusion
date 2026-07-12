import { parseArgs } from "node:util";

import { loadEdgeAgentConfig } from "./config.js";
import { rehearseConnectors } from "./rehearsal.js";
import { createConnectors } from "./runtime.js";

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      config: { type: "string" },
      batches: { type: "string" },
    },
    strict: true,
  });
  const configPath = parsed.values.config?.trim() || process.env.ODF_EDGE_CONFIG?.trim();
  if (!configPath) throw new Error("Supply --config <path> or set ODF_EDGE_CONFIG");

  const configuration = await loadEdgeAgentConfig(configPath);
  const connectors = await createConnectors(configuration, process.env);
  const maxBatches = positiveInteger(parsed.values.batches, "--batches");
  const results = await rehearseConnectors(
    connectors,
    configuration.connectors,
    maxBatches === undefined ? {} : { maxBatches },
  );
  console.log(JSON.stringify({ mode: "read-only", results }, null, 2));
}

main().catch((error: unknown) => {
  console.error("Connector rehearsal failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
