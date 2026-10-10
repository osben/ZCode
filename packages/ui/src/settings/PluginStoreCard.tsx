import {
  Crown,
  Download,
  Loader2,
  MoreHorizontal,
  Power,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import {
  canUpdatePluginItem,
  resolveItemDescription,
  resolveItemDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

/** Shared action set for marketplace entries: list cards and detail pages use the same callbacks and in-progress-state checks. */
export interface PluginStoreActions {
  onOpenDetail: (pluginId: string) => void;
  /** Install or restore (restorable built-in Plugins use restoreBuiltin; others use install). */
  onInstall: (item: StorePluginItem) => void;
  onUninstall: (pluginId: string) => void;
  onSetEnabled?: (pluginId: string, enabled: boolean) => void;
  /** Delete the explicit configuration for the current Workspace scope so it falls back to User. */
  onResetConfig?: (pluginId: string) => void;
  onUpdate: (pluginId: string) => void;
  operationId: string | null;
  togglingPluginId: string | null;
}

function isItemBusy(item: StorePluginItem, actions: PluginStoreActions): boolean {
  return (
    actions.operationId === `plugin:install:${item.name}@${item.marketplace}` ||
    actions.operationId === `plugin:restore:${item.id}` ||
    actions.operationId === `plugin:uninstall:${item.id}` ||
    actions.operationId === `plugin:update:${item.id}` ||
    actions.operationId === `plugin:reset-config:${item.id}` ||
    actions.togglingPluginId === item.id
  );
}

/**
 * Paid-plan notice: when a catalog entry declares `listing.requiresPaidPlan`, show a gradient badge to the right of the title.
 * This describes the condition “works best with a paid plan,” not “the plugin is a paid product”—it does not gate installation.
 * The store card and detail-page title share the same gradient badge.
 * Use short copy on the badge and express the full condition in Tooltip and aria-label; omit the entire marker when the field is missing.
 * Hover help uses ControlHintTooltip (Root Provider delayDuration=0, so it appears immediately),
 * not native title, which has about a one-second system delay.
 */
export function PluginStorePaidPlanBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "listing">;
}) {
  const { intl } = useZCodeIntl();
  if (!item.listing?.requiresPaidPlan) return null;
  const label = intl.formatMessage({ id: "settings.plugins.store.requiresPaidPlan" });
  const badgeLabel = intl.formatMessage({ id: "settings.plugins.store.paidPlanBadge" });
  return (
    <ControlHintTooltip title={label}>
      <span
        data-testid="plugin-store-paid-plan-badge"
        data-plugin-id={item.id}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-plugin-paid-plan-badge)] px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-[var(--color-plugin-paid-plan-badge-foreground)]"
        aria-label={label}
      >
        <Crown className="size-3" aria-hidden="true" />
        {badgeLabel}
      </span>
    </ControlHintTooltip>
  );
}

