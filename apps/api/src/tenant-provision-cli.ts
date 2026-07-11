import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createPostgresPool,
  type RuntimePool,
} from '@open-data-fusion/postgres-runtime';

import {
  provisionTenantProject,
  type TenantProjectProvisionInput,
  type TenantProjectProvisionReport,
} from './tenant-provision.js';

const usage = [
  'Usage: tenant-provision',
  '--tenant-id <uuid> --tenant-slug <slug> --tenant-name <name>',
  '--project-id <uuid> --project-slug <slug> --project-name <name>',
  '--owner-user-id <user> --model-space-id <uuid> --model-space-slug <slug> --model-space-name <name>',
  '--provisioned-by <user> [--apply]',
].join(' ');

const argumentFields = {
  '--tenant-id': 'tenantId',
  '--tenant-slug': 'tenantSlug',
  '--tenant-name': 'tenantName',
  '--project-id': 'projectId',
  '--project-slug': 'projectSlug',
  '--project-name': 'projectName',
  '--owner-user-id': 'ownerUserId',
  '--model-space-id': 'modelSpaceId',
  '--model-space-slug': 'modelSpaceSlug',
  '--model-space-name': 'modelSpaceName',
  '--provisioned-by': 'provisionedBy',
} as const;

type ArgumentFlag = keyof typeof argumentFields;
type ArgumentField = (typeof argumentFields)[ArgumentFlag];

export interface TenantProvisionArguments {
  input: TenantProjectProvisionInput;
  apply: boolean;
}

export type TenantProvisionPoolFactory = (connectionString: string) => RuntimePool;

function isArgumentFlag(value: string): value is ArgumentFlag {
  return Object.hasOwn(argumentFields, value);
}

export function parseTenantProvisionArguments(args: readonly string[]): TenantProvisionArguments {
  const fields: Partial<Record<ArgumentField, string>> = {};
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      if (apply) throw new Error(usage);
      apply = true;
      continue;
    }
    if (!argument || !isArgumentFlag(argument)) throw new Error(usage);

    const value = args[index + 1];
    const field = argumentFields[argument];
    if (!value || value.startsWith('--') || fields[field] !== undefined) throw new Error(usage);
    fields[field] = value;
    index += 1;
  }

  const required = Object.values(argumentFields) as ArgumentField[];
  if (required.some((field) => fields[field] === undefined)) throw new Error(usage);

  return {
    input: {
      tenantId: fields.tenantId!,
      tenantSlug: fields.tenantSlug!,
      tenantName: fields.tenantName!,
      projectId: fields.projectId!,
      projectSlug: fields.projectSlug!,
      projectName: fields.projectName!,
      ownerUserId: fields.ownerUserId!,
      modelSpaceId: fields.modelSpaceId!,
      modelSpaceSlug: fields.modelSpaceSlug!,
      modelSpaceName: fields.modelSpaceName!,
      provisionedBy: fields.provisionedBy!,
    },
    apply,
  };
}

function defaultPoolFactory(connectionString: string): RuntimePool {
  return createPostgresPool({
    connectionString,
    applicationName: 'open-data-fusion-tenant-provisioning',
    max: 1,
    statementTimeoutMillis: 60_000,
    lockTimeoutMillis: 10_000,
    idleInTransactionTimeoutMillis: 90_000,
  }).pool;
}

export async function runTenantProvisionCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  poolFactory: TenantProvisionPoolFactory = defaultPoolFactory,
): Promise<TenantProjectProvisionReport> {
  const parsed = parseTenantProvisionArguments(args);
  const connectionString = environment.ODF_TENANT_PROVISION_POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error('ODF_TENANT_PROVISION_POSTGRES_URL is required for tenant/project provisioning');
  }

  const pool = poolFactory(connectionString);
  try {
    return await provisionTenantProject(pool, parsed.input, { apply: parsed.apply });
  } finally {
    await pool.end();
  }
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
}

if (isMainModule()) {
  try {
    const report = await runTenantProvisionCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
