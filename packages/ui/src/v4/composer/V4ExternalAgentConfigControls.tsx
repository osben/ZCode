import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";
import {
  BoxIcon,
  ChevronDownIcon,
  GaugeIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ZCodeConfigOption } from "@zcode/shared";
import type {
  ExternalAgentConfigOption,
  ExternalAgentConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_COMPOSER_INPUT, testId } from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { restoreComposerInputFocusAfterPickerClose } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
// Same entry ConversationComposer used before the S6 branch, so existing composer test doubles still apply.
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerToolbar.js";
import { useAcpAgentCatalog } from "@/hooks/useAcpAgentCatalog.js";
import {
  EXTERNAL_AGENT_CONFIG_SEARCH_THRESHOLD,
  EXTERNAL_AGENT_CONTROL_KINDS,
  TID_EXTERNAL_AGENT_CONFIG_HINT,
  TID_EXTERNAL_AGENT_CONFIG_ITEM,
  TID_EXTERNAL_AGENT_CONFIG_SEARCH,
  TID_EXTERNAL_AGENT_CONFIG_TRIGGER,
  currentExternalAgentConfigValue,
  filterExternalAgentConfigValues,
  resolveExternalAgentId,
  nextExternalAgentConfigValue,
  resolveExternalAgentComposerState,
  type ExternalAgentComposerState,
  type ExternalAgentControlKind,
  type ExternalAgentDraftChoices,
} from "@/v4/composer/externalAgentConfig.js";

function noop(): void {}

const KIND_ICON: Record<ExternalAgentControlKind, ComponentType<{ className?: string }>> = {
  mode: SlidersHorizontalIcon,
  model: BoxIcon,
  effort: GaugeIcon,
};

const KIND_LABEL_ID: Record<ExternalAgentControlKind, string> = {
  mode: "chat.toolbar.externalAgent.mode",
  model: "chat.toolbar.externalAgent.model",
  effort: "chat.toolbar.externalAgent.effort",
};

const KIND_PICKER: Record<ExternalAgentControlKind, V4ComposerConfigPicker> = {
  mode: "agent-mode",
  model: "agent-model",
  effort: "agent-effort",
};

interface ExternalAgentConfigSelectProps {
  kind: ExternalAgentControlKind;
  /** Null renders the disabled placeholder ("available after the first message"). */
  option: ExternalAgentConfigOption | null;
  /** False while the composer has no session of this agent: the values show, but a choice is not sent. */
  enabled: boolean;
  disabled: boolean;
  open: boolean;
  shortcut?: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (configId: string, value: string) => void;
}