/** “…” menu for installed entries: enable/disable, update (when available), and uninstall. Shared by the card and detail page. */
export function PluginStoreItemMenu({
  item,
  actions,
  triggerClassName,
  triggerVariant = "ghost",
  triggerSize = "icon-md",
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  triggerClassName?: string;
  triggerVariant?: "ghost" | "outline";
  triggerSize?: "icon-md" | "icon-lg";
}) {
  const { intl } = useZCodeIntl();
  const enabled = item.info?.enabled ?? false;
  const updatePending = canUpdatePluginItem(item);
  const busy = isItemBusy(item, actions);
  const canToggleEnabled = Boolean(item.info && actions.onSetEnabled);
  // Do not render a separator unconditionally based on item.installed. When enable/disable/update/restore-config are all absent,
  // Uninstall is the only menu item but an orphaned line remains above it. Show the separator only when another action precedes Uninstall.
  const hasActionsBeforeUninstall =
    canToggleEnabled || updatePending || Boolean(actions.onResetConfig);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/**
         * The original implementation declared data-testid twice, causing TSX compilation error TS17001;
         * keeping one test ID is sufficient.
         */}
        <Button
          type="button"
          data-testid="plugin-store-item-menu"
          data-plugin-id={item.id}
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          aria-label={intl.formatMessage({ id: "settings.plugins.store.menu.label" })}
          onClick={(event) => event.stopPropagation()}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <MoreHorizontal className="size-4" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {canToggleEnabled ? (
          <DropdownMenuItem
            data-testid="plugin-store-menu-enabled"
            data-plugin-id={item.id}
            disabled={busy}
            onSelect={() => actions.onSetEnabled?.(item.id, !enabled)}
          >
            <Power className="size-4" aria-hidden="true" />
            {enabled
              ? intl.formatMessage({ id: "settings.plugins.store.menu.disable" })
              : intl.formatMessage({ id: "settings.plugins.store.menu.enable" })}
          </DropdownMenuItem>
        ) : null}
        {updatePending ? (
          <DropdownMenuItem
            data-testid="plugin-store-menu-update"
            data-plugin-id={item.id}
            disabled={busy}
            onSelect={() => actions.onUpdate(item.id)}
          >
            <Download className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.detail.update" })}
          </DropdownMenuItem>
        ) : null}
        {actions.onResetConfig ? (
          <DropdownMenuItem
            data-testid="plugin-store-menu-reset-config"
            data-plugin-id={item.id}
            disabled={busy}
            onSelect={() => actions.onResetConfig?.(item.id)}
          >
            {intl.formatMessage({ id: "settings.plugins.store.menu.resetConfig" })}
          </DropdownMenuItem>
        ) : null}
        {item.installed ? (
          <>
            {hasActionsBeforeUninstall ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid="plugin-store-menu-uninstall"
              data-plugin-id={item.id}
              variant="destructive"
              disabled={busy}
              onSelect={() => actions.onUninstall(item.id)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.detail.uninstall" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Install/restore pill button (shared by cards for uninstalled entries and the detail-page primary button). */
export function PluginStoreInstallButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  const installing =
    actions.operationId === `plugin:install:${item.name}@${item.marketplace}` ||
    actions.operationId === `plugin:restore:${item.id}`;
  return (
    <Button
      type="button"
      data-testid="plugin-store-install"
      data-plugin-id={item.id}
      variant="secondary"
      size={size}
      className="rounded-full"
      disabled={installing}
      onClick={(event) => {
        event.stopPropagation();
        runUserAction({
          input: { featureId: "extension.plugin", action: "install", trigger: "button" },
          operation: () => actions.onInstall(item),
          completed: { resultSource: "optimistic_projection" },
          failureStage: "plugin_install",
        });
      }}
    >
      {installing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
      {installing
        ? intl.formatMessage({ id: "settings.plugins.marketplace.installing" })
        : intl.formatMessage({ id: "settings.plugins.store.install" })}
    </Button>
  );
}

/** “Update available” badge for installed entries: mark updated plugins in list/card title rows using the same check as the detail-page entry. */
export function PluginStoreUpdateBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "installedMeta" | "orphaned"> | null | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (!canUpdatePluginItem(item)) return null;
  const label = intl.formatMessage({ id: "settings.plugins.list.updateAvailable" });
  return (
    <span
      data-testid="plugin-store-update-badge"
      data-plugin-id={item?.id}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/14 px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-success dark:bg-success/18"
      aria-label={label}
    >
      <Download className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Inline “Update” pill: update installed entries that have an update without opening the detail page. */
export function PluginStoreUpdateButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem | null | undefined;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  if (!item || !canUpdatePluginItem(item)) return null;
  const updating = actions.operationId === `plugin:update:${item.id}`;
  return (
    <Button
      type="button"
      data-testid="plugin-store-card-update"
      data-plugin-id={item.id}
      variant="secondary"
      size={size}
      className="rounded-full"
      disabled={actions.operationId !== null}
      onClick={(event) => {
        event.stopPropagation();
        actions.onUpdate(item.id);
      }}
    >
      {updating ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-3.5" aria-hidden="true" />
      )}
      {intl.formatMessage({ id: "settings.plugins.detail.update" })}
    </Button>
  );
}

/**
 * Store card (two-column grid cell): 40px avatar + display name + single-line truncated description;
 * trailing action: installed → “…” menu, not installed → “Install” pill. Clicking the body opens the detail page.
 */
export function PluginStoreCard({
  item,
  actions,
  locale,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  const displayName = resolveItemDisplayName(item, locale);
  const description = resolveItemDescription(item, locale);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="plugin-store-card"
      data-plugin-id={item.id}
      className="group/card flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={() => actions.onOpenDetail(item.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          actions.onOpenDetail(item.id);
        }
      }}
    >
      <PluginStoreAvatar item={item} className="size-10" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">
            {displayName}
          </span>
          <PluginStorePaidPlanBadge item={item} />
          <PluginStoreUpdateBadge item={item} />
        </div>
        {item.orphaned ? (
          <div
            data-testid="plugin-store-source-degraded"
            data-plugin-id={item.id}
            className="mt-0.5 flex items-center gap-1 truncate text-ui-sm text-warning"
          >
            <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {intl.formatMessage({ id: "settings.plugins.store.sourceMissing" })}
            </span>
          </div>
        ) : null}
        {description ? (
          <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {item.installed ? (
          <>
            <PluginStoreUpdateButton item={item} actions={actions} />
            {/* A previous bad suppression write may leave only an installation record with no
                    runtime info. Keep the Uninstall menu available so users can remove the record
                    and stale suppression entry. */}
            <PluginStoreItemMenu item={item} actions={actions} />
          </>
        ) : (
          <PluginStoreInstallButton item={item} actions={actions} />
        )}
      </div>
    </div>
  );
}
