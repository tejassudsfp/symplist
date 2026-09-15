"use client";

import type { AccessLevel, AccessState, UserId, UserRole } from "@symplist/contracts";
import { createContext, type ReactNode, useContext } from "react";

/*
 * Session seam (§2.3). PLACEHOLDER: the access feature implements these exports in place (§5.1,
 * §5.4). `SessionProvider` will resolve the signed-in person and their access state, and
 * `SessionGate` will send anyone who fails its level to sign-in, the access gate or paused access.
 * Other features build against these names and shapes, so keep the file name, export names and prop
 * types stable.
 */

export type SessionStatus = "loading" | "signed_out" | "signed_in";

/** The signed-in person. */
export interface SessionUser {
  readonly id: UserId;
  readonly displayName: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface Session {
  readonly status: SessionStatus;
  /** Present when `status` is `signed_in`. */
  readonly user?: SessionUser;
  /** The account's access fields (§5.4); present when `status` is `signed_in`. */
  readonly access?: AccessState;
}

/** The placeholder never resolves a session, so every route sees one that is still loading. */
const PLACEHOLDER_SESSION: Session = { status: "loading" };

const SessionContext = createContext<Session | null>(null);

export interface SessionProviderProps {
  readonly children: ReactNode;
  /** A fixed session used instead of the resolved one, for tests and previews. */
  readonly value?: Session;
}

/** Mounted once at the root by `AppProviders`, so every route group can read the session. */
export function SessionProvider({ children, value }: SessionProviderProps) {
  return (
    <SessionContext.Provider value={value ?? PLACEHOLDER_SESSION}>
      {children}
    </SessionContext.Provider>
  );
}

/** The current session. Throws outside `SessionProvider`. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionProvider");
  return session;
}

export interface SessionGateProps {
  readonly children: ReactNode;
  /** The §5.4 guard level every route inside the gate needs. */
  readonly require: AccessLevel;
}

/**
 * Guards a route group at an access level; the `(app)` layout requires `admitted`. PLACEHOLDER: it
 * renders its children at every level until the access feature enforces `require`.
 */
export function SessionGate({ children }: SessionGateProps) {
  return children;
}
