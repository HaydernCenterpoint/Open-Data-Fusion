import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  AssetListQuery,
  AuditListQuery,
  IngestBundle,
  RelationReview,
  TelemetryAggregateQuery,
  TelemetryLatestQuery,
  TelemetryQuery,
  WorkspaceOperations,
  WorkspaceMemberUpsert,
  WorkspaceRevisionQuery,
  WorkspaceRollback,
  WorkspaceSnapshot,
  WorkspaceUpdate,
} from './schemas.js';
import type { WorkspaceMember, WorkspaceRole } from './collaboration.js';

type SqliteRow = Record<string, unknown>;

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class DataIntegrityError extends Error {}
export class ForbiddenError extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asAsset(row: SqliteRow): Record<string, unknown> {
  return {
    externalId: String(row.external_id),
    name: String(row.name),
    description: nullableString(row.description),
    type: String(row.type),
    parentExternalId: nullableString(row.parent_external_id),
    metadata: parseJson(row.metadata_json),
    sourceSystem: String(row.source_system),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asTimeSeries(row: SqliteRow): Record<string, unknown> {
  return {
    externalId: String(row.external_id),
    assetExternalId: String(row.asset_external_id),
    name: String(row.name),
    unit: nullableString(row.unit),
    description: nullableString(row.description),
    metadata: parseJson(row.metadata_json),
    sourceSystem: String(row.source_system),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asDocument(row: SqliteRow): Record<string, unknown> {
  return {
    externalId: String(row.external_id),
    assetExternalId: nullableString(row.asset_external_id),
    title: String(row.title),
    mimeType: nullableString(row.mime_type),
    uri: nullableString(row.uri),
    metadata: parseJson(row.metadata_json),
    sourceSystem: String(row.source_system),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asRelation(row: SqliteRow): Record<string, unknown> {
  return {
    id: String(row.id),
    source: { type: String(row.source_type), externalId: String(row.source_external_id) },
    target: { type: String(row.target_type), externalId: String(row.target_external_id) },
    type: String(row.relation_type),
    status: String(row.status),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    evidence: parseJson(row.evidence_json),
    ruleVersion: nullableString(row.rule_version),
    reviewer: nullableString(row.reviewer),
    reviewComment: nullableString(row.review_comment),
    reviewedAt: nullableString(row.reviewed_at),
    sourceSystem: String(row.source_system),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asProvenance(row: SqliteRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    sourceSystem: String(row.source_system),
    sourceRecordId: nullableString(row.source_record_id),
    ingestionRunId: String(row.ingestion_run_id),
    rawHash: String(row.raw_hash),
    modelVersion: String(row.model_version),
    validFrom: String(row.valid_from),
    transactionTime: String(row.transaction_time),
    metadata: parseJson(row.metadata_json),
  };
}

function asAudit(row: SqliteRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    timestamp: String(row.timestamp),
    actor: String(row.actor),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: nullableString(row.entity_id),
    details: parseJson(row.details_json),
    correlationId: String(row.correlation_id),
  };
}

function asWorkspace(row: SqliteRow): Record<string, unknown> {
  return {
    id: String(row.id),
    name: String(row.name),
    version: Number(row.version),
    snapshot: parseJson(row.snapshot_json),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  };
}

function asWorkspaceRevision(row: SqliteRow): Record<string, unknown> {
  return {
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    snapshot: parseJson(row.snapshot_json),
    changeSummary: String(row.change_summary),
    actor: String(row.actor),
    createdAt: String(row.created_at),
    correlationId: String(row.correlation_id),
  };
}

function asWorkspaceMember(row: SqliteRow): WorkspaceMember {
  return {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    role: String(row.role) as WorkspaceRole,
  };
}

function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
  const nodeIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if (nodeIds.has(node.id)) throw new DataIntegrityError(`Canvas node '${node.id}' already exists`);
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edgeIds.has(edge.id)) throw new DataIntegrityError(`Canvas edge '${edge.id}' already exists`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) {
      throw new DataIntegrityError(`Canvas edge '${edge.id}' references missing source node '${edge.source}'`);
    }
    if (!nodeIds.has(edge.target)) {
      throw new DataIntegrityError(`Canvas edge '${edge.id}' references missing target node '${edge.target}'`);
    }
  }
}

function applyCanvasOperations(snapshot: WorkspaceSnapshot, operations: WorkspaceOperations['operations']): WorkspaceSnapshot {
  const next = structuredClone(snapshot);

  for (const operation of operations) {
    switch (operation.type) {
      case 'moveNode': {
        const node = next.nodes.find((candidate) => candidate.id === operation.nodeId);
        if (!node) throw new DataIntegrityError(`Canvas node '${operation.nodeId}' was not found`);
        node.position = structuredClone(operation.position);
        break;
      }
      case 'addNode':
        if (next.nodes.some((node) => node.id === operation.node.id)) {
          throw new DataIntegrityError(`Canvas node '${operation.node.id}' already exists`);
        }
        next.nodes.push(structuredClone(operation.node));
        break;
      case 'removeNode': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new DataIntegrityError(`Canvas node '${operation.nodeId}' was not found`);
        next.nodes.splice(index, 1);
        break;
      }
      case 'updateNode': {
        const node = next.nodes.find((candidate) => candidate.id === operation.nodeId);
        if (!node) throw new DataIntegrityError(`Canvas node '${operation.nodeId}' was not found`);
        if (operation.patch.type !== undefined) node.type = operation.patch.type;
        if (operation.patch.position !== undefined) node.position = structuredClone(operation.patch.position);
        if (operation.patch.data !== undefined) {
          node.data = { ...node.data, ...structuredClone(operation.patch.data) };
        }
        break;
      }
      case 'addEdge':
        if (next.edges.some((edge) => edge.id === operation.edge.id)) {
          throw new DataIntegrityError(`Canvas edge '${operation.edge.id}' already exists`);
        }
        next.edges.push(structuredClone(operation.edge));
        break;
      case 'removeEdge': {
        const index = next.edges.findIndex((edge) => edge.id === operation.edgeId);
        if (index < 0) throw new DataIntegrityError(`Canvas edge '${operation.edgeId}' was not found`);
        next.edges.splice(index, 1);
        break;
      }
      case 'updateEdge': {
        const edge = next.edges.find((candidate) => candidate.id === operation.edgeId);
        if (!edge) throw new DataIntegrityError(`Canvas edge '${operation.edgeId}' was not found`);
        if (operation.patch.type !== undefined) edge.type = operation.patch.type;
        if (operation.patch.data !== undefined) {
          edge.data = { ...edge.data, ...structuredClone(operation.patch.data) };
        }
        break;
      }
    }
  }

  validateWorkspaceSnapshot(next);
  return next;
}

export interface DatabaseOptions {
  path: string;
  seed?: boolean;
}

export interface WorkspaceMemberUpsertResult {
  member: WorkspaceMember;
  created: boolean;
}

export class FusionDatabase {
  readonly database: DatabaseSync;

  constructor(options: DatabaseOptions) {
    if (options.path !== ':memory:') {
      mkdirSync(dirname(resolve(options.path)), { recursive: true });
    }
    this.database = new DatabaseSync(options.path);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (options.path !== ':memory:') {
      this.database.exec('PRAGMA journal_mode = WAL;');
    }
    this.createSchema();
    this.migrateWorkspaceMemberRoles();
    if (options.seed !== false) this.seedIfEmpty();
    if (options.seed !== false) this.seedCanvasWorkspaceIfEmpty();
    if (options.seed !== false) this.seedWorkspaceMembers();
  }

  close(): void {
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      INSERT INTO schema_metadata(key, value) VALUES ('schema_version', '3')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;

      CREATE TABLE IF NOT EXISTS assets (
        external_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        parent_external_id TEXT REFERENCES assets(external_id) ON UPDATE CASCADE ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        source_system TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(parent_external_id IS NULL OR parent_external_id <> external_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS assets_parent_idx ON assets(parent_external_id);
      CREATE INDEX IF NOT EXISTS assets_type_idx ON assets(type);
      CREATE INDEX IF NOT EXISTS assets_name_idx ON assets(name);

      CREATE TABLE IF NOT EXISTS time_series (
        external_id TEXT PRIMARY KEY,
        asset_external_id TEXT NOT NULL REFERENCES assets(external_id) ON UPDATE CASCADE ON DELETE CASCADE,
        name TEXT NOT NULL,
        unit TEXT,
        description TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        source_system TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS time_series_asset_idx ON time_series(asset_external_id);

      CREATE TABLE IF NOT EXISTS data_points (
        time_series_external_id TEXT NOT NULL REFERENCES time_series(external_id) ON UPDATE CASCADE ON DELETE CASCADE,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        quality TEXT NOT NULL DEFAULT 'good' CHECK(quality IN ('good', 'uncertain', 'bad')),
        source_system TEXT NOT NULL,
        ingestion_run_id TEXT NOT NULL,
        PRIMARY KEY(time_series_external_id, timestamp)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS data_points_timestamp_idx ON data_points(timestamp);

      CREATE TABLE IF NOT EXISTS documents (
        external_id TEXT PRIMARY KEY,
        asset_external_id TEXT REFERENCES assets(external_id) ON UPDATE CASCADE ON DELETE SET NULL,
        title TEXT NOT NULL,
        mime_type TEXT,
        uri TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        source_system TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS documents_asset_idx ON documents(asset_external_id);

      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL CHECK(source_type IN ('asset', 'timeSeries', 'document')),
        source_external_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('asset', 'timeSeries', 'document')),
        target_external_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'accepted', 'rejected', 'superseded')),
        confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
        rule_version TEXT,
        reviewer TEXT,
        review_comment TEXT,
        reviewed_at TEXT,
        source_system TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_type, source_external_id, target_type, target_external_id, relation_type)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS relations_source_idx ON relations(source_type, source_external_id);
      CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_type, target_external_id);
      CREATE INDEX IF NOT EXISTS relations_status_idx ON relations(status);

      CREATE TABLE IF NOT EXISTS ingestion_runs (
        run_id TEXT PRIMARY KEY,
        source_system TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
        payload_hash TEXT NOT NULL,
        counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts_json)),
        error_message TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        source_system TEXT NOT NULL,
        source_record_id TEXT,
        ingestion_run_id TEXT NOT NULL,
        raw_hash TEXT NOT NULL,
        model_version TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        transaction_time TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS provenance_entity_idx ON provenance(entity_type, entity_id, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS provenance_run_idx ON provenance(ingestion_run_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
        correlation_id TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_timestamp_idx ON audit_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log(action);

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        version INTEGER NOT NULL CHECK(version >= 1),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workspace_revisions (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version >= 1),
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        change_summary TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        PRIMARY KEY(workspace_id, version)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS workspace_revisions_created_idx ON workspace_revisions(workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'reviewer', 'viewer')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, user_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id, workspace_id);
    `);
  }

  private migrateWorkspaceMemberRoles(): void {
    const table = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_members'
    `).get() as SqliteRow | undefined;
    if (!table || String(table.sql).includes("'reviewer'")) return;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE workspace_members_next (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'reviewer', 'viewer')),
          created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, user_id)
        ) STRICT, WITHOUT ROWID;
        INSERT INTO workspace_members_next(workspace_id, user_id, display_name, role, created_at)
        SELECT workspace_id, user_id, display_name, role, created_at FROM workspace_members;
        DROP TABLE workspace_members;
        ALTER TABLE workspace_members_next RENAME TO workspace_members;
        CREATE INDEX workspace_members_user_idx ON workspace_members(user_id, workspace_id);
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private seedIfEmpty(): void {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM assets').get() as SqliteRow;
    if (Number(row.count) > 0) return;

    const seededAt = nowIso();
    const seedRunId = 'seed-open-data-fusion-v1';
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const insertAsset = this.database.prepare(`
        INSERT INTO assets(external_id, name, description, type, parent_external_id, metadata_json, source_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'demo-cmms', ?, ?)
      `);
      insertAsset.run('PLANT-01', 'North Plant', 'Primary demonstration facility', 'Plant', null, JSON.stringify({ country: 'TH', timezone: 'Asia/Bangkok', status: 'Running' }), seededAt, seededAt);
      insertAsset.run('AREA-A', 'Cooling Water System', 'Cooling-water process area', 'System', 'PLANT-01', JSON.stringify({ criticality: 'High', status: 'Running' }), seededAt, seededAt);
      insertAsset.run('P-101', 'Pump P-101', 'Primary centrifugal circulation pump', 'Pump', 'AREA-A', JSON.stringify({ manufacturer: 'Nordic Pumps', model: 'NP-400', criticality: 'High', status: 'Running' }), seededAt, seededAt);
      insertAsset.run('P-102', 'Pump P-102', 'Standby centrifugal circulation pump', 'Pump', 'AREA-A', JSON.stringify({ criticality: 'High', status: 'Standby' }), seededAt, seededAt);
      insertAsset.run('HX-201', 'Heat Exchanger HX-201', 'Cooling-water plate heat exchanger', 'HeatExchanger', 'AREA-A', JSON.stringify({ criticality: 'High', status: 'Running' }), seededAt, seededAt);
      insertAsset.run('CT-301', 'Cooling Tower CT-301', 'North plant cooling tower', 'CoolingTower', 'AREA-A', JSON.stringify({ criticality: 'Medium', status: 'Running' }), seededAt, seededAt);
      insertAsset.run('V-401', 'Surge Vessel V-401', 'Cooling-water surge vessel', 'Vessel', 'AREA-A', JSON.stringify({ criticality: 'Medium', status: 'Running' }), seededAt, seededAt);
      insertAsset.run('FM-501', 'Flow Meter FM-501', 'Cooling-water supply flow meter', 'FlowMeter', 'AREA-A', JSON.stringify({ criticality: 'Medium', status: 'Maintenance' }), seededAt, seededAt);

      const insertSeries = this.database.prepare(`
        INSERT INTO time_series(external_id, asset_external_id, name, unit, description, metadata_json, source_system, created_at, updated_at)
        VALUES (?, 'P-101', ?, ?, ?, ?, 'demo-opcua', ?, ?)
      `);
      insertSeries.run('P-101-PRESSURE', 'P-101 discharge pressure', 'psi', 'Discharge pressure at pump outlet', JSON.stringify({ opcNodeId: 'ns=2;s=P101.Pressure' }), seededAt, seededAt);
      insertSeries.run('P-101-TEMP', 'P-101 bearing temperature', '°C', 'Drive-end bearing temperature', JSON.stringify({ opcNodeId: 'ns=2;s=P101.BearingTemp' }), seededAt, seededAt);

      const insertPoint = this.database.prepare(`
        INSERT INTO data_points(time_series_external_id, timestamp, value, quality, source_system, ingestion_run_id)
        VALUES (?, ?, ?, 'good', 'demo-opcua', ?)
      `);
      const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      for (let hoursAgo = 24; hoursAgo >= 0; hoursAgo -= 1) {
        const timestamp = currentHour - hoursAgo * 3_600_000;
        const phase = (24 - hoursAgo) / 3;
        insertPoint.run('P-101-PRESSURE', timestamp, 106.5 + Math.sin(phase) * 10.5, seedRunId);
        insertPoint.run('P-101-TEMP', timestamp, 61.5 + Math.cos(phase / 1.4) * 2.4, seedRunId);
      }

      const insertDocument = this.database.prepare(`
        INSERT INTO documents(external_id, asset_external_id, title, mime_type, uri, metadata_json, source_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'demo-dms', ?, ?)
      `);
      insertDocument.run('DOC-P101-MANUAL', 'P-101', 'P-101 Operation and Maintenance Manual', 'application/pdf', 's3://odf-demo/documents/p101-manual.pdf', JSON.stringify({ revision: 'C', language: 'en' }), seededAt, seededAt);
      insertDocument.run('DOC-AREA-A-PID', 'AREA-A', 'Area A P&ID', 'application/pdf', 's3://odf-demo/documents/area-a-pid.pdf', JSON.stringify({ drawingNumber: 'PID-A-001', revision: '7' }), seededAt, seededAt);

      const insertRelation = this.database.prepare(`
        INSERT INTO relations(id, source_type, source_external_id, target_type, target_external_id, relation_type, status, confidence, evidence_json, rule_version, reviewer, reviewed_at, source_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertRelation.run('rel-p101-manual', 'asset', 'P-101', 'document', 'DOC-P101-MANUAL', 'hasDocument', 'proposed', 0.94, JSON.stringify({ matchedTag: 'P-101', page: 1 }), 'tag-match/1.0', null, null, 'context-engine', seededAt, seededAt);
      insertRelation.run('rel-pressure-p101', 'timeSeries', 'P-101-PRESSURE', 'asset', 'P-101', 'monitors', 'accepted', 1, JSON.stringify({ mappedBy: 'OPC UA connector configuration' }), 'connector-map/1.0', 'system', seededAt, 'demo-opcua', seededAt, seededAt);
      insertRelation.run('rel-temp-p101', 'timeSeries', 'P-101-TEMP', 'asset', 'P-101', 'monitors', 'accepted', 1, JSON.stringify({ mappedBy: 'OPC UA connector configuration' }), 'connector-map/1.0', 'system', seededAt, 'demo-opcua', seededAt, seededAt);

      this.database.prepare(`
        INSERT INTO ingestion_runs(run_id, source_system, status, payload_hash, counts_json, started_at, completed_at)
        VALUES (?, 'seed', 'completed', ?, ?, ?, ?)
      `).run(seedRunId, createHash('sha256').update(seedRunId).digest('hex'), JSON.stringify({ assets: 8, timeSeries: 2, dataPoints: 50, documents: 2, relations: 3 }), seededAt, seededAt);

      const insertProvenance = this.database.prepare(`
        INSERT INTO provenance(entity_type, entity_id, source_system, source_record_id, ingestion_run_id, raw_hash, model_version, valid_from, transaction_time, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, 'odf-core/0.1', ?, ?, '{}')
      `);
      const seededEntities: Array<[string, string, string]> = [
        ['asset', 'PLANT-01', 'demo-cmms'],
        ['asset', 'AREA-A', 'demo-cmms'],
        ['asset', 'P-101', 'demo-cmms'],
        ['asset', 'P-102', 'demo-cmms'],
        ['asset', 'HX-201', 'demo-cmms'],
        ['asset', 'CT-301', 'demo-cmms'],
        ['asset', 'V-401', 'demo-cmms'],
        ['asset', 'FM-501', 'demo-cmms'],
        ['timeSeries', 'P-101-PRESSURE', 'demo-opcua'],
        ['timeSeries', 'P-101-TEMP', 'demo-opcua'],
        ['document', 'DOC-P101-MANUAL', 'demo-dms'],
        ['document', 'DOC-AREA-A-PID', 'demo-dms'],
      ];
      for (const [entityType, entityId, sourceSystem] of seededEntities) {
        insertProvenance.run(entityType, entityId, sourceSystem, entityId, seedRunId, createHash('sha256').update(`${entityType}:${entityId}`).digest('hex'), seededAt, seededAt);
      }

      this.insertAudit('system', 'database.seeded', 'platform', 'open-data-fusion', { assets: 8, timeSeries: 2, dataPoints: 50, documents: 2, relations: 3 }, seedRunId, seededAt);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private seedCanvasWorkspaceIfEmpty(): void {
    const existing = this.database.prepare('SELECT 1 AS found FROM workspaces WHERE id = ?').get('cooling-water-system');
    if (existing) return;

    const seededAt = nowIso();
    const snapshot: WorkspaceSnapshot = {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'canvas-pid', type: 'diagram', position: { x: 55, y: 135 }, data: { documentExternalId: 'DOC-AREA-A-PID', title: 'P&ID — Cooling Water System' } },
        { id: 'canvas-p101', type: 'asset', position: { x: 500, y: 105 }, data: { externalId: 'P-101', label: 'Pump P-101' } },
        { id: 'canvas-pressure', type: 'timeSeries', position: { x: 475, y: 290 }, data: { externalId: 'P-101-PRESSURE', label: 'Pressure psi' } },
        { id: 'canvas-system', type: 'asset', position: { x: 470, y: 475 }, data: { externalId: 'AREA-A', label: 'Cooling Water System' } },
        { id: 'canvas-overview', type: 'document', position: { x: 475, y: 655 }, data: { externalId: 'DOC-AREA-A-PID', label: 'CWS Overview.pdf' } },
      ],
      edges: [
        { id: 'canvas-p101-pressure', source: 'canvas-p101', target: 'canvas-pressure', type: 'measures', data: {} },
        { id: 'canvas-pressure-system', source: 'canvas-pressure', target: 'canvas-system', type: 'partOf', data: {} },
        { id: 'canvas-system-overview', source: 'canvas-system', target: 'canvas-overview', type: 'documentedBy', data: {} },
        { id: 'canvas-pid-p101', source: 'canvas-pid', target: 'canvas-p101', type: 'diagramOf', data: {} },
      ],
    };

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO workspaces(id, name, snapshot_json, version, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, 1, 'system', ?, 'system', ?)
      `).run('cooling-water-system', 'Cooling Water System', JSON.stringify(snapshot), seededAt, seededAt);
      this.database.prepare(`
        INSERT INTO workspace_revisions(workspace_id, version, snapshot_json, change_summary, actor, created_at, correlation_id)
        VALUES (?, 1, ?, ?, 'system', ?, ?)
      `).run('cooling-water-system', JSON.stringify(snapshot), 'Seeded Cooling Water System canvas', seededAt, 'seed-open-data-fusion-workspace-v1');
      this.insertAudit('system', 'workspace.created', 'workspace', 'cooling-water-system', { version: 1, name: 'Cooling Water System' }, 'seed-open-data-fusion-workspace-v1', seededAt);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private seedWorkspaceMembers(): void {
    const workspace = this.database.prepare('SELECT 1 AS found FROM workspaces WHERE id = ?').get('cooling-water-system');
    if (!workspace) return;

    const createdAt = nowIso();
    const insert = this.database.prepare(`
      INSERT INTO workspace_members(workspace_id, user_id, display_name, role, created_at)
      VALUES ('cooling-water-system', ?, ?, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO NOTHING
    `);
    insert.run('harper.dennis', 'Harper Dennis', 'owner', createdAt);
    insert.run('riley.chen', 'Riley Chen', 'editor', createdAt);
    insert.run('monica.reyes', 'Monica Reyes', 'reviewer', createdAt);
    insert.run('samantha.lee', 'Samantha Lee', 'viewer', createdAt);
  }

  health(): Record<string, unknown> {
    const probe = this.database.prepare('SELECT 1 AS ok').get() as SqliteRow;
    const schema = this.database.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get() as SqliteRow;
    return {
      status: Number(probe.ok) === 1 ? 'ok' : 'degraded',
      service: 'open-data-fusion-api',
      schemaVersion: String(schema.value),
      timestamp: nowIso(),
    };
  }

  getWorkspace(id: string): Record<string, unknown> {
    const row = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as SqliteRow | undefined;
    if (!row) throw new NotFoundError(`Workspace '${id}' was not found`);
    return asWorkspace(row);
  }

  getWorkspaceMember(id: string, userId: string): WorkspaceMember {
    this.getWorkspace(id);
    const row = this.database.prepare(`
      SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?
    `).get(id, userId) as SqliteRow | undefined;
    if (!row) throw new ForbiddenError(`User '${userId}' is not a member of workspace '${id}'`);
    return asWorkspaceMember(row);
  }

  listWorkspaceMembers(id: string): Record<string, unknown> {
    this.getWorkspace(id);
    const rows = this.database.prepare(`
      SELECT * FROM workspace_members
      WHERE workspace_id = ?
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'reviewer' THEN 2 ELSE 3 END, display_name
    `).all(id) as SqliteRow[];
    return { items: rows.map(asWorkspaceMember), total: rows.length };
  }

  upsertWorkspaceMember(
    id: string,
    actor: string,
    targetUserId: string,
    update: WorkspaceMemberUpsert,
    correlationId: string,
  ): WorkspaceMemberUpsertResult {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.requireWorkspaceOwner(id, actor);
      const existing = this.database.prepare(`
        SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?
      `).get(id, targetUserId) as SqliteRow | undefined;

      if (existing && String(existing.role) === 'owner' && update.role !== 'owner' && this.workspaceOwnerCount(id) <= 1) {
        throw new ConflictError(`Workspace '${id}' must retain at least one owner`);
      }

      const changedAt = nowIso();
      const created = !existing;
      this.database.prepare(`
        INSERT INTO workspace_members(workspace_id, user_id, display_name, role, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET
          display_name = excluded.display_name,
          role = excluded.role
      `).run(id, targetUserId, update.displayName, update.role, changedAt);

      const action = created ? 'workspace.member_added' : 'workspace.member_updated';
      this.insertAudit(actor, action, 'workspaceMember', targetUserId, {
        workspaceId: id,
        targetUserId,
        displayName: update.displayName,
        role: update.role,
        previousDisplayName: existing ? String(existing.display_name) : null,
        previousRole: existing ? String(existing.role) : null,
      }, correlationId, changedAt);
      const row = this.database.prepare(`
        SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?
      `).get(id, targetUserId) as SqliteRow;
      this.database.exec('COMMIT');
      return { member: asWorkspaceMember(row), created };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  removeWorkspaceMember(id: string, actor: string, targetUserId: string, correlationId: string): WorkspaceMember {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.requireWorkspaceOwner(id, actor);
      const existing = this.database.prepare(`
        SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?
      `).get(id, targetUserId) as SqliteRow | undefined;
      if (!existing) throw new NotFoundError(`Member '${targetUserId}' was not found in workspace '${id}'`);
      if (String(existing.role) === 'owner' && this.workspaceOwnerCount(id) <= 1) {
        throw new ConflictError(`Workspace '${id}' must retain at least one owner`);
      }

      const removedAt = nowIso();
      this.database.prepare(`
        DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?
      `).run(id, targetUserId);
      this.insertAudit(actor, 'workspace.member_removed', 'workspaceMember', targetUserId, {
        workspaceId: id,
        targetUserId,
        displayName: String(existing.display_name),
        role: String(existing.role),
      }, correlationId, removedAt);
      this.database.exec('COMMIT');
      return asWorkspaceMember(existing);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  applyWorkspaceOperations(id: string, actor: string, update: WorkspaceOperations, correlationId: string): Record<string, unknown> {
    const member = this.getWorkspaceMember(id, actor);
    if (member.role !== 'owner' && member.role !== 'editor') {
      throw new ForbiddenError(`User '${actor}' has read-only access to workspace '${id}'`);
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as SqliteRow | undefined;
      if (!current) throw new NotFoundError(`Workspace '${id}' was not found`);
      const currentVersion = Number(current.version);
      if (currentVersion !== update.baseVersion) {
        throw new ConflictError(`Workspace '${id}' is at version ${currentVersion}; reload and merge before applying operations to version ${update.baseVersion}`);
      }

      const currentSnapshot = JSON.parse(String(current.snapshot_json)) as WorkspaceSnapshot;
      const nextSnapshot = applyCanvasOperations(currentSnapshot, update.operations);
      const nextVersion = currentVersion + 1;
      const updatedAt = nowIso();
      const snapshotJson = JSON.stringify(nextSnapshot);
      this.database.prepare(`
        UPDATE workspaces
        SET snapshot_json = ?, version = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(snapshotJson, nextVersion, actor, updatedAt, id, currentVersion);
      this.database.prepare(`
        INSERT INTO workspace_revisions(workspace_id, version, snapshot_json, change_summary, actor, created_at, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, nextVersion, snapshotJson, update.changeSummary, actor, updatedAt, correlationId);
      this.insertAudit(actor, 'workspace.operations_applied', 'workspace', id, {
        previousVersion: currentVersion,
        version: nextVersion,
        changeSummary: update.changeSummary,
        operations: update.operations,
      }, correlationId, updatedAt);
      const updated = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as SqliteRow;
      this.database.exec('COMMIT');
      return asWorkspace(updated);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listWorkspaceRevisions(id: string, query: WorkspaceRevisionQuery): Record<string, unknown> {
    this.getWorkspace(id);
    const total = this.database.prepare('SELECT COUNT(*) AS count FROM workspace_revisions WHERE workspace_id = ?').get(id) as SqliteRow;
    const rows = this.database.prepare(`
      SELECT * FROM workspace_revisions
      WHERE workspace_id = ?
      ORDER BY version DESC
      LIMIT ? OFFSET ?
    `).all(id, query.limit, query.offset) as SqliteRow[];
    return { items: rows.map(asWorkspaceRevision), total: Number(total.count), limit: query.limit, offset: query.offset };
  }

  updateWorkspace(id: string, update: WorkspaceUpdate, correlationId: string): Record<string, unknown> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as SqliteRow | undefined;
      if (!current) throw new NotFoundError(`Workspace '${id}' was not found`);
      const currentVersion = Number(current.version);
      if (currentVersion !== update.expectedVersion) {
        throw new ConflictError(`Workspace '${id}' is at version ${currentVersion}; reload and merge before saving version ${update.expectedVersion}`);
      }

      const nextVersion = currentVersion + 1;
      const updatedAt = nowIso();
      const snapshotJson = JSON.stringify(update.snapshot);
      this.database.prepare(`
        UPDATE workspaces
        SET snapshot_json = ?, version = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(snapshotJson, nextVersion, update.actor, updatedAt, id, currentVersion);
      this.database.prepare(`
        INSERT INTO workspace_revisions(workspace_id, version, snapshot_json, change_summary, actor, created_at, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, nextVersion, snapshotJson, update.changeSummary, update.actor, updatedAt, correlationId);
      this.insertAudit(update.actor, 'workspace.saved', 'workspace', id, {
        previousVersion: currentVersion,
        version: nextVersion,
        changeSummary: update.changeSummary,
      }, correlationId, updatedAt);
      const updated = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as SqliteRow;
      this.database.exec('COMMIT');
      return asWorkspace(updated);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  rollbackWorkspace(id: string, rollback: WorkspaceRollback, correlationId: string): Record<string, unknown> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as SqliteRow | undefined;
      if (!current) throw new NotFoundError(`Workspace '${id}' was not found`);
      const currentVersion = Number(current.version);
      if (currentVersion !== rollback.expectedVersion) {
        throw new ConflictError(`Workspace '${id}' is at version ${currentVersion}; reload and merge before rolling back version ${rollback.expectedVersion}`);
      }
      const target = this.database.prepare(`
        SELECT * FROM workspace_revisions WHERE workspace_id = ? AND version = ?
      `).get(id, rollback.targetVersion) as SqliteRow | undefined;
      if (!target) throw new NotFoundError(`Revision ${rollback.targetVersion} for workspace '${id}' was not found`);

      const nextVersion = currentVersion + 1;
      const rolledBackAt = nowIso();
      const snapshotJson = String(target.snapshot_json);
      const changeSummary = rollback.changeSummary || `Rolled back to revision ${rollback.targetVersion}`;
      this.database.prepare(`
        UPDATE workspaces
        SET snapshot_json = ?, version = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(snapshotJson, nextVersion, rollback.actor, rolledBackAt, id, currentVersion);
      this.database.prepare(`
        INSERT INTO workspace_revisions(workspace_id, version, snapshot_json, change_summary, actor, created_at, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, nextVersion, snapshotJson, changeSummary, rollback.actor, rolledBackAt, correlationId);
      this.insertAudit(rollback.actor, 'workspace.rolled_back', 'workspace', id, {
        previousVersion: currentVersion,
        version: nextVersion,
        restoredFromVersion: rollback.targetVersion,
        changeSummary,
      }, correlationId, rolledBackAt);
      const updated = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as SqliteRow;
      this.database.exec('COMMIT');
      return asWorkspace(updated);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listAssets(query: AssetListQuery): Record<string, unknown> {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.q) {
      conditions.push('(external_id LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE OR COALESCE(description, \'\') LIKE ? COLLATE NOCASE)');
      const search = `%${query.q}%`;
      parameters.push(search, search, search);
    }
    if (query.type) {
      conditions.push('type = ? COLLATE NOCASE');
      parameters.push(query.type);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = this.database.prepare(`SELECT COUNT(*) AS count FROM assets ${where}`).get(...parameters) as SqliteRow;
    const rows = this.database
      .prepare(`SELECT * FROM assets ${where} ORDER BY name COLLATE NOCASE, external_id LIMIT ? OFFSET ?`)
      .all(...parameters, query.limit, query.offset) as SqliteRow[];
    return { items: rows.map(asAsset), total: Number(totalRow.count), limit: query.limit, offset: query.offset };
  }

  getAsset(externalId: string): Record<string, unknown> {
    const row = this.database.prepare('SELECT * FROM assets WHERE external_id = ?').get(externalId) as SqliteRow | undefined;
    if (!row) throw new NotFoundError(`Asset '${externalId}' was not found`);

    const parent = row.parent_external_id
      ? (this.database.prepare('SELECT * FROM assets WHERE external_id = ?').get(row.parent_external_id as string) as SqliteRow | undefined)
      : undefined;
    const children = this.database.prepare('SELECT * FROM assets WHERE parent_external_id = ? ORDER BY name').all(externalId) as SqliteRow[];
    const timeSeries = this.database.prepare('SELECT * FROM time_series WHERE asset_external_id = ? ORDER BY name').all(externalId) as SqliteRow[];
    const documents = this.database.prepare('SELECT * FROM documents WHERE asset_external_id = ? ORDER BY title').all(externalId) as SqliteRow[];
    const relations = this.database.prepare(`
      SELECT * FROM relations
      WHERE (source_type = 'asset' AND source_external_id = ?)
         OR (target_type = 'asset' AND target_external_id = ?)
      ORDER BY CASE status WHEN 'proposed' THEN 0 ELSE 1 END, created_at DESC
    `).all(externalId, externalId) as SqliteRow[];
    const provenance = this.database.prepare(`
      SELECT * FROM provenance WHERE entity_type = 'asset' AND entity_id = ? ORDER BY transaction_time DESC
    `).all(externalId) as SqliteRow[];

    return {
      asset: asAsset(row),
      parent: parent ? asAsset(parent) : null,
      children: children.map(asAsset),
      timeSeries: timeSeries.map(asTimeSeries),
      documents: documents.map(asDocument),
      relations: relations.map(asRelation),
      provenance: provenance.map(asProvenance),
    };
  }

  getTelemetry(assetExternalId: string, query: TelemetryQuery): Record<string, unknown> {
    const asset = this.database.prepare('SELECT external_id FROM assets WHERE external_id = ?').get(assetExternalId);
    if (!asset) throw new NotFoundError(`Asset '${assetExternalId}' was not found`);

    const from = query.from ?? Date.now() - 24 * 60 * 60 * 1_000;
    const to = query.to ?? Date.now();
    const seriesRows = query.timeSeriesExternalId
      ? (this.database.prepare('SELECT * FROM time_series WHERE asset_external_id = ? AND external_id = ? ORDER BY name').all(assetExternalId, query.timeSeriesExternalId) as SqliteRow[])
      : (this.database.prepare('SELECT * FROM time_series WHERE asset_external_id = ? ORDER BY name').all(assetExternalId) as SqliteRow[]);

    if (query.timeSeriesExternalId && seriesRows.length === 0) {
      throw new NotFoundError(`Time series '${query.timeSeriesExternalId}' was not found on asset '${assetExternalId}'`);
    }

    const pointStatement = this.database.prepare(`
      SELECT * FROM (
        SELECT timestamp, value, quality
        FROM data_points
        WHERE time_series_external_id = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC
        LIMIT ?
      ) ORDER BY timestamp ASC
    `);

    return {
      assetExternalId,
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      series: seriesRows.map((seriesRow) => {
        const points = pointStatement.all(String(seriesRow.external_id), from, to, query.limit) as SqliteRow[];
        return {
          ...asTimeSeries(seriesRow),
          points: points.map((point) => ({
            timestamp: new Date(Number(point.timestamp)).toISOString(),
            value: Number(point.value),
            quality: String(point.quality),
          })),
        };
      }),
    };
  }

  getLatestTelemetry(assetExternalId: string, query: TelemetryLatestQuery): Record<string, unknown> {
    const asset = this.database.prepare('SELECT external_id FROM assets WHERE external_id = ?').get(assetExternalId);
    if (!asset) throw new NotFoundError(`Asset '${assetExternalId}' was not found`);
    const asOf = query.at ?? Date.now();
    const seriesRows = query.timeSeriesExternalId
      ? (this.database.prepare('SELECT * FROM time_series WHERE asset_external_id = ? AND external_id = ? ORDER BY name').all(assetExternalId, query.timeSeriesExternalId) as SqliteRow[])
      : (this.database.prepare('SELECT * FROM time_series WHERE asset_external_id = ? ORDER BY name').all(assetExternalId) as SqliteRow[]);
    if (query.timeSeriesExternalId && seriesRows.length === 0) {
      throw new NotFoundError(`Time series '${query.timeSeriesExternalId}' was not found on asset '${assetExternalId}'`);
    }
    const latest = this.database.prepare(`
      SELECT timestamp,value,quality FROM data_points
      WHERE time_series_external_id=? AND timestamp<=?
      ORDER BY timestamp DESC LIMIT 1
    `);
    return {
      assetExternalId,
      asOf: new Date(asOf).toISOString(),
      series: seriesRows.map((seriesRow) => {
        const point = latest.get(String(seriesRow.external_id), asOf) as SqliteRow | undefined;
        const mappedPoint = point ? {
          timestamp: new Date(Number(point.timestamp)).toISOString(),
          value: Number(point.value),
          quality: String(point.quality),
        } : null;
        return {
          ...asTimeSeries(seriesRow),
          point: mappedPoint,
          points: mappedPoint ? [mappedPoint] : [],
        };
      }),
    };
  }

  getAggregatedTelemetry(assetExternalId: string, query: TelemetryAggregateQuery): Record<string, unknown> {
    const asset = this.database.prepare('SELECT external_id FROM assets WHERE external_id = ?').get(assetExternalId);
    if (!asset) throw new NotFoundError(`Asset '${assetExternalId}' was not found`);
    const from = query.from ?? Date.now() - 24 * 60 * 60 * 1_000;
    const to = query.to ?? Date.now();
    const seriesRows = query.timeSeriesExternalId
      ? (this.database.prepare('SELECT * FROM time_series WHERE asset_external_id = ? AND external_id = ? ORDER BY name').all(assetExternalId, query.timeSeriesExternalId) as SqliteRow[])
      : (this.database.prepare('SELECT * FROM time_series WHERE asset_external_id = ? ORDER BY name').all(assetExternalId) as SqliteRow[]);
    if (query.timeSeriesExternalId && seriesRows.length === 0) {
      throw new NotFoundError(`Time series '${query.timeSeriesExternalId}' was not found on asset '${assetExternalId}'`);
    }
    const aggregate = this.database.prepare(`
      WITH filtered AS (
        SELECT timestamp,value,quality,CAST(timestamp / ? AS INTEGER) * ? AS bucket_start
        FROM data_points
        WHERE time_series_external_id=? AND timestamp>=? AND timestamp<=?
      ), ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY timestamp ASC) AS first_rank,
          ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY timestamp DESC) AS last_rank
        FROM filtered
      )
      SELECT * FROM (
        SELECT bucket_start,COUNT(*) AS point_count,AVG(value) AS average_value,
          MIN(value) AS minimum_value,MAX(value) AS maximum_value,SUM(value) AS sum_value,
          MAX(CASE WHEN first_rank=1 THEN timestamp END) AS first_timestamp,
          MAX(CASE WHEN first_rank=1 THEN value END) AS first_value,
          MAX(CASE WHEN last_rank=1 THEN timestamp END) AS last_timestamp,
          MAX(CASE WHEN last_rank=1 THEN value END) AS last_value,
          CASE
            WHEN SUM(CASE WHEN quality='bad' THEN 1 ELSE 0 END)>0 THEN 'bad'
            WHEN SUM(CASE WHEN quality='uncertain' THEN 1 ELSE 0 END)>0 THEN 'uncertain'
            ELSE 'good'
          END AS quality
        FROM ranked GROUP BY bucket_start ORDER BY bucket_start DESC LIMIT ?
      ) ORDER BY bucket_start ASC
    `);
    const valueFor = (row: SqliteRow): number => {
      switch (query.aggregation) {
        case 'min': return Number(row.minimum_value);
        case 'max': return Number(row.maximum_value);
        case 'sum': return Number(row.sum_value);
        case 'count': return Number(row.point_count);
        default: return Number(row.average_value);
      }
    };
    return {
      assetExternalId,
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      bucketMs: query.bucketMs,
      aggregation: query.aggregation,
      series: seriesRows.map((seriesRow) => {
        const rows = aggregate.all(
          query.bucketMs,
          query.bucketMs,
          String(seriesRow.external_id),
          from,
          to,
          query.limit,
        ) as SqliteRow[];
        const buckets = rows.map((row) => ({
          timestamp: new Date(Number(row.bucket_start)).toISOString(),
          endTimestamp: new Date(Math.min(Number(row.bucket_start) + query.bucketMs, to)).toISOString(),
          value: valueFor(row),
          count: Number(row.point_count),
          min: Number(row.minimum_value),
          max: Number(row.maximum_value),
          avg: Number(row.average_value),
          sum: Number(row.sum_value),
          first: {
            timestamp: new Date(Number(row.first_timestamp)).toISOString(),
            value: Number(row.first_value),
          },
          last: {
            timestamp: new Date(Number(row.last_timestamp)).toISOString(),
            value: Number(row.last_value),
          },
          quality: String(row.quality),
        }));
        return {
          ...asTimeSeries(seriesRow),
          buckets,
          points: buckets,
        };
      }),
    };
  }

  listRelations(status: 'proposed' | 'accepted' | 'rejected' | 'superseded' | undefined, limit: number): Record<string, unknown> {
    const rows = status
      ? (this.database.prepare('SELECT * FROM relations WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit) as SqliteRow[])
      : (this.database.prepare('SELECT * FROM relations ORDER BY created_at DESC LIMIT ?').all(limit) as SqliteRow[]);
    return { items: rows.map(asRelation), total: rows.length, limit };
  }

  listAudit(query: AuditListQuery): Record<string, unknown> {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.action) {
      conditions.push('action = ?');
      parameters.push(query.action);
    }
    if (query.entityType) {
      conditions.push('entity_type = ?');
      parameters.push(query.entityType);
    }
    if (query.entityId) {
      conditions.push('entity_id = ?');
      parameters.push(query.entityId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = this.database.prepare(`SELECT COUNT(*) AS count FROM audit_log ${where}`).get(...parameters) as SqliteRow;
    const rows = this.database.prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`).all(...parameters, query.limit, query.offset) as SqliteRow[];
    return { items: rows.map(asAudit), total: Number(totalRow.count), limit: query.limit, offset: query.offset };
  }

  ingest(bundle: IngestBundle, correlationId: string): Record<string, unknown> {
    const runId = bundle.source.runId ?? randomUUID();
    const payloadHash = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
    const prior = this.database.prepare('SELECT * FROM ingestion_runs WHERE run_id = ?').get(runId) as SqliteRow | undefined;
    if (prior?.status === 'completed') {
      if (String(prior.payload_hash) !== payloadHash) {
        throw new ConflictError(`Ingestion run '${runId}' was already used with a different payload`);
      }
      return { runId, status: 'already_processed', counts: parseJson(prior.counts_json) };
    }

    const startedAt = nowIso();
    const counts = {
      assets: bundle.assets.length,
      timeSeries: bundle.timeSeries.length,
      dataPoints: bundle.dataPoints.length,
      documents: bundle.documents.length,
      relations: bundle.relations.length,
    };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO ingestion_runs(run_id, source_system, status, payload_hash, counts_json, error_message, started_at, completed_at)
        VALUES (?, ?, 'processing', ?, ?, NULL, ?, NULL)
        ON CONFLICT(run_id) DO UPDATE SET
          source_system = excluded.source_system,
          status = 'processing',
          payload_hash = excluded.payload_hash,
          counts_json = excluded.counts_json,
          error_message = NULL,
          started_at = excluded.started_at,
          completed_at = NULL
      `).run(runId, bundle.source.system, payloadHash, JSON.stringify(counts), startedAt);

      const upsertAsset = this.database.prepare(`
        INSERT INTO assets(external_id, name, description, type, parent_external_id, metadata_json, source_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
        ON CONFLICT(external_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          type = excluded.type,
          metadata_json = excluded.metadata_json,
          source_system = excluded.source_system,
          updated_at = excluded.updated_at
      `);
      for (const asset of bundle.assets) {
        upsertAsset.run(asset.externalId, asset.name, asset.description ?? null, asset.type, JSON.stringify(asset.metadata ?? {}), bundle.source.system, startedAt, startedAt);
        this.insertProvenance('asset', asset.externalId, bundle.source.system, runId, asset, startedAt);
      }
      const setAssetParent = this.database.prepare('UPDATE assets SET parent_external_id = ?, updated_at = ? WHERE external_id = ?');
      for (const asset of bundle.assets) {
        if (asset.parentExternalId !== undefined) {
          if (asset.parentExternalId !== null) this.assertEntityExists('asset', asset.parentExternalId);
          setAssetParent.run(asset.parentExternalId, startedAt, asset.externalId);
        }
      }
      this.assertNoAssetCycles();

      const upsertSeries = this.database.prepare(`
        INSERT INTO time_series(external_id, asset_external_id, name, unit, description, metadata_json, source_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_id) DO UPDATE SET
          asset_external_id = excluded.asset_external_id,
          name = excluded.name,
          unit = excluded.unit,
          description = excluded.description,
          metadata_json = excluded.metadata_json,
          source_system = excluded.source_system,
          updated_at = excluded.updated_at
      `);
      for (const series of bundle.timeSeries) {
        this.assertEntityExists('asset', series.assetExternalId);
        upsertSeries.run(series.externalId, series.assetExternalId, series.name, series.unit ?? null, series.description ?? null, JSON.stringify(series.metadata ?? {}), bundle.source.system, startedAt, startedAt);
        this.insertProvenance('timeSeries', series.externalId, bundle.source.system, runId, series, startedAt);
      }

      const upsertPoint = this.database.prepare(`
        INSERT INTO data_points(time_series_external_id, timestamp, value, quality, source_system, ingestion_run_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(time_series_external_id, timestamp) DO UPDATE SET
          value = excluded.value,
          quality = excluded.quality,
          source_system = excluded.source_system,
          ingestion_run_id = excluded.ingestion_run_id
      `);
      for (const point of bundle.dataPoints) {
        this.assertEntityExists('timeSeries', point.timeSeriesExternalId);
        upsertPoint.run(point.timeSeriesExternalId, point.timestamp, point.value, point.quality, bundle.source.system, runId);
      }

      const upsertDocument = this.database.prepare(`
        INSERT INTO documents(external_id, asset_external_id, title, mime_type, uri, metadata_json, source_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_id) DO UPDATE SET
          asset_external_id = excluded.asset_external_id,
          title = excluded.title,
          mime_type = excluded.mime_type,
          uri = excluded.uri,
          metadata_json = excluded.metadata_json,
          source_system = excluded.source_system,
          updated_at = excluded.updated_at
      `);
      for (const document of bundle.documents) {
        if (document.assetExternalId) this.assertEntityExists('asset', document.assetExternalId);
        upsertDocument.run(document.externalId, document.assetExternalId ?? null, document.title, document.mimeType ?? null, document.uri ?? null, JSON.stringify(document.metadata ?? {}), bundle.source.system, startedAt, startedAt);
        this.insertProvenance('document', document.externalId, bundle.source.system, runId, document, startedAt);
      }

      const upsertRelation = this.database.prepare(`
        INSERT INTO relations(id, source_type, source_external_id, target_type, target_external_id, relation_type, status, confidence, evidence_json, rule_version, source_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_external_id, target_type, target_external_id, relation_type) DO UPDATE SET
          confidence = excluded.confidence,
          evidence_json = excluded.evidence_json,
          rule_version = excluded.rule_version,
          source_system = excluded.source_system,
          updated_at = excluded.updated_at,
          status = CASE WHEN relations.status IN ('accepted', 'rejected') THEN relations.status ELSE excluded.status END
      `);
      for (const relation of bundle.relations) {
        this.assertEntityExists(relation.sourceType, relation.sourceExternalId);
        this.assertEntityExists(relation.targetType, relation.targetExternalId);
        const relationId = relation.id ?? randomUUID();
        upsertRelation.run(relationId, relation.sourceType, relation.sourceExternalId, relation.targetType, relation.targetExternalId, relation.relationType, relation.status, relation.confidence ?? null, JSON.stringify(relation.evidence), relation.ruleVersion ?? null, bundle.source.system, startedAt, startedAt);
        this.insertProvenance('relation', relationId, bundle.source.system, runId, relation, startedAt);
      }

      const completedAt = nowIso();
      this.database.prepare("UPDATE ingestion_runs SET status = 'completed', completed_at = ? WHERE run_id = ?").run(completedAt, runId);
      this.insertAudit(bundle.source.actor, 'ingestion.completed', 'ingestionRun', runId, { sourceSystem: bundle.source.system, counts, payloadHash }, correlationId, completedAt);
      this.database.exec('COMMIT');
      return { runId, status: 'completed', counts, completedAt };
    } catch (error) {
      this.database.exec('ROLLBACK');
      const message = error instanceof Error ? error.message : 'Unknown ingestion error';
      this.database.prepare(`
        INSERT INTO ingestion_runs(run_id, source_system, status, payload_hash, counts_json, error_message, started_at, completed_at)
        VALUES (?, ?, 'failed', ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET status = 'failed', error_message = excluded.error_message, completed_at = excluded.completed_at
      `).run(runId, bundle.source.system, payloadHash, JSON.stringify(counts), message, startedAt, nowIso());
      this.insertAudit(bundle.source.actor, 'ingestion.failed', 'ingestionRun', runId, { sourceSystem: bundle.source.system, error: message }, correlationId);
      throw error;
    }
  }

  reviewRelation(id: string, review: RelationReview, correlationId: string): Record<string, unknown> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM relations WHERE id = ?').get(id) as SqliteRow | undefined;
      if (!current) throw new NotFoundError(`Relation '${id}' was not found`);
      if (current.status !== 'proposed') {
        throw new ConflictError(`Relation '${id}' has already been ${String(current.status)}`);
      }
      const reviewedAt = nowIso();
      this.database.prepare(`
        UPDATE relations
        SET status = ?, reviewer = ?, review_comment = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(review.decision, review.reviewer, review.comment ?? null, reviewedAt, reviewedAt, id);
      this.insertAudit(review.reviewer, `relation.${review.decision}`, 'relation', id, {
        previousStatus: 'proposed',
        decision: review.decision,
        comment: review.comment ?? null,
      }, correlationId, reviewedAt);
      const updated = this.database.prepare('SELECT * FROM relations WHERE id = ?').get(id) as SqliteRow;
      this.database.exec('COMMIT');
      return asRelation(updated);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private assertEntityExists(type: 'asset' | 'timeSeries' | 'document', externalId: string): void {
    const table = type === 'asset' ? 'assets' : type === 'timeSeries' ? 'time_series' : 'documents';
    const row = this.database.prepare(`SELECT 1 AS found FROM ${table} WHERE external_id = ?`).get(externalId);
    if (!row) throw new DataIntegrityError(`${type} '${externalId}' referenced by a relation does not exist`);
  }

  private assertNoAssetCycles(): void {
    const cycle = this.database.prepare(`
      WITH RECURSIVE walk(root, node, parent, path, cycle) AS (
        SELECT external_id, external_id, parent_external_id, ',' || external_id || ',', 0 FROM assets
        UNION ALL
        SELECT walk.root, asset.external_id, asset.parent_external_id,
               walk.path || asset.external_id || ',',
               instr(walk.path, ',' || asset.external_id || ',') > 0
        FROM walk
        JOIN assets AS asset ON asset.external_id = walk.parent
        WHERE walk.parent IS NOT NULL AND walk.cycle = 0
      )
      SELECT root FROM walk WHERE cycle = 1 LIMIT 1
    `).get() as SqliteRow | undefined;
    if (cycle) throw new DataIntegrityError(`Asset hierarchy contains a cycle involving '${String(cycle.root)}'`);
  }

  private insertProvenance(entityType: string, entityId: string, sourceSystem: string, runId: string, sourceRecord: unknown, timestamp: string): void {
    const rawHash = createHash('sha256').update(JSON.stringify(sourceRecord)).digest('hex');
    this.database.prepare(`
      INSERT INTO provenance(entity_type, entity_id, source_system, source_record_id, ingestion_run_id, raw_hash, model_version, valid_from, transaction_time, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, 'odf-core/0.1', ?, ?, '{}')
    `).run(entityType, entityId, sourceSystem, entityId, runId, rawHash, timestamp, timestamp);
  }

  private requireWorkspaceOwner(id: string, actor: string): WorkspaceMember {
    const member = this.getWorkspaceMember(id, actor);
    if (member.role !== 'owner') {
      throw new ForbiddenError(`Only owners can manage members of workspace '${id}'`);
    }
    return member;
  }

  private workspaceOwnerCount(id: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ? AND role = 'owner'
    `).get(id) as SqliteRow;
    return Number(row.count);
  }

  private insertAudit(actor: string, action: string, entityType: string, entityId: string | null, details: unknown, correlationId: string, timestamp = nowIso()): void {
    this.database.prepare(`
      INSERT INTO audit_log(timestamp, actor, action, entity_type, entity_id, details_json, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(timestamp, actor, action, entityType, entityId, JSON.stringify(details), correlationId);
  }
}
