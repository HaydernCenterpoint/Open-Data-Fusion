import {
  AttributeIds,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  UserTokenType,
  type ClientSession,
  type OPCUAClientOptions,
  type UserIdentityInfo,
} from "node-opcua";

import type { OpcUaConnectorConfig } from "../config.js";
import { mappedAssets } from "../mapping.js";
import type { ConnectorBatch, EdgeConnector, IngestDataPoint, IngestTimeSeries } from "../types.js";

export interface OpcUaReadValue {
  nodeId: string;
  value: unknown;
  sourceTimestamp: Date | null;
  serverTimestamp: Date | null;
  quality: IngestDataPoint["quality"];
  statusCode: string;
}

export interface OpcUaValueReader {
  read(nodeIds: readonly string[]): Promise<OpcUaReadValue[]>;
  close(): Promise<void>;
}

export interface NodeOpcUaReaderOptions {
  endpointUrl: string;
  sourceSystem: string;
  securityMode: OpcUaConnectorConfig["securityMode"];
  securityPolicy: OpcUaConnectorConfig["securityPolicy"];
  endpointMustExist: boolean;
  connectionTimeoutMs: number;
  certificateFile?: string;
  privateKeyFile?: string;
  credentials: { type: "anonymous" } | { type: "username"; username: string; password: string };
}

const securityModes = {
  None: MessageSecurityMode.None,
  Sign: MessageSecurityMode.Sign,
  SignAndEncrypt: MessageSecurityMode.SignAndEncrypt,
} as const;

const securityPolicies = {
  None: SecurityPolicy.None,
  Basic256Sha256: SecurityPolicy.Basic256Sha256,
  Aes128_Sha256_RsaOaep: SecurityPolicy.Aes128_Sha256_RsaOaep,
  Aes256_Sha256_RsaPss: SecurityPolicy.Aes256_Sha256_RsaPss,
} as const;

function qualityFromStatusCode(value: number): IngestDataPoint["quality"] {
  const severity = value >>> 30;
  if (severity === 0) return "good";
  if (severity === 1) return "uncertain";
  return "bad";
}

export class NodeOpcUaReader implements OpcUaValueReader {
  private readonly client: OPCUAClient;
  private session: ClientSession | null = null;
  private connecting: Promise<ClientSession> | null = null;

  constructor(private readonly options: NodeOpcUaReaderOptions) {
    const clientOptions: OPCUAClientOptions = {
      applicationName: `Open Data Fusion Edge (${options.sourceSystem})`,
      securityMode: securityModes[options.securityMode],
      securityPolicy: securityPolicies[options.securityPolicy],
      endpointMustExist: options.endpointMustExist,
      connectionStrategy: { initialDelay: 250, maxDelay: 5_000, maxRetry: 3 },
      transportTimeout: options.connectionTimeoutMs,
      ...(options.certificateFile ? { certificateFile: options.certificateFile } : {}),
      ...(options.privateKeyFile ? { privateKeyFile: options.privateKeyFile } : {}),
    };
    this.client = OPCUAClient.create(clientOptions);
  }

  private async connect(): Promise<ClientSession> {
    if (this.session) return this.session;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.client.connect(this.options.endpointUrl);
      const identity: UserIdentityInfo =
        this.options.credentials.type === "username"
          ? {
              type: UserTokenType.UserName,
              userName: this.options.credentials.username,
              password: this.options.credentials.password,
            }
          : { type: UserTokenType.Anonymous };
      const session = await this.client.createSession(identity);
      this.session = session;
      return session;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async read(nodeIds: readonly string[]): Promise<OpcUaReadValue[]> {
    const session = await this.connect();
    const values = await session.read(nodeIds.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value })));
    return values.map((dataValue, index) => ({
      nodeId: nodeIds[index]!,
      value: dataValue.value.value,
      sourceTimestamp: dataValue.sourceTimestamp,
      serverTimestamp: dataValue.serverTimestamp,
      quality: qualityFromStatusCode(dataValue.statusCode.value),
      statusCode: dataValue.statusCode.toString(),
    }));
  }

  async close(): Promise<void> {
    const pendingSession = this.connecting ? await this.connecting.catch(() => null) : null;
    const session = this.session ?? pendingSession;
    this.session = null;
    if (session) await session.close();
    await this.client.disconnect();
  }
}

interface OpcUaCheckpoint {
  version: 1;
  nodes: Record<string, string>;
}

