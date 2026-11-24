// ============================================================
// Dynamic Workflow rollout: server feature-key values and the client snapshot.
// ============================================================
// The server sends `data.configs.dynamicWorkflow.mode` via `/api/v1/client/configs`.

// This contains only the value set, normalization, and snapshot shape shared by Host services, Desktop main, and UI;
// each owner handles remote reads, overrides, and delivery; the shared layer makes no requests.

export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/**
 * Environment variable for local overrides. Semantics have three build-profile layers; Desktop main **rewrites or deletes** it before forking the Host
 * (`buildHostProcessEnv` in desktopRuntimeEnv.ts), and the Host consumes the value without distinguishing its source:
 *   - Unpackaged dev: pass through a valid value from the developer's shell;
 *   - Packaged preview: always set `alwaysOn`, ignoring the shell;
 *   - Packaged production: delete inherited values and never set it.
 * Web/server Hosts without main read the process environment directly (set by operators/developers).
 */
export const ZCODE_DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/**
 * Value used when the server **responds successfully** but omits this key or sends an invalid value: disabled.
 * The server removing the key means turning the rollout off, so the old snapshot must not be reused. A failed request does not come here; see the next constant.
 */
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

/**
 * 灰度配置**请求失败**（断网、接口报错、远程设备连不上服务端、读取抛错）时的「提供」：onDemand。
 * 为什么与 key 缺失区分：请求失败说明不了服务端的意图，过去一律按 disabled 处理，
 * 离线启动的 Host 会到重启前都没有工作流入口；功能已全面可用，读不到也要保留入口。
 * 为什么是 onDemand 而不是 alwaysOn：alwaysOn 让每个新会话首轮就注册十个工作流工具，
 * 太占上下文；onDemand 入口（+ 菜单、/ 面板、自动化页、Resume）都在，模型工具面推迟到
 * `/workflow`、Resume 或恢复带工作流的会话才注册（launch.md「On demand: activation」）。
 * 只有一次成功响应才能把默认值关掉。用户选择与本地覆盖仍在它之上生效。
 */
export const DYNAMIC_WORKFLOW_MODE_ON_FETCH_FAILURE: DynamicWorkflowMode = "onDemand";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

/**
 * Folds the "feature enabled" state: both `onDemand` and `alwaysOn` mean enabled. The `/workflow` command, skills,
 * the workflow tab on the Automations page, and the Resume entry are available in both modes. The only difference is when model tools are registered
 * (launch.md "On demand: activation"); the CLI decides that from the mode, so this code does not participate.
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** Snapshot source, for observability: UI and logs use it to tell "disabled by server" from "local override". It only describes where the offered value came from. */
export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";

/**
 * Gray-release snapshot (launch.md "Gray release" and "The user's choice"). It has two layers:
 *   - Offer: the server key or local override decides the default mode, recorded in `offeredMode` (`disabled` is only a default);
 *   - Effective: the user's explicit choice in Settings always replaces the offered mode, recorded in `mode` / `enabled`.
 * Legacy consumers read `mode` / `enabled` for the effective value; the Settings page reads `offeredMode` to decide the "Default" label.
 */
export interface DynamicWorkflowClientConfig {
  /** Effective mode: the user's choice when one exists, otherwise equal to offeredMode. */
  readonly mode: DynamicWorkflowMode;
  /** Equal to isDynamicWorkflowModeEnabled(mode); stored separately so consumers do not each reimplement the folding rule. */
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
  /** Mode offered by the server (or local override): the effective mode when the user has not chosen, and the Settings "Default" option. */
  readonly offeredMode: DynamicWorkflowMode;
  /** The effective user choice; absent means follow the offered mode (no choice, or an invalid value). */
  readonly userMode?: DynamicWorkflowMode;
}

export function createDynamicWorkflowClientConfig(
  offeredMode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return {
    mode: offeredMode,
    enabled: isDynamicWorkflowModeEnabled(offeredMode),
    source,
    offeredMode,
  };
}

/**
 * Reads the server-offered default mode from a snapshot, independent of the user's choice. `disabled` is a valid default
 * (the Settings row still appears, with the "Default" label on "Off").
 *
 * Returns undefined when offeredMode is missing or unreadable. A snapshot may come from an older Host without offeredMode
 * (a new UI, for example the mobile remote-control bundle, connected to an older Desktop). Such an old Host does not honor user choices,
 * so showing the Settings row would write a choice that never takes effect. Only Hosts that understand user choices write this field.
 */
export function readDynamicWorkflowOfferedMode(
  config: DynamicWorkflowClientConfig,
): DynamicWorkflowMode | undefined {
  return normalizeDynamicWorkflowMode(config.offeredMode);
}

/**
 * The single implementation of the "server gives the default, the user's choice always wins" rule (launch.md "The user's choice"):
 *   - A valid user choice replaces the offered mode, including when the offer is `disabled`: the server only decides the default;
 *   - An absent or invalid value (old files, or values written by a future version) follows the offered mode.
 * It derives only from `offeredMode`, so applying a choice to an already-applied snapshot overrides rather than stacks: the Host latches the offer
 * and reapplies the latest choice on every use.
 */
export function applyDynamicWorkflowUserMode(
  config: DynamicWorkflowClientConfig,
  userMode: unknown,
): DynamicWorkflowClientConfig {
  const offer = createDynamicWorkflowClientConfig(config.offeredMode, config.source);
  const choice = normalizeDynamicWorkflowMode(userMode);
  if (!choice) return offer;
  return {
    ...offer,
    mode: choice,
    enabled: isDynamicWorkflowModeEnabled(choice),
    userMode: choice,
  };
}

/**
 * Pure function: folds the remote envelope `configs.dynamicWorkflow` and the local override environment variable into the offer, then applies the user's choice.
 * Offer precedence: override > valid remote value > default. A successful remote response that **omits** this key also means disabled:
 * the server removing the key means disabled, so an old snapshot must not be reused (same decision as desktopContextPromptRollout).
 */
export function resolveDynamicWorkflowClientConfig(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
  userMode?: unknown;
}): DynamicWorkflowClientConfig {
  return applyDynamicWorkflowUserMode(resolveDynamicWorkflowOffer(input), input.userMode);
}

function resolveDynamicWorkflowOffer(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
}): DynamicWorkflowClientConfig {
  const override = normalizeDynamicWorkflowMode(input.env?.[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]);
  if (override) return createDynamicWorkflowClientConfig(override, "override");
  const remoteMode = normalizeDynamicWorkflowMode(
    typeof input.remote === "object" && input.remote !== null
      ? (input.remote as { mode?: unknown }).mode
      : undefined,
  );
  if (remoteMode) return createDynamicWorkflowClientConfig(remoteMode, "remote");
  return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
}
