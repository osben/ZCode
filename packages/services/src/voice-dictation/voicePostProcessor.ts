import { spawn } from "node:child_process";
import { applyPostProcessPrompt } from "./voicePostProcessPrompt.js";
import type {
  VoicePostProcessAvailability,
  VoicePostProcessRequest,
  VoicePostProcessResponse,
} from "./voiceDictation.js";

/** Environment variable through which Desktop main hands the Host the bundled helper path. */
export const ZCODE_APPLE_FM_HELPER_ENV = "ZCODE_APPLE_FM_HELPER";

const AVAILABILITY_TIMEOUT_MS = 5_000;
const GENERATE_TIMEOUT_MS = 15_000;
/** A dictated clip is short; this bounds a pathological input before it reaches the model. */
const MAX_INPUT_CHARS = 20_000;

export interface ProcessResult {
  stdout: string;
  code: number | null;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs: number },
) => Promise<ProcessResult>;

/** Runs a process to completion with optional stdin; rejects (after killing it) when the timeout passes. */
export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${command} timed out after ${options.timeoutMs} ms`)));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ stdout, code })));
    // The helper may exit before reading stdin; that surfaces through its exit code, not an EPIPE crash.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });

export interface VoicePostProcessorOptions {
  /** Path of the bundled Apple Foundation Models bridge; absent when the build did not ship it. */
  helperPath: string | undefined;
  platform?: NodeJS.Platform;
  run?: ProcessRunner;
  generateTimeoutMs?: number;
}

type UnavailableReason = Extract<VoicePostProcessAvailability, { status: "unavailable" }>["reason"];

const KNOWN_UNAVAILABLE_REASONS: readonly UnavailableReason[] = [
  "deviceNotEligible",
  "appleIntelligenceNotEnabled",
  "modelNotReady",
  "unsupportedOS",
];

/**
 * Host-side owner of the post-processing provider. The only provider today is the on-device Apple
 * Foundation Models bridge; new providers would plug in behind `postProcess` without changing callers.
 */
export class VoicePostProcessor {
  private readonly helperPath: string | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly run: ProcessRunner;
  private readonly generateTimeoutMs: number;

  constructor(options: VoicePostProcessorOptions) {
    this.helperPath = options.helperPath;
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runProcess;
    this.generateTimeoutMs = options.generateTimeoutMs ?? GENERATE_TIMEOUT_MS;
  }

  async getAvailability(): Promise<VoicePostProcessAvailability> {
    if (this.platform !== "darwin") return { status: "unavailable", reason: "unsupportedPlatform" };
    if (!this.helperPath) return { status: "unavailable", reason: "helperMissing" };
    try {
      const { stdout } = await this.run(this.helperPath, ["availability"], {
        timeoutMs: AVAILABILITY_TIMEOUT_MS,
      });
      const parsed = parseJsonObject(stdout);
      if (parsed?.status === "available") return { status: "available" };
      const reason = KNOWN_UNAVAILABLE_REASONS.find((known) => known === parsed?.reason);
      return { status: "unavailable", reason: reason ?? "unknown" };
    } catch {
      return { status: "unavailable", reason: "unknown" };
    }
  }

  async postProcess(request: VoicePostProcessRequest): Promise<VoicePostProcessResponse> {
    const text = request.text.trim();
    if (!text) throw new Error("post-processing input is empty");
    if (text.length > MAX_INPUT_CHARS) throw new Error("post-processing input is too long");
    if (this.platform !== "darwin" || !this.helperPath) {
      throw new Error("post-processing provider is unavailable");
    }
    const { stdout, code } = await this.run(this.helperPath, ["generate"], {
      stdin: JSON.stringify({ prompt: applyPostProcessPrompt(request.prompt, text) }),
      timeoutMs: this.generateTimeoutMs,
    });
    const parsed = parseJsonObject(stdout);
    if (!parsed) throw new Error("post-processing provider returned invalid output");
    if (code !== 0 || typeof parsed.error === "string") {
      throw new Error(`post-processing failed: ${String(parsed.error ?? `exit code ${code}`)}`);
    }
    const result = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!result) throw new Error("post-processing returned empty text");
    return { text: result };
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
