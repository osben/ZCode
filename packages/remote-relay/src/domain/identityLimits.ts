import type { RelayIdentityLimits, RelayKeyTier, RelayUsageRow } from "../contract.js";

export const OWNER_LIMIT_MULTIPLIER = 4;
export const DEFAULT_IDENTITY_LIMITS: RelayIdentityLimits = {
  maxSockets: 8,
  bytesPerDay: 512 * 1024 * 1024,
  tokensPerMinute: 30,
  maxDevices: 8,
};
const DAY_MS = 86_400_000;

interface Usage {
  sockets: number;
  tokenWindowUntil: number;
  tokenCount: number;
  day: number;
  bytes: number;
  lastSeen: number;
  dirty: boolean;
}

/**
 * In-memory per-identity quotas for device-key sessions (`specs/relay-v2-migration.md` section 15.6).
 * Pure: the clock is injected and nothing here does IO. Counters reset on restart by design.
 */
export class IdentityLimits {
  private readonly usage = new Map<string, Usage>();
  readonly config: RelayIdentityLimits;

  constructor(
    private readonly now: () => number,
    config: Partial<RelayIdentityLimits> = {},
  ) {
    this.config = { ...DEFAULT_IDENTITY_LIMITS, ...config };
  }

  private scale(value: number, tier: RelayKeyTier) {
    return tier === "owner" ? value * OWNER_LIMIT_MULTIPLIER : value;
  }

  maxDevices(tier: RelayKeyTier) {
    return this.scale(this.config.maxDevices, tier);
  }

  private entry(identity: string): Usage {
    let usage = this.usage.get(identity);
    const today = Math.floor(this.now() / DAY_MS);
    if (!usage) {
      usage = {
        sockets: 0,
        tokenWindowUntil: 0,
        tokenCount: 0,
        day: today,
        bytes: 0,
        lastSeen: 0,
        dirty: false,
      };
      this.usage.set(identity, usage);
    }
    if (usage.day !== today) {
      usage.day = today;
      usage.bytes = 0;
    }
    return usage;
  }

  /** Fixed one-minute window of `POST /token` requests. */
  allowToken(identity: string, tier: RelayKeyTier): boolean {
    const usage = this.entry(identity);
    const now = this.now();
    if (usage.tokenWindowUntil <= now) {
      usage.tokenWindowUntil = now + 60_000;
      usage.tokenCount = 0;
    }
    usage.tokenCount += 1;
    return usage.tokenCount <= this.scale(this.config.tokensPerMinute, tier);
  }

  overBudget(identity: string, tier: RelayKeyTier): boolean {
    return this.entry(identity).bytes >= this.scale(this.config.bytesPerDay, tier);
  }

  acquireSocket(identity: string, tier: RelayKeyTier): boolean {
    const usage = this.entry(identity);
    if (usage.sockets >= this.scale(this.config.maxSockets, tier)) return false;
    usage.sockets += 1;
    usage.lastSeen = Math.floor(this.now() / 1000);
    usage.dirty = true;
    return true;
  }

  releaseSocket(identity: string) {
    const usage = this.usage.get(identity);
    if (usage && usage.sockets > 0) usage.sockets -= 1;
  }

  /** Counts client-to-relay bytes. Returns false once the day's budget is spent. */
  addBytes(identity: string, tier: RelayKeyTier, bytes: number): boolean {
    const usage = this.entry(identity);
    usage.bytes += bytes;
    usage.lastSeen = Math.floor(this.now() / 1000);
    usage.dirty = true;
    return usage.bytes <= this.scale(this.config.bytesPerDay, tier);
  }

  /** Rows changed since the last drain, for persistence; also forgets identities with no live state. */
  drain(): RelayUsageRow[] {
    const rows: RelayUsageRow[] = [];
    const now = this.now();
    for (const [identity, usage] of this.usage) {
      if (usage.dirty) {
        rows.push({
          identity,
          lastSeen: usage.lastSeen,
          day: usage.day,
          dayBytes: usage.bytes,
        });
        usage.dirty = false;
      }
      if (
        usage.sockets === 0 &&
        usage.tokenWindowUntil <= now &&
        usage.day !== Math.floor(now / DAY_MS)
      ) {
        this.usage.delete(identity);
      }
    }
    return rows;
  }
}
