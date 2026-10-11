/**
 * Serialization rules for workflow-run artifacts, shared by two places in core:
 * `<result>` in completion notifications (background-tasks.ts) and `resultText` on
 * runtime task entries (background-task-registry.ts, the sole source for TaskOutput).
 *
 * The implementation **moved to `@zcode/contracts`** (`interfaces/dynamic-workflow-run.port.ts`,
 * alongside `boundDynamicWorkflowRunEventPayload`) because it gained a third consumer:
 * the bootstrap v4 projection uses the same rule for `workflowRuns.reports[].preview`
 * in the detail page's Results section. Bootstrap cannot import core internals, and
 * duplicating serialization would make the same value look different in notifications
 * and the panel. Keep this re-export so the two core import sites do not change.
 */
import { serializeWorkflowArtifact } from "@zcode/contracts";

export { serializeWorkflowArtifact };

/**
 * Character budget for the `<reports>` section in completion notifications.
 *
 * Notifications already have a 120k overall truncation limit, but that is the **last** gate and truncates later fields first. Snapshots can contain
 * up to 256 progressive artifacts (`DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS`); expanding them without a local limit could push `<result>` and
 * `<error>` out of the notification, even though those are what the model needs first. So this section has its own budget.
 */
const WORKFLOW_REPORTS_PREVIEW_MAX_CHARS = 8_000;
/** Per-item limit: a 32 KB artifact should not consume the whole section budget and keep the next ten entries out. */
const WORKFLOW_REPORT_ITEM_MAX_CHARS = 2_000;

interface WorkflowReportsNotificationSection {
  /** **Actual total count** (not the number of previewed entries). */
  count: number;
  /** Number of entries actually included in the preview; less than count means the preview is partial. */
  shown: number;
  preview: string;
}

/**
 * Convert report entries from the journal into a `<reports>` section in completion
 * notifications (shared by completed / failed / cancelled states).
 *
 * Both truncation and count matter: count tells the main agent that the preview is
 * partial and the full set can be retrieved by run id. A preview alone could make the
 * model think it saw everything; a count alone would return no artifact content.
 *
 * `total` is the run's actual item count (snapshot `reportCount`); `items` contains only the first portion (snapshots are capped
 * at 256 items). Fall back to `items.length` when absent—older snapshots lack this field, and their `items` contain everything.
 *
 * Return `undefined` for zero entries so the caller omits the entire section instead of emitting an empty `<reports>`.
 */
export function buildWorkflowReportsNotificationSection(
  items: readonly unknown[] | undefined,
  total?: number,
): WorkflowReportsNotificationSection | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const lines: string[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    const text = clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_REPORT_ITEM_MAX_CHARS);
    const line = `[${index + 1}] ${text}`;
    // Include at least one entry: one oversized artifact is more useful than reporting eleven entries with none visible.
    if (lines.length > 0 && used + line.length + 1 > WORKFLOW_REPORTS_PREVIEW_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  return {
    count: Math.max(total ?? 0, items.length),
    shown: lines.length,
    preview: lines.join("\n"),
  };
}

/**
 * Build the `<reports>` section in the manifest payload (`WorkflowNotificationMeta.reports`).
 * Like the **notification text** section above, it uses the same per-entry serializer
 * (`serializeWorkflowArtifact`), but returns **string[]** instead of joined text. The
 * GUI renders each manifest entry as a numbered preview; joining would force it to split
 * the text again.
 *
 * This has a deliberately different limit from the notification-text section: at most
 * 500 characters per entry and 8 entries (matching shared's
 * `workflowNotificationMetaSchema`; exceeding it makes zod reject the turnHeader row
 * when persisted). `count` is always the **actual total**: `count ≠ shown` signals that
 * the preview is partial and the full set is available by run id.
 *
 * `total` has the same meaning as in the notification section (snapshot `reportCount`, falling back to `items.length` when absent).
 *
 * Return `undefined` for zero entries so the caller omits the field entirely.
 */
export function buildWorkflowReportsManifestSection(
  items: readonly unknown[] | undefined,
  total?: number,
): { count: number; shown: number; preview: string[] } | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const preview: string[] = [];
  for (const item of items) {
    if (preview.length >= WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS) break;
    preview.push(clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS));
  }
  return { count: Math.max(total ?? 0, items.length), shown: preview.length, preview };
}

/** Per-entry artifact preview limit in the manifest payload (shared schema: ≤500 characters). */
const WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS = 500;
/** Maximum number of entries previewed in the manifest payload (shared schema: ≤8). */
const WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS = 8;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

