/* eslint-disable max-lines -- test-support code, acceptable to exceed the limit */
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  type ModelConfig,
  type ProviderConfig,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_V4_SESSION_PANE,
  TID_WORKSPACE_ITEM,
  TID_WORKSPACE_PATH,
  ZAI_PROVIDER_ID,
  testId,
} from "@zcode/shared";
import type { AppSettings } from "@zcode/shared";
import { collectWindowsE2EProcessTreePids } from "./e2e-process-cleanup.js";
import {
  collectE2EWebDriverPageHandleCandidates,
  type E2EBrowserTargetInfo,
} from "./e2e-window-target.js";
import { dismissOccupationOnboarding } from "./occupation-onboarding.js";
import { sel } from "./selectors.js";

const DEFAULT_E2E_HOME_DIR = resolve(process.cwd(), ".e2e-home");
const E2E_HOME_DIR =
  process.env.ZCODE_E2E_HOME_DIR?.trim() ||
  process.env.ZCODE_DATA_BASE_DIR?.trim() ||
  process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
  // Fix rationale: when the WDIO worker environment is unstable, the helper used to fall back to
  // the real HOME, making provider diagnostics and cleanup read and write the developer's local
  // configuration instead of the current e2e sandbox.
  DEFAULT_E2E_HOME_DIR;
// Bug root cause: the storage profile rollback removed this shared root field, but multiple E2E
// flows still need to locate the CLI data.
// Isolation is guaranteed by the test HOME; the directory name keeps the production historical
// semantics of .zcode.
const E2E_STORAGE_ROOT = join(E2E_HOME_DIR, ".zcode");
const E2E_APP_DATA_DIR = join(E2E_STORAGE_ROOT, "v2");
export const DEFAULT_WORKSPACE = join(E2E_HOME_DIR, "ZCodeProject");
export const DEFAULT_CONVERSATION_WORKSPACE = join(E2E_STORAGE_ROOT, "workspace", "default");
const SETTINGS_FILE = join(E2E_APP_DATA_DIR, "setting.json");
const CREDENTIALS_FILE = join(E2E_APP_DATA_DIR, "credentials.json");
const CONFIG_FILE = join(E2E_APP_DATA_DIR, PERSONAL_PROVIDER_CONFIG_FILE_NAME);
const CLI_CONFIG_FILE = join(E2E_STORAGE_ROOT, "cli", "config.json");
const AGENTS_STATE_FILE = join(E2E_APP_DATA_DIR, "agents-state.json");
const REMOVE_APP_DATA_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000];
const REMOVE_APP_DATA_MAX_ATTEMPTS = REMOVE_APP_DATA_RETRY_DELAYS_MS.length;
const E2E_USER_PROFILE = {
  displayName: "ZCode E2E",
  id: "zcode-e2e-user",
  username: "zcode-e2e-user",
};

interface WindowInfo {
  id: number;
  title: string;
  visible: boolean;
  width: number;
  height: number;
  resizable: boolean;
  url: string;
}

export interface CliConfigSnapshot {
  content: string | null;
}

export interface ElectronRendererContentSizeSnapshot {
  height: number;
  windowId: number;
  width: number;
}

/**
 * The assertion snapshot E2E reads from Personal Config.
 *
 * It describes only the fields the tests need to observe; it is not the source of truth for
 * provider configuration and takes no part in runtime assembly.
 */
export interface E2EModelProviderSnapshot {
  apiFormat: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
  apiKey: string;
  apiKeyRequired?: boolean;
  createdAt: number;
  defaultKind: E2EProviderKind;
  enabled?: boolean;
  endpoints: {
    anthropic?: string;
    baseURL?: string;
    openai?: string;
    paths?: Partial<Record<E2EProviderKind, string>>;
  };
  id: string;
  models: E2EProviderModelSnapshot[];
  name: string;
  source: "custom";
  systemDisabledReason?: string;
  updatedAt: number;
}

export type E2EProviderKind = "anthropic" | "openai" | "openai-compatible";
export type E2EProviderModality = "text" | "image" | "video" | "audio" | "pdf";

export interface E2EProviderModelSnapshot {
  contextWindow: number;
  defaultMaxOutputTokens?: number;
  defaultKind?: E2EProviderKind;
  deleted?: boolean;
  disabledReason?: string;
  id: string;
  kinds: E2EProviderKind[];
  maxOutputTokens?: number;
  modalities: { input: E2EProviderModality[]; output: E2EProviderModality[] };
  name?: string;
  reasoning?: unknown;
  supportsJsonSchemaOutput?: boolean;
  supportsTools?: boolean;
}

export function createE2EProviderModelSnapshot(params: {
  contextWindow?: number;
  defaultMaxOutputTokens?: number;
  defaultKind?: E2EProviderKind;
  id: string;
  kinds?: readonly E2EProviderKind[];
  maxOutputTokens?: number;
  modalities?: {
    input?: readonly E2EProviderModality[];
    output?: readonly E2EProviderModality[];
  };
  supportsJsonSchemaOutput?: boolean;
  supportsTools?: boolean;
}): E2EProviderModelSnapshot {
  return {
    id: params.id,
    kinds: [...new Set(params.kinds ?? [])],
    ...(params.defaultKind ? { defaultKind: params.defaultKind } : {}),
    contextWindow: params.contextWindow ?? 200_000,
    ...(params.defaultMaxOutputTokens === undefined
      ? {}
      : { defaultMaxOutputTokens: params.defaultMaxOutputTokens }),
    ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    modalities: {
      input: [...new Set<E2EProviderModality>(params.modalities?.input ?? ["text"])],
      output: [...new Set<E2EProviderModality>(params.modalities?.output ?? ["text"])],
    },
    ...(params.supportsTools === undefined ? {} : { supportsTools: params.supportsTools }),
    ...(params.supportsJsonSchemaOutput === undefined
      ? {}
      : { supportsJsonSchemaOutput: params.supportsJsonSchemaOutput }),
  };
}

export function resolveE2EProviderRuntimeBaseUrl(provider: E2EModelProviderSnapshot): string {
  return provider.endpoints.baseURL?.trim().replace(/\/+$/, "") ?? "";
}

