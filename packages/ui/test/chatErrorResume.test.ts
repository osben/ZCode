import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_ERROR_RESUME_MESSAGE,
  canResumeChatError,
  isModelConfigMissingError,
} from "../src/lib/chatErrorResume.js";

test("Resume sends the fixed English continuation prompt", () => {
  assert.equal(CHAT_ERROR_RESUME_MESSAGE, "Continue from where you left off");
});

test("Resume is offered for ordinary chat errors", () => {
  assert.equal(canResumeChatError({ code: "SEND_FAILED", message: "boom" }), true);
  assert.equal(canResumeChatError({ code: "UNKNOWN", message: "network reset" }), true);
  assert.equal(canResumeChatError({ message: "no code" }), true);
});

test("Resume is hidden when the model config is missing", () => {
  for (const code of ["model_config_missing", "MODEL_CONFIG_MISSING", "ModelConfigMissing"]) {
    assert.equal(isModelConfigMissingError({ code, message: "" }), true);
    assert.equal(canResumeChatError({ code, message: "" }), false);
  }
});

test("model config detection uses structured codes only, not message text", () => {
  const message = "Model config is missing";
  assert.equal(isModelConfigMissingError({ code: "UNKNOWN", message }), false);
  assert.equal(canResumeChatError({ code: "UNKNOWN", message }), true);
});

test("Resume is hidden when a hook blocked the turn", () => {
  assert.equal(canResumeChatError({ code: "fault.runtime.hookBlocked", message: "" }), false);
});
