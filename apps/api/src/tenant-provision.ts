import type { RuntimeClient, RuntimePool } from '@open-data-fusion/postgres-runtime';

const POSTGRES_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_NAME_LENGTH = 256;
const MAX_USER_IDENTIFIER_LENGTH = 512;

export const REQUIRED_TENANT_PROVISION_MIGRATIONS = [
  '003_tenant_industrial_data_plane',
  '005_tenant_membership_and_workspace_scope',
  '006_workspace_application_role_grants',
  '007_tenant_project_provisioning_role',
] as const;

export interface TenantProjectProvisionInput {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  ownerUserId: string;
  modelSpaceId: string;
  modelSpaceSlug: string;
  modelSpaceName: string;
  provisionedBy: string;
}

export interface TenantProjectProvisionOptions {
  /** Dry-run is the default; callers must explicitly opt in to a commit. */
  apply?: boolean;
}

export interface TenantProjectProvisionReport {
  mode: 'applied' | 'dry-run';
  tenant: {
    id: string;
    slug: string;
    created: boolean;
  };
  project: {
    id: string;
    slug: string;
    created: boolean;
  };
  memberships: {
    tenantOwnerCreated: boolean;
    projectOwnerCreated: boolean;
    ownerUserId: string;
  };
  modelSpace: {
    id: string;
    slug: string;
    created: boolean;
  };
  /** An append-only audit record is written only for committed changes. */
  auditRecorded: boolean;
}

export class TenantProvisionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantProvisionInputError';
  }
}

interface NormalizedTenantProjectProvisionInput extends TenantProjectProvisionInput {}

interface ProvisionFunctionRow extends Record<string, unknown> {
  tenant_created: unknown;
  project_created: unknown;
  tenant_owner_created: unknown;
  project_owner_created: unknown;
  model_space_created: unknown;
  audit_recorded: unknown;
}

type SqlRow = Record<string, unknown>;

const provisionFunctionSignature = [
  'odf.provision_tenant_project(',
  'uuid,text,text,uuid,text,text,text,uuid,text,text,text',
  ')',
].join('');

function normalizedUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !POSTGRES_UUID_PATTERN.test(value)) {
    throw new TenantProvisionInputError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function normalizedSlug(value: string, field: string): string {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
    throw new TenantProvisionInputError(`${field} must be a lowercase slug`);
  }
  return value;
}

function normalizedText(value: string, field: string, maximumLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || value !== value.trim()
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TenantProvisionInputError(`${field} must be a non-empty, trimmed text value no longer than ${String(maximumLength)} characters`);
  }
  return value;
}

function normalizedInput(input: TenantProjectProvisionInput): NormalizedTenantProjectProvisionInput {
  return {
    tenantId: normalizedUuid(input.tenantId, 'tenantId'),
    tenantSlug: normalizedSlug(input.tenantSlug, 'tenantSlug'),
    tenantName: normalizedText(input.tenantName, 'tenantName', MAX_NAME_LENGTH),
    projectId: normalizedUuid(input.projectId, 'projectId'),
    projectSlug: normalizedSlug(input.projectSlug, 'projectSlug'),
    projectName: normalizedText(input.projectName, 'projectName', MAX_NAME_LENGTH),
    ownerUserId: normalizedText(input.ownerUserId, 'ownerUserId', MAX_USER_IDENTIFIER_LENGTH),
    modelSpaceId: normalizedUuid(input.modelSpaceId, 'modelSpaceId'),
    modelSpaceSlug: normalizedSlug(input.modelSpaceSlug, 'modelSpaceSlug'),
    modelSpaceName: normalizedText(input.modelSpaceName, 'modelSpaceName', MAX_NAME_LENGTH),
    provisionedBy: normalizedText(input.provisionedBy, 'provisionedBy', MAX_USER_IDENTIFIER_LENGTH),
  };
}

