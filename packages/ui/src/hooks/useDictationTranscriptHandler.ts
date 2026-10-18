import { useCallback } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";

/**
 * Wraps the composer's transcript insertion with the optional "copy dictated text to the
 * clipboard" preference, so both dictation engines (Desktop Host and Web Speech) share one owner.
 * Insertion always happens first; a clipboard failure (permission, unfocused document, missing
 * API) is logged and never fails dictation.
 */
export function useDictationTranscriptHandler(
  onTranscript: (text: string) => void,
): (text: string) => void {
  const { settings } = useSettings();
  const copyToClipboard = settings?.voiceDictation?.copyToClipboard === true;
  return useCallback(
    (text: string) => {
      onTranscript(text);
      if (!copyToClipboard) return;
      try {
        void navigator.clipboard.writeText(text).catch(logCopyFailure);
      } catch (error) {
        logCopyFailure(error);
      }
    },
    [copyToClipboard, onTranscript],
  );
}

function logCopyFailure(error: unknown): void {
  logger.warn("voice dictation clipboard copy failed", {
    error: error instanceof Error ? error.message : String(error),
  });
}
