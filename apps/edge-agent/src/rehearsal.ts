import type { ConnectorConfig } from "./config.js";
import type { ManagedConnector } from "./runner.js";

export interface ConnectorSchemaContract {
  connectorType: ConnectorConfig["type"];
  requiredFields: string[];
  schemaEvolutionPolicy: string;
}

export interface ConnectorRehearsalBatch {
  checkpointAfter: string;
  rawRecordCount: number;
  dataPointCount: number;
}

export interface ConnectorRehearsalResult {
  sourceSystem: string;
  connectorType: ConnectorConfig["type"];
  initialCheckpoint: string | null;
  finalCheckpoint: string | null;
  exhausted: boolean;
  schemaContract: ConnectorSchemaContract;
  batches: ConnectorRehearsalBatch[];
}

export interface ConnectorRehearsalOptions {
  /** Number of bounded source batches to read per connector; no data is persisted or delivered. */
  maxBatches?: number;
  /** Optional checkpoints allow an operator to rehearse a known resume position. */
  checkpoints?: Readonly<Record<string, string | null | undefined>>;
}

function tabularRequiredFields(config: Extract<ConnectorConfig, { type: "csv" | "postgres" }>): string[] {
  const required = new Set<string>([config.mapping.timestampColumn]);
  if (config.type === "postgres") required.add(config.checkpointColumn);
  for (const series of config.mapping.timeSeries) {
    required.add(series.valueColumn);
    if (series.qualityColumn) required.add(series.qualityColumn);
  }
  return [...required].sort((left, right) => left.localeCompare(right));
}

export function connectorSchemaContract(config: ConnectorConfig): ConnectorSchemaContract {
  if (config.type === "csv") {
    return {
      connectorType: config.type,
      requiredFields: tabularRequiredFields(config),
      schemaEvolutionPolicy: "CSV replacement or rewriting before a checkpoint fails closed; migrate the checkpoint explicitly before accepting a changed header or historical rows.",
    };
  }
  if (config.type === "postgres") {
    return {
      connectorType: config.type,
      requiredFields: tabularRequiredFields(config),
      schemaEvolutionPolicy: "Additional query fields are tolerated. Removing or renaming a checkpoint or mapped field fails the rehearsal before delivery.",
    };
  }
  return {
    connectorType: config.type,
    requiredFields: [...new Set(config.nodes.flatMap((node) => [node.nodeId, node.timeSeriesExternalId]))]
      .sort((left, right) => left.localeCompare(right)),
    schemaEvolutionPolicy: "Configured nodes are checkpointed independently. Add or remove nodes through a reviewed configuration change; a timestamp rollback fails closed.",
  };
}

function maximumBatches(options: ConnectorRehearsalOptions): number {
  const value = options.maxBatches ?? 2;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Connector rehearsal maxBatches must be an integer between 1 and 10000");
  }
  return value;
}

/**
 * Performs a bounded, read-only backfill/resume check.  It deliberately does
 * not create archives, queues, OAuth tokens, or API requests.
 */
export async function rehearseConnectors(
  connectors: readonly ManagedConnector[],
  configurations: readonly ConnectorConfig[],
  options: ConnectorRehearsalOptions = {},
): Promise<ConnectorRehearsalResult[]> {
  const configuredBySource = new Map(configurations.map((config) => [config.sourceSystem, config]));
  const maxBatches = maximumBatches(options);
  const results: ConnectorRehearsalResult[] = [];

  try {
    for (const managed of connectors) {
      const configuration = configuredBySource.get(managed.sourceSystem);
      if (!configuration) throw new Error(`Connector '${managed.sourceSystem}' has no validated configuration`);
      let checkpoint = options.checkpoints?.[managed.sourceSystem] ?? null;
      const initialCheckpoint = checkpoint;
      const batches: ConnectorRehearsalBatch[] = [];
      let exhausted = false;

      for (let index = 0; index < maxBatches; index += 1) {
        const batch = await managed.connector.poll(checkpoint);
        if (!batch) {
          exhausted = true;
          break;
        }
        if (!batch.checkpointAfter || batch.checkpointAfter === checkpoint) {
          throw new Error(`Connector '${managed.sourceSystem}' did not advance its checkpoint during rehearsal`);
        }
        batches.push({
          checkpointAfter: batch.checkpointAfter,
          rawRecordCount: batch.rawRecords.length,
          dataPointCount: batch.dataPoints.length,
        });
        checkpoint = batch.checkpointAfter;
      }

      results.push({
        sourceSystem: managed.sourceSystem,
        connectorType: configuration.type,
        initialCheckpoint,
        finalCheckpoint: checkpoint,
        exhausted,
        schemaContract: connectorSchemaContract(configuration),
        batches,
      });
    }
    return results;
  } finally {
    await Promise.all(connectors.map(async (managed) => managed.connector.close()));
  }
}
