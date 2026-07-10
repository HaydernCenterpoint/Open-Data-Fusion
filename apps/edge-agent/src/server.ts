import { createEdgeAgentRuntimeFromEnvironment } from "./runtime.js";

async function main(): Promise<void> {
  const runner = await createEdgeAgentRuntimeFromEnvironment();
  const shutdown = new AbortController();
  const requestShutdown = (signal: NodeJS.Signals): void => {
    console.info(`Received ${signal}; stopping polls and draining the durable delivery queue`);
    shutdown.abort();
  };
  process.once("SIGINT", () => requestShutdown("SIGINT"));
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  await runner.run(shutdown.signal);
}

main().catch((error: unknown) => {
  console.error("Edge agent failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