function ExternalAgentConfigSelect({
  kind,
  option,
  enabled,
  disabled,
  open,
  shortcut,
  onOpenChange,
  onSelect,
}: ExternalAgentConfigSelectProps) {
  const { intl } = useZCodeIntl();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const Icon = KIND_ICON[kind];
  const unavailableText = intl.formatMessage({
    id: "chat.toolbar.externalAgent.availableAfterFirstMessage",
  });
  const current = option ? currentExternalAgentConfigValue(option) : null;
  const available = Boolean(option) && enabled;
  // Agent labels and value names are shown as the agent sends them; only ZCode strings are translated.
  const title = option?.name || intl.formatMessage({ id: KIND_LABEL_ID[kind] });
  const label = option ? (current?.name ?? option.currentValue) : title;
  const searchable = (option?.options.length ?? 0) > EXTERNAL_AGENT_CONFIG_SEARCH_THRESHOLD;
  const values = useMemo(
    () => (option ? filterExternalAgentConfigValues(option.options, searchable ? query : "") : []),
    [option, query, searchable],
  );
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setQuery("");
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <ControlHintTooltip
        title={option ? title : `${title} · ${unavailableText}`}
        shortcut={available ? shortcut : undefined}
        open={open ? false : undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-disabled={available ? undefined : true}
            data-testid={testId(TID_EXTERNAL_AGENT_CONFIG_TRIGGER, kind)}
            data-external-agent-config-available={available ? "true" : "false"}
            data-composer-collapse-priority="1"
            aria-label={option ? `${title}: ${label}` : `${title}: ${unavailableText}`}
            className={cn(
              "group/agent-config h-7 min-w-0 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
              !available && "text-foreground-subtle hover:text-foreground-subtle",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="inline min-w-0 max-w-40 truncate group-data-[composer-compact=true]/agent-config:hidden">
              <RollingToolbarLabel label={label} />
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 group-data-[composer-compact=true]/agent-config:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={4}
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreComposerInputFocusAfterPickerClose({
            anchor: triggerRef.current,
            fallbackSelector: `[data-testid="${TID_V4_COMPOSER_INPUT}"]`,
          });
        }}
      >
        <DropdownMenuLabel className="truncate">{title}</DropdownMenuLabel>
        {option ? (
          <>
            {searchable ? (
              // Radix typeahead would otherwise take the keystrokes meant for the filter input.
              <div className="shrink-0 pb-1" onKeyDown={(event) => event.stopPropagation()}>
                <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover">
                  <input
                    data-testid={TID_EXTERNAL_AGENT_CONFIG_SEARCH}
                    value={query}
                    placeholder={intl.formatMessage({
                      id: "chat.toolbar.externalAgent.searchPlaceholder",
                    })}
                    onChange={(event) => setQuery(event.target.value)}
                    className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest"
                  />
                  <InputGroupAddon>
                    <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
                  </InputGroupAddon>
                </InputGroup>
              </div>
            ) : null}
            <div className="flex max-h-72 min-h-0 flex-col gap-0.5 overflow-y-auto">
              <DropdownMenuRadioGroup
                value={option.currentValue}
                // The shown value may be agent-initiated; choosing it pins it (the server no-ops a repeat).
                onValueChange={(value) => {
                  if (enabled) onSelect(option.id, value);
                }}
              >
                {values.map((value, index) => (
                  <div key={value.value} className="contents">
                    {value.group && value.group !== values[index - 1]?.group ? (
                      <DropdownMenuLabel className="truncate text-ui-sm">
                        {value.group}
                      </DropdownMenuLabel>
                    ) : null}
                    <DropdownMenuRadioItem
                      value={value.value}
                      data-testid={testId(TID_EXTERNAL_AGENT_CONFIG_ITEM, `${kind}-${value.value}`)}
                      className="items-start gap-3 py-1.5"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate">{value.name}</span>
                        {value.description ? (
                          <span className="text-ui-sm text-foreground-subtle">
                            {value.description}
                          </span>
                        ) : null}
                      </span>
                    </DropdownMenuRadioItem>
                  </div>
                ))}
              </DropdownMenuRadioGroup>
              {values.length === 0 ? (
                <div className="px-2 py-1.5 text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.toolbar.externalAgent.noMatches" })}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div
            data-external-agent-config-unavailable="true"
            className="px-2 py-1.5 text-ui-base text-foreground-subtle"
          >
            {unavailableText}
          </div>
        )}
        <DropdownMenuSeparator />
        <div
          data-testid={TID_EXTERNAL_AGENT_CONFIG_HINT}
          className="px-2 py-1.5 text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage({ id: "chat.toolbar.externalAgent.hint" })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface V4ExternalAgentConfigControlsProps {
  state: ExternalAgentComposerState;
  disabled?: boolean;
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  onSetOption: (configId: string, value: string) => void;
}

/** The ACP agent's own selects (mode, model, effort if offered) in place of the ZCode permission modes. */
function V4ExternalAgentConfigControlsImpl({
  state,
  disabled = false,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSetOption,
}: V4ExternalAgentConfigControlsProps) {
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const mode = state.options?.mode;
  const modeOption = useMemo<ZCodeConfigOption | undefined>(
    () =>
      mode
        ? {
            id: mode.id,
            name: mode.name,
            // The shortcut resolver matches on the mode category; an id-only agent mode still cycles.
            category: "mode",
            type: "select",
            currentValue: mode.currentValue,
            options: mode.options.map(({ value, name }) => ({ value, name })),
          }
        : undefined,
    [mode],
  );
  const cycleMode = useCallback(() => {
    if (!mode || !state.enabled) return;
    const next = nextExternalAgentConfigValue(mode);
    if (next) onSetOption(mode.id, next);
  }, [mode, onSetOption, state.enabled]);
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(modeOption) && state.enabled,
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycleMode,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });

  const kinds = state.options
    ? EXTERNAL_AGENT_CONTROL_KINDS.filter((kind) => state.options?.[kind])
    : (["mode", "model"] as const);
  return (
    <div className="flex min-w-0 items-center gap-1" data-external-agent-id={state.agentId}>
      {kinds.map((kind) => (
        <ExternalAgentConfigSelect
          key={kind}
          kind={kind}
          option={state.options?.[kind] ?? null}
          enabled={state.enabled}
          disabled={disabled}
          open={activeConfigPicker === KIND_PICKER[kind]}
          shortcut={kind === "mode" ? modeShortcutLabel : undefined}
          onOpenChange={(open) => onConfigPickerOpenChange(KIND_PICKER[kind], open)}
          onSelect={onSetOption}
        />
      ))}
    </div>
  );
}
export const V4ExternalAgentConfigControls = memo(V4ExternalAgentConfigControlsImpl);

