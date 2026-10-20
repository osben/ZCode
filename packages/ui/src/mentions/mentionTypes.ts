export type MentionCategory =
  | "files"
  | "skills"
  | "commands"
  | "subagents"
  | "whiteboards"
  | "sessions"
  | "plugins";

export interface MentionItemData {
  kind?: "file" | "directory" | "whiteboard";
  path?: string;
  relativePath?: string;
  /** 只用于候选展示；执行路径与 canonical 链接不依赖 root 名。 */
  rootName?: string;
  boardId?: string;
  scope?: "built-in" | "workspace" | "user" | "plugin";
  source?: "built-in" | "user" | "plugin";
  model?: string;
  /** Stable identity for a Plugin reference (`name@marketplace`); canonical link destination; the label is not part of the identity. */
  pluginId?: string;
  /** Original icon for a Plugin store listing; used only in the UI and must be loaded only after HTTPS validation. */
  icon?: string;
}

export interface MentionItem {
  id: string;
  category: MentionCategory;
  label: string;
  description: string;
  value: string;
  markdown: string;
  keywords?: string[];
  data?: MentionItemData;
  /**
   * Localized display name used only in the panel (for example, a Plugin listing displayName).
   * `label` is both the panel copy and the label in the chip/markdown payload; localizing it directly `label` would make the
   * composer chip and message bubble (reconstructed from the markdown label) inconsistent; the panel display name uses this separate field.
   */
  displayLabel?: string;
  /** Disabled state (V1 same-name Plugin conflict fails closed): visible in the panel but not selectable. */
  disabled?: boolean;
  /** Reason the item is disabled, shown as secondary information on the right of the candidate row. */
  disabledReason?: string;
}

export interface MentionCategoryResult {
  items: MentionItem[];
  groups?: Array<{ id: string; title: string; items: MentionItem[] }>;
  loading: boolean;
  error: Error | null;
  emptyText: string;
  title: string;
  refresh?: () => Promise<void>;
}
