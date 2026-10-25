import { useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import {
  TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
  TID_WORKSPACE_HELP_MENU_TRIGGER,
} from "@zcode/shared/test-ids";
import {
  ActivityIcon,
  BookOpenIcon,
  CircleHelpIcon,
  CopyIcon,
  DownloadIcon,
  LightbulbIcon,
  InfoIcon,
  MessageSquareIcon,
  UsersIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useDesktopUpdateMenu } from "@/hooks/useDesktopUpdateMenu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useVulnerabilityReportUrl } from "@/hooks/useVulnerabilityReportUrl.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createHelpMenuActionHandlers } from "@/lib/helpMenuActions.js";

export function WorkspaceHelpMenuButton({
  className,
  isDesktop = false,
}: {
  className?: string;
  /**
   * Whether this is Desktop. Inject this from the mount site instead of sniffing inside the component: the Web IPlatformService stub also implements
   * executeDesktopCommand (as a no-op), so using it for detection would show a nonfunctional “File Explorer” entry on Web.
   */
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const { url: vulnerabilityReportUrl, loading: vulnerabilityReportLoading } =
    useVulnerabilityReportUrl(open);
  const updateMenu = useDesktopUpdateMenu(isDesktop);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeatureRequest = useFeedbackStore((state) => state.openFeatureRequest);
  const helpMenuLabel = intl.formatMessage({ id: "workspaceHeader.help.menu" });
  const helpMenuActions = createHelpMenuActionHandlers({
    platform,
    intl,
    openSubmit: openFeedbackSubmit,
  });
  const handleOpenCommunity = () => {
    void platform.openCommunity();
  };
  const handleOpenResourceManager = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.OpenResourceManager);
  };

  const handleShowAbout = () => {
    void platform.executeDesktopCommand(DesktopCommandIds.ShowAbout);
  };

  // Copies the device MID for support requests. The value goes only to the clipboard; it is never logged.
  const handleCopyDeviceMid = async () => {
    try {
      const deviceMid = platform.getDeviceId();
      if (!deviceMid || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(deviceMid);
      toast(intl.formatMessage({ id: "workspaceHeader.help.deviceMidCopied" }));
    } catch {
      toast(intl.formatMessage({ id: "workspaceHeader.help.deviceMidCopyFailed" }));
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ControlHintTooltip title={helpMenuLabel} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            // The Settings page positions the help button absolutely above Electron’s top drag region.
            // With no-drag only on the outer container, the title-bar drag region could still swallow clicks on the actual trigger.
            className={cn(
              "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
              className,
            )}
            aria-label={helpMenuLabel}
            data-testid={TID_WORKSPACE_HELP_MENU_TRIGGER}
          >
            <CircleHelpIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent
        align="end"
        className="min-w-0 w-max [&_[data-slot=dropdown-menu-item]]:pr-6"
      >
        <DropdownMenuItem onSelect={helpMenuActions.openProductDocs}>
          <BookOpenIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.docs" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleOpenCommunity}>
          <UsersIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.community" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={helpMenuActions.openIssueReport}>
          <MessageSquareIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.issueReport" })}
        </DropdownMenuItem>
        {vulnerabilityReportLoading || vulnerabilityReportUrl ? (
          <DropdownMenuItem
            disabled={vulnerabilityReportLoading}
            aria-busy={vulnerabilityReportLoading}
            onSelect={
              vulnerabilityReportUrl
                ? () => platform.openExternal(vulnerabilityReportUrl)
                : undefined
            }
          >
            <ShieldAlertIcon className="size-4" />
            {intl.formatMessage({ id: "workspaceHeader.help.reportVulnerability" })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={openFeatureRequest}>
          <LightbulbIcon className="size-4" />
          {intl.formatMessage({ id: "workspaceHeader.help.productRequest" })}
        </DropdownMenuItem>
        {/* Windows/Linux have no native menu bar, and the custom title-bar arrow menu has been removed,
            so File Explorer is accessible only here; Web has no such window, so do not render it. */}
        {isDesktop ? (
          <>
            <DropdownMenuSeparator />
            {/* The standalone export entry had been removed; reuse the original menu action to keep packaging, system location, and hints consistent. */}
            <DropdownMenuItem onSelect={helpMenuActions.exportLogs}>
              <DownloadIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.exportLogs" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCopyDeviceMid}>
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "workspaceHeader.help.copyDeviceMid" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid={TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER}
              onSelect={handleOpenResourceManager}
            >
              <ActivityIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.resourceManager" })}
            </DropdownMenuItem>
            {updateMenu.visible ? (
              <DropdownMenuItem
                disabled={updateMenu.disabled}
                onSelect={updateMenu.checkForUpdates}
              >
                <RefreshCwIcon className="size-4" />
                {updateMenu.labelId === "desktopMenu.help.restartToUpdate" ? (
                  <>
                    <span className="whitespace-nowrap">
                      {intl.formatMessage({ id: "desktopMenu.help.restartUpdateAction" })}
                    </span>
                    <Badge
                      variant="secondary"
                      className="h-4 px-1.5 py-0 bg-success/10 text-success"
                    >
                      {updateMenu.labelValues?.version}
                    </Badge>
                  </>
                ) : (
                  intl.formatMessage({ id: updateMenu.labelId }, updateMenu.labelValues)
                )}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={handleShowAbout}>
              <InfoIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.about" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
