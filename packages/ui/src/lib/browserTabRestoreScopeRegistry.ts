export type BrowserTabRestoreAttempt = symbol;

interface BrowserTabRestoreScopeState {
  attempt: BrowserTabRestoreAttempt;
  status: "in-flight" | "completed";
}

/**
 * Browser shell cold restore deduplicates per workspace scope and isolates late promises with an
 * attempt token. cleanup may only revoke the in-flight it created; an old attempt must not
 * overwrite a newer attempt's completion state.
 */
export class BrowserTabRestoreScopeRegistry {
  private readonly scopes = new Map<string, BrowserTabRestoreScopeState>();

  begin(scopeKey: string): BrowserTabRestoreAttempt | null {
    if (this.scopes.has(scopeKey)) return null;
    const attempt = Symbol(scopeKey);
    this.scopes.set(scopeKey, { attempt, status: "in-flight" });
    return attempt;
  }

  complete(scopeKey: string, attempt: BrowserTabRestoreAttempt): boolean {
    const current = this.scopes.get(scopeKey);
    if (!current || current.attempt !== attempt || current.status !== "in-flight") return false;
    current.status = "completed";
    return true;
  }

  cancel(scopeKey: string, attempt: BrowserTabRestoreAttempt): void {
    this.releaseInFlight(scopeKey, attempt);
  }

  fail(scopeKey: string, attempt: BrowserTabRestoreAttempt): void {
    this.releaseInFlight(scopeKey, attempt);
  }

  private releaseInFlight(scopeKey: string, attempt: BrowserTabRestoreAttempt): void {
    const current = this.scopes.get(scopeKey);
    if (current?.attempt === attempt && current.status === "in-flight") {
      this.scopes.delete(scopeKey);
    }
  }
}
