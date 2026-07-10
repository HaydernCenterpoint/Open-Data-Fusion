import { LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import {
  initialize,
  signIn,
  signOut,
  type BrowserAuthSession,
  type SessionIdentity,
} from "../lib/auth";

interface AuthContextValue {
  enabled: boolean;
  identity: SessionIdentity | null;
  signOut: () => Promise<void>;
}

const DEVELOPMENT_AUTH: AuthContextValue = {
  enabled: false,
  identity: null,
  signOut,
};

const AuthContext = createContext<AuthContextValue>(DEVELOPMENT_AUTH);

export function useAuthSession(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthBoundary({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BrowserAuthSession | null>(null);
  const [error, setError] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let active = true;
    initialize()
      .then((nextSession) => {
        if (active) setSession(nextSession);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Authentication could not be initialized");
      });
    return () => { active = false; };
  }, []);

  const context = useMemo<AuthContextValue>(() => ({
    enabled: session?.enabled ?? false,
    identity: session?.identity ?? null,
    signOut,
  }), [session?.enabled, session?.identity]);

  if (error) {
    return (
      <main className="auth-gate" role="alert">
        <div className="auth-gate-card">
          <ShieldCheck size={34} />
          <span className="auth-gate-eyebrow">Identity configuration</span>
          <h1>Open Data Fusion could not verify this session</h1>
          <p>{error}</p>
          <button type="button" onClick={() => window.location.reload()}><RefreshCw size={16} /> Reload</button>
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="auth-gate" aria-busy="true">
        <div className="auth-gate-card"><span className="auth-gate-spinner" /><p>Checking your Open Data Fusion session…</p></div>
      </main>
    );
  }

  if (session.enabled && !session.authenticated) {
    const startSignIn = async () => {
      setRedirecting(true);
      setError("");
      try {
        await signIn();
      } catch (reason) {
        setRedirecting(false);
        setError(reason instanceof Error ? reason.message : "Sign-in could not be started");
      }
    };
    return (
      <main className="auth-gate">
        <div className="auth-gate-card">
          <ShieldCheck size={34} />
          <span className="auth-gate-eyebrow">Secure industrial workspace</span>
          <h1>Sign in to Open Data Fusion</h1>
          <p>Your identity provider verifies the account; workspace roles determine what you can edit.</p>
          <button type="button" disabled={redirecting} onClick={() => void startSignIn()}><LogIn size={16} /> {redirecting ? "Redirecting…" : "Continue to sign in"}</button>
        </div>
      </main>
    );
  }

  return <AuthContext.Provider value={context}>{children}</AuthContext.Provider>;
}
