// ============================================================
// Provenance block on the detail page.
// ============================================================
// Split from WorkflowRunSidePaneSections.tsx to meet the max-lines rule. This block appears for two run types: launched directly from the hub
// and created by a “Configure” revision.
// Tool-initiated runs do not have it — their provenance is the CreateWorkflow row in the transcript. Read-only, no actions.

import { Fragment, memo } from "react";
import type { WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";
import { workflowSettingsProvenanceRows } from "@/components/workflow-timeline/workflowSettingsChange.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Argument value: preserve strings as-is and use `JSON.stringify` for others (same normalization as the arguments dialog / notification). */
function formatArgValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Hub launch: “Launched by you from the Workflows hub · time” with a scope badge; description and argument key/value table below.
 * “Configure” revision: “Settings adjusted by you · time,” with no scope badge; each change appears below as one “{from} → {to}” row.
 */
export const WorkflowRunProvenance = memo(function WorkflowRunProvenance({
  meta,
  providerName,
  startedAt,
}: {
  meta: WorkflowLaunchMeta;
  /** providerId → provider name (same lookup as the model part of the summary row); fall back to raw modelId when absent. */
  providerName?: (providerId: string) => string | undefined;
  /** startedAt for the launch / settings turn; omit the time when absent. */
  startedAt?: number;
}) {
  const { intl } = useZCodeIntl();
  const amend = meta.amend;
  const caption = intl.formatMessage({
    id:
      amend === undefined
        ? "chat.workflowLaunch.startedByYou"
        : "chat.workflowLaunch.settingsChangedByYou",
  });
  const time =
    startedAt === undefined
      ? undefined
      : new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(startedAt);
  const rows =
    amend === undefined
      ? Object.entries(meta.args ?? {}).map(([key, value]) => ({
          key,
          label: key,
          value: formatArgValue(value),
        }))
      : workflowSettingsProvenanceRows(amend, {
          formatMessage: intl.formatMessage.bind(intl),
          ...(providerName === undefined ? {} : { providerName }),
        });

  return (
    <div
      className="shrink-0 border-b border-border px-4 py-3"
      data-testid="workflow-run-provenance"
      data-workflow-launch-kind={amend === undefined ? "launch" : "settings"}
      {...(meta.scope === undefined ? {} : { "data-workflow-launch-scope": meta.scope })}
    >
      <div className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtle">
        <span className="min-w-0 truncate">
          {time === undefined ? caption : `${caption} · ${time}`}
        </span>
        {/* Scope badge: reuse the hub's compact badge style (rounded-sm border and small text). Settings runs save no files and therefore have no scope. */}
        {amend !== undefined || meta.scope === undefined ? null : (
          <span
            className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 leading-none text-foreground-subtlest"
            data-testid="workflow-run-provenance-scope"
          >
            {intl.formatMessage({ id: `chat.workflowLaunch.scope.${meta.scope}` })}
          </span>
        )}
      </div>
      {amend === undefined && meta.description ? (
        <p className="mt-1 min-w-0 text-ui-sm leading-5 text-foreground-subtle">
          {meta.description}
        </p>
      ) : null}
      {/* Key/value table: arguments use monospace keys and values, truncated to one line (title contains the full value); setting changes use readable labels and one-line values.
          The side pane has vertical space, so do not collapse the table. */}
      {rows.length > 0 ? (
        <dl
          className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
          data-testid={
            amend === undefined
              ? "workflow-run-provenance-args"
              : "workflow-run-provenance-settings"
          }
        >
          {rows.map((row) => (
            <Fragment key={row.key}>
              <dt
                className={
                  amend === undefined
                    ? "truncate font-mono text-ui-xs text-foreground-subtle"
                    : "truncate text-ui-xs text-foreground-subtle"
                }
              >
                {row.label}
              </dt>
              <dd
                className={
                  amend === undefined
                    ? "truncate font-mono text-ui-xs text-foreground"
                    : "truncate text-ui-xs text-foreground tabular-nums"
                }
                title={row.value}
              >
                {row.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
});
