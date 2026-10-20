import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { IMemoryService, ProjectMemoryWorkspaceSummary } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_OPEN_FOLDER,
  TID_SETTINGS_MEMORY_REFRESH,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  TID_SETTINGS_MEMORY_WORKSPACE,
} from "@zcode/shared/test-ids";
import { Accordion } from "@/components/ui/accordion.js";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import { FolderOpen } from "lucide-react";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  classifyMemoryPreviewError,
  MemoryFileAccordionItem,
  type MemoryPreviewRecord,
} from "@/settings/MemorySettingsFileAccordion.js";
import {
  formatMemoryDayGroupLabel,
  formatMemoryLastDreamLabel,
  startOfLocalDay,
} from "@/settings/memoryUpdatedAt.js";

export type MemoryViewerLoadingState = "idle" | "loading" | "ready" | "error";

type MemoryPreviewService = Pick<
  IMemoryService,
  "readProjectMemoryFile" | "getProjectMemoryDirectory"
>;

interface MemoryDayGroup {
  dayStart: number;
  label: string;
  files: ProjectMemoryWorkspaceSummary["files"];
}

export function MemorySettingsViewer({
  catalogError,
  catalogState,
  memoryService,
  selectedWorkspace,
  workspaces,
  onRefresh,
  onScopeKeyChange,
}: {
  catalogError: string | null;
  catalogState: MemoryViewerLoadingState;
  memoryService: MemoryPreviewService;
  selectedWorkspace: ProjectMemoryWorkspaceSummary | undefined;
  workspaces: ProjectMemoryWorkspaceSummary[];
  onRefresh: () => Promise<void>;
  onScopeKeyChange: (workspaceId: string) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const [searchQuery, setSearchQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [openFileNames, setOpenFileNames] = useState<readonly string[]>([]);
  const [previews, setPreviews] = useState<Map<string, MemoryPreviewRecord>>(new Map());
  const openFileNamesRef = useRef(openFileNames);
  const previewsRef = useRef(previews);
  const previewRequestIdRef = useRef(0);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useLayoutEffect(() => {
    openFileNamesRef.current = openFileNames;
  }, [openFileNames]);

  useLayoutEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  // A catalog refresh or a workspace switch invalidates in-flight and cached previews and closes
  // the accordion so a stale file name never renders another workspace's content. The scope id is
  // part of the deps because switching scopes keeps catalogState at "ready"; useLayoutEffect so
  // the stale preview is never painted.
  useLayoutEffect(() => {
    previewRequestIdRef.current += 1;
    openFileNamesRef.current = [];
    previewsRef.current = new Map();
    setPreviews(new Map());
    setOpenFileNames([]);
  }, [catalogState, selectedWorkspace?.id]);

  const formatMemoryCount = (count: number) =>
    intl.formatPlural({ id: "settings.memory.viewer.memoryCount" }, count);
  const timeFormatContext = { formatMessage: intl.formatMessage, locale, now };
  const lastDreamLabel = formatMemoryLastDreamLabel({
    ...timeFormatContext,
    lastDreamConsolidatedAt: selectedWorkspace?.lastDreamConsolidatedAt,
  });
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      selectedWorkspace?.files.filter(
        (file) =>
          file.name.toLocaleLowerCase().includes(normalizedSearchQuery) ||
          (file.description ?? "").toLocaleLowerCase().includes(normalizedSearchQuery),
      ) ?? [],
    [normalizedSearchQuery, selectedWorkspace],
  );
  const indexFile = visibleFiles.find((file) => file.kind === "index");
  const dayGroups = useMemo<MemoryDayGroup[]>(() => {
    const buckets = new Map<number, ProjectMemoryWorkspaceSummary["files"]>();
    for (const file of visibleFiles) {
      if (file.kind === "index") {
        continue;
      }
      const dayStart = startOfLocalDay(file.updatedAt);
      const bucket = buckets.get(dayStart);
      if (bucket) {
        bucket.push(file);
      } else {
        buckets.set(dayStart, [file]);
      }
    }
    return [...buckets.entries()]
      .sort(([left], [right]) => right - left)
      .map(([dayStart, files]) => ({
        dayStart,
        label: formatMemoryDayGroupLabel({
          ...timeFormatContext,
          updatedAt: dayStart,
        }),
        files: [...files].sort((left, right) => right.updatedAt - left.updatedAt),
      }));
  }, [intl, locale, now, visibleFiles]);

  const loadPreview = useCallback(
    (workspaceId: string, fileName: string) => {
      const requestId = previewRequestIdRef.current + 1;
      previewRequestIdRef.current = requestId;
      // The request id lives in the loading entry itself: with multiple rows open, file B's
      // request must not invalidate file A's in-flight callbacks (scoped per file, not global).
      setPreviews((previous) => new Map(previous).set(fileName, { status: "loading", requestId }));
      return memoryService
        .readProjectMemoryFile({ workspaceId, fileName })
        .then((result) => {
          setPreviews((previous) => {
            const entry = previous.get(fileName);
            if (entry?.status !== "loading" || entry.requestId !== requestId) {
              return previous;
            }
            return new Map(previous).set(fileName, {
              status: "ready",
              content: result.content,
            });
          });
        })
        .catch((error: unknown) => {
          setPreviews((previous) => {
            const entry = previous.get(fileName);
            if (entry?.status !== "loading" || entry.requestId !== requestId) {
              return previous;
            }
            return new Map(previous).set(fileName, {
              status: "error",
              kind: classifyMemoryPreviewError(error),
              message: error instanceof Error ? error.message : String(error),
            });
          });
          throw error;
        });
    },
    [memoryService],
  );

  const recordPreviewExpansion = useCallback(
    (workspaceId: string, fileName: string) => {
      void runUserActionAsync({
        input: { featureId: "settings.memory", action: "expand_preview", trigger: "button" },
        operation: () => loadPreview(workspaceId, fileName),
        completed: { resultSource: "local_commit" },
        failureStage: "preview_read",
      }).catch((error: unknown) => {
        // The failed preview is already represented in the row; log the rejected telemetry operation.
        logger.warn("[MemorySettingsViewer] Failed to load memory preview:", error);
      });
    },
    [loadPreview],
  );

  const handleAccordionValueChange = useCallback(
    (files: ProjectMemoryWorkspaceSummary["files"], value: string[]) => {
      const previousNames = openFileNamesRef.current;
      const fileNames = new Set(files.map((file) => file.name));
      const nextNames = [...previousNames.filter((name) => !fileNames.has(name)), ...value];
      openFileNamesRef.current = nextNames;
      setOpenFileNames(nextNames);
      if (!selectedWorkspace) {
        return;
      }
      for (const file of files) {
        if (!value.includes(file.name) || previousNames.includes(file.name)) {
          continue;
        }
        const preview = previewsRef.current.get(file.name);
        if (!preview || preview.status === "error") {
          recordPreviewExpansion(selectedWorkspace.id, file.name);
        }
      }
    },
    [recordPreviewExpansion, selectedWorkspace?.id],
  );

  const toggleFile = useCallback(
    (fileName: string) => {
      const previousNames = openFileNamesRef.current;
      const isOpen = previousNames.includes(fileName);
      const nextNames = isOpen
        ? previousNames.filter((name) => name !== fileName)
        : [...previousNames, fileName];
      openFileNamesRef.current = nextNames;
      setOpenFileNames(nextNames);
      const preview = previewsRef.current.get(fileName);
      if (!isOpen && selectedWorkspace && (!preview || preview.status === "error")) {
        recordPreviewExpansion(selectedWorkspace.id, fileName);
      }
    },
    [recordPreviewExpansion, selectedWorkspace?.id],
  );

  const handleOpenFolder = async (workspaceId: string) => {
    await runUserActionAsync({
      input: { featureId: "settings.memory", action: "open_folder", trigger: "menu" },
      operation: async () => {
        const { path } = await memoryService.getProjectMemoryDirectory({ workspaceId });
        const result = await platform.openInFileManager(path);
        if (!result.success) {
          throw new Error(result.error);
        }
        return result;
      },
      completed: { resultSource: "platform_result" },
      failureStage: "open_memory_folder",
    }).catch((error: unknown) => {
      logger.warn("[MemorySettingsViewer] Failed to open memory folder:", error);
    });
  };

  if (catalogError) {
    return (
      <Alert>
        <AlertDescription>{catalogError}</AlertDescription>
      </Alert>
    );
  }

  if (catalogState === "loading" && workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.loading" })}
      </div>
    );
  }

  if (!selectedWorkspace) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.empty" })}
      </div>
    );
  }

  const renderFileList = (files: ProjectMemoryWorkspaceSummary["files"]) => (
    <Accordion
      type="multiple"
      className="overflow-hidden rounded-xl bg-surface"
      value={openFileNames.filter((name) => files.some((file) => file.name === name))}
      onValueChange={(value) => handleAccordionValueChange(files, value)}
    >
      {files.map((file, index) => (
        <Fragment key={file.name}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <MemoryFileAccordionItem
            file={file}
            open={openFileNames.includes(file.name)}
            preview={previews.get(file.name)}
            onToggle={toggleFile}
          />
        </Fragment>
      ))}
    </Accordion>
  );

  return (
    <section className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginScopeMenu
            includeUser={false}
            selectedScopeKey={selectedWorkspace.id}
            workspaceOptions={workspaces.map((workspace) => ({
              key: workspace.id,
              label: workspace.label,
            }))}
            onScopeKeyChange={onScopeKeyChange}
            triggerIconTestId={TID_SETTINGS_MEMORY_SCOPE_ICON}
            triggerTestId={TID_SETTINGS_MEMORY_SCOPE_TRIGGER}
            workspaceOptionTestIdPrefix={TID_SETTINGS_MEMORY_WORKSPACE}
          />
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <span
            data-testid={TID_SETTINGS_MEMORY_COUNT}
            className="shrink-0 text-ui-sm text-foreground-subtle"
          >
            {formatMemoryCount(selectedWorkspace.files.length)}
          </span>
          {lastDreamLabel ? (
            <span className="shrink-0 border-l border-border pl-3 text-ui-sm text-foreground-subtle">
              {lastDreamLabel}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-md"
                aria-label={intl.formatMessage({ id: "settings.memory.viewer.openFolder" })}
                data-testid={TID_SETTINGS_MEMORY_OPEN_FOLDER}
              >
                <FolderOpen aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {workspaces.map((workspace) => (
                <DropdownMenuItem
                  key={workspace.id}
                  onSelect={() => void handleOpenFolder(workspace.id)}
                >
                  {workspace.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <SettingsSearchInput
            containerClassName="w-full sm:w-64"
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            clearTestId={TID_SETTINGS_MEMORY_SEARCH_CLEAR}
            data-testid={TID_SETTINGS_MEMORY_SEARCH_INPUT}
            value={searchQuery}
            onClear={() => setSearchQuery("")}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.memory.viewer.searchPlaceholder",
            })}
          />
        </div>
      </div>

      {normalizedSearchQuery && visibleFiles.length === 0 ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.memory.viewer.searchEmpty",
          })}
        />
      ) : (
        <>
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.memory.viewer.files" })}
            </h3>
            <SettingsResourceHeaderActions
              onRefresh={() => void onRefresh()}
              refreshing={catalogState === "loading"}
              refreshTestId={TID_SETTINGS_MEMORY_REFRESH}
              refreshLabel={intl.formatMessage({
                id: "settings.memory.viewer.refresh",
              })}
            />
          </div>
          {indexFile ? (
            <section className="space-y-2">
              <h3 className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "settings.memory.viewer.indexSection" })}
              </h3>
              {renderFileList([indexFile])}
            </section>
          ) : null}
          {dayGroups.map((group) => (
            <section className="space-y-2" key={group.dayStart}>
              <h3 className="sticky top-0 z-10 bg-background py-2 text-ui-sm font-medium text-foreground-subtle">
                {group.label}
              </h3>
              {renderFileList(group.files)}
            </section>
          ))}
        </>
      )}
    </section>
  );
}
