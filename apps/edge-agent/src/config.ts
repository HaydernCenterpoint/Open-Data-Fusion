import { readFile } from "node:fs/promises";

import { z } from "zod";

const externalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Use letters, numbers, dots, colons, slashes, underscores, or dashes");

const sourceSystemSchema = externalIdSchema.max(100);
const environmentReferenceSchema = z
  .string()
  .trim()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "Use the name of an environment variable, for example ODF_EDGE_CLIENT_SECRET");
const fieldNameSchema = z.string().trim().min(1).max(255);
const metadataSchema = z.record(z.unknown()).default({});

const httpUrlSchema = z.string().url().superRefine((value, context) => {
  const protocol = new URL(value).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected an HTTP or HTTPS URL" });
  }
});

export const mappedAssetSchema = z
  .object({
    externalId: externalIdSchema,
    name: z.string().trim().min(1).max(255),
    type: z.string().trim().min(1).max(100),
    parentExternalId: externalIdSchema.nullable().optional(),
    description: z.string().trim().max(4_000).nullable().optional(),
    metadata: metadataSchema,
  })
  .strict();

export const mappedTimeSeriesSchema = z
  .object({
    externalId: externalIdSchema,
    assetExternalId: externalIdSchema,
    name: z.string().trim().min(1).max(255),
    unit: z.string().trim().max(50).nullable().optional(),
    description: z.string().trim().max(4_000).nullable().optional(),
    metadata: metadataSchema,
    valueColumn: fieldNameSchema,
    qualityColumn: fieldNameSchema.optional(),
  })
  .strict();

export const tabularMappingSchema = z
  .object({
    timestampColumn: fieldNameSchema,
    assets: z.array(mappedAssetSchema).max(10_000).default([]),
    timeSeries: z.array(mappedTimeSeriesSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((mapping, context) => {
    const assetIds = new Set<string>();
    for (const [index, asset] of mapping.assets.entries()) {
      if (assetIds.has(asset.externalId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate asset externalId '${asset.externalId}'`,
          path: ["assets", index, "externalId"],
        });
      }
      assetIds.add(asset.externalId);
    }

    const timeSeriesIds = new Set<string>();
    for (const [index, timeSeries] of mapping.timeSeries.entries()) {
      if (timeSeriesIds.has(timeSeries.externalId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate time-series externalId '${timeSeries.externalId}'`,
          path: ["timeSeries", index, "externalId"],
        });
      }
      timeSeriesIds.add(timeSeries.externalId);
    }
  });

const csvConnectorSchema = z
  .object({
    type: z.literal("csv"),
    sourceSystem: sourceSystemSchema,
    filePath: z.string().trim().min(1),
    delimiter: z.string().length(1).default(","),
    batchSize: z.number().int().min(1).max(100_000).default(1_000),
    trim: z.boolean().default(true),
    mapping: tabularMappingSchema,
  })
  .strict();

const readOnlySqlSchema = z.string().trim().min(1).max(100_000).superRefine((query, context) => {
  const normalized = query.replace(/;\s*$/, "");
  if (!/^\s*(select|with)\b/i.test(normalized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "PostgreSQL connector query must start with SELECT or WITH" });
  }
  if (/;/.test(normalized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "PostgreSQL connector query must contain exactly one statement" });
  }
  if (/\b(insert|update|delete|merge|alter|drop|truncate|create|grant|revoke|call|copy)\b/i.test(normalized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "PostgreSQL connector query must be read-only" });
  }
  if (!/\$1\b/.test(normalized) || !/\$2\b/.test(normalized)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PostgreSQL connector query must use $1 for the checkpoint and $2 for the bounded batch limit",
    });
  }
  if (!/\border\s+by\b/i.test(normalized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "PostgreSQL connector query must define a deterministic ORDER BY" });
  }
});

const postgresConnectorSchema = z
  .object({
    type: z.literal("postgres"),
    sourceSystem: sourceSystemSchema,
    connectionStringEnv: environmentReferenceSchema,
    query: readOnlySqlSchema,
    checkpointColumn: fieldNameSchema,
    initialCheckpoint: z.string().max(2_000),
    batchSize: z.number().int().min(1).max(100_000).default(1_000),
    statementTimeoutMs: z.number().int().min(100).max(3_600_000).default(30_000),
    ssl: z
      .object({
        rejectUnauthorized: z.boolean().default(true),
        caFile: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    mapping: tabularMappingSchema,
  })
  .strict();

const opcUaNodeSchema = z
  .object({
    nodeId: z.string().trim().min(1).max(1_000),
    timeSeriesExternalId: externalIdSchema,
    assetExternalId: externalIdSchema,
    name: z.string().trim().min(1).max(255),
    unit: z.string().trim().max(50).nullable().optional(),
    description: z.string().trim().max(4_000).nullable().optional(),
    metadata: metadataSchema,
    scale: z.number().finite().default(1),
    offset: z.number().finite().default(0),
  })
  .strict();

const opcUaCredentialsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("anonymous") }).strict(),
  z
    .object({
      type: z.literal("username"),
      usernameEnv: environmentReferenceSchema,
      passwordEnv: environmentReferenceSchema,
    })
    .strict(),
]);

