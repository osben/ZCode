// ============================================================
// OpenDocumentStore: open documents of one server connection (spec §4-§5)
// ============================================================
// One store per (serverId, pool key, connection). A new connection after a restart gets a
// new store, so documents are re-opened from disk on the next use. Least-recently-used
// eviction is performed by the caller, which must send didClose for each evicted entry.

import type { LspDiagnostic } from "@zcode/contracts";
import { DiagnosticsFreshness } from "./diagnostics-freshness.js";

export interface DocumentSnapshot {
  sizeBytes: number;
  mtimeMs?: number;
}

export interface OpenDocument {
  uri: string;
  path: string;
  languageId: string;
  text: string;
  lines: string[];
  snapshot: DocumentSnapshot;
  /** `version` is owned by freshness: it is the LSP version of the last didOpen/didChange. */
  freshness: DiagnosticsFreshness<LspDiagnostic[]>;
}

export class OpenDocumentStore {
  /** Map insertion order is the LRU order: the first entry is the least recently used. */
  private readonly documents = new Map<string, OpenDocument>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.documents.size;
  }

  /** Read without changing LRU order (used by publish handling, which must not keep documents alive). */
  peek(uri: string): OpenDocument | undefined {
    return this.documents.get(uri);
  }

  /** Read and mark as most recently used. */
  touch(uri: string): OpenDocument | undefined {
    const document = this.documents.get(uri);
    if (document) {
      this.documents.delete(uri);
      this.documents.set(uri, document);
    }
    return document;
  }

  /** Inserts a document and returns the least recently used documents over capacity. */
  insert(document: OpenDocument): OpenDocument[] {
    this.documents.delete(document.uri);
    this.documents.set(document.uri, document);
    const evicted: OpenDocument[] = [];
    for (const candidate of this.documents.values()) {
      if (this.documents.size - evicted.length <= this.capacity) break;
      if (candidate.uri === document.uri) continue;
      evicted.push(candidate);
    }
    for (const victim of evicted) this.documents.delete(victim.uri);
    return evicted;
  }

  delete(uri: string): OpenDocument | undefined {
    const document = this.documents.get(uri);
    if (document) this.documents.delete(uri);
    return document;
  }

  values(): OpenDocument[] {
    return [...this.documents.values()];
  }
}
