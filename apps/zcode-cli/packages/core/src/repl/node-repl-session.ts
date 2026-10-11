import { createContext, runInContext, type Context } from "node:vm";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { IifeContextExecutor, type ReplExecutor } from "./executors.js";
import {
  PROCESS_MODULE_IDS,
  createReplRequire,
  createRestrictedProcessFacade,
  normalizeReplError,
  stringifyReplResult,
} from "./node-repl-runtime-helpers.js";

/** Images collected by the REPL (nodeRepl.emitImage). */
export interface NodeReplImage {
  base64: string;
  mimeType: string;
}

/** SDK/bridge result block; preserve MCP structured fields without making core depend on MCP SDK types. */
export interface NodeReplStructuredResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Target application identity for this cell's operation (Computer Use).
 *
 * Recorded only by the host CUA bridge when it receives a broker response; it is not on sandbox globals, so the model cannot change it.
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` are model-writable channels, so producer application metadata received through them
 * is untrusted and must be discarded by toMcpRunResult.
 */
export interface NodeReplCuaAppIdentity {
  appKey: string;
  displayName?: string;
}

/** Output sink: nodeRepl.write / console output in the REPL is collected here; emitImage collects images. */
export interface NodeReplWriteSink {
  write(text: string): void;
  images: NodeReplImage[];
  browserScreenshots: NodeReplImage[];
  structuredResults: NodeReplStructuredResult[];
  responseMeta: Record<string, unknown>;
  cuaApps: NodeReplCuaAppIdentity[];
}

export interface NodeReplRunResult {
  /** Stringified final value/return value (may be undefined). */
  result?: string;
  /** Output collected by nodeRepl.write + console during this run. */
  logs: string;
  /** Structured error when an exception is thrown (without crashing the process). */
  error?: { name: string; message: string; stack?: string };
  /** Images collected by nodeRepl.emitImage during this run (such as screenshots). */
  images?: NodeReplImage[];
  /** Indexes in images confirmed to come from an explicit tab.screenshot() call in this run. */
  browserScreenshotImageIndices?: number[];
  /** Structured result written by the SDK through a dedicated channel; takes priority over console/REPL output. */
  structuredResults?: NodeReplStructuredResult[];
  /** Metadata set by nodeRepl.setResponseMeta during this run. */
  responseMeta?: Record<string, unknown>;
  /** Application targeted by the last identity-establishing CUA call in this cell; recorded by the host bridge and not writable by the model. */
  cuaApp?: NodeReplCuaAppIdentity;
}

export type NodeReplRequestMeta = Record<string, unknown>;

export interface NodeReplSessionOptions {
  /** Additional globals injected into the sandbox (such as the browser execute bridge or agent object). */
  injectedGlobals?: Record<PropertyKey, unknown> | (() => Record<PropertyKey, unknown>);
  /** MCP stdio runtime uses a restricted process facade so a cell cannot close the process or corrupt protocol stdout. */
  restrictProcess?: boolean;
}

function browserScreenshotIndexResult(
  images: readonly NodeReplImage[],
  browserScreenshots: readonly NodeReplImage[],
): Pick<NodeReplRunResult, "browserScreenshotImageIndices"> {
  if (images.length === 0 || browserScreenshots.length === 0) return {};

  const remainingByPayload = new Map<string, number>();
  for (const screenshot of browserScreenshots) {
    const key = `${screenshot.mimeType}\u0000${screenshot.base64}`;
    remainingByPayload.set(key, (remainingByPayload.get(key) ?? 0) + 1);
  }

  const browserScreenshotImageIndices: number[] = [];
  images.forEach((image, index) => {
    const key = `${image.mimeType}\u0000${image.base64}`;
    const remaining = remainingByPayload.get(key) ?? 0;
    if (remaining <= 0) return;
    browserScreenshotImageIndices.push(index);
    remainingByPayload.set(key, remaining - 1);
  });
  return browserScreenshotImageIndices.length > 0 ? { browserScreenshotImageIndices } : {};
}

/**
 * If a cell makes multiple CUA calls, use the last one that establishes identity, matching the existing last-write-wins behavior of `_meta`.
 * Calls that do not produce a primary identity (list_apps items mode, request_access / stop none) never enter
 * this array, so they do not overwrite the identity from a previous action.
 */
function latestCuaAppResult(
  cuaApps: readonly NodeReplCuaAppIdentity[],
): Pick<NodeReplRunResult, "cuaApp"> {
  const cuaApp = cuaApps.at(-1);
  return cuaApp ? { cuaApp } : {};
}

/**
 * NodeReplSession: persistent JavaScript execution engine inside the caller's process.
 *
 * One instance per session; the sandbox is the globalThis visible to the model and retains state across run() calls.
 * Top-level await runs through an async IIFE, dynamic loading uses the injected importModule(), and results are returned in a consistent structured form.
 *
 * Security: vm is not a secure sandbox; isolation still depends on higher-level permissions and approval gates. The restricted process facade only
 * limits a cell's direct impact on process control and MCP stdio; third-party modules still execute in the host Node realm.
 */
export class NodeReplSession {
  private context: Context;
  private readonly createInjectedGlobals: () => Record<PropertyKey, unknown>;
  private readonly restrictedProcess: Readonly<Record<string, unknown>> | undefined;
  private currentSink: NodeReplWriteSink | null = null;
  private nodeReplApi: {
    requestMeta: NodeReplRequestMeta;
    emitStructuredResult: (result: unknown) => void;
  } | null = null;
  private disposed = false;
  private cleanupContextResources: () => void = () => undefined;
  /** Execution + persistence strategy (strategy B by default); switching the executor changes the strategy without changing the run body. */
  private readonly executor: ReplExecutor;

  constructor(options: NodeReplSessionOptions = {}) {
    const injectedGlobals = options.injectedGlobals;
    this.createInjectedGlobals =
      typeof injectedGlobals === "function" ? injectedGlobals : () => injectedGlobals ?? {};
    this.restrictedProcess = options.restrictProcess ? createRestrictedProcessFacade() : undefined;
    this.executor = new IifeContextExecutor();
    this.context = this.buildContext();
  }

  private buildContext(): Context {
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();
    const scopedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setTimeout(() => {
        timeouts.delete(handle);
        callback(...args);
      }, delay);
      timeouts.add(handle);
      return handle;
    };
    const scopedClearTimeout = (handle: ReturnType<typeof setTimeout>) => {
      timeouts.delete(handle);
      clearTimeout(handle);
    };
    const scopedSetInterval = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setInterval(callback, delay, ...args);
      intervals.add(handle);
      return handle;
    };
    const scopedClearInterval = (handle: ReturnType<typeof setInterval>) => {
      intervals.delete(handle);
      clearInterval(handle);
    };
    this.cleanupContextResources = () => {
      for (const handle of timeouts) clearTimeout(handle);
      for (const handle of intervals) clearInterval(handle);
      timeouts.clear();
      intervals.clear();
    };
    // Tee console output to the current sink (set before each run) while preserving the original console for debugging.
    const teeConsole = {
      log: (...args: unknown[]) => this.emit(args),
      info: (...args: unknown[]) => this.emit(args),
      warn: (...args: unknown[]) => this.emit(args),
      error: (...args: unknown[]) => this.emit(args),
      debug: (...args: unknown[]) => this.emit(args),
    };
    // Use the current working directory as the require base.
    const req = createReplRequire(createRequire(`${process.cwd()}/`), this.restrictedProcess);
    const nodeReplApi = {
      cwd: process.cwd(),
      homeDir: homedir(),
      tmpDir: tmpdir(),
      requestMeta: {} as NodeReplRequestMeta,
      write: (text: string) => this.emit([text]),
      // Return images (such as tab.screenshot results) to the model as image content blocks; accept bytes/base64/dataUrl.
      emitImage: (image: unknown) => this.emitImage(image),
      // SDK results must use the structured channel; otherwise model console.log can split image/image_ref into plain text,
      // and official CUA exact-frame validation cannot confirm that the blocks remain adjacent and unchanged.
      emitStructuredResult: (result: unknown) => this.emitStructuredResult(result),
      setResponseMeta: (meta: unknown) => this.setResponseMeta(meta),
    };
    this.nodeReplApi = nodeReplApi;
    const sandbox: Record<PropertyKey, unknown> = {
      console: teeConsole,
      process: this.restrictedProcess ?? process,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout: scopedSetTimeout,
      clearTimeout: scopedClearTimeout,
      setInterval: scopedSetInterval,
      clearInterval: scopedClearInterval,
      queueMicrotask,
      structuredClone,
      require: req,
      // Load modules dynamically through the injected function rather than bare import(): import() in vm requires the --experimental-vm-modules
      // startup flag (the agent is a packaged binary, so adding the flag is inconvenient); importModule calls host import() directly and needs no flag.
      // The model and browser skill use standard await import("..."); the executor safely rewrites it to this loader using the AST.
      importModule: (specifier: string) => this.importModule(specifier),
      nodeRepl: nodeReplApi,
      // Rebuild the browser-client facade on each kernel reset; browser/tab bindings from the old context
      // must not drift into the new generation, keeping the bootstrap boundary consistent with a new session.
      ...this.createInjectedGlobals(),
    };
    const context = createContext(sandbox);
    // Make globalThis self-referential so the model can persist values explicitly with globalThis.x = ...
    runInContext("globalThis.globalThis = globalThis;", context);
    return context;
  }

  private emit(args: unknown[]): void {
    if (!this.currentSink) {
      return;
    }
    const text = args
      .map((a) => (typeof a === "string" ? a : (stringifyReplResult(a) ?? "undefined")))
      .join(" ");
    this.currentSink.write(text);
  }

  /**
   * Collect an image in this run's output (formatModelContent converts it to an image content block for the model).
   * Accept Uint8Array/Buffer/number[], a data URL, or { base64 | bytes, mimeType }.
   * Throw TypeError for invalid input so the model can see the usage error directly.
   */
  private emitImage(image: unknown): void {
    if (!this.currentSink) {
      return;
    }
    const directBytes =
      (ArrayBuffer.isView(image) && !(image instanceof DataView)) || Array.isArray(image)
        ? (image as Uint8Array | number[])
        : null;
    const rec =
      directBytes !== null
        ? { bytes: directBytes }
        : ((image ?? {}) as {
            base64?: unknown;
            bytes?: unknown;
            dataUrl?: unknown;
            mimeType?: unknown;
          });
    let base64: string | null = null;
    let dataUrlMimeType: string | undefined;
    if (typeof rec.dataUrl === "string") {
      const match = /^data:([^;,]+);base64,(.+)$/u.exec(rec.dataUrl);
      if (match) {
        dataUrlMimeType = match[1];
        base64 = match[2];
      }
    } else if (typeof rec.base64 === "string" && rec.base64.length > 0) {
      base64 = rec.base64;
    } else if (rec.bytes != null) {
      try {
        base64 = Buffer.from(rec.bytes as Uint8Array | readonly number[]).toString("base64");
      } catch {
        base64 = null;
      }
    }
    if (!base64) {
      throw new TypeError(
        "nodeRepl.emitImage requires bytes, dataUrl, { base64 }, or { bytes }; e.g. emitImage(await tab.screenshot())",
      );
    }
    const mimeType =
      typeof rec.mimeType === "string" && rec.mimeType
        ? rec.mimeType
        : (dataUrlMimeType ?? "image/png");
    this.currentSink.images.push({ base64, mimeType });
  }

  private setResponseMeta(meta: unknown): void {
    if (!this.currentSink) return;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new TypeError("nodeRepl.setResponseMeta requires a plain object");
    }
    Object.assign(this.currentSink.responseMeta, meta as Record<string, unknown>);
  }

  private emitStructuredResult(result: unknown): void {
    if (!this.currentSink) return;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError("nodeRepl.emitStructuredResult requires a result object");
    }
    const candidate = result as { content?: unknown };
    if (!Array.isArray(candidate.content)) {
      throw new TypeError("nodeRepl.emitStructuredResult requires a content array");
    }
    for (const block of candidate.content) {
      if (!block || typeof block !== "object" || typeof (block as { type?: unknown }).type !== "string") {
        throw new TypeError("nodeRepl.emitStructuredResult content blocks require a type");
      }
    }
    this.currentSink.structuredResults.push(result as NodeReplStructuredResult);
  }

  /** Browser-client transport merges backend metadata into the tool result within the same js run. */
  mergeResponseMeta(meta: Record<string, unknown>): void {
    if (!this.currentSink) return;
    const currentSurface = this.currentSink.responseMeta["zcode/toolSurface"];
    const nextSurface = meta["zcode/toolSurface"];
    // Tool results must retain openTabIds/sessionEnded from the last successful side effect in the same cell. ZCode does not preview automatically,
    // but later title/url/domSnapshot reads in that cell must not overwrite metadata from the earlier action.
    if (
      currentSurface &&
      typeof currentSurface === "object" &&
      !Array.isArray(currentSurface) &&
      nextSurface &&
      typeof nextSurface === "object" &&
      !Array.isArray(nextSurface)
    ) {
      this.setResponseMeta({
        ...meta,
        "zcode/toolSurface": {
          ...(currentSurface as Record<string, unknown>),
          ...(nextSurface as Record<string, unknown>),
        },
      });
      return;
    }
    this.setResponseMeta(meta);
  }

  /** Browser transport records the raw image from a model-requested screenshot so emitImage output can be matched to its source. */
  recordBrowserScreenshot(image: NodeReplImage): void {
    if (!this.currentSink) return;
    this.currentSink.browserScreenshots.push(image);
  }

  /**
   * The CUA bridge records the target application identity for this call from the broker response.
   *
   * Deliberately not placed in sandbox globals (unlike write/emitImage/emitStructuredResult/setResponseMeta):
   * tool cards use this to show the App icon, and if the model could write it, it could claim to have operated another application.
   */
  recordCuaAppIdentity(app: NodeReplCuaAppIdentity): void {
    if (!this.currentSink) return;
    this.currentSink.cuaApps.push(app);
  }

  /** Execute code; signal supports cancellation (timeout/stop). */
  async run(
    code: string,
    options: {
      signal?: AbortSignal;
      requestMeta?: NodeReplRequestMeta;
      syncTimeoutMs?: number;
    } = {},
  ): Promise<NodeReplRunResult> {
    if (this.disposed) {
      return {
        logs: "",
        error: { name: "DisposedError", message: "REPL session 已释放" },
      };
    }
    let buffer = "";
    const images: NodeReplImage[] = [];
    const browserScreenshots: NodeReplImage[] = [];
    const structuredResults: NodeReplStructuredResult[] = [];
    const responseMeta: Record<string, unknown> = {};
    const cuaApps: NodeReplCuaAppIdentity[] = [];
    if (this.nodeReplApi) {
      this.nodeReplApi.requestMeta = { ...options.requestMeta };
    }
    this.currentSink = {
      write: (text: string) => {
        buffer += (buffer ? "\n" : "") + text;
      },
      images,
      browserScreenshots,
      structuredResults,
      responseMeta,
      cuaApps,
    };
    try {
      // Delegate execution to the executor (strategy B by default: instrument top-level declarations → async IIFE → runInContext),
      // making top-level const/let/var/function/class persist across js calls by copying them to globalThis.
      const value = await this.executor.run(
        code,
        this.context,
        options.signal,
        options.syncTimeoutMs,
      );
      return {
        result: stringifyReplResult(value),
        logs: buffer,
        ...(images.length > 0 ? { images } : {}),
        ...browserScreenshotIndexResult(images, browserScreenshots),
        ...(structuredResults.length > 0 ? { structuredResults } : {}),
        ...(Object.keys(responseMeta).length > 0 ? { responseMeta } : {}),
        ...latestCuaAppResult(cuaApps),
      };
    } catch (error) {
      // Errors thrown in the vm context belong to another realm, so `instanceof Error` is false on the host.
      // Extract them by their error-like structure (name/message/stack fields) instead of wrapping in a new Error
      // (which would change the message to "Error: boom" and lose the original message).
      const normalized = normalizeReplError(error);
      const mustResetKernel =
        normalized.name === "AbortError" ||
        normalized.name === "TimeoutError" ||
        normalized.message.includes("Script execution timed out");
      if (mustResetKernel && !this.disposed) {
        // Promise.race can stop waiting only; old async continuations/timers may still write state to the same global.
        // After cancellation or VM timeout, discard the entire context and clear that generation's timers;
        // subsequent calls see only a fresh kernel and cannot observe late mutations.
        this.cleanupContextResources();
        this.context = this.buildContext();
        // Silently rebuilding the context would leave the model calling cleared browser/tab variables,
        // turning one timeout into repeated ReferenceErrors. The error itself must expose the reset semantics and recovery action.
        normalized.message = `${normalized.message}; kernel reset, all previous bindings were cleared; reinitialize browser/tab bindings before rerunning`;
      }
      return {
        logs: buffer,
        error: normalized,
        ...(images.length > 0 ? { images } : {}),
        ...browserScreenshotIndexResult(images, browserScreenshots),
        ...(structuredResults.length > 0 ? { structuredResults } : {}),
        ...(Object.keys(responseMeta).length > 0 ? { responseMeta } : {}),
        ...latestCuaAppResult(cuaApps),
      };
    } finally {
      this.currentSink = null;
      if (this.nodeReplApi) {
        this.nodeReplApi.requestMeta = {};
      }
    }
  }

  private async importModule(specifier: string): Promise<unknown> {
    if (this.restrictedProcess && PROCESS_MODULE_IDS.has(specifier)) {
      return { ...this.restrictedProcess, default: this.restrictedProcess };
    }
    return await import(specifier);
  }

  /** Release resources. */
  dispose(): void {
    this.disposed = true;
    this.cleanupContextResources();
    this.currentSink = null;
  }
}