const opcUaConnectorSchema = z
  .object({
    type: z.literal("opcua"),
    sourceSystem: sourceSystemSchema,
    endpointUrl: z.string().url().refine((value) => new URL(value).protocol === "opc.tcp:", "Expected an opc.tcp URL"),
    securityMode: z.enum(["None", "Sign", "SignAndEncrypt"]).default("SignAndEncrypt"),
    securityPolicy: z
      .enum(["None", "Basic256Sha256", "Aes128_Sha256_RsaOaep", "Aes256_Sha256_RsaPss"])
      .default("Basic256Sha256"),
    certificateFile: z.string().trim().min(1).optional(),
    privateKeyFile: z.string().trim().min(1).optional(),
    endpointMustExist: z.boolean().default(true),
    connectionTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
    credentials: opcUaCredentialsSchema.default({ type: "anonymous" }),
    assets: z.array(mappedAssetSchema).max(10_000).default([]),
    nodes: z.array(opcUaNodeSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((connector, context) => {
    const noSecurity = connector.securityMode === "None";
    if (noSecurity !== (connector.securityPolicy === "None")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "securityMode and securityPolicy must either both be None or both enable security",
        path: ["securityPolicy"],
      });
    }
    if (!noSecurity && (!connector.certificateFile || !connector.privateKeyFile)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "certificateFile and privateKeyFile are required when OPC-UA security is enabled",
        path: ["certificateFile"],
      });
    }

    const nodeIds = new Set<string>();
    const timeSeriesIds = new Set<string>();
    for (const [index, node] of connector.nodes.entries()) {
      if (nodeIds.has(node.nodeId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate nodeId '${node.nodeId}'`, path: ["nodes", index, "nodeId"] });
      }
      if (timeSeriesIds.has(node.timeSeriesExternalId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate time-series externalId '${node.timeSeriesExternalId}'`,
          path: ["nodes", index, "timeSeriesExternalId"],
        });
      }
      nodeIds.add(node.nodeId);
      timeSeriesIds.add(node.timeSeriesExternalId);
    }
  });

export const connectorConfigSchema = z.union([csvConnectorSchema, postgresConnectorSchema, opcUaConnectorSchema]);

const retrySchema = z
  .object({
    baseDelayMs: z.number().int().min(10).max(3_600_000).default(1_000),
    maxDelayMs: z.number().int().min(10).max(86_400_000).default(300_000),
    jitterRatio: z.number().min(0).max(1).default(0.2),
  })
  .strict()
  .refine((retry) => retry.maxDelayMs >= retry.baseDelayMs, "maxDelayMs must be greater than or equal to baseDelayMs");

export const edgeAgentConfigSchema = z
  .object({
    agent: z
      .object({
        archiveDirectory: z.string().trim().min(1),
        queuePath: z.string().trim().min(1),
        actor: z.string().trim().min(1).max(255).default("edge-agent"),
        pollIntervalMs: z.number().int().min(50).max(3_600_000).default(5_000),
        deliveryIntervalMs: z.number().int().min(10).max(60_000).default(250),
        deliveryLeaseMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
        shutdownDrainTimeoutMs: z.number().int().min(0).max(3_600_000).default(15_000),
        maxDrainBatch: z.number().int().min(1).max(10_000).default(100),
        retry: retrySchema.default({}),
      })
      .strict(),
    delivery: z
      .object({
        apiBaseUrl: httpUrlSchema,
        tenantId: externalIdSchema,
        projectId: externalIdSchema,
        requestTimeoutMs: z.number().int().min(100).max(300_000).default(30_000),
        token: z
          .object({
            tokenUrl: httpUrlSchema,
            clientIdEnv: environmentReferenceSchema,
            clientSecretEnv: environmentReferenceSchema,
            scope: z.string().trim().min(1).max(2_000).optional(),
            audience: z.string().trim().min(1).max(2_000).optional(),
            expirySkewSeconds: z.number().int().min(0).max(300).default(30),
            requestTimeoutMs: z.number().int().min(100).max(300_000).default(15_000),
          })
          .strict(),
      })
      .strict(),
    connectors: z.array(connectorConfigSchema).min(1).max(100),
  })
  .strict()
  .superRefine((configuration, context) => {
    const sourceSystems = new Set<string>();
    for (const [index, connector] of configuration.connectors.entries()) {
      if (sourceSystems.has(connector.sourceSystem)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate connector sourceSystem '${connector.sourceSystem}'`,
          path: ["connectors", index, "sourceSystem"],
        });
      }
      sourceSystems.add(connector.sourceSystem);
    }
  });

export type EdgeAgentConfig = z.infer<typeof edgeAgentConfigSchema>;
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;
export type CsvConnectorConfig = z.infer<typeof csvConnectorSchema>;
export type PostgresConnectorConfig = z.infer<typeof postgresConnectorSchema>;
export type OpcUaConnectorConfig = z.infer<typeof opcUaConnectorSchema>;
export type TabularMappingConfig = z.infer<typeof tabularMappingSchema>;

export async function loadEdgeAgentConfig(path: string): Promise<EdgeAgentConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read edge-agent configuration '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
  return edgeAgentConfigSchema.parse(raw);
}

export function resolveEnvironmentReference(
  environment: NodeJS.ProcessEnv,
  reference: string,
  purpose: string,
): string {
  const value = environment[reference];
  if (value === undefined || value.length === 0) {
    throw new Error(`Environment variable '${reference}' is required for ${purpose}`);
  }
  return value;
}