type WorkspaceRendererSwitchResult =
  | { switched: true }
  | {
      switched: false;
      reason: string;
      currentUrl?: string | null;
      handleInspections?: Array<{
        currentHandle: string | null;
        currentUrl: string | null;
        error?: string;
        handle: string;
        targetUrl: string;
      }>;
      handles?: string[];
      target?: E2EBrowserTargetInfo | null;
      targets?: E2EBrowserTargetInfo[];
      windowUrl?: string | null;
      windows?: WindowInfo[];
      error?: string;
    };

async function ensureAppDataDir() {
  await mkdir(E2E_APP_DATA_DIR, { recursive: true });
}

export function readExactTestIdAttribute(testId: string, attributeName: string): string | null {
  // Bug root cause: on Windows the workspacePath contains backslashes, and splicing it directly
  // into a CSS selector makes them parse as escape characters.
  // Enumerate the stable data-testid nodes and compare by attribute value, which works for both
  // Windows and macOS native paths.
  const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
    (item) => item.dataset.testid === testId,
  );
  return element?.getAttribute(attributeName) ?? null;
}

export function dispatchMouseDownByExactTestId(testId: string): boolean {
  // Bug root cause: the Skill option id contains a Windows absolute path, and splicing backslashes
  // directly into a CSS selector makes them parse as escape characters. Compare by attribute value
  // and then dispatch mousedown, compatible with every native path format.
  const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
    (item) => item.dataset.testid === testId,
  );
  if (!element) {
    return false;
  }
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  return true;
}

async function hasTestId(testId: string) {
  const value = await browser.execute(readExactTestIdAttribute, testId, "data-testid");
  return value === testId;
}

interface DomTestIdOptions {
  timeout?: number;
  timeoutMsg?: string;
}

interface SetInputValueByTestIdDomOptions extends DomTestIdOptions {
  /** After the async restore settles, re-establish and verify the Lexical caret at the end of the text. */
  stabilizeLexicalCaretAtEnd?: boolean;
}

