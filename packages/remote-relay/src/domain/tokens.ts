import type { WebRemoteControlRelayV2Role } from "@zcode/shared/web-remote-relay";

export interface RelayTokenGrant {
  userId: string;
  role: WebRemoteControlRelayV2Role;
  expiresAt: number;
}

export interface RelayTokenStoreOptions {
  now: () => number;
  /** Produces the 22-character Base64URL token; injected so the domain stays free of IO. */
  randomToken: () => string;
  ttlMs?: number;
  maxOutstandingPerUser?: number;
}

/**
 * One-time WebSocket admission tokens. A token is bound to user and role, never to a SID,
 * and is removed on the first successful consume. Expired and consumed tokens are not restored.
 */
export class RelayTokenStore {
  private readonly grants = new Map<string, RelayTokenGrant>();
  private readonly ttlMs: number;
  private readonly maxOutstandingPerUser: number;

  constructor(private readonly options: RelayTokenStoreOptions) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxOutstandingPerUser = options.maxOutstandingPerUser ?? 32;
  }

  /** Returns undefined when the user already holds too many unexpired tokens. */
  issue(
    userId: string,
    role: WebRemoteControlRelayV2Role,
  ): { token: string; expiresIn: number } | undefined {
    this.prune();
    let outstanding = 0;
    for (const grant of this.grants.values()) if (grant.userId === userId) outstanding += 1;
    if (outstanding >= this.maxOutstandingPerUser) return undefined;
    const token = this.options.randomToken();
    this.grants.set(token, {
      userId,
      role,
      expiresAt: this.options.now() + this.ttlMs,
    });
    return { token, expiresIn: Math.floor(this.ttlMs / 1000) };
  }

  /** Atomically removes the token. Expired tokens are removed and rejected. */
  consume(token: string): RelayTokenGrant | undefined {
    const grant = this.grants.get(token);
    if (!grant) return undefined;
    this.grants.delete(token);
    if (grant.expiresAt <= this.options.now()) return undefined;
    return grant;
  }

  private prune() {
    const now = this.options.now();
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
  }
}
