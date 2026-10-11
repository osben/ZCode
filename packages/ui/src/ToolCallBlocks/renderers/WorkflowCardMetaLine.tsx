import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * A metadata line at the top of a tool card: a muted label + monospace value (source filename, run id, etc.), optionally with a muted note.
 * `marker` becomes `data-workflow-card-<marker>="true"`, which tests and styles use to find the row; `flag` becomes
 * `data-workflow-card-<marker>-<flag>="true"` to indicate an additional fact about the row.
 */
export function WorkflowCardMetaLine({
  marker,
  label,
  value,
  title,
  note,
  flag,
}: {
  marker: string;
  label: string;
  value: string;
  title?: string;
  note?: string;
  flag?: string;
}) {
  return (
    <p
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ui-sm"
      {...{ [`data-workflow-card-${marker}`]: "true" }}
      {...(flag === undefined ? {} : { [`data-workflow-card-${marker}-${flag}`]: "true" })}
    >
      <span className="shrink-0 text-foreground-subtlest">{label}</span>
      <span className="min-w-0 truncate font-mono text-foreground-subtle" title={title ?? value}>
        {value}
      </span>
      {note === undefined ? null : (
        <span className="shrink-0 text-foreground-subtlest">· {note}</span>
      )}
    </p>
  );
}

/**
 * Lineage in the workflow revision row card body:
 * "Amend run X" — identifies which run this card will modify. Read `runId` from the AmendWorkflow
 * input (`run_id`), using the same rule as the confirmation dialog. CreateWorkflow rows do not have
 * it, so they do not show this line.
 *
 * `scriptInherited`: this revision omitted a script and reuses the predecessor's ("Keeping the
 * predecessor's script"). Add "Script unchanged" at the end of the row; the card has no script to
 * collapse, and omitting it is exactly what this call intends.
 */
export function WorkflowAmendsLine({
  runId,
  scriptInherited = false,
}: {
  runId: string;
  scriptInherited?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <WorkflowCardMetaLine
      marker="amends"
      label={intl.formatMessage({ id: "chat.toolCall.workflow.amend.amends" })}
      value={runId}
      {...(scriptInherited
        ? {
            note: intl.formatMessage({ id: "chat.toolCall.workflow.amend.scriptUnchanged" }),
            flag: "script-inherited",
          }
        : {})}
    />
  );
}
