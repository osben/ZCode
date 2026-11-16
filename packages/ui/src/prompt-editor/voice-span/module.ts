/**
 * ui-voice-span module manifest (architecture-governance managed module). Update requires in
 * architecture-policy.yaml together with this manifest — the checker validates both agree.
 */
export const uiVoiceSpanModule = {
  id: "ui-voice-span",
  requires: [],
  provides: ["ui-voice-span"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