function parseCheckpoint(value: string | null): OpcUaCheckpoint {
  if (value === null) return { version: 1, nodes: {} };
  try {
    const parsed = JSON.parse(value) as Partial<OpcUaCheckpoint>;
    if (parsed.version !== 1 || !parsed.nodes || typeof parsed.nodes !== "object" || Array.isArray(parsed.nodes)) {
      throw new Error("unexpected checkpoint shape");
    }
    for (const [nodeId, nodeTimestamp] of Object.entries(parsed.nodes)) {
      if (!nodeId || typeof nodeTimestamp !== "string" || !Number.isFinite(Date.parse(nodeTimestamp))) {
        throw new Error(`invalid timestamp for node '${nodeId}'`);
      }
    }
    return parsed as OpcUaCheckpoint;
  } catch (error) {
    throw new Error(`Invalid OPC-UA checkpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function numericValue(value: unknown, nodeId: string): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`OPC-UA node '${nodeId}' returned an integer outside the safe numeric range`);
    }
    return Number(value);
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`OPC-UA node '${nodeId}' did not return a finite scalar number`);
  return parsed;
}

function rawValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return value;
}

export interface OpcUaConnectorDependencies {
  now?: () => Date;
}

export class OpcUaConnector implements EdgeConnector {
  private readonly now: () => Date;

  constructor(
    private readonly config: OpcUaConnectorConfig,
    private readonly reader: OpcUaValueReader,
    dependencies: OpcUaConnectorDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async poll(checkpointValue: string | null): Promise<ConnectorBatch | null> {
    const checkpoint = parseCheckpoint(checkpointValue);
    const observedAt = this.now();
    const values = await this.reader.read(this.config.nodes.map((node) => node.nodeId));
    const valuesByNode = new Map(values.map((value) => [value.nodeId, value]));
    const nextCheckpoint: OpcUaCheckpoint = { version: 1, nodes: { ...checkpoint.nodes } };
    const dataPoints: IngestDataPoint[] = [];
    const rawRecords: Array<Record<string, unknown>> = [];
    const timeSeries: IngestTimeSeries[] = [];

    for (const node of this.config.nodes) {
      const value = valuesByNode.get(node.nodeId);
      if (!value) throw new Error(`OPC-UA read did not return configured node '${node.nodeId}'`);
      const valueTimestamp = value.sourceTimestamp ?? value.serverTimestamp ?? observedAt;
      const timestamp = valueTimestamp.toISOString();
      const previousTimestamp = checkpoint.nodes[node.nodeId];
      if (previousTimestamp) {
        const comparison = valueTimestamp.getTime() - Date.parse(previousTimestamp);
        if (comparison < 0) {
          throw new Error(`OPC-UA node '${node.nodeId}' timestamp moved backwards; reset or migrate its checkpoint explicitly`);
        }
        if (comparison === 0) continue;
      }

      const scaledValue = numericValue(value.value, node.nodeId) * node.scale + node.offset;
      if (!Number.isFinite(scaledValue)) throw new Error(`OPC-UA node '${node.nodeId}' scale and offset produced a non-finite value`);
      dataPoints.push({
        timeSeriesExternalId: node.timeSeriesExternalId,
        timestamp,
        value: scaledValue,
        quality: value.quality,
      });
      timeSeries.push({
        externalId: node.timeSeriesExternalId,
        assetExternalId: node.assetExternalId,
        name: node.name,
        metadata: { ...node.metadata, opcUaNodeId: node.nodeId },
        ...(node.unit !== undefined ? { unit: node.unit } : {}),
        ...(node.description !== undefined ? { description: node.description } : {}),
      });
      rawRecords.push({
        nodeId: node.nodeId,
        value: rawValue(value.value),
        sourceTimestamp: value.sourceTimestamp?.toISOString() ?? null,
        serverTimestamp: value.serverTimestamp?.toISOString() ?? null,
        statusCode: value.statusCode,
        quality: value.quality,
      });
      nextCheckpoint.nodes[node.nodeId] = timestamp;
    }

    if (dataPoints.length === 0) return null;
    return {
      checkpointAfter: JSON.stringify(nextCheckpoint),
      observedAt: observedAt.toISOString(),
      assets: mappedAssets(this.config.assets),
      timeSeries,
      dataPoints,
      documents: [],
      relations: [],
      rawRecords,
    };
  }

  async close(): Promise<void> {
    await this.reader.close();
  }
}
