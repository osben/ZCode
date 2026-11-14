import {
  EXTERNAL_SESSION_SOURCE_CATALOG,
  type ExternalSessionSource,
  type ExternalSessionSourceStatus,
} from "./contract.js";

const VIEW_STORAGE_KEY = "zcode.externalSessions.view.v1";

export interface PanelViewState {
  collapsed: boolean;
  /** Empty = every source. */
  sources: ExternalSessionSource[];
}

export function readViewState(): PanelViewState {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return { collapsed: false, sources: [] };
    const parsed = JSON.parse(raw) as Partial<PanelViewState>;
    const known = new Set<string>(EXTERNAL_SESSION_SOURCE_CATALOG.map((item) => item.source));
    return {
      collapsed: parsed.collapsed === true,
      sources: Array.isArray(parsed.sources)
        ? (parsed.sources.filter((item): item is ExternalSessionSource =>
            known.has(String(item)),
          ) as ExternalSessionSource[])
        : [],
    };
  } catch {
    return { collapsed: false, sources: [] };
  }
}

export function persistViewState(state: PanelViewState): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Per-device convenience only.
  }
}

export type SourceStatusMap = Partial<Record<ExternalSessionSource, ExternalSessionSourceStatus>>;

/** Empty selection = every source (specs/external-sessions.md "UI"). */
function isActiveSource(sources: readonly ExternalSessionSource[], source: ExternalSessionSource) {
  return sources.length === 0 || sources.includes(source);
}

/**
 * Statuses of the selected sources only. Deselected sources were not scanned by the current request,
 * so their cached or `not scanned` status must not drive counts or the empty-state message.
 */
export function selectedSourceStatuses(
  statuses: SourceStatusMap | undefined,
  sources: readonly ExternalSessionSource[],
): ExternalSessionSourceStatus[] {
  if (!statuses) return [];
  return EXTERNAL_SESSION_SOURCE_CATALOG.filter((item) =>
    isActiveSource(sources, item.source),
  ).flatMap((item) => {
    const status = statuses[item.source];
    return status ? [status] : [];
  });
}

export function summarizeSourceSelection(
  statuses: SourceStatusMap | undefined,
  sources: readonly ExternalSessionSource[],
): { totalCount: number; everySourceUnavailable: boolean } {
  const selected = selectedSourceStatuses(statuses, sources);
  return {
    totalCount: selected.reduce((sum, item) => sum + item.count, 0),
    everySourceUnavailable: selected.length > 0 && selected.every((item) => !item.available),
  };
}

/** Unavailable styling applies to selected chips only. */
export function isChipUnavailable(
  statuses: SourceStatusMap | undefined,
  sources: readonly ExternalSessionSource[],
  source: ExternalSessionSource,
): boolean {
  const status = statuses?.[source];
  return isActiveSource(sources, source) && status !== undefined && !status.available;
}

/** A count is shown for an active chip, or for a deselected source whose cached status is available. */
export function showChipCount(
  statuses: SourceStatusMap | undefined,
  sources: readonly ExternalSessionSource[],
  source: ExternalSessionSource,
): boolean {
  const status = statuses?.[source];
  return status !== undefined && (isActiveSource(sources, source) || status.available);
}

/**
 * Next stored selection after a chip click. Empty stored selection = every source, so it is expanded first and a
 * click flips that chip alone. Turning off the last selected chip is a no-op: deselection never collapses the
 * selection into the every-source sentinel (specs/external-sessions.md "Last-chip rule").
 */
export function toggleSourceSelection(
  current: readonly ExternalSessionSource[],
  source: ExternalSessionSource,
): ExternalSessionSource[] {
  const all = EXTERNAL_SESSION_SOURCE_CATALOG.map((item) => item.source);
  const next = new Set<ExternalSessionSource>(current.length === 0 ? all : current);
  if (next.has(source)) {
    if (next.size === 1) return [...current];
    next.delete(source);
  } else {
    next.add(source);
  }
  return next.size === all.length ? [] : [...next];
}
