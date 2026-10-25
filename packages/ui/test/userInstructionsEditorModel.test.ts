import assert from "node:assert/strict";
import test from "node:test";
import {
  canSaveUserInstructions,
  countUtf8Bytes,
  estimateUserInstructionsDiskBytes,
  getUserInstructionsHostKey,
  getUserInstructionsRevealDirectory,
  hasClaudeAtImports,
  isUnknownChannelError,
  isUserInstructionsDraftDirty,
  resolvePinnedUserInstructionsTarget,
  resolveUserInstructionsEditorStatus,
  type UserInstructionsLoadedFile,
} from "../src/settings/userInstructionsEditorModel.js";

function loaded(overrides: Partial<UserInstructionsLoadedFile> = {}): UserInstructionsLoadedFile {
  return {
    kind: "ok",
    path: "/home/u/.zcode/AGENTS.md",
    state: "file",
    content: "hello\n",
    revision: "rev",
    sizeBytes: 6,
    eol: "lf",
    hasBom: false,
    mixedLineEndings: false,
    agentReadLimitBytes: 102400,
    editLimitBytes: 5 * 1024 * 1024,
    ...overrides,
  };
}

test("host key: local without workspace or for local workspace, remote by identity then path", () => {
  assert.equal(getUserInstructionsHostKey({ workspacePath: null }), "local");
  assert.equal(getUserInstructionsHostKey({ workspacePath: "/repo" }), "local");
  assert.equal(
    getUserInstructionsHostKey({ workspacePath: "/repo", workspaceIdentity: " ssh://h/repo " }),
    "remote:ssh://h/repo",
  );
  assert.equal(
    getUserInstructionsHostKey({ workspacePath: "/repo", remoteSessionId: "s1" }),
    "remote:/repo",
  );
  // Reconnecting to the same remote changes only remoteSessionId; the key stays the same.
  assert.equal(
    getUserInstructionsHostKey({
      workspacePath: "/repo",
      workspaceIdentity: "id",
      remoteSessionId: "s1",
    }),
    getUserInstructionsHostKey({
      workspacePath: "/repo",
      workspaceIdentity: "id",
      remoteSessionId: "s2",
    }),
  );
});

test("pinned target follows active host unless a dirty draft belongs to another host", () => {
  const local = { workspacePath: "/repo" };
  const remote = { workspacePath: "/r", workspaceIdentity: "id", remoteSessionId: "s1" };
  const reconnected = { ...remote, remoteSessionId: "s2" };

  assert.equal(
    resolvePinnedUserInstructionsTarget({ pinned: local, active: remote, dirty: false }),
    remote,
  );
  assert.equal(
    resolvePinnedUserInstructionsTarget({ pinned: local, active: remote, dirty: true }),
    local,
  );
  assert.equal(
    resolvePinnedUserInstructionsTarget({ pinned: remote, active: reconnected, dirty: true }),
    reconnected,
  );
});

test("dirty and save availability", () => {
  assert.equal(isUserInstructionsDraftDirty(null, "x"), false);
  assert.equal(isUserInstructionsDraftDirty(loaded(), "hello\n"), false);
  assert.equal(isUserInstructionsDraftDirty(loaded(), "changed"), true);

  assert.equal(canSaveUserInstructions({ loaded: null, draft: "", saving: false }), false);
  assert.equal(
    canSaveUserInstructions({ loaded: loaded(), draft: "hello\n", saving: false }),
    false,
  );
  assert.equal(canSaveUserInstructions({ loaded: loaded(), draft: "x", saving: false }), true);
  assert.equal(canSaveUserInstructions({ loaded: loaded(), draft: "x", saving: true }), false);
  // If the file does not exist, allow saving even without edits (creating an empty file).
  assert.equal(
    canSaveUserInstructions({
      loaded: loaded({ state: "missing", content: "", revision: null }),
      draft: "",
      saving: false,
    }),
    true,
  );
});

test("utf-8 byte count, @ import detection and unknown channel errors", () => {
  assert.equal(countUtf8Bytes("ab"), 2);
  assert.equal(countUtf8Bytes("指令"), 6);
  assert.equal(estimateUserInstructionsDiskBytes({ draft: "a\nb\n", eol: "lf", hasBom: false }), 4);
  assert.equal(
    estimateUserInstructionsDiskBytes({ draft: "a\nb\n", eol: "crlf", hasBom: true }),
    9,
  );

  assert.equal(hasClaudeAtImports("see @docs/a.md inline"), false);
  assert.equal(hasClaudeAtImports("intro\n@docs/rules.md\n"), true);
  assert.equal(hasClaudeAtImports("  @~/shared.md"), true);
  assert.equal(hasClaudeAtImports("email me@example.com"), false);

  const unknown = Object.assign(new Error("Channel name 'x' timed out"), {
    name: "Unknown channel",
  });
  assert.equal(isUnknownChannelError(unknown), true);
  assert.equal(isUnknownChannelError(new Error("boom")), false);
  assert.equal(isUnknownChannelError(undefined), false);
});

test("editor status shows waiting while disconnected even if a file was loaded", () => {
  assert.equal(
    resolveUserInstructionsEditorStatus({ status: "ready", rpcReady: false }),
    "waiting",
  );
  assert.equal(
    resolveUserInstructionsEditorStatus({ status: "loading", rpcReady: false }),
    "waiting",
  );
});

test("editor status passes through the stored status once rpc is ready", () => {
  assert.equal(resolveUserInstructionsEditorStatus({ status: "ready", rpcReady: true }), "ready");
  assert.equal(resolveUserInstructionsEditorStatus({ status: "failed", rpcReady: true }), "failed");
});

test("reveal directory strips the file name for posix and windows paths", () => {
  assert.equal(getUserInstructionsRevealDirectory("/home/u/.zcode/AGENTS.md"), "/home/u/.zcode");
  assert.equal(
    getUserInstructionsRevealDirectory("C:\\Users\\u\\.zcode\\AGENTS.md"),
    "C:\\Users\\u\\.zcode",
  );
  assert.equal(getUserInstructionsRevealDirectory("C:\\AGENTS.md"), "C:\\");
  assert.equal(getUserInstructionsRevealDirectory("/AGENTS.md"), "/");
});
