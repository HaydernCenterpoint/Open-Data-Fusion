import type { User, UserManager, UserManagerSettings } from "oidc-client-ts";

export interface SessionIdentity {
  userId: string;
  displayName: string;
  email?: string;
}

export interface BrowserAuthSession {
  enabled: boolean;
  authenticated: boolean;
  identity: SessionIdentity | null;
  expiresAt?: number;
}

export class OidcConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigurationError";
  }
}

export class OidcSessionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OidcSessionError";
  }
}

interface EnabledConfiguration {
  enabled: true;
  authority: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scope: string;
  userClaim: string;
}

interface DisabledConfiguration {
  enabled: false;
}

type BrowserAuthConfiguration = EnabledConfiguration | DisabledConfiguration;

const DISABLED_SESSION: BrowserAuthSession = {
  enabled: false,
  authenticated: false,
  identity: null,
};

const CALLBACK_PARAMETERS = [
  "code",
  "state",
  "session_state",
  "iss",
  "scope",
  "error",
  "error_description",
  "error_uri",
] as const;

let configuration: BrowserAuthConfiguration | undefined;
let managerPromise: Promise<UserManager> | null = null;
let initializationPromise: Promise<BrowserAuthSession> | null = null;
let signInPromise: Promise<void> | null = null;
let signOutPromise: Promise<void> | null = null;
let currentUser: User | null = null;

function environmentValue(name: string): string {
  const environment = import.meta.env as unknown as Record<string, unknown>;
  const value = environment[name];
  return typeof value === "string" ? value.trim() : "";
}

function browserWindow(): Window {
  if (typeof window === "undefined") {
    throw new OidcConfigurationError("OIDC browser authentication requires a browser window");
  }
  return window;
}

function validatedAuthority(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported protocol");
    const localHostname = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !localHostname) throw new Error("Plain HTTP is allowed only for a local identity provider");
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    throw new OidcConfigurationError(`VITE_OIDC_AUTHORITY must be an absolute HTTP(S) URL: ${String(error)}`);
  }
}

function localApplicationUrl(value: string, fallbackPath: string, label: string): string {
  const currentWindow = browserWindow();
  try {
    const url = new URL(value || fallbackPath, currentWindow.location.origin);
    if (url.origin !== currentWindow.location.origin) {
      throw new Error("URL must use the application origin");
    }
    return url.toString();
  } catch (error) {
    throw new OidcConfigurationError(`${label} must resolve to this application's origin: ${String(error)}`);
  }
}

function readConfiguration(): BrowserAuthConfiguration {
  const authority = environmentValue("VITE_OIDC_AUTHORITY");
  const clientId = environmentValue("VITE_OIDC_CLIENT_ID");
  if (!authority && !clientId) return { enabled: false };
  if (!authority || !clientId) {
    throw new OidcConfigurationError(
      "OIDC authentication requires both VITE_OIDC_AUTHORITY and VITE_OIDC_CLIENT_ID",
    );
  }

  const scope = environmentValue("VITE_OIDC_SCOPE") || "openid profile email";
  if (!scope.split(/\s+/u).includes("openid")) {
    throw new OidcConfigurationError("VITE_OIDC_SCOPE must include the openid scope");
  }
  const userClaim = environmentValue("VITE_OIDC_USER_CLAIM") || "sub";
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(userClaim)) {
    throw new OidcConfigurationError("VITE_OIDC_USER_CLAIM is not a valid claim name");
  }

  return {
    enabled: true,
    authority: validatedAuthority(authority),
    clientId,
    redirectUri: localApplicationUrl(
      environmentValue("VITE_OIDC_REDIRECT_URI"),
      "/",
      "VITE_OIDC_REDIRECT_URI",
    ),
    postLogoutRedirectUri: localApplicationUrl(
      environmentValue("VITE_OIDC_POST_LOGOUT_REDIRECT_URI"),
      "/",
      "VITE_OIDC_POST_LOGOUT_REDIRECT_URI",
    ),
    scope,
    userClaim,
  };
}

function getConfiguration(): BrowserAuthConfiguration {
  configuration ??= readConfiguration();
  return configuration;
}

async function createManager(config: EnabledConfiguration): Promise<UserManager> {
  const currentWindow = browserWindow();
  let storage: Storage;
  try {
    storage = currentWindow.sessionStorage;
    const probe = "odf.oidc.storage.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
  } catch (error) {
    throw new OidcConfigurationError("OIDC authentication requires accessible sessionStorage");
  }

  const { UserManager: OidcUserManager, WebStorageStateStore } = await import("oidc-client-ts");
  const settings: UserManagerSettings = {
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    response_type: "code",
    response_mode: "query",
    scope: config.scope,
    disablePKCE: false,
    automaticSilentRenew: true,
    monitorSession: false,
    revokeTokensOnSignout: true,
    userStore: new WebStorageStateStore({ prefix: "odf.oidc.user:", store: storage }),
    stateStore: new WebStorageStateStore({ prefix: "odf.oidc.state:", store: storage }),
  };
  const manager = new OidcUserManager(settings);
  manager.events.addUserLoaded((user) => { currentUser = user; });
  manager.events.addUserUnloaded(() => { currentUser = null; });
  manager.events.addUserSignedOut(() => { currentUser = null; });
  return manager;
}

function getManager(config: EnabledConfiguration): Promise<UserManager> {
  managerPromise ??= createManager(config);
  return managerPromise;
}

