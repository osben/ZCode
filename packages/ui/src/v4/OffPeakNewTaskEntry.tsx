import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* New task page idle-time task entry (Figma ⚫️ Z.ai - Zcode / node 5488-3978; spec §5 "Templates" / D30-4 second entry).
   Guide banner "Use free run Idle-time task" + Client Scenes template cards (prefill the create form; Customize = blank).
   No render when the staged rollout misses (D31); the banner is dismissible (within this session, D28 "after closing, reopens on next
   login/restart" → session-level).
   Clicking a card: stage the prefill draft → open the Automations main view (idle tab) where the create form consumes the draft.
   The entry sits in the fixed bottom area of the draft page (38px from the bottom); templates use a desktop three-column row,
   single column on narrow screens;
   business logic (staged rollout, Coding Plan check, upgrade toast, draft prefill, telemetry) stays unchanged. */
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { Megaphone, Moon, X } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  appendLocalCustomizeTemplate,
  materializeOffPeakTemplateDraft,
  resolveOffPeakTemplateText,
  type OffPeakAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useOffPeakTaskStore, type OffPeakCreateDraft } from "@/store/offPeakTaskStore.js";
import { useMemo } from "react";

interface OffPeakNewTaskEntryProps {
  /** Opens the Automations main view (idle tab); the prefill draft is staged before the card click is handled. */
  onOpenAutomations?: () => void;
}

