import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserRecordingArtifact, BrowserViewportSize } from "@zcode/shared";

export interface BrowserWebmRecorderFactoryInput {
  outputPath: string;
  targetFrame: unknown;
  viewport: BrowserViewportSize;
  fps: number;
  signal: AbortSignal;
}

export interface BrowserWebmRecorderSession {
  /** Stop Chromium MediaRecorder and wait for the final WebM chunk to be safely written to disk. */
  stop(): Promise<void>;
  /** Abort recording and close the renderer/stream/file handle; this must be safe to call repeatedly. */
  cancel(): Promise<void>;
}

export type BrowserWebmRecorderFactory = (
  input: BrowserWebmRecorderFactoryInput,
) => Promise<BrowserWebmRecorderSession>;

function abortError(message = "Browser recording cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/**
 * Orchestrate one IAB WebM recording. Desktop main injects the media capabilities, so this pure
 * orchestration layer does not depend on Electron. This makes failure cleanup and artifact contracts
 * testable and avoids Service/Host references back to Runtime implementations.
 */
export async function recordBrowserVideo(input: {
  targetFrame: unknown;
  tempRoot: string;
  recordingId: string;
  viewport: BrowserViewportSize;
  fps: number;
  signal: AbortSignal;
  executeScenario(): Promise<void>;
  onPhase?(phase: "capturing" | "finalizing"): void;
  onCaptureComplete?(): void;
  createRecorder: BrowserWebmRecorderFactory;
  now?: () => number;
}): Promise<BrowserRecordingArtifact> {
  const outputPath = join(input.tempRoot, `${input.recordingId}.webm`);
  const now = input.now ?? Date.now;
  let recorder: BrowserWebmRecorderSession | undefined;
  let completed = false;

  try {
    throwIfAborted(input.signal);
    recorder = await input.createRecorder({
      outputPath,
      targetFrame: input.targetFrame,
      viewport: input.viewport,
      fps: input.fps,
      signal: input.signal,
    });
    throwIfAborted(input.signal);

    const captureStartedAt = now();
    input.onPhase?.("capturing");
    await input.executeScenario();
    throwIfAborted(input.signal);
    const durationMs = Math.max(0, Math.round(now() - captureStartedAt));

    // Page capture is complete: release the background-surface watchdog before waiting for the recorder's final flush chunk.
    input.onCaptureComplete?.();
    input.onPhase?.("finalizing");
    await recorder.stop();
    throwIfAborted(input.signal);

    const artifactStat = await stat(outputPath);
    if (!artifactStat.isFile() || artifactStat.size === 0) {
      throw new Error("Browser recording produced an empty WebM artifact");
    }
    completed = true;
    return {
      path: outputPath,
      mimeType: "video/webm",
      width: input.viewport.width,
      height: input.viewport.height,
      fps: input.fps,
      durationMs,
      frameCount: Math.max(1, Math.round((durationMs / 1_000) * input.fps)),
    };
  } finally {
    if (!completed) {
      // If MediaRecorder fails or a scene action throws, the remaining EBML header looks like a video
      // but cannot be played. Close the recorder and delete the partial file so status does not expose a fake artifact.
      await recorder?.cancel().catch(() => undefined);
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
  }
}
