import { LOCAL_TTFT_TTL_MS } from "@zcode/shared";

const MAX_OBSERVATIONS = 1024;
const MAX_FACTS_PER_OBSERVATION = 512;

/** Tracks identities for export deduplication only; when full, reject new details instead of evicting root identities still observing input. */
export class LocalTtftExportDedupe {
  private readonly observations = new Map<string, { start: number; facts: Set<string> }>();
  constructor(private readonly now = Date.now) {}
  admit(
    renderer: string,
    observation: string,
    start: number,
  ): ((factId: string) => boolean) | undefined {
    const now = this.now();
    // Match the Renderer observation-retention window; retransmissions outside that window must not recreate Histogram samples.
    if (now - start > LOCAL_TTFT_TTL_MS) return;
    for (const [id, entry] of this.observations)
      if (now - entry.start > LOCAL_TTFT_TTL_MS) this.observations.delete(id);
    const key = `${renderer}:${observation}`;
    let entry = this.observations.get(key);
    if (!entry) {
      if (this.observations.size >= MAX_OBSERVATIONS) return;
      entry = { start, facts: new Set() };
      this.observations.set(key, entry);
    }
    const facts = entry.facts;
    return (factId) => {
      if (facts.has(factId) || facts.size >= MAX_FACTS_PER_OBSERVATION) return false;
      facts.add(factId);
      return true;
    };
  }
}
