import { readFile } from "node:fs/promises";

import type { FetchLike } from "./auth.js";
import { ClientCredentialsTokenCache } from "./auth.js";
import { loadEdgeAgentConfig, resolveEnvironmentReference, type EdgeAgentConfig } from "./config.js";
import { CsvConnector } from "./connectors/csv.js";
import { NodeOpcUaReader, OpcUaConnector, type NodeOpcUaReaderOptions } from "./connectors/opcua.js";
import { PgPoolSource, PostgresConnector, type PgPoolSourceOptions } from "./connectors/postgres.js";
import { AuthenticatedIngestDelivery } from "./delivery.js";
import { EdgeQueue } from "./queue.js";
import { EdgeAgentRunner, type EdgeAgentLogger, type ManagedConnector } from "./runner.js";

export interface EdgeAgentRuntimeDependencies {
  fetch?: FetchLike;
  logger?: EdgeAgentLogger;
}

async function createConnectors(configuration: EdgeAgentConfig, environment: NodeJS.ProcessEnv): Promise<ManagedConnector[]> {
  const managed: ManagedConnector[] = [];
  for (const connector of configuration.connectors) {
    if (connector.type === "csv") {
      managed.push({ sourceSystem: connector.sourceSystem, connector: new CsvConnector(connector) });
      continue;
    }
    if (connector.type === "postgres") {
      const poolOptions: PgPoolSourceOptions = {
        connectionString: resolveEnvironmentReference(
          environment,
          connector.connectionStringEnv,
          `PostgreSQL connector '${connector.sourceSystem}'`,
        ),
        sourceSystem: connector.sourceSystem,
        statementTimeoutMs: connector.statementTimeoutMs,
      };
      if (connector.ssl) {
        poolOptions.ssl = {
          rejectUnauthorized: connector.ssl.rejectUnauthorized,
          ...(connector.ssl.caFile ? { ca: await readFile(connector.ssl.caFile, "utf8") } : {}),
        };
      }
      const source = new PgPoolSource(poolOptions);
      managed.push({ sourceSystem: connector.sourceSystem, connector: new PostgresConnector(connector, source) });
      continue;
    }

    const readerOptions: NodeOpcUaReaderOptions = {
      endpointUrl: connector.endpointUrl,
      sourceSystem: connector.sourceSystem,
      securityMode: connector.securityMode,
      securityPolicy: connector.securityPolicy,
      endpointMustExist: connector.endpointMustExist,
      connectionTimeoutMs: connector.connectionTimeoutMs,
      credentials:
        connector.credentials.type === "username"
          ? {
              type: "username",
              username: resolveEnvironmentReference(
                environment,
                connector.credentials.usernameEnv,
                `OPC-UA username for '${connector.sourceSystem}'`,
              ),
              password: resolveEnvironmentReference(
                environment,
                connector.credentials.passwordEnv,
                `OPC-UA password for '${connector.sourceSystem}'`,
              ),
            }
          : { type: "anonymous" },
      ...(connector.certificateFile ? { certificateFile: connector.certificateFile } : {}),
      ...(connector.privateKeyFile ? { privateKeyFile: connector.privateKeyFile } : {}),
    };
    managed.push({
      sourceSystem: connector.sourceSystem,
      connector: new OpcUaConnector(connector, new NodeOpcUaReader(readerOptions)),
    });
  }
  return managed;
}

export async function createEdgeAgentRuntime(
  configuration: EdgeAgentConfig,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: EdgeAgentRuntimeDependencies = {},
): Promise<EdgeAgentRunner> {
  const token = configuration.delivery.token;
  const tokenCache = new ClientCredentialsTokenCache(
    {
      tokenUrl: token.tokenUrl,
      clientId: resolveEnvironmentReference(environment, token.clientIdEnv, "ingest OAuth client id"),
      clientSecret: resolveEnvironmentReference(environment, token.clientSecretEnv, "ingest OAuth client secret"),
      expirySkewSeconds: token.expirySkewSeconds,
      requestTimeoutMs: token.requestTimeoutMs,
      ...(token.scope ? { scope: token.scope } : {}),
      ...(token.audience ? { audience: token.audience } : {}),
    },
    dependencies.fetch ? { fetch: dependencies.fetch } : {},
  );
  const delivery = new AuthenticatedIngestDelivery(
    {
      apiBaseUrl: configuration.delivery.apiBaseUrl,
      tenantId: configuration.delivery.tenantId,
      projectId: configuration.delivery.projectId,
      requestTimeoutMs: configuration.delivery.requestTimeoutMs,
    },
    tokenCache,
    dependencies.fetch ? { fetch: dependencies.fetch } : {},
  );
  const connectors = await createConnectors(configuration, environment);
  return new EdgeAgentRunner(
    {
      archiveDirectory: configuration.agent.archiveDirectory,
      actor: configuration.agent.actor,
      pollIntervalMs: configuration.agent.pollIntervalMs,
      deliveryIntervalMs: configuration.agent.deliveryIntervalMs,
      deliveryLeaseMs: configuration.agent.deliveryLeaseMs,
      shutdownDrainTimeoutMs: configuration.agent.shutdownDrainTimeoutMs,
      maxDrainBatch: configuration.agent.maxDrainBatch,
      retry: configuration.agent.retry,
    },
    connectors,
    new EdgeQueue(configuration.agent.queuePath),
    delivery,
    dependencies.logger ? { logger: dependencies.logger } : {},
  );
}

export async function createEdgeAgentRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: EdgeAgentRuntimeDependencies = {},
): Promise<EdgeAgentRunner> {
  const configurationPath = environment.ODF_EDGE_CONFIG?.trim();
  if (!configurationPath) throw new Error("ODF_EDGE_CONFIG must reference the edge-agent JSON configuration file");
  const configuration = await loadEdgeAgentConfig(configurationPath);
  return createEdgeAgentRuntime(configuration, environment, dependencies);
}