export async function waitForTestIdByDom(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有渲染 test id: ${testId}` }: DomTestIdOptions = {},
) {
  await browser.waitUntil(async () => hasTestId(testId), {
    timeout,
    timeoutMsg,
  });
}

export async function clickTestIdByDom(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可点击的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  // Fix rationale: Chromium inside the Electron Linux container places some settings-page elements
  // at huge coordinates, so the WebDriver clickable check misreports failure. A DOM click still
  // triggers React onClick, letting tests focus on business logic.
  let latestReason = "not-started";
  try {
    await browser.waitUntil(
      async () => {
        const latest = (await browser.execute((currentTestId) => {
          const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (item) => item.dataset.testid === currentTestId,
          );
          if (!element) {
            return { clicked: false, reason: "missing" };
          }
          const disabled =
            (element instanceof HTMLButtonElement ||
              element instanceof HTMLInputElement ||
              element instanceof HTMLSelectElement ||
              element instanceof HTMLTextAreaElement) &&
            element.disabled;
          if (disabled) {
            return { clicked: false, reason: "disabled" };
          }
          element.click();
          return { clicked: true };
        }, testId)) as { clicked: boolean; reason?: string };
        latestReason = latest.reason ?? "clicked";
        return latest.clicked;
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    // Fix rationale: React/Radix controls may remount on the frame right after the wait succeeds.
    // The wait and the click must complete within the same DOM query, otherwise sporadic "missing"
    // results pollute e2e authentication.
    throw new Error(`${timeoutMsg}: ${latestReason}`, {
      cause: error,
    });
  }
}

export async function ensureWorkspaceItemExpanded(
  workspacePath: string,
  timeout = 30_000,
): Promise<void> {
  const workspaceItemTestId = testId(TID_WORKSPACE_ITEM, workspacePath);
  await waitForTestIdByDom(workspaceItemTestId, {
    timeout,
    timeoutMsg: `侧栏没有显示 workspace: ${workspacePath}`,
  });

  const isExpanded = async () =>
    (await browser.execute(readExactTestIdAttribute, workspaceItemTestId, "aria-expanded")) ===
    "true";
  if (!(await isExpanded())) {
    await clickTestIdByDom(workspaceItemTestId, {
      timeout: 15_000,
      timeoutMsg: `侧栏 workspace 不可展开: ${workspacePath}`,
    });
  }

  // Bug root cause: in slow rendering environments a successful DOM click only means the event was
  // dispatched; the project tree's React expansion commit may still land in a later frame. Wait
  // uniformly for the aria terminal state so cases do not look for the task too early.
  await browser.waitUntil(isExpanded, {
    timeout: 15_000,
    timeoutMsg: `侧栏 workspace 没有完成展开: ${workspacePath}`,
  });
}

export async function clickTestIdByWebDriver(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可点击的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  // Bug root cause: Radix DropdownMenu/Select triggers depend on a pointerdown gesture;
  // element.click() only dispatches click, so tests would misreport the portal item as missing.
  // This keeps the real WebDriver pointer chain and is meant only for cases that explicitly use
  // such triggers.
  const element = $(sel(testId));
  await element.waitForClickable({ timeout, timeoutMsg });
  await element.click();
}

export async function hoverTestIdByWebDriver(
  testId: string,
  { timeout = 10000, timeoutMsg = `页面没有可悬停的 test id: ${testId}` }: DomTestIdOptions = {},
) {
  const element = $(sel(testId));
  await element.waitForDisplayed({ timeout, timeoutMsg });
  await element.moveTo();
}

export async function setInputValueByTestIdDom(
  testId: string,
  value: string,
  {
    stabilizeLexicalCaretAtEnd = false,
    timeout = 10000,
    timeoutMsg = `页面没有可输入的 test id: ${testId}`,
  }: SetInputValueByTestIdDomOptions = {},
) {
  // Fix rationale: the same class of container coordinate anomalies keeps input fields from being
  // focused via WebDriver. This uses the native value setter and dispatches input/change/blur, so
  // the page's own save logic still runs.
  // M5: the v4 composer is back to a Lexical contenteditable — writes go through the
  // __zcodeLexicalInputE2E bridge mounted by the editor (driving the real editor state, so DOM
  // writes cannot bypass Lexical).
  // The bridge is attached by E2ELexicalInputBridgePlugin's short polling and may appear later
  // than the node, hence the retry.
  await waitForTestIdByDom(testId, { timeout, timeoutMsg });
  type SetInputResult = {
    ok: boolean;
    reason?: string;
    tagName?: string | null;
    value?: string;
  };
  let result: SetInputResult = { ok: false, reason: "not-attempted" };
  const attempt = async () => {
    result = (await browser.execute(
      (currentTestId, nextValue) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === currentTestId,
        );
        if (
          element &&
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement) &&
          (element.isContentEditable || element.hasAttribute("data-e2e-lexical-bridge"))
        ) {
          const bridge = (
            element as HTMLElement & {
              __zcodeLexicalInputE2E?: {
                focus: () => void;
                getText: () => string;
                setText: (text: string) => void;
              };
            }
          ).__zcodeLexicalInputE2E;
          if (!bridge) {
            return {
              ok: false,
              reason: "lexical-bridge-not-ready",
              tagName: element.tagName,
            };
          }
          // Bugfix: Lexical's editor.update commits in a microtask, so getText right after setText
          // reads the old value.
          // Read the current value first and succeed on a hit; otherwise write and mark pending,
          // letting the outer waitUntil poll for confirmation.
          if (bridge.getText() === nextValue) {
            return { ok: true, value: nextValue };
          }
          bridge.focus();
          bridge.setText(nextValue);
          return {
            ok: false,
            reason: "lexical-pending",
            value: bridge.getText(),
          };
        }
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return {
            ok: false,
            reason: "not-input",
            tagName: element?.tagName ?? null,
          };
        }
        if (element.disabled || element.readOnly) {
          return {
            ok: false,
            reason: "not-editable",
            tagName: element.tagName,
          };
        }

        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        element.focus();
        if (descriptor?.set) {
          descriptor.set.call(element, nextValue);
        } else {
          element.value = nextValue;
        }
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: nextValue,
            inputType: "insertText",
          }),
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: element.value === nextValue, value: element.value };
      },
      testId,
      value,
    )) as SetInputResult;
    return result;
  };
  await browser
    .waitUntil(
      async () => {
        const current = await attempt();
        // Bug root cause: after clicking an inline edit React remounts the user row; between
        // waitForTestId and execute we may land exactly in a frame where the old node is unmounted
        // and the new Lexical node is not yet mounted.
        // "missing" is not a terminal state of "the selector points at a non-input"; it must be
        // retried together with bridge initialization.
        return (
          current.ok ||
          (current.reason !== "lexical-bridge-not-ready" &&
            current.reason !== "lexical-pending" &&
            !(current.reason === "not-input" && current.tagName === null))
        );
      },
      { timeout, timeoutMsg },
    )
    .catch(() => undefined);

  if (!result.ok) {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(result)}`);
  }

  if (stabilizeLexicalCaretAtEnd) {
    // Bug cause: on task switch the pane changes sessionId first, while Lexical's draft restore
    // and auto-focus complete in later RAFs. A plain setText has already written the text, but the
    // caret may still be moved before the text by a late restore. The option is off by default and
    // is enabled explicitly only by cases that need the end-of-text caret stable across a restore.
    type LexicalCaretResult = {
      ok: boolean;
      reason?: string;
      text?: string;
    };
    let caretResult: LexicalCaretResult = { ok: false, reason: "not-attempted" };
    try {
      await browser.waitUntil(
        async () => {
          caretResult = (await browser.executeAsync(
            (currentTestId, nextValue, done) => {
              // ConversationComposer's draft restore and focusing each take one RAF; after they
              // settle, replay setText through the same bridge so we do not write early on a
              // mere sessionId update.
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const element = Array.from(
                    document.querySelectorAll<HTMLElement>("[data-testid]"),
                  ).find((item) => item.dataset.testid === currentTestId) as
                    | (HTMLElement & {
                        __zcodeLexicalInputE2E?: {
                          focus: () => void;
                          getText: () => string;
                          setText: (text: string) => void;
                        };
                      })
                    | undefined;
                  const bridge = element?.__zcodeLexicalInputE2E;
                  if (!element?.isContentEditable || !bridge) {
                    done({ ok: false, reason: "lexical-not-editable" });
                    return;
                  }

                  bridge.setText(nextValue);
                  bridge.focus();
                  requestAnimationFrame(() => {
                    const selection = window.getSelection();
                    const focusNode = selection?.focusNode ?? null;
                    const trailingRange = document.createRange();
                    if (focusNode !== null && element.contains(focusNode) && selection) {
                      trailingRange.setStart(focusNode, selection.focusOffset);
                      trailingRange.setEnd(element, element.childNodes.length);
                    }
                    const text = bridge.getText();
                    const caretAtEnd =
                      focusNode !== null &&
                      element.contains(focusNode) &&
                      selection?.isCollapsed === true &&
                      trailingRange.toString() === "";
                    done({
                      ok: text === nextValue && caretAtEnd,
                      reason:
                        text === nextValue ? "caret-not-at-end" : "text-restored-by-initializer",
                      text,
                    });
                  });
                }),
              );
            },
            testId,
            value,
          )) as LexicalCaretResult;
          return caretResult.ok;
        },
        {
          timeout,
          timeoutMsg: `${timeoutMsg}: Lexical caret 未稳定在文本末尾`,
        },
      );
    } catch (error) {
      throw new Error(`${timeoutMsg}: ${JSON.stringify(caretResult)}`, {
        cause: error,
      });
    }
  }

  await browser.pause(50);
  await browser.execute((currentTestId) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === currentTestId,
    );
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.blur();
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
  }, testId);
}

export function workspaceLabel(workspacePath: string) {
  return basename(workspacePath) || workspacePath;
}

export function getE2EAppDataPaths() {
  return {
    appDataDir: E2E_APP_DATA_DIR,
    configFile: CONFIG_FILE,
    credentialsFile: CREDENTIALS_FILE,
    homeDir: E2E_HOME_DIR,
    storageRoot: E2E_STORAGE_ROOT,
    workspace: DEFAULT_WORKSPACE,
  };
}