function stringClaim(user: User, claim: string): string | undefined {
  const profile = user.profile as unknown as Record<string, unknown>;
  const value = profile[claim];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function identityFromUser(user: User, userClaim: string): SessionIdentity {
  const subject = stringClaim(user, "sub");
  const email = stringClaim(user, "email");
  const preferredUsername = stringClaim(user, "preferred_username");
  const userId = stringClaim(user, userClaim) ?? subject;
  if (!userId) throw new OidcSessionError("The OIDC session has no usable user identity");

  const identity: SessionIdentity = {
    userId,
    displayName: stringClaim(user, "name") ?? preferredUsername ?? email ?? subject ?? userId,
  };
  if (email) identity.email = email;
  return identity;
}

function activeUser(user: User | null): user is User {
  return user !== null && user.expired !== true && user.access_token.trim().length > 0;
}

function sessionFromUser(user: User | null, userClaim: string): BrowserAuthSession {
  if (!activeUser(user)) return { enabled: true, authenticated: false, identity: null };
  const session: BrowserAuthSession = {
    enabled: true,
    authenticated: true,
    identity: identityFromUser(user, userClaim),
  };
  if (typeof user.expires_at === "number" && Number.isFinite(user.expires_at)) session.expiresAt = user.expires_at;
  return session;
}

function currentRoute(): string {
  const { pathname, search, hash } = browserWindow().location;
  return `${pathname}${search}${hash}`;
}

function safeReturnRoute(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>).returnUrl;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const currentWindow = browserWindow();
    const url = new URL(value, currentWindow.location.origin);
    if (url.origin !== currentWindow.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function cleanCallbackUrl(state: unknown): void {
  const currentWindow = browserWindow();
  const url = new URL(currentWindow.location.href);
  for (const parameter of CALLBACK_PARAMETERS) url.searchParams.delete(parameter);
  const search = url.searchParams.toString();
  const cleanedCurrentRoute = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
  currentWindow.history.replaceState(
    currentWindow.history.state,
    "",
    safeReturnRoute(state) ?? cleanedCurrentRoute,
  );
}

function hasSigninCallback(url: URL): boolean {
  const hasCode = url.searchParams.has("code");
  const hasState = url.searchParams.has("state");
  const hasError = url.searchParams.has("error");
  if ((hasCode || hasError) && !hasState) {
    cleanCallbackUrl(null);
    throw new OidcSessionError("OIDC callback is missing its state parameter");
  }
  return hasState && (hasCode || hasError);
}

function hasSignoutCallback(url: URL): boolean {
  return url.searchParams.has("state") && !url.searchParams.has("code") && !url.searchParams.has("error");
}

async function processSigninCallback(manager: UserManager, url: string): Promise<User> {
  let user: User | null = null;
  try {
    user = await manager.signinRedirectCallback(url);
    return user;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OidcSessionError(`OIDC sign-in callback failed: ${detail}`, error);
  } finally {
    cleanCallbackUrl(user?.state);
  }
}

async function processSignoutCallback(manager: UserManager, url: string): Promise<void> {
  let returnState: unknown = null;
  try {
    const response = await manager.signoutRedirectCallback(url);
    returnState = response.userState;
    currentUser = null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OidcSessionError(`OIDC sign-out callback failed: ${detail}`, error);
  } finally {
    cleanCallbackUrl(returnState);
  }
}

async function initializeOnce(): Promise<BrowserAuthSession> {
  const config = getConfiguration();
  if (!config.enabled) return DISABLED_SESSION;

  try {
    const manager = await getManager(config);
    const callbackUrl = new URL(browserWindow().location.href);
    if (hasSigninCallback(callbackUrl)) {
      currentUser = await processSigninCallback(manager, callbackUrl.toString());
    } else if (hasSignoutCallback(callbackUrl)) {
      await processSignoutCallback(manager, callbackUrl.toString());
    } else {
      const storedUser = await manager.getUser();
      if (storedUser?.expired === true && storedUser.refresh_token) {
        try {
          currentUser = await manager.signinSilent();
        } catch {
          currentUser = null;
        }
      } else {
        currentUser = storedUser;
      }
    }
    return sessionFromUser(currentUser, config.userClaim);
  } catch (error) {
    if (error instanceof OidcConfigurationError || error instanceof OidcSessionError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new OidcSessionError(`OIDC session initialization failed: ${detail}`, error);
  }
}

/** Safe to call from repeated React StrictMode effects; initialization is shared. */
export function initialize(): Promise<BrowserAuthSession> {
  initializationPromise ??= initializeOnce();
  return initializationPromise;
}

export async function getAccessToken(): Promise<string | null> {
  const session = await initialize();
  if (!session.enabled || !activeUser(currentUser)) return null;
  return currentUser.access_token;
}

export async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const session = await initialize();
  return session.authenticated ? session.identity : null;
}

async function signInOnce(): Promise<void> {
  const session = await initialize();
  const config = getConfiguration();
  if (!config.enabled) throw new OidcConfigurationError("OIDC authentication is not configured");
  if (session.authenticated) return;
  const manager = await getManager(config);
  await manager.signinRedirect({ state: { returnUrl: currentRoute() } });
}

export function signIn(): Promise<void> {
  signInPromise ??= signInOnce().catch((error: unknown) => {
    signInPromise = null;
    throw error;
  });
  return signInPromise;
}

async function signOutOnce(): Promise<void> {
  await initialize();
  const config = getConfiguration();
  if (!config.enabled) throw new OidcConfigurationError("OIDC authentication is not configured");
  const manager = await getManager(config);
  await manager.signoutRedirect({
    state: { returnUrl: currentRoute() },
    post_logout_redirect_uri: config.postLogoutRedirectUri,
  });
}

export function signOut(): Promise<void> {
  signOutPromise ??= signOutOnce().catch((error: unknown) => {
    signOutPromise = null;
    throw error;
  });
  return signOutPromise;
}
