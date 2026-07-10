import type { Request } from 'express';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';

export interface AuthenticatedIdentity {
  userId: string;
  displayName?: string;
  claims?: JWTPayload;
  permissions: ReadonlySet<DataPlanePermission>;
}

export const DATA_PLANE_PERMISSIONS = [
  'data:read',
  'data:ingest',
  'relations:review',
  'audit:read',
  'platform:admin',
  'writeback:request',
  'writeback:approve',
  'writeback:execute',
] as const;

export type DataPlanePermission = (typeof DATA_PLANE_PERMISSIONS)[number];

const allDataPlanePermissions: ReadonlySet<DataPlanePermission> = new Set(DATA_PLANE_PERMISSIONS);

export interface AuthenticationContext {
  /**
   * EventSource cannot attach an Authorization header. This hint exists only
   * for the explicit development identity provider and is ignored by OIDC.
   */
  developmentUserHint?: unknown;
}

export interface IdentityProvider {
  readonly mode: 'development' | 'oidc';
  authenticate(request: Request, context?: AuthenticationContext): Promise<AuthenticatedIdentity>;
}

export class AuthenticationError extends Error {}

function normalizedUserId(value: unknown): string {
  if (typeof value !== 'string') throw new AuthenticationError('The authenticated token has no usable user identity');
  const userId = value.trim();
  if (userId.length === 0 || userId.length > 255) {
    throw new AuthenticationError('The authenticated token has no usable user identity');
  }
  return userId;
}

function optionalClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export class DevelopmentIdentityProvider implements IdentityProvider {
  readonly mode = 'development' as const;

  constructor(private readonly defaultUser = 'harper.dennis') {}

  async authenticate(request: Request, context?: AuthenticationContext): Promise<AuthenticatedIdentity> {
    const hintedUser = context?.developmentUserHint;
    const userId = normalizedUserId(hintedUser ?? request.header('x-odf-user') ?? this.defaultUser);
    return { userId, displayName: userId, permissions: allDataPlanePermissions };
  }
}

export interface OidcIdentityProviderConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
  userClaim?: string;
  permissionClaim?: string;
  algorithms?: string[];
}

function addPermissionValues(target: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    for (const item of value.split(/\s+/u)) {
      if (item) target.add(item);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) target.add(item.trim());
    }
  }
}

function oidcPermissions(payload: JWTPayload, audience: string, permissionClaim: string): ReadonlySet<DataPlanePermission> {
  const granted = new Set<string>();
  addPermissionValues(granted, payload.scope);
  addPermissionValues(granted, payload.scp);
  addPermissionValues(granted, payload[permissionClaim]);

  const realmAccess = payload.realm_access;
  if (realmAccess && typeof realmAccess === 'object' && 'roles' in realmAccess) {
    addPermissionValues(granted, realmAccess.roles);
  }
  const resourceAccess = payload.resource_access;
  if (resourceAccess && typeof resourceAccess === 'object') {
    const audienceAccess = (resourceAccess as Record<string, unknown>)[audience];
    if (audienceAccess && typeof audienceAccess === 'object' && 'roles' in audienceAccess) {
      addPermissionValues(granted, audienceAccess.roles);
    }
  }

  return new Set(DATA_PLANE_PERMISSIONS.filter((permission) => granted.has(permission)));
}

export class OidcIdentityProvider implements IdentityProvider {
  readonly mode = 'oidc' as const;
  private readonly keySet: JWTVerifyGetKey;
  private readonly userClaim: string;
  private readonly permissionClaim: string;
  private readonly algorithms: string[];

  constructor(
    private readonly config: OidcIdentityProviderConfig,
    keySet?: JWTVerifyGetKey,
  ) {
    this.keySet = keySet ?? createRemoteJWKSet(new URL(config.jwksUri));
    this.userClaim = config.userClaim?.trim() || 'sub';
    this.permissionClaim = config.permissionClaim?.trim() || 'permissions';
    this.algorithms = config.algorithms?.length ? [...config.algorithms] : ['RS256'];
  }

  async authenticate(request: Request): Promise<AuthenticatedIdentity> {
    const authorization = request.header('authorization');
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) throw new AuthenticationError('A valid bearer access token is required');

    try {
      const { payload } = await jwtVerify(match[1], this.keySet, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.algorithms,
      });
      const userId = normalizedUserId(payload[this.userClaim]);
      const displayName =
        optionalClaim(payload, 'name') ??
        optionalClaim(payload, 'preferred_username') ??
        optionalClaim(payload, 'email') ??
        userId;
      return {
        userId,
        displayName,
        claims: payload,
        permissions: oidcPermissions(payload, this.config.audience, this.permissionClaim),
      };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError('A valid bearer access token is required');
    }
  }
}

export type IdentityEnvironment = Record<string, string | undefined>;

function requiredEnvironmentValue(environment: IdentityEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when ODF_AUTH_MODE=oidc`);
  return value;
}

export function createIdentityProviderFromEnvironment(
  environment: IdentityEnvironment = process.env,
): IdentityProvider {
  const defaultMode = environment.NODE_ENV === 'production' ? 'oidc' : 'development';
  const mode = (environment.ODF_AUTH_MODE ?? defaultMode).trim().toLowerCase();

  if (mode === 'development') {
    return new DevelopmentIdentityProvider(environment.ODF_DEV_USER?.trim() || 'harper.dennis');
  }
  if (mode !== 'oidc') {
    throw new Error(`Unsupported ODF_AUTH_MODE '${mode}'`);
  }

  const algorithms = (environment.ODF_OIDC_ALGORITHMS ?? 'RS256')
    .split(',')
    .map((algorithm) => algorithm.trim())
    .filter(Boolean);
  if (algorithms.length === 0) throw new Error('ODF_OIDC_ALGORITHMS must contain at least one algorithm');

  return new OidcIdentityProvider({
    issuer: requiredEnvironmentValue(environment, 'ODF_OIDC_ISSUER'),
    audience: requiredEnvironmentValue(environment, 'ODF_OIDC_AUDIENCE'),
    jwksUri: requiredEnvironmentValue(environment, 'ODF_OIDC_JWKS_URI'),
    userClaim: environment.ODF_OIDC_USER_CLAIM?.trim() || 'sub',
    permissionClaim: environment.ODF_OIDC_PERMISSION_CLAIM?.trim() || 'permissions',
    algorithms,
  });
}
