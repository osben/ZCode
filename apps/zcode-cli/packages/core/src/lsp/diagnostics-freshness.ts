// ============================================================
// Diagnostics freshness state machine (spec §5)
// ============================================================
// Owner: one instance per open document, held by the document store.
// A diagnostics result counts for the document's current version only when:
//   1. it is a pull response for that version;
//   2. it is a publish with version >= current;
//   3. it is a versionless publish and exactly one change was in flight (sent since the last publish).
// With two or more changes in flight a versionless publish is ambiguous and resolves nothing.

export type DiagnosticsMode = "pull" | "versioned" | "attributed";

export type PublishOutcome = "fresh" | "stale" | "ambiguous" | "unattributed";

export interface FreshDiagnostics<TItems> {
  version: number;
  mode: DiagnosticsMode;
  items: TItems;
}

export class DiagnosticsFreshness<TItems> {
  private currentVersion = 0;
  private changesInFlight = 0;
  private latestFresh: FreshDiagnostics<TItems> | undefined;

  get version(): number {
    return this.currentVersion;
  }

  get inFlight(): number {
    return this.changesInFlight;
  }

  /** The most recent fresh result, possibly for an older version (used as the edit baseline). */
  get lastFresh(): FreshDiagnostics<TItems> | undefined {
    return this.latestFresh;
  }

  /** Whether the result is fresh for the document's current version. */
  isFreshForCurrent(): boolean {
    return this.latestFresh !== undefined && this.latestFresh.version === this.currentVersion;
  }

  /** Current fresh result, or undefined when the document has changed since it was produced. */
  currentFresh(): FreshDiagnostics<TItems> | undefined {
    return this.isFreshForCurrent() ? this.latestFresh : undefined;
  }

  /** didOpen or didChange was sent with `version`. */
  recordChange(version: number): void {
    this.currentVersion = version;
    this.changesInFlight += 1;
  }

  /** A textDocument/diagnostic pull answered for `version`. Pulls do not reset the in-flight count. */
  recordPull(version: number, items: TItems): PublishOutcome {
    if (version !== this.currentVersion) return "stale";
    this.latestFresh = { version, mode: "pull", items };
    return "fresh";
  }

  /**
   * A publishDiagnostics notification. Every publish resets the in-flight count, because
   * the count is defined as changes sent since the last publish for the URI.
   */
  recordPublish(input: { version?: number; items: TItems }): PublishOutcome {
    const inFlight = this.changesInFlight;
    this.changesInFlight = 0;

    if (input.version !== undefined) {
      if (input.version < this.currentVersion) return "stale";
      this.latestFresh = { version: this.currentVersion, mode: "versioned", items: input.items };
      return "fresh";
    }

    if (inFlight === 1) {
      this.latestFresh = { version: this.currentVersion, mode: "attributed", items: input.items };
      return "fresh";
    }
    return inFlight >= 2 ? "ambiguous" : "unattributed";
  }
}
