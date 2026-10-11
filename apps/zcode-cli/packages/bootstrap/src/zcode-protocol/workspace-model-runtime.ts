/* eslint-disable max-lines -- Workspace model protocols and compatibility request handling remain centralized in this file. */
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import type { ModelSelection } from "@zcode/contracts";
import {
  zcodeProviderTestModelConnectivityParamsSchema,
  zcodeWorkspaceReadPresentationParamsSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../app/types.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import {
  parseParams,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { createProviderRuntimeHeadersPort } from "./provider-runtime-headers.js";

export async function readWorkspacePresentation(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);
  return {
    workspace: params.workspace,
    mode: "build" as const,
    slashCommands: await listProtocolSlashCommands({
      // The rollout gate is a Host-determined workspace-level fact; catalog assembly reads the process cache.
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
      workingDirectory: params.workspace.workspacePath,
    }),
  };
}

export async function testProviderModelConnectivity(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeProviderTestModelConnectivityParamsSchema, rawParams);
  // The old cross-process Personal Config watcher could permanently miss atomic-write events.
  // Without refreshing first, a connection test would keep querying the old Registry. Reuse the
  // official Registry refresh here; do not create configuration facts through a side path.
  await context.deps.refreshProviderRegistry?.("provider-connectivity");
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: { workingDirectory: params.workspace.workspacePath },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));
  try {
    await app.testModelConnectivity(
      { selection: params.selection as ModelSelection },
      { abortSignal },
    );
    return { success: true as const };
  } finally {
    if (!active) await app.close?.();
  }
}

export async function createWorkspaceZCodeApp(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
  options: Omit<ZCodeAppOptions, "providerRegistry">,
): Promise<ZCodeApp> {
  const providerRuntimeHeadersPort =
    options.providerRuntimeHeadersPort ?? createProviderRuntimeHeadersPort(context, workspace);
  return context.deps.createZCodeApp({
    ...options,
    includeVisualize: true,
    platform: context.deps.platform,
    providerRuntimeHeadersPort,
    runtimeConfig: {
      ...options.runtimeConfig,
      // createZCodeApp normalizes workingDirectory to the execution cwd. Inject the protocol entry's
      // workspacePath into runtime separately so session persistence retains the local workspaceKey path representation.
      workspacePath: workspace.workspacePath,
      // A remote session is a second isolation boundary for shared-host CUA. Passing only
      // workspacePath/identity would let different attachments for the same remote workspace reuse
      // Accessibility frame/action state. Keep this in the helper rather than individual call sites
      // so both session creation paths use the same isolation key.
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
      ...(workspace.workspaceIdentity
        ? {
            memory: {
              ...options.runtimeConfig?.memory,
              workspaceIdentity: workspace.workspaceIdentity,
            },
          }
        : {}),
      // Electron/Protocol main sessions previously did not explicitly enable model streaming like
      // CLI/TUI sessions. Main turns therefore fell back to non-streaming generateText requests,
      // which failed JSON parsing against compatible endpoints that return SSE.
      modelStreaming: options.runtimeConfig?.modelStreaming ?? "on",
    },
  });
}

export function hasSessionModelProvider(
  _context: ZCodeProtocolAgentServerContext,
  record: Pick<ZCodeProtocolSessionRecord, "app" | "workspace">,
  providerId: string,
): boolean {
  return record.app.listModels().some((model) => model.ref.providerId === providerId);
}

async function ensureSessionModelAvailableUnlocked(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<boolean> {
  // Do not silently replace a user's selection with the first Registry entry when an existing model
  // becomes invalid. Keep the selection unbound and let recovery/Composer selection validation and
  // the first-request gate handle it; do not write another default-model fact here.
  // Keep this transitional entry point so legacy protocol callers can be retired smoothly.
  void context;
  void record;
  return false;
}

export async function ensureSessionModelAvailable(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<boolean> {
  return runSessionModelConfigMutation(record.app, () =>
    ensureSessionModelAvailableUnlocked(context, record),
  );
}

export function resolveSessionModelContextWindow(
  _context: ZCodeProtocolAgentServerContext,
  record: Pick<ZCodeProtocolSessionRecord, "app" | "workspace" | "restoredModelSelection">,
): number | undefined {
  // A missing tier leaves the recovered selection temporarily unbound from Runtime, but model
  // identity can still be used to read capacity. Do not fabricate a 200k capacity.
  const selection = record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
  const value = selection && record.app.getModelOption?.(selection)?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
