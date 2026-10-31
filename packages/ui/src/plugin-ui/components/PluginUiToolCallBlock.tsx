import { Button } from "@/components/ui/button.js";
import { PluginIcon } from "@/components/PluginIcon.js";
import { PluginUiCard } from "@/plugin-ui/components/PluginUiCard.js";
import type { PluginUiToolCallViewProps } from "@/plugin-ui/contract.js";
import { TID_PLUGIN_UI_OPEN_SIDE_PANE } from "@zcode/shared/test-ids";
import { PanelRightOpenIcon, PinIcon, PinOffIcon } from "lucide-react";

/** Pure tool card view: platform capabilities, result, and side pane ownership are all supplied by the adapter. */
export function PluginUiToolCallView(props: PluginUiToolCallViewProps) {
  // The old UI has been taken over by the updated result; drawing a replacement placeholder would flood the transcript with noise; keep only the expandable plain tool result.
  if (!props.supported || props.superseded) return props.fallback;
  return (
    <div
      className="space-y-2"
      data-plugin-ui-preferred-display-mode={props.preferredDisplayMode}
      {...(props.surface ? { "data-plugin-ui-surface": props.surface } : {})}
    >
      {props.fallback}
      {props.sidePaneActive || !props.inlineAllowed ? (
        <div
          className="flex min-w-0 items-center gap-3 rounded-xl border border-card-border bg-card px-4 py-3"
          data-testid="plugin-ui-side-pane-placeholder"
        >
          <PluginIcon
            key={props.pluginIcon ?? props.pluginId}
            pluginId={props.pluginId}
            src={props.pluginIcon}
            className="size-10 rounded-lg"
            iconClassName="size-5"
          />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-ui-base font-medium text-foreground"
              title={props.pluginName}
            >
              {props.pluginName}
            </div>
            <div className="text-ui-sm text-foreground-subtle">
              {props.sidePaneActive ? props.openedLabel : props.openLabel}
            </div>
          </div>
          {props.onOpenSidePane ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              data-testid={TID_PLUGIN_UI_OPEN_SIDE_PANE}
              aria-label={props.openLabel}
              onClick={props.onOpenSidePane}
            >
              <PanelRightOpenIcon className="size-4" />
              {props.openButtonLabel}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="relative">
          {/* The fixed carrier layer is independent of the virtual list's stacking context; host buttons stay outside the page anchor. */}
          <div className="mb-1 flex justify-end gap-1">
            {props.onTogglePin ? (
              // 4b-1: manual pin / collapse, independent of the "auto-expand for the last three turns" default rule.
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full bg-background/80"
                data-testid="plugin-ui-pin-toggle"
                data-plugin-ui-pinned={String(props.pinned === true)}
                aria-label={props.pinned ? props.unpinLabel : props.pinLabel}
                title={props.pinned ? props.unpinLabel : props.pinLabel}
                onClick={props.onTogglePin}
              >
                {props.pinned ? (
                  <PinOffIcon className="size-3.5" />
                ) : (
                  <PinIcon className="size-3.5" />
                )}
              </Button>
            ) : null}
            {props.onOpenSidePane ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full bg-background/80"
                data-testid={TID_PLUGIN_UI_OPEN_SIDE_PANE}
                aria-label={props.openLabel}
                title={props.openLabel}
                onClick={props.onOpenSidePane}
              >
                <PanelRightOpenIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
          <PluginUiCard
            pageKey={props.host.pageKey}
            handle={props.host.handle}
            phase={props.host.phase}
            height={props.host.height}
            prefersBorder={props.prefersBorder}
            error={props.host.error}
            loadingLabel={props.loadingLabel}
            errorLabel={props.errorLabel}
            retryLabel={props.retryLabel}
            onRetry={props.host.reload}
            onWidthChange={props.onWidthChange}
          />
        </div>
      )}
    </div>
  );
}
