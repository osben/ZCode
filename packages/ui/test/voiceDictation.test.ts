import assert from "node:assert/strict";
import test from "node:test";
import {
  VOICE_SAMPLE_RATE,
  concatFloat32Chunks,
  float32ToPcm16Le,
  peakLevel,
  samplesToMilliseconds,
} from "../src/lib/voiceDictationAudio.js";
import { isVoiceShortcutReleased } from "../src/lib/voiceDictationShortcut.js";

test("float32ToPcm16Le encodes little-endian and clamps out-of-range samples", () => {
  const bytes = float32ToPcm16Le(new Float32Array([0, 0.5, -1, 2, -2]));
  const view = new DataView(bytes.buffer);

  assert.equal(bytes.byteLength, 10);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), Math.round(0.5 * 0x7fff));
  assert.equal(view.getInt16(4, true), -0x8000);
  assert.equal(view.getInt16(6, true), 0x7fff);
  assert.equal(view.getInt16(8, true), -0x8000);
});

test("concatFloat32Chunks joins chunks in order", () => {
  const joined = concatFloat32Chunks([new Float32Array([1, 2]), new Float32Array([3])]);
  assert.deepEqual(Array.from(joined), [1, 2, 3]);
  assert.equal(concatFloat32Chunks([]).length, 0);
});

test("peakLevel returns the absolute maximum clamped to 1", () => {
  assert.ok(Math.abs(peakLevel(new Float32Array([0.1, -0.7, 0.3])) - 0.7) < 1e-6);
  assert.equal(peakLevel(new Float32Array([0, 0])), 0);
  assert.equal(peakLevel(new Float32Array([3])), 1);
});

test("samplesToMilliseconds uses the 16 kHz voice sample rate", () => {
  assert.equal(VOICE_SAMPLE_RATE, 16000);
  assert.equal(samplesToMilliseconds(8000), 500);
});

test("push-to-talk ends when the main key of the binding is released", () => {
  assert.equal(isVoiceShortcutReleased({ key: "d", code: "KeyD" }, "CmdOrCtrl+Shift+d"), true);
  assert.equal(isVoiceShortcutReleased({ key: "D", code: "KeyD" }, "CmdOrCtrl+Shift+d"), true);
});

test("push-to-talk ends when any modifier of the binding is released", () => {
  assert.equal(
    isVoiceShortcutReleased({ key: "Meta", code: "MetaLeft" }, "CmdOrCtrl+Shift+d"),
    true,
  );
  assert.equal(
    isVoiceShortcutReleased({ key: "Shift", code: "ShiftLeft" }, "CmdOrCtrl+Shift+d"),
    true,
  );
  assert.equal(isVoiceShortcutReleased({ key: "Alt", code: "AltLeft" }, "Alt+d"), true);
});

test("unrelated keys do not end push-to-talk", () => {
  assert.equal(isVoiceShortcutReleased({ key: "a", code: "KeyA" }, "CmdOrCtrl+Shift+d"), false);
  assert.equal(
    isVoiceShortcutReleased({ key: "Alt", code: "AltLeft" }, "CmdOrCtrl+Shift+d"),
    false,
  );
  assert.equal(isVoiceShortcutReleased({ key: "d", code: "KeyD" }, "not a binding+++"), false);
});
