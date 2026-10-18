import type { IVoiceDictationService, VoicePostProcessProvider } from "@zcode/services";

/** Safety net above the Host's own 15 s limit, so a hung Host call can never strand the busy state. */
export const POST_PROCESS_CLIENT_TIMEOUT_MS = 20_000;

/**
 * Runs the transcript through the Host's post-processing provider. Rejects on any failure or when the
 * Host does not answer in time; the caller then falls back to the raw transcript.
 */
export async function runPostProcess(
  service: IVoiceDictationService,
  request: { text: string; prompt: string; provider: VoicePostProcessProvider },
  timeoutMs = POST_PROCESS_CLIENT_TIMEOUT_MS,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("post-processing timed out")), timeoutMs);
  });
  try {
    const result = await Promise.race([service.postProcess(request), timeout]);
    const text = result.text.trim();
    if (!text) throw new Error("post-processing returned empty text");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post-processes a transcript best-effort: any failure (including a Host that lacks the method) is
 * logged and yields the raw text, which is still what the user said.
 */
export async function postProcessOrRaw(
  service: IVoiceDictationService,
  request: { text: string; prompt: string; provider: VoicePostProcessProvider },
  onFailure: (error: unknown) => void,
): Promise<string> {
  try {
    return await runPostProcess(service, request);
  } catch (error) {
    onFailure(error);
    return request.text;
  }
}
