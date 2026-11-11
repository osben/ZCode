import type { ZCodeInteractionRequestOrigin } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function InteractionRequestOriginBadge({
  className,
  origin,
}: {
  className?: string;
  origin?: ZCodeInteractionRequestOrigin;
}) {
  const { intl } = useZCodeIntl();
  if (origin?.kind !== "subagent") {
    return null;
  }

  // description names which subagent is asking (dynamic-workflow subagents use `<name> (<siteId>@<ordinal>)`,
  // see docs/dynamic-workflow/launch.md "Permissions inside a run"); the badge truncates, with the full text in the tooltip.
  const description = origin.description?.trim();
  const label = description
    ? intl.formatMessage({ id: "chat.interactionOrigin.subagent.named" }, { description })
    : intl.formatMessage({ id: "chat.interactionOrigin.subagent" });
  const title = !origin.agentType
    ? label
    : description
      ? intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.titleNamed" },
          { agentType: origin.agentType, description },
        )
      : intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.title" },
          { agentType: origin.agentType },
        );

  return (
    <span
      title={title}
      data-interaction-origin-badge="subagent"
      className={cn(
        "block w-full min-w-0 basis-full whitespace-normal [overflow-wrap:anywhere] text-ui-base font-normal text-foreground-subtle",
        className,
      )}
    >
      {label}
    </span>
  );
}