export async function clearAppData() {
  if (process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP === "1") {
    // Fix rationale: a normal spec's after hook quitting the app first destroys the browsing
    // context before ChromeDriver's deleteSession, making every worker pay a disconnection timeout.
    // WDIO afterSession deletes the app data after the process exits; here we only hand back
    // ownership of shutting down.
    return;
  }
  await quitElectronAppGracefully();
  await removeAppDataWithRetry();
}

export async function quitElectronAppGracefully() {
  try {
    const result = (await browser.electron.execute((electron) => {
      if (electron.app.getName() !== "ZCode E2E") {
        return { quit: false, pid: process.pid };
      }
      // Fix rationale: clearAppData often runs in the spec after hook; if app.quit is deferred to
      // the next tick, a long batch may let the old session's quit spill into the next Electron
      // round.
      electron.app.quit();
      return { quit: true, pid: process.pid };
    })) as { quit: boolean; pid: number };

    if (result.quit && result.pid) {
      // Bug root cause: Electron's before-quit can wait up to 9s for Host cleanup, and a 10s outer
      // wait would return just before Main's final settings write-back. Writing the next E2E
      // scenario immediately after would let the old process overwrite the new fixture with the
      // previous scenario. The wait cap must cover Electron's own cleanup window and hand back
      // ownership of the persistence files only after the process has exited.
      await waitForPidExit(result.pid, 15_000);
    }
  } catch {
    // session already closed or app already gone — safe to continue
  }
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function removeAppDataWithRetry() {
  for (let attempt = 0; attempt <= REMOVE_APP_DATA_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rm(E2E_APP_DATA_DIR, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 500,
      });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === REMOVE_APP_DATA_MAX_ATTEMPTS) {
        if (
          !isRetryableRemoveError(error) ||
          process.env.ZCODE_E2E_STRICT_APP_DATA_CLEANUP === "1"
        ) {
          throw error;
        } else {
          // Bugfix: the after hook's app data cleanup is only responsible for finishing up; Windows
          // may briefly retain a tasks-index.sqlite handle, and the next round's beforeSession
          // kills the process and force-resets .e2e-home first.
          process.stderr.write(
            `[desktop-e2e-cleanup] clearAppData skipped locked app data cleanup: ${formatErrorMessage(error)}\n`,
          );
          return;
        }
      }
      // Fix rationale: on Windows host/service processes may briefly hold the WAL/SHM handles of
      // tasks-index.sqlite after the Electron main process exits; clean up leftover E2E processes
      // before deleting, so the after hook does not misreport business cases as failures over a
      // cleanup error.
      await cleanupLeftoverE2EProcesses();
      await browser.pause(REMOVE_APP_DATA_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableRemoveError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "ENOTEMPTY" || error.code === "EBUSY" || error.code === "EPERM";
}

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function cleanupLeftoverE2EProcesses() {
  if (process.platform !== "win32") {
    return;
  }

  const pids = listWindowsLeftoverE2EProcessPids();
  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Cleanup is best-effort; removeAppDataWithRetry keeps using the error path to decide
      // whether to fail.
    }
  }
  await waitForProcessesExit(pids, 3000);
}

