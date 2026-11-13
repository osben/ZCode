import { EXTERNAL_SESSION_SOURCE_CATALOG, type ExternalSessionSource } from "./contract.js";

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
