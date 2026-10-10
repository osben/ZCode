// ============================================================
// Transcript row for a settings turn
// ============================================================
// A Configure change leaves a control turn in the transcript: no user bubble, just the new run card and this row above it describing
// what changed. It uses the single-row tool style: sliders icon, "Settings changed", one segment per change, and timestamp separated by `·`.
// It is a record, not a control.

import { Fragment } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowSettingsChangeSegments } from "./workflowSettingsChange.js";

export function WorkflowSettingsChangeRow({
  amend,
  at,
  providerName,
}: {
  amend: WorkflowSettingsAmendMeta;
  /** Timestamp of the settings turn; absent means omit it. */
  at?: number;
  /** providerId → provider name (same lookup as the model segment on the card); absent falls back to bare modelId. */
  providerName?: (providerId: string) => string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const segments = workflowSettingsChangeSegments(amend, {
    formatMessage: intl.formatMessage.bind(intl),
    ...(providerName === undefined ? {} : { providerName }),
  });
  const time =
    at === undefined
      ? undefined
      : new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(at);
  const parts = [
    intl.formatMessage({ id: "chat.toolCall.workflow.settingsChange.kind" }),
    ...segments,
    ...(time === undefined ? [] : [time]),
  ];
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-0.5 text-ui-base text-foreground-subtle"
      data-testid="workflow-settings-change-row"
    >
      <SlidersHorizontalIcon aria-hidden className="size-4 shrink-0" />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span aria-hidden className="text-foreground-subtlest">
                ·
              </span>
            ) : null}
            <span
              className={
                index === 0
                  ? "font-medium"
                  : index === parts.length - 1 && time !== undefined
                    ? "text-foreground-subtlest tabular-nums"
                    : undefined
              }
            >
              {part}
            </span>
          </Fragment>
        ))}
      </span>
    </div>
  );
}