function listWindowsLeftoverE2EProcessPids() {
  try {
    const script = [
      "Get-CimInstance Win32_Process |",
      "Select-Object ProcessId,ParentProcessId,CommandLine |",
      "ConvertTo-Json -Compress",
    ].join(" ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return collectWindowsE2EProcessTreePids(output, {
      currentPid: process.pid,
      homeDir: E2E_HOME_DIR,
      runId: process.env.ZCODE_E2E_RUN_ID,
    });
  } catch {
    return [];
  }
}
async function waitForProcessesExit(pids: number[], timeoutMs: number) {
  if (pids.length === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readSettings(): Promise<Partial<AppSettings>> {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf-8")) as Partial<AppSettings>;
  } catch {
    return {};
  }
}

async function readCliConfig(): Promise<Record<string, unknown>> {
  try {
    const json = JSON.parse(await readFile(CLI_CONFIG_FILE, "utf-8")) as unknown;
    return isRecord(json) ? json : {};
  } catch {
    return {};
  }
}

export async function readModelProviders(): Promise<E2EModelProviderSnapshot[]> {
  const repository = new NodePersonalProviderConfigRepository({
    filePath: CONFIG_FILE,
    pollingIntervalMs: false,
  });
  try {
    return convertPersonalProviderConfig(await repository.read());
  } catch {
    return [];
  } finally {
    repository.dispose();
  }
}

export async function readAgentsState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(AGENTS_STATE_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function convertPersonalProviderConfig(
  document: ProviderConfigLayerSnapshot,
): E2EModelProviderSnapshot[] {
  return document.providers.entries().map(([providerId, provider]) => {
    const now = Date.now();
    const kind = mapPersonalProviderKind(provider);
    return {
      id: providerId,
      name: document.providers.getRule(providerId)?.providerName?.trim() || providerId,
      endpoints: {
        baseURL: provider.api?.baseUrl?.trim() || "",
        paths: { [kind]: "" },
      },
      apiFormat: provider.api?.type ?? "openai-chat-completions",
      apiKeyRequired: true,
      apiKey: provider.access?.type === "api-key" ? provider.access.apiKey?.trim() || "" : "",
      defaultKind: kind,
      models: (provider.personalModelIds ?? []).map((modelId) =>
        convertPersonalModelConfig(
          modelId,
          document.models.resolve({
            providerId,
            modelId,
            apiType: provider.api?.type,
            baseUrl: provider.api?.baseUrl,
          }),
          kind,
        ),
      ),
      source: "custom" as const,
      createdAt: now,
      updatedAt: now,
    };
  });
}

function convertPersonalModelConfig(
  modelId: string,
  model: ModelConfig,
  defaultKind: E2EProviderKind,
) {
  const properties = model.properties;
  const input: E2EProviderModality[] = ["text"];
  if (properties?.inputFormat?.supportsImage) input.push("image");
  if (properties?.inputFormat?.supportsAudio) input.push("audio");
  if (properties?.inputFormat?.supportsPdf) input.push("pdf");
  if (properties?.inputFormat?.supportsVideo) input.push("video");
  return createE2EProviderModelSnapshot({
    id: modelId,
    kinds: [defaultKind],
    defaultKind,
    contextWindow: properties?.contextWindow ?? undefined,
    defaultMaxOutputTokens: model.optionSpecs?.maxOutputTokens?.max ?? undefined,
    maxOutputTokens: model.optionSpecs?.maxOutputTokens?.max ?? undefined,
    modalities: { input, output: ["text"] },
    supportsTools: properties?.supportsToolCall ?? undefined,
    supportsJsonSchemaOutput: properties?.supportsJsonSchemaOutput ?? undefined,
  });
}

function mapPersonalProviderKind(provider: ProviderConfig): E2EProviderKind {
  switch (provider.api?.type) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
    case null:
    case undefined:
      return "openai-compatible";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeRecord(
  current: Record<string, unknown>,
  partial: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    const existing = next[key];
    next[key] = isRecord(existing) && isRecord(value) ? mergeRecord(existing, value) : value;
  }
  return next;
}

export async function readModelProvider(
  providerId: string,
): Promise<E2EModelProviderSnapshot | null> {
  const providers = await readModelProviders();
  return providers.find((provider) => provider.id === providerId) ?? null;
}

export async function seedSettings(partial: Partial<AppSettings>): Promise<Partial<AppSettings>> {
  const current = await readSettings();
  const next = { ...current, ...partial };
  await ensureAppDataDir();
  await writeFile(SETTINGS_FILE, JSON.stringify(next), "utf-8");
  return next;
}

export async function seedCliConfig(
  partial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const current = await readCliConfig();
  const next = mergeRecord(current, partial);
  await mkdir(dirname(CLI_CONFIG_FILE), { recursive: true });
  await writeFile(CLI_CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export async function snapshotCliConfig(): Promise<CliConfigSnapshot> {
  try {
    return { content: await readFile(CLI_CONFIG_FILE, "utf-8") };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { content: null };
    }
    throw error;
  }
}

export async function restoreCliConfig(snapshot: CliConfigSnapshot): Promise<void> {
  // Fix rationale: seedCliConfig writes the CLI global config under the isolated HOME; clearing
  // only ~/.zcode/v2 would leave WebFetch's temporary proxy into later steps of the same E2E
  // session, so a file-level snapshot must be restored.
  if (snapshot.content === null) {
    await rm(CLI_CONFIG_FILE, { force: true });
    return;
  }

  await mkdir(dirname(CLI_CONFIG_FILE), { recursive: true });
  await writeFile(CLI_CONFIG_FILE, snapshot.content, "utf-8");
}

export async function seedCredentials(authToken = "mock-token") {
  await ensureAppDataDir();
  // Bugfix: login restore has migrated to the OAuth namespace; writing only the old auth_token
  // would leave e2e waiting for a workspace on the welcome page and fail before the provider flow
  // is recorded.
  await writeFile(
    CREDENTIALS_FILE,
    JSON.stringify(
      {
        auth_token: authToken,
        "oauth:active_provider": ZAI_PROVIDER_ID,
        [`oauth:${ZAI_PROVIDER_ID}:access_token`]: authToken,
        [`oauth:${ZAI_PROVIDER_ID}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
        zcodejwttoken: authToken,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export interface WorkspaceAppProbeParams {
  workspacePathTestId: string;
  workspaceItemTestId: string;
  sessionPanePrefix: string;
  composerWorkspaceTriggerTestId: string;
  expectedPath: string;
}

// Runs inside the renderer (serialized by browser.execute); cannot reference module-scope variables.
export function probeWorkspaceAppState(
  params: WorkspaceAppProbeParams,
): "ready" | "onboarding" | "pending" {
  // Fix rationale: the occupation onboarding shows automatically when "there are no answered
  // records and no Task on this machine", and every E2E worker is a fresh isolated HOME, so it
  // always matches; before the onboarding check completes, Root does not render the main UI, and
  // while it shows, it replaces the main UI wholesale — the two are mutually exclusive. So this
  // reports onboarding honestly and the caller closes it through the real UI before waiting for
  // the workspace.
  if (document.querySelector('[data-testid="onboarding-page"]')) {
    return "onboarding";
  }

  const pathBadge = document.querySelector<HTMLElement>(
    `[data-testid="${params.workspacePathTestId}"]`,
  );
  if (pathBadge?.getAttribute("title") === params.expectedPath) {
    return "ready";
  }

  // Fix rationale: after API Key login, in the empty-task state the main area shows only the new
  // task draft and does not necessarily render WorkspaceHeader's path badge. Only when the sidebar
  // workspace item and the session pane both exist has the user entered the actionable target
  // workspace.
  // Fix rationale: on Windows the workspacePath ends up in data-testid, and backslashes spliced
  // directly into a CSS attribute selector parse as escape characters, so elements that exist in
  // the DOM cannot be found.
  const workspaceItem = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
    (element) => element.dataset.testid === params.workspaceItemTestId,
  );
  const conversationWorkspaceReady =
    params.expectedPath.replace(/\\/g, "/").endsWith("/.zcode/workspace/default") &&
    Boolean(document.querySelector(`[data-testid="${params.composerWorkspaceTriggerTestId}"]`));
  // After the v4 hard switch the chat area is a v4 session pane (testid carries a paneId suffix;
  // match by prefix).
  return (workspaceItem || conversationWorkspaceReady) &&
    document.querySelector(`[data-testid^="${params.sessionPanePrefix}-"]`)
    ? "ready"
    : "pending";
}

// Bugfix: TID_WORKSPACE_TITLE in WorkspaceHeader now shows activeTaskTitle and no longer stably
// represents the current workspace name. e2e reads TID_WORKSPACE_PATH's title attribute instead;
// under a new task draft the header path capsule does not render, so the sidebar workspace item is
// accepted as well.
// Only this covers the real product flow of "default workspace opens automatically / multi-tab
// switching" accurately.
export async function waitForWorkspaceApp(workspacePath: string, timeout = 10000) {
  const timeoutMsg = `主界面没有切到工作区: ${workspacePath}`;
  const probeParams: WorkspaceAppProbeParams = {
    workspacePathTestId: TID_WORKSPACE_PATH,
    workspaceItemTestId: testId(TID_WORKSPACE_ITEM, workspacePath),
    sessionPanePrefix: TID_V4_SESSION_PANE,
    composerWorkspaceTriggerTestId: TID_COMPOSER_WORKSPACE_TRIGGER,
    expectedPath: workspacePath,
  };

  try {
    await browser.waitUntil(
      async () => {
        const state = await browser.execute(probeWorkspaceAppState, probeParams);
        if (state === "onboarding") {
          // Bug root cause: previously only the v4 helper skipped onboarding first, so specs like
          // conversation-session, automations and smoke that go through this function would be
          // stuck behind the onboarding page for 30s and fail. After closing, the next polling
          // round confirms the workspace.
          await dismissOccupationOnboarding();
          return false;
        }
        return state === "ready";
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    // Fix rationale: e2e used to report only a wait timeout, with the real white-screen cause
    // hidden in the renderer state.
    // On failure, attach the current DOM, window and storage summaries so a later stuck case can
    // locate the initialization boundary directly.
    throw new Error(`${timeoutMsg}\n${await collectWorkspaceDiagnostics(workspacePath)}`, {
      cause: error,
    });
  }
}

async function isWorkspaceAppVisible(workspacePath: string) {
  const workspaceItemTestId = testId(TID_WORKSPACE_ITEM, workspacePath);
  try {
    return await browser.execute(
      (workspacePathTestId, workspaceItemTestId, sessionPanePrefix, expectedPath) => {
        const pathBadge = document.querySelector<HTMLElement>(
          `[data-testid="${workspacePathTestId}"]`,
        );
        if (pathBadge?.getAttribute("title") === expectedPath) {
          return true;
        }

        // Fix rationale: after API Key login, in the empty-task state the main area shows only the
        // new task draft and does not necessarily render WorkspaceHeader's path badge. Only when
        // the sidebar workspace item and the v4 session pane both exist has the user entered the
        // actionable target workspace.
        // Fix rationale: on Windows the workspacePath ends up in data-testid, and backslashes
        // spliced directly into a CSS attribute selector parse as escape characters, so elements
        // that exist in the DOM cannot be found.
        const workspaceItem = Array.from(
          document.querySelectorAll<HTMLElement>("[data-testid]"),
        ).find((element) => element.dataset.testid === workspaceItemTestId);
        return Boolean(
          workspaceItem && document.querySelector(`[data-testid^="${sessionPanePrefix}-"]`),
        );
      },
      TID_WORKSPACE_PATH,
      workspaceItemTestId,
      TID_V4_SESSION_PANE,
      workspacePath,
    );
  } catch {
    // Bugfix: after browser.reloadSession the WebDriver/CDP link is briefly broken; the workspace
    // wait should treat this kind of "not connected yet" as not-ready instead of failing early.
    return false;
  }
}

export async function getActiveWorkspacePath() {
  return browser.execute((workspacePathTestId) => {
    const pathBadge = document.querySelector<HTMLElement>(`[data-testid="${workspacePathTestId}"]`);
    return pathBadge?.getAttribute("title") ?? null;
  }, TID_WORKSPACE_PATH);
}

async function collectWorkspaceDiagnostics(expectedPath: string) {
  const workspaceItemTestId = testId(TID_WORKSPACE_ITEM, expectedPath);
  const windows = await getAllWindowInfo().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const targets = await getBrowserTargetInfo().catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const dom = await browser
    .execute(
      (workspacePathTestId, workspaceItemId) => {
        const pathBadge = document.querySelector<HTMLElement>(
          `[data-testid="${workspacePathTestId}"]`,
        );
        const workspaceItem = Array.from(
          document.querySelectorAll<HTMLElement>("[data-testid]"),
        ).find((element) => element.dataset.testid === workspaceItemId);
        let localStorageKeys: string[] | { error: string };
        try {
          localStorageKeys = Object.keys(window.localStorage).sort();
        } catch (error) {
          localStorageKeys = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return {
          bodyText: document.body?.innerText?.slice(0, 1200) ?? "",
          readyState: document.readyState,
          testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
            .slice(0, 80)
            .map((element) => element.dataset.testid ?? ""),
          title: document.title,
          url: window.location.href,
          workspaceItemExists: Boolean(workspaceItem),
          workspacePathTitle: pathBadge?.getAttribute("title") ?? null,
          localStorageKeys,
        };
      },
      TID_WORKSPACE_PATH,
      workspaceItemTestId,
    )
    .catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));

  return `诊断: ${JSON.stringify({ expectedPath, windows, targets, dom }, null, 2)}`;
}

export async function waitForDefaultWorkspaceReady(timeout = 10000) {
  await browser.waitUntil(
    async () => {
      try {
        await access(DEFAULT_WORKSPACE);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout,
      timeoutMsg: `默认工作区没有自动创建: ${DEFAULT_WORKSPACE}`,
    },
  );

  if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
    // Fix rationale: after browser.reloadSession the renderer is already usable, but the Electron
    // bridge may sporadically still be in its reconnection window; continuing to rely on the
    // BrowserWindow list here would misreport "the main window did not appear".
    return;
  }

  await browser.waitUntil(
    async () => {
      // Bug root cause: after reloadSession the renderer DOM usually recovers before the Electron
      // service bridge. The old implementation only polled BrowserWindow once it entered this wait,
      // so even when the page was already usable it would wait out the full timeout and misreport
      // "the main window did not appear". The two readiness chains must converge in parallel.
      if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
        return true;
      }
      try {
        const windows = await getAllWindowInfo();
        return windows.length >= 1;
      } catch {
        return false;
      }
    },
    {
      interval: 250,
      timeout,
      timeoutMsg: "主窗口没有出现",
    },
  );

  if (await isWorkspaceAppVisible(DEFAULT_WORKSPACE)) {
    return;
  }

  await switchToWorkspaceRendererWindow(DEFAULT_WORKSPACE, timeout);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, timeout);
}

export async function getAllWindowInfo(): Promise<WindowInfo[]> {
  return browser.electron.execute((electron) => {
    return electron.BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .map((win) => ({
        id: win.id,
        title: win.getTitle(),
        visible: win.isVisible(),
        width: win.getBounds().width,
        height: win.getBounds().height,
        resizable: win.isResizable(),
        url: win.webContents.getURL(),
      }));
  });
}

export async function setCurrentElectronRendererContentSize(
  width: number,
  height?: number,
): Promise<ElectronRendererContentSizeSnapshot> {
  const currentUrl = await browser.getUrl();
  const result = await browser.electron.execute(
    (electron, targetUrl, nextWidth, nextHeight) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL() === targetUrl,
      );
      if (!target) {
        return {
          ok: false as const,
          candidateUrls: electron.BrowserWindow.getAllWindows()
            .filter((candidate) => !candidate.isDestroyed())
            .map((candidate) => candidate.webContents.getURL()),
        };
      }

      const [originalWidth = 0, originalHeight = 0] = target.getContentSize();
      // Fix rationale: ChromeDriver's window/rect calls Electron's unimplemented
      // Browser.getWindowForTarget; E2E must resize the client viewport through Electron's
      // authoritative window API.
      target.setContentSize(nextWidth, nextHeight ?? originalHeight);
      target.focus();
      const [appliedWidth = 0, appliedHeight = 0] = target.getContentSize();
      return {
        ok: true as const,
        appliedHeight,
        appliedWidth,
        zoomFactor: target.webContents.getZoomFactor(),
        snapshot: {
          height: originalHeight,
          windowId: target.id,
          width: originalWidth,
        },
      };
    },
    currentUrl,
    width,
    height,
  );

  if (!result.ok) {
    throw new Error(
      `当前 WebDriver URL 没有精确匹配 Electron renderer 窗口: ${currentUrl}; candidates=${JSON.stringify(result.candidateUrls)}`,
    );
  }
  if (
    Math.abs(result.appliedWidth - width) > 1 ||
    (height !== undefined && Math.abs(result.appliedHeight - height) > 1)
  ) {
    await restoreElectronRendererContentSize(result.snapshot);
    throw new Error(
      `Electron renderer content size 没有应用: requested=${width}x${height ?? "preserve"}; applied=${result.appliedWidth}x${result.appliedHeight}`,
    );
  }

  const expectedRendererWidth = Math.round(result.appliedWidth / result.zoomFactor);
  const expectedRendererHeight = Math.round(result.appliedHeight / result.zoomFactor);
  let latestRendererViewport: { height: number; width: number } | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestRendererViewport = await browser.execute(() => ({
          height: window.innerHeight,
          width: window.innerWidth,
        }));
        return (
          Math.abs(latestRendererViewport.width - expectedRendererWidth) <= 1 &&
          (height === undefined ||
            Math.abs(latestRendererViewport.height - expectedRendererHeight) <= 1)
        );
      },
      {
        timeout: 10000,
        timeoutMsg: `renderer viewport 没有收敛到 ${expectedRendererWidth}x${height === undefined ? "preserve" : expectedRendererHeight}`,
      },
    );
  } catch (error) {
    await restoreElectronRendererContentSize(result.snapshot);
    throw new Error(
      `renderer viewport 没有收敛: expected=${expectedRendererWidth}x${height === undefined ? "preserve" : expectedRendererHeight}; actual=${JSON.stringify(latestRendererViewport)}; zoomFactor=${result.zoomFactor}`,
      { cause: error },
    );
  }

  return result.snapshot;
}

export async function restoreElectronRendererContentSize(
  snapshot: ElectronRendererContentSizeSnapshot,
): Promise<void> {
  const result = await browser.electron.execute((electron, original) => {
    const target = electron.BrowserWindow.fromId(original.windowId);
    if (!target || target.isDestroyed()) {
      return { ok: true as const, windowMissing: true as const };
    }
    target.setContentSize(original.width, original.height);
    const [restoredWidth = 0, restoredHeight = 0] = target.getContentSize();
    return {
      ok:
        Math.abs(restoredWidth - original.width) <= 1 &&
        Math.abs(restoredHeight - original.height) <= 1,
      restoredHeight,
      restoredWidth,
      windowMissing: false as const,
    };
  }, snapshot);

  if (!result.ok) {
    throw new Error(
      `Electron renderer content size 恢复失败: expected=${snapshot.width}x${snapshot.height}; actual=${result.restoredWidth}x${result.restoredHeight}`,
    );
  }
}

async function switchToWorkspaceRendererWindow(workspacePath: string, timeout = 10000) {
  let latestResult: WorkspaceRendererSwitchResult = {
    switched: false,
    reason: "not-started",
  };

  try {
    // Fix rationale: early in Electron startup the BrowserWindow already exists, but the
    // WebDriver handle / CDP target Chromedriver sees may still be the chrome-error transition
    // page. Retry the switch against the real BrowserWindow URL so conversation e2e does not look
    // for the welcome page on the wrong renderer.
    await browser.waitUntil(
      async () => {
        latestResult = await trySwitchToWorkspaceRendererWindow(workspacePath);
        return latestResult.switched;
      },
      {
        interval: 250,
        timeout,
        timeoutMsg: `未找到可切换的工作区 renderer target: ${workspacePath}`,
      },
    );
  } catch (error) {
    throw new Error(
      `未找到可切换的工作区 renderer target: ${workspacePath}\n诊断: ${JSON.stringify(
        latestResult,
        null,
        2,
      )}`,
      {
        cause: error,
      },
    );
  }
}

async function trySwitchToWorkspaceRendererWindow(
  workspacePath: string,
): Promise<WorkspaceRendererSwitchResult> {
  const windows = await getAllWindowInfo().catch((error: unknown) => ({
    error: serializeError(error),
  }));
  if (!Array.isArray(windows)) {
    return {
      switched: false,
      reason: "window-info-failed",
      error: windows.error,
    };
  }
  const windowUrl =
    windows.find((win) => isWorkspaceRendererUrl(win.url, workspacePath))?.url ??
    windows.find((win) => isRendererUrl(win.url))?.url ??
    null;

  if (!windowUrl) {
    return {
      switched: false,
      reason: "missing-renderer-window-url",
      windows,
    };
  }

  const targets = await getBrowserTargetInfo().catch(() => []);
  const handles = await browser.getWindowHandles().catch(() => []);
  const target =
    targets.find((item) => item.id && isExpectedRendererUrl(item.url, windowUrl, workspacePath)) ??
    null;
  const candidates = collectE2EWebDriverPageHandleCandidates(handles, targets).sort(
    (left, right) =>
      Number(isExpectedRendererUrl(right.targetUrl, windowUrl, workspacePath)) -
      Number(isExpectedRendererUrl(left.targetUrl, windowUrl, workspacePath)),
  );

  if (candidates.length === 0) {
    return {
      switched: false,
      reason: target?.id ? "renderer-target-not-in-webdriver-handles" : "missing-renderer-target",
      currentUrl: await getCurrentRendererUrl().catch(() => null),
      handles,
      target,
      targets,
      windowUrl,
      windows,
    };
  }

  const handleInspections: NonNullable<
    Exclude<WorkspaceRendererSwitchResult, { switched: true }>["handleInspections"]
  > = [];
  for (const candidate of candidates) {
    try {
      await browser.switchToWindow(candidate.handle);
      const currentHandle = await browser.getWindowHandle().catch(() => null);
      const currentUrl = await getCurrentRendererUrl().catch(() => null);
      handleInspections.push({
        currentHandle,
        currentUrl,
        handle: candidate.handle,
        targetUrl: candidate.targetUrl,
      });
      if (
        currentHandle === candidate.handle &&
        typeof currentUrl === "string" &&
        isExpectedRendererUrl(currentUrl, windowUrl, workspacePath)
      ) {
        setElectronWindowHandle(candidate.handle);
        return { switched: true };
      }
    } catch (error) {
      handleInspections.push({
        currentHandle: null,
        currentUrl: null,
        error: serializeError(error),
        handle: candidate.handle,
        targetUrl: candidate.targetUrl,
      });
    }
  }

  return {
    switched: false,
    reason: "webdriver-page-handle-url-mismatch",
    currentUrl: handleInspections.at(-1)?.currentUrl ?? null,
    handleInspections,
    handles,
    target,
    targets,
    windowUrl,
    windows,
  };
}

async function switchToHandle(handle: string) {
  await browser.switchToWindow(handle);
  setElectronWindowHandle(handle);
}

function setElectronWindowHandle(handle: string) {
  (browser.electron as typeof browser.electron & { windowHandle?: string }).windowHandle = handle;
}

async function getBrowserTargetInfo(): Promise<E2EBrowserTargetInfo[]> {
  const puppeteer = await browser.getPuppeteer();
  return puppeteer.targets().map((target) => ({
    id: (target as unknown as { _targetId?: string })._targetId ?? null,
    type: target.type(),
    url: target.url(),
  }));
}

async function getCurrentRendererUrl() {
  return browser.execute(() => window.location.href);
}

function serializeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isExpectedRendererUrl(currentUrl: string, windowUrl: string, workspacePath: string) {
  return currentUrl === windowUrl || isWorkspaceRendererUrl(currentUrl, workspacePath);
}

function isRendererUrl(url: string) {
  try {
    // Fix rationale: E2E copies out to runId/app, so renderer identity can no longer be bound to
    // the shared out path.
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}

function isWorkspaceRendererUrl(url: string, workspacePath: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.endsWith("/renderer/index.html") &&
      parsed.searchParams.get("initialWorkspacePath") === workspacePath
    );
  } catch {
    return false;
  }
}

export async function switchToNewestWindow() {
  const handles = await browser.getWindowHandles();
  const newestHandle = handles.at(-1);

  if (!newestHandle) {
    throw new Error("当前没有可切换的窗口句柄");
  }

  await switchToHandle(newestHandle);
}

export async function clickAboutMenuItem() {
  await browser.electron.execute((electron) => {
    const menu = electron.Menu.getApplicationMenu();
    const topMenuLabel = process.platform === "darwin" ? electron.app.name : "Help";
    const topMenu = menu?.items.find((item) => item.label === topMenuLabel);
    const menuItem = topMenu?.submenu?.items.find((item) => item.label === "About ZCode");

    if (!menuItem) {
      throw new Error(`未找到 About ZCode 菜单项: ${topMenuLabel}`);
    }

    menuItem.click(undefined as never, undefined, undefined as never);
  });
}

export async function clickDockMenuItem(itemLabel: string) {
  await browser.electron.execute((electron, itemLabel) => {
    const menu = electron.app.dock?.getMenu();
    const menuItem = menu?.items.find((item) => item.label === itemLabel);
    menuItem?.click(undefined as never, undefined, undefined as never);
  }, itemLabel);
}

export async function getDockMenuLabels(): Promise<string[]> {
  return browser.electron.execute((electron) => {
    return (
      electron.app.dock
        ?.getMenu()
        ?.items.map((item) => item.label)
        .filter((label): label is string => Boolean(label)) ?? []
    );
  });
}

export async function clearRecentDocuments() {
  await browser.electron.execute((electron) => {
    if (process.platform === "darwin" || process.platform === "win32") {
      electron.app.clearRecentDocuments();
    }
  });
}

export async function getRecentDocuments(): Promise<string[]> {
  return browser.electron.execute((electron) => {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return [];
    }

    return electron.app.getRecentDocuments();
  });
}

export async function minimizePrimaryWindow() {
  await browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    win?.minimize();
  });
}

export async function isPrimaryWindowMinimized(): Promise<boolean> {
  return browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getAllWindows()[0];
    return win?.isMinimized() ?? false;
  });
}

export async function getTabLabels(): Promise<string[]> {
  return browser.execute(() => {
    const workspaceItems = Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid^='workspace-item-']"),
    );
    if (workspaceItems.length > 0) {
      return workspaceItems
        .map((node) => {
          const label = node.querySelector("div > div")?.textContent?.trim();
          return label ?? "";
        })
        .filter(Boolean);
    }

    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='tab-item-'] span"))
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}