type ModeSwitchProps = ComponentProps<typeof V4ComposerModeSwitch>;

export interface V4ComposerModeAreaProps extends ModeSwitchProps {
  sessionId: string | null;
  /** Session model provider (`config.modelSelection.providerId`), not the draft's. */
  sessionProviderId: string | null | undefined;
  externalAgentConfig: ExternalAgentConfigState | null | undefined;
  /** A session choice (setExternalAgentConfigOption) once the session exists. */
  onSetExternalAgentConfigOption?: (configId: string, value: string) => void;
  /** S6 readiness: a draft's choice, kept in the composer draft until the first submission sends it. */
  draftExternalAgentChoices?: Readonly<Record<string, ExternalAgentDraftChoices>>;
  onSetDraftExternalAgentChoice?: (agentId: string, configId: string, value: string) => void;
}

/**
 * The ACP agent's selects for an ACP draft. The catalog read (`useAcpAgentCatalog`) needs the services context, so
 * only an ACP draft mounts this component; every other model never calls it.
 */
function V4ExternalAgentModeAreaImpl({
  agentId,
  sessionId,
  sessionProviderId,
  externalAgentConfig,
  draftProviderId,
  draftExternalAgentChoices,
  onSetExternalAgentConfigOption,
  onSetDraftExternalAgentChoice,
  modeSwitchProps,
}: {
  agentId: string;
  sessionId: string | null;
  sessionProviderId: string | null | undefined;
  externalAgentConfig: ExternalAgentConfigState | null | undefined;
  draftProviderId: string | null | undefined;
  draftExternalAgentChoices?: Readonly<Record<string, ExternalAgentDraftChoices>>;
  onSetExternalAgentConfigOption?: (configId: string, value: string) => void;
  onSetDraftExternalAgentChoice?: (agentId: string, configId: string, value: string) => void;
  modeSwitchProps: ModeSwitchProps;
}) {
  const catalog = useAcpAgentCatalog(agentId);
  const canSend = Boolean(
    sessionId ? onSetExternalAgentConfigOption : onSetDraftExternalAgentChoice,
  );
  const state = useMemo(() => {
    const resolved = resolveExternalAgentComposerState({
      draftProviderId,
      sessionId,
      sessionProviderId,
      projection: externalAgentConfig,
      catalog: catalog.options,
      draftChoices: draftExternalAgentChoices?.[agentId],
    });
    return resolved && !canSend ? { ...resolved, options: null } : resolved;
  }, [
    agentId,
    canSend,
    catalog.options,
    draftExternalAgentChoices,
    draftProviderId,
    externalAgentConfig,
    sessionId,
    sessionProviderId,
  ]);
  const onSetOption = state?.draft
    ? (configId: string, value: string) => onSetDraftExternalAgentChoice?.(agentId, configId, value)
    : (onSetExternalAgentConfigOption ?? noop);
  if (!state) return <V4ComposerModeSwitch {...modeSwitchProps} />;
  return (
    <V4ExternalAgentConfigControls
      state={state}
      disabled={modeSwitchProps.disabled}
      activeConfigPicker={modeSwitchProps.activeConfigPicker}
      onConfigPickerOpenChange={modeSwitchProps.onConfigPickerOpenChange}
      onSetOption={onSetOption}
    />
  );
}

/**
 * ACP models get the agent's selects; every other model renders the ZCode mode switch unchanged. Before the session
 * exists the selects show the agent catalog (the host reads it) with the draft's choices, and a choice only updates
 * the draft.
 */
function V4ComposerModeAreaImpl({
  sessionId,
  sessionProviderId,
  externalAgentConfig,
  onSetExternalAgentConfigOption,
  draftExternalAgentChoices,
  onSetDraftExternalAgentChoice,
  ...modeSwitchProps
}: V4ComposerModeAreaProps) {
  const draftProviderId = modeSwitchProps.draftConfig?.modelSelection?.providerId;
  const agentId = resolveExternalAgentId(draftProviderId);
  if (!agentId) return <V4ComposerModeSwitch {...modeSwitchProps} />;
  return (
    <V4ExternalAgentModeAreaImpl
      agentId={agentId}
      sessionId={sessionId}
      sessionProviderId={sessionProviderId}
      externalAgentConfig={externalAgentConfig}
      draftProviderId={draftProviderId}
      draftExternalAgentChoices={draftExternalAgentChoices}
      onSetExternalAgentConfigOption={onSetExternalAgentConfigOption}
      onSetDraftExternalAgentChoice={onSetDraftExternalAgentChoice}
      modeSwitchProps={modeSwitchProps}
    />
  );
}
export const V4ComposerModeArea = memo(V4ComposerModeAreaImpl);
