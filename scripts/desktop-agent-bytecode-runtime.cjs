"use strict";

const v8 = require("node:v8");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { basename, dirname, join } = require("node:path");

function configureBytecodeRuntime() {
  // Bytecode has no source that can be recompiled; compile it fully and preserve the bytecode. The compiler and loader share this configuration.
  v8.setFlagsFromString("--no-lazy --no-flush-bytecode");
  return {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cachedDataVersionTag: v8.cachedDataVersionTag(),
  };
}

function bytecodeDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function loadBytecode(metadata, targetModule, targetRequire) {
  const runtime = configureBytecodeRuntime();
  if (JSON.stringify(runtime) !== JSON.stringify(metadata.runtime)) {
    throw new Error(
      "字节码运行时不匹配，请用当前 Electron 重新运行 pnpm build:desktop-agent:bytecode",
    );
  }
  const directory = dirname(targetModule.filename);
  if (basename(metadata.bytecodeFile) !== metadata.bytecodeFile) {
    throw new Error("无效的字节码文件名");
  }
  const cachedData = await readFile(join(directory, metadata.bytecodeFile));
  if (bytecodeDigest(cachedData) !== metadata.bytecodeSha256) {
    throw new Error("字节码摘要不匹配，请重新构建桌面 Agent");
  }
  // Use an ASCII space rather than a two-byte zero-width character. This removes plaintext source while retaining an equal-length memory placeholder.
  const source = " ".repeat(metadata.sourceLength);
  const filename = join(directory, metadata.sourceFile);
  const script = new vm.Script(source, {
    cachedData,
    filename,
    // Dynamic imports must be handed back to Node so external ESM and native dependencies keep using the original bundle URL resolution.
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  if (script.cachedDataRejected) {
    throw new Error("V8 拒绝字节码缓存，请重新构建桌面 Agent");
  }
  const run = script.runInThisContext();
  if (typeof run !== "function") throw new Error("字节码不是 CommonJS 模块");
  run.call(
    targetModule.exports,
    targetModule.exports,
    targetRequire,
    targetModule,
    filename,
    directory,
  );
}

module.exports = { configureBytecodeRuntime, bytecodeDigest, loadBytecode };