function stringValue(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function hasBooleanValue(row: SqlRow, column: string): boolean {
  return row[column] === true;
}

function requiredBooleanValue(row: ProvisionFunctionRow, column: keyof ProvisionFunctionRow): boolean {
  const value = row[column];
  if (typeof value !== 'boolean') {
    throw new Error(`PostgreSQL tenant provisioning function returned an invalid ${column} value`);
  }
  return value;
}

async function verifyTenantProvisioningPrincipal(client: RuntimeClient): Promise<void> {
  const result = await client.query({
    text: [
      'SELECT',
      '  current_user AS role_name,',
      '  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,',
      '  (SELECT rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls',
      '   FROM pg_roles WHERE rolname = current_user) AS has_elevated_role_attributes,',
      "  pg_has_role(current_user, 'odf_tenant_provisioner', 'USAGE') AS has_tenant_provisioner_role,",
      "  has_schema_privilege(current_user, 'odf', 'USAGE') AS can_use_odf_schema,",
      "  has_schema_privilege(current_user, 'odf', 'CREATE') AS can_create_in_odf_schema,",
      "  has_table_privilege(current_user, 'odf.schema_migrations', 'SELECT') AS can_read_schema_migrations,",
      `  has_function_privilege(current_user, '${provisionFunctionSignature}'::regprocedure, 'EXECUTE') AS can_execute_bootstrap_function,`,
      '  EXISTS (',
      '    SELECT 1',
      '    FROM pg_catalog.pg_class AS candidate',
      '    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = candidate.relnamespace',
      "    WHERE namespace.nspname = 'odf'",
      "      AND candidate.relkind IN ('r', 'p', 'v', 'm', 'f')",
      "      AND candidate.relname <> 'schema_migrations'",
      "      AND has_table_privilege(current_user, candidate.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')",
      '  ) AS has_forbidden_odf_relation_privileges,',
      '  EXISTS (',
      '    SELECT 1',
      '    FROM pg_catalog.pg_class AS candidate',
      '    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = candidate.relnamespace',
      "    WHERE namespace.nspname = 'odf'",
      "      AND candidate.relkind = 'S'",
      "      AND has_sequence_privilege(current_user, candidate.oid, 'USAGE, SELECT, UPDATE')",
      '  ) AS has_forbidden_odf_sequence_privileges,',
      '  EXISTS (',
      '    SELECT 1',
      '    FROM pg_catalog.pg_proc AS candidate',
      '    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = candidate.pronamespace',
      "    WHERE namespace.nspname = 'odf'",
      `      AND candidate.oid <> '${provisionFunctionSignature}'::regprocedure`,
      "      AND has_function_privilege(current_user, candidate.oid, 'EXECUTE')",
      '  ) AS has_other_odf_function_privileges',
    ].join('\n'),
  });
  const row = result.rows[0] as SqlRow | undefined;
  if (!row) throw new Error('PostgreSQL did not return tenant provisioning principal privileges');

  const roleName = stringValue(row, 'role_name') ?? 'unknown';
  if (hasBooleanValue(row, 'is_superuser')) {
    throw new Error(`PostgreSQL tenant provisioning principal '${roleName}' must not be a superuser`);
  }
  if (!hasBooleanValue(row, 'has_tenant_provisioner_role')) {
    throw new Error(`PostgreSQL tenant provisioning principal '${roleName}' must inherit the odf_tenant_provisioner role`);
  }
  if (
    hasBooleanValue(row, 'has_elevated_role_attributes')
    || hasBooleanValue(row, 'can_create_in_odf_schema')
    || hasBooleanValue(row, 'has_forbidden_odf_relation_privileges')
    || hasBooleanValue(row, 'has_forbidden_odf_sequence_privileges')
    || hasBooleanValue(row, 'has_other_odf_function_privileges')
  ) {
    throw new Error(`PostgreSQL tenant provisioning principal '${roleName}' has privileges outside odf_tenant_provisioner`);
  }

  const requiredPrivileges = [
    ['odf schema usage', hasBooleanValue(row, 'can_use_odf_schema')],
    ['schema migration read', hasBooleanValue(row, 'can_read_schema_migrations')],
    ['tenant/project bootstrap function execute', hasBooleanValue(row, 'can_execute_bootstrap_function')],
  ] as const;
  const missing = requiredPrivileges.filter(([, granted]) => !granted).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`PostgreSQL tenant provisioning principal '${roleName}' is missing privileges: ${missing.join(', ')}`);
  }
}

async function verifyRequiredMigrations(client: RuntimeClient): Promise<void> {
  const result = await client.query<{ version: unknown }>({
    text: 'SELECT version FROM odf.schema_migrations WHERE version = ANY($1::text[]) ORDER BY version',
    values: [[...REQUIRED_TENANT_PROVISION_MIGRATIONS]],
  });
  const applied = new Set(result.rows.map((row) => String(row.version)));
  const missing = REQUIRED_TENANT_PROVISION_MIGRATIONS.filter((version) => !applied.has(version));
  if (missing.length > 0) {
    throw new Error(`PostgreSQL tenant provisioning target is missing migrations: ${missing.join(', ')}`);
  }
}

