// ============================================================
// Model Catalog Port - read-only snapshot boundary for models configured by the host
// ============================================================
// There is one reason for this port:
// The tool layer must resolve a model name supplied by the user ("GLM-5.3-Flash") into a
// subagent selection for a workflow run, while core cannot see the provider registry. The
// port supplies the host fact of which models are available; resolution remains in core (a
// pure function with no I/O).
//
// Deliberately **synchronous and I/O-free**: call sites are in the `resolveInput` and
// `ListModels` handlers, and neither should wait on the network just to list models. The host
// simply reads an in-memory view of the registry.

/** One catalog entry (a provider × model pair). */
export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  /** Human-readable provider name; omitted when not supplied by the registry (readers fall back to `providerId`). */
  providerLabel?: string;
  /** Reasoning levels supported by this model (valid values for `$level`). Models with no levels have an **empty array**, not an omitted field. */
  reasoningLevels: string[];
  /** Registry default level; omitted when `reasoningLevels` is empty. */
  defaultReasoningLevel?: string;
  contextWindow?: number;
  /** Whether this entry is the session's current selection (same provider + model). At most one entry in the full catalog is true. */
  current: boolean;
  /** Why this model cannot be selected (e.g. missing credentials or disabled by policy); omitted when selectable. */
  disabledReason?: string;
}

export interface ModelCatalogPort {
  /**
   * List models available for selection now.
   *
   * **Read the live registry view on every call**; never return a copy frozen at construction.
   * Providers may be added, removed, or changed during a session (the stale provider registry
   * lesson: a subagent retained the adapters from when its parent session was constructed).
   * A stale catalog can make resolution select a model that no longer exists, with failure
   * delayed until the subagent's first response—long after the user confirmed.
   */
  listModels(): ModelCatalogEntry[];
}
