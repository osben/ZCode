/**
 * ui-voice-span canonical call example: this is the shape agents should imitate.
 */
import { createEditor } from "lexical";
import { VoiceTextNode, VoiceTentativeTextNode } from "./VoiceTextNode.js";
import {
  $finalizeVoiceSpan,
  $updateVoiceSpan,
  createVoiceSpanState,
  type VoiceSpanState,
} from "./voiceSpanOperations.js";

export function exampleVoiceSpan(): void {
  const editor = createEditor({
    namespace: "example",
    nodes: [VoiceTextNode, VoiceTentativeTextNode],
  });
  const state: VoiceSpanState = createVoiceSpanState();
  editor.update(() => $updateVoiceSpan({ committed: "hello", tentative: "the" }, state));
  editor.update(() => $finalizeVoiceSpan("hello there", state));
}