async function callProvisionFunction(
  client: RuntimeClient,
  input: NormalizedTenantProjectProvisionInput,
): Promise<{
  tenantCreated: boolean;
  projectCreated: boolean;
  tenantOwnerCreated: boolean;
  projectOwnerCreated: boolean;
  modelSpaceCreated: boolean;
  auditRecorded: boolean;
}> {
  const result = await client.query<ProvisionFunctionRow>({
    text: [
      'SELECT tenant_created, project_created, tenant_owner_created,',
      '  project_owner_created, model_space_created, audit_recorded',
      'FROM odf.provision_tenant_project(',
      '  $1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8::uuid, $9, $10, $11',
      ')',
    ].join('\n'),
    values: [
      input.tenantId,
      input.tenantSlug,
      input.tenantName,
      input.projectId,
      input.projectSlug,
      input.projectName,
      input.ownerUserId,
      input.modelSpaceId,
      input.modelSpaceSlug,
      input.modelSpaceName,
      input.provisionedBy,
    ],
  });
  if (result.rows.length !== 1) {
    throw new Error('PostgreSQL tenant provisioning function must return exactly one result row');
  }

  const row = result.rows[0];
  if (!row) {
    throw new Error('PostgreSQL tenant provisioning function did not return a result row');
  }
  const response = {
    tenantCreated: requiredBooleanValue(row, 'tenant_created'),
    projectCreated: requiredBooleanValue(row, 'project_created'),
    tenantOwnerCreated: requiredBooleanValue(row, 'tenant_owner_created'),
    projectOwnerCreated: requiredBooleanValue(row, 'project_owner_created'),
    modelSpaceCreated: requiredBooleanValue(row, 'model_space_created'),
    auditRecorded: requiredBooleanValue(row, 'audit_recorded'),
  };
  const creationFlags = [
    response.tenantCreated,
    response.projectCreated,
    response.tenantOwnerCreated,
    response.projectOwnerCreated,
    response.modelSpaceCreated,
  ];
  const allCreated = creationFlags.every(Boolean);
  const allUnchanged = creationFlags.every((value) => !value);
  if (!allCreated && !allUnchanged) {
    throw new Error('PostgreSQL tenant provisioning function returned a partial bootstrap result');
  }
  if (response.auditRecorded !== allCreated) {
    throw new Error('PostgreSQL tenant provisioning function returned an inconsistent audit result');
  }
  return response;
}

/**
 * Rehearses or applies the database-owned tenant/project bootstrap function.
 *
 * The caller has no direct tenant/project/membership/audit privileges. The
 * SECURITY DEFINER routine performs one all-new bootstrap or returns an exact
 * completed bootstrap as a no-op; partial targets are rejected inside the
 * same serializable transaction.
 */
export async function provisionTenantProject(
  pool: RuntimePool,
  rawInput: TenantProjectProvisionInput,
  options: TenantProjectProvisionOptions = {},
): Promise<TenantProjectProvisionReport> {
  const input = normalizedInput(rawInput);
  const client = await pool.connect();
  let began = false;
  let transactionClosed = false;
  let discardClient = false;

  try {
    await client.query({ text: 'BEGIN ISOLATION LEVEL SERIALIZABLE' });
    began = true;
    await client.query({ text: "SELECT set_config('lock_timeout', $1, true)", values: ['10s'] });
    await client.query({ text: "SELECT set_config('statement_timeout', $1, true)", values: ['60s'] });
    await client.query({ text: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", values: ['90s'] });

    await verifyTenantProvisioningPrincipal(client);
    await verifyRequiredMigrations(client);
    const changes = await callProvisionFunction(client, input);

    if (options.apply === true) {
      await client.query({ text: 'COMMIT' });
    } else {
      await client.query({ text: 'ROLLBACK' });
    }
    transactionClosed = true;

    return {
      mode: options.apply === true ? 'applied' : 'dry-run',
      tenant: { id: input.tenantId, slug: input.tenantSlug, created: changes.tenantCreated },
      project: { id: input.projectId, slug: input.projectSlug, created: changes.projectCreated },
      memberships: {
        tenantOwnerCreated: changes.tenantOwnerCreated,
        projectOwnerCreated: changes.projectOwnerCreated,
        ownerUserId: input.ownerUserId,
      },
      modelSpace: { id: input.modelSpaceId, slug: input.modelSpaceSlug, created: changes.modelSpaceCreated },
      auditRecorded: options.apply === true && changes.auditRecorded,
    };
  } catch (error) {
    if (began && !transactionClosed) {
      try {
        await client.query({ text: 'ROLLBACK' });
      } catch {
        discardClient = true;
      }
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