export function OffPeakNewTaskEntry({ onOpenAutomations }: OffPeakNewTaskEntryProps) {
  const { intl, locale } = useZCodeIntl();
  const { clientScenesService } = useServices();
  const { offPeak: remoteOffPeakTemplates } = useAutomationTemplates(clientScenesService);
  const offPeakTemplates = useMemo(
    () => appendLocalCustomizeTemplate(remoteOffPeakTemplates),
    [remoteOffPeakTemplates],
  );
  const { settings: sharedSettings } = useSettings();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  useOffPeakEligibility(sharedSettings, providerSettingsView?.revision);
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const entryGate = useCodingPlanEntryGate();
  const grayConfig = useOffPeakTaskStore((state) => state.grayConfig);
  const dismissed = useOffPeakTaskStore((state) => state.newTaskBannerDismissed);
  const dismiss = useOffPeakTaskStore((state) => state.dismissNewTaskBanner);
  const setPendingCreateDraft = useOffPeakTaskStore((state) => state.setPendingCreateDraft);

  // Rollout miss / user dismissed → do not render (D31 exposure gating + D28 dismissible).
  if (grayConfig?.enabled !== true || dismissed) return null;

  const entryPlanState = resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView);
  const codingPlanUnavailable =
    grayConfig.codingPlanActive === false ||
    (grayConfig.codingPlanActive === undefined &&
      providerSettingsView !== null &&
      entryPlanState.entryPlanStatus !== "coding_plan");

  const showCodingPlanRequiredToast = () => {
    toast(entryGate.label ?? intl.formatMessage({ id: "offPeak.create.codingPlanToast" }), {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      actionLabel:
        entryGate.status === "loading"
          ? undefined
          : (entryGate.label ??
            intl.formatMessage({
              id: "settings.modelProvider.codingPlan.upgrade",
            })),
      onAction:
        entryGate.status === "error"
          ? entryGate.retry
          : () => {
              const providerId =
                sharedSettings?.providerFamilyDomain === "bigmodel"
                  ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
                  : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
              const eventText = intl.formatMessage({
                id: "settings.modelProvider.codingPlan.upgrade",
              });
              // Why the funnel context was missing: the idle-time entry previously passed only providerId, so the purchase panel could not
              // build a source-attributed funnel, and there was no attributable context that survived across OAuth. Freeze the context
              // once at click time; the global dialog holds it across logins.
              codingPlanUpgradeDialog?.openCodingPlanUpgrade({
                providerId,
                initialAudience: "personal",
                funnelContext: createIdleTimeCodingPlanFunnelContext({
                  providerId,
                  eventText,
                  entryPlanState,
                }),
              });
            },
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "common.close" }),
    });
  };

  const handleCardClick = (template: OffPeakAutomationTemplate) => {
    // Bug cause: the selected-connection gate conflated "no provider selected" with "no plan", wrongly blocking users who already had a plan.
    // The homepage only navigates and admits on any Coding Plan; form submission is still strictly gated by Automations' selected support.
    if (codingPlanUnavailable) {
      logger.debug("[off-peak] blocked home template without any Coding Plan", {
        templateId: template.id,
      });
      showCodingPlanRequiredToast();
      return;
    }
    // Bugfix: the homepage copy went through i18n while the draft was hardcoded in English, producing mixed-language pages on Chinese
    // systems after clicking a template. Generate the title and prompt from the current locale at click time; Customize still stays blank.
    const materialized = materializeOffPeakTemplateDraft(template, locale);
    const draft: OffPeakCreateDraft = {
      ...(template.customize ? {} : { title: materialized.title, prompt: materialized.prompt }),
      telemetrySource: {
        eventRegion: "app.session",
        templateId: template.id,
      },
    };
    setPendingCreateDraft(draft);
    onOpenAutomations?.();
  };

  return (
    // 5488-3978: the entry is a permanent fixture at the bottom of the draft page; pb-[38px] gives the fixed gap to the window bottom.
    // Width does not expand on the @container/conversation breakpoints (that container is declared only inside the timeline).
    <div
      data-off-peak-new-task-entry="true"
      className="flex w-full shrink-0 flex-col items-center gap-3 px-4 pb-[38px]"
    >
      {/* Guide banner: 32px icon slot + 4px gap + main copy / description Tooltip, horizontally centered;
          the close button is hidden this design round (see the comment below). */}
      <div
        data-off-peak-new-task-banner="true"
        className="flex w-full max-w-[580px] items-center justify-center"
      >
        <div className="flex min-w-0 items-center gap-1 text-foreground-subtle opacity-80">
          <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
            <Megaphone className="size-4" strokeWidth={2} />
          </span>
          {/* Bug cause: joining the eligibility note and the main copy into one line triggered ellipsis, so users could neither read the
              full main copy nor see the parenthesized limitation on its own. The main copy now wraps fully, and the whole copy area
              carries the description Tooltip; the plain text hint does not use cursor-help, avoiding an extra question-mark cursor. */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Fix reason: the caption font size scales with UI settings; use a relative line height so large font sizes are not clipped by a fixed 18px line box. */}
                <span
                  tabIndex={0}
                  className="min-w-0 cursor-default rounded-sm text-ui-caption font-normal leading-snug focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-hover"
                >
                  {intl.formatMessage({ id: "offPeak.newTask.bannerText" })}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="max-w-none whitespace-nowrap">
                <span>
                  {intl.formatMessage({
                    id: "offPeak.newTask.bannerTipText",
                  })}
                </span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {/* 5488-3978: no close entry for now; per product, hide the implementation without deleting it,
            keeping dismissNewTaskBanner and the offPeak.newTask close semantics usable;
            to re-enable, change hidden back to flex (both are in the display group and cannot coexist). */}
        <button
          type="button"
          data-off-peak-new-task-dismiss="true"
          onClick={dismiss}
          aria-label={intl.formatMessage({ id: "common.close" })}
          className="ml-auto hidden size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtle opacity-80 hover:bg-hover hover:opacity-100"
        >
          <X className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* Remote template buttons use an equal-width grid; a desktop row, single column on narrow screens.
          Descriptions have no fixed height; cards stretch to the tallest content in the row. */}
      <div
        data-off-peak-template-grid="true"
        className="grid w-full max-w-[780px] grid-cols-1 gap-4 sm:grid-cols-3"
      >
        {offPeakTemplates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => handleCardClick(template)}
            className="flex h-full w-full flex-col gap-2 rounded-2xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-surface-hover"
          >
            <div className="flex items-center gap-1.5 text-foreground">
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                <ClientSceneLucideIcon
                  name={template.iconName}
                  aria-hidden="true"
                  className="size-4"
                  size={16}
                  strokeWidth={2}
                  fallback={
                    <Moon
                      aria-hidden="true"
                      className="size-4"
                      data-off-peak-homepage-template-icon="moon"
                      size={16}
                      strokeWidth={2}
                    />
                  }
                />
              </span>
              <span className="truncate text-ui-base leading-5 text-foreground">
                {resolveOffPeakTemplateText(template, "title", locale, intl.formatMessage)}
              </span>
            </div>
            <p className="text-wrap-phrase line-clamp-2 text-ui-caption font-normal leading-snug text-foreground-subtle">
              {resolveOffPeakTemplateText(
                template,
                "homepageDescription",
                locale,
                intl.formatMessage,
              )}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
