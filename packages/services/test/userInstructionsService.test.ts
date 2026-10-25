import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { getUserZcodeAgentsFilePath, resolveAgentUserHomeDir } from "@zcode/shared/node";
import { createUserInstructionsService } from "../src/user-instructions/userInstructionsService.js";
import type { UserInstructionsReadResult } from "../src/user-instructions/userInstructions.js";

const isWindows = process.platform === "win32";
let tempHome = "";
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(async () => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  tempHome = await mkdtemp(join(tmpdir(), "zcode-user-instructions-"));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  await rm(tempHome, { recursive: true, force: true });
});

function agentsPath(): string {
  return join(tempHome, ".zcode", "AGENTS.md");
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectOk(result: UserInstructionsReadResult) {
  assert.equal(result.kind, "ok", JSON.stringify(result));
  if (result.kind !== "ok") throw new Error("unreachable");
  return result;
}

test("路径解析与 CLI 一致：HOME → USERPROFILE → os.homedir()，不读取 ZCODE_DESKTOP_HOME_DIR", () => {
  const previousDesktopHome = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = join(tempHome, "desktop-home");
  try {
    assert.equal(getUserZcodeAgentsFilePath(), agentsPath());

    process.env.HOME = "   ";
    process.env.USERPROFILE = join(tempHome, "profile");
    assert.equal(resolveAgentUserHomeDir(), join(tempHome, "profile"));

    delete process.env.HOME;
    delete process.env.USERPROFILE;
    assert.equal(resolveAgentUserHomeDir(), homedir());
  } finally {
    if (previousDesktopHome === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = previousDesktopHome;
  }
});

test("文件不存在（含 ~/.zcode 不存在）→ missing；保存时创建目录与空文件", async () => {
  const service = createUserInstructionsService();
  const read = expectOk(await service.read());
  assert.equal(read.state, "missing");
  assert.equal(read.revision, null);
  assert.equal(read.content, "");
  assert.equal(read.path, agentsPath());
  assert.equal(read.agentReadLimitBytes, 100 * 1024);

  const write = await service.write({
    content: "",
    expectedRevision: null,
    eol: "lf",
    hasBom: false,
  });
  assert.equal(write.kind, "ok");
  assert.equal(await readFile(agentsPath(), "utf8"), "");
  const reread = expectOk(await service.read());
  assert.equal(reread.state, "file");
  assert.equal(reread.revision, sha256(""));
});

test("普通文件读写往返，revision 为磁盘字节 sha256", async () => {
  await mkdir(join(tempHome, ".zcode"), { recursive: true });
  await writeFile(agentsPath(), "# Rules\n- 中文\n");
  const service = createUserInstructionsService();
  const read = expectOk(await service.read());
  assert.equal(read.content, "# Rules\n- 中文\n");
  assert.equal(read.revision, sha256(await readFile(agentsPath())));
  assert.equal(read.sizeBytes, Buffer.byteLength("# Rules\n- 中文\n"));

  const write = await service.write({
    content: "updated\n",
    expectedRevision: read.revision,
    eol: read.eol,
    hasBom: read.hasBom,
  });
  assert.deepEqual(write, { kind: "ok", revision: sha256("updated\n"), sizeBytes: 8 });
  assert.equal(await readFile(agentsPath(), "utf8"), "updated\n");
});

test("CRLF 与 BOM 往返保留；混合行尾标记并统一为主导风格", async () => {
  await mkdir(join(tempHome, ".zcode"), { recursive: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await writeFile(agentsPath(), Buffer.concat([bom, Buffer.from("a\r\nb\r\n")]));
  const service = createUserInstructionsService();
  const read = expectOk(await service.read());
  assert.equal(read.content, "a\nb\n");
  assert.equal(read.eol, "crlf");
  assert.equal(read.hasBom, true);
  assert.equal(read.mixedLineEndings, false);

  const write = await service.write({
    content: "a\nb\nc\n",
    expectedRevision: read.revision,
    eol: read.eol,
    hasBom: read.hasBom,
  });
  assert.equal(write.kind, "ok");
  assert.deepEqual(
    await readFile(agentsPath()),
    Buffer.concat([bom, Buffer.from("a\r\nb\r\nc\r\n")]),
  );

  await writeFile(agentsPath(), "a\r\nb\nc\rd\r\n");
  const mixed = expectOk(await service.read());
  assert.equal(mixed.content, "a\nb\nc\nd\n");
  assert.equal(mixed.eol, "crlf");
  assert.equal(mixed.mixedLineEndings, true);
});

test("revision 冲突：外部修改、外部删除、外部创建均不写入", async () => {
  await mkdir(join(tempHome, ".zcode"), { recursive: true });
  await writeFile(agentsPath(), "v1");
  const service = createUserInstructionsService();
  const read = expectOk(await service.read());

  await writeFile(agentsPath(), "external");
  const modified = await service.write({
    content: "draft",
    expectedRevision: read.revision,
    eol: "lf",
    hasBom: false,
  });
  assert.deepEqual(modified, { kind: "conflict", currentRevision: sha256("external") });
  assert.equal(await readFile(agentsPath(), "utf8"), "external");

  await rm(agentsPath());
  const deleted = await service.write({
    content: "draft",
    expectedRevision: sha256("external"),
    eol: "lf",
    hasBom: false,
  });
  assert.deepEqual(deleted, { kind: "conflict", currentRevision: null });
  await assert.rejects(lstat(agentsPath()));

  await writeFile(agentsPath(), "created");
  const created = await service.write({
    content: "draft",
    expectedRevision: null,
    eol: "lf",
    hasBom: false,
  });
  assert.deepEqual(created, { kind: "conflict", currentRevision: sha256("created") });

  const overwrite = await service.write({
    content: "draft",
    expectedRevision: sha256("created"),
    eol: "lf",
    hasBom: false,
  });
  assert.equal(overwrite.kind, "ok");
  assert.equal(await readFile(agentsPath(), "utf8"), "draft");
});

test("非 UTF-8、目录、超过 5 MiB 返回对应错误且禁止写入", async () => {
  await mkdir(join(tempHome, ".zcode"), { recursive: true });
  const service = createUserInstructionsService();

  await writeFile(agentsPath(), Buffer.from([0x61, 0xff, 0xfe]));
  const notUtf8 = await service.read();
  assert.equal(notUtf8.kind === "error" && notUtf8.code, "NOT_UTF8");

  await writeFile(agentsPath(), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
  const tooLarge = await service.read();
  assert.equal(tooLarge.kind === "error" && tooLarge.code, "TOO_LARGE_TO_EDIT");
  assert.equal(tooLarge.kind === "error" && tooLarge.sizeBytes, 5 * 1024 * 1024 + 1);

  await rm(agentsPath());
  await mkdir(agentsPath());
  const directory = await service.read();
  assert.equal(directory.kind === "error" && directory.code, "NOT_REGULAR_FILE");
  const write = await service.write({
    content: "x",
    expectedRevision: null,
    eol: "lf",
    hasBom: false,
  });
  assert.equal(write.kind === "error" && write.code, "NOT_REGULAR_FILE");
});

test(
  "符号链接：写入目标文件、链接保持、权限保留；悬空链接拒绝写入",
  { skip: isWindows },
  async () => {
    await mkdir(join(tempHome, ".zcode"), { recursive: true });
    const targetDir = join(tempHome, "dotfiles");
    await mkdir(targetDir);
    const target = join(targetDir, "AGENTS.md");
    await writeFile(target, "linked");
    await chmod(target, 0o640);
    await symlink(target, agentsPath());

    const service = createUserInstructionsService();
    const read = expectOk(await service.read());
    assert.equal(read.linkTarget, await realpath(target));
    assert.equal(read.content, "linked");

    const write = await service.write({
      content: "via link",
      expectedRevision: read.revision,
      eol: "lf",
      hasBom: false,
    });
    assert.equal(write.kind, "ok");
    assert.equal((await lstat(agentsPath())).isSymbolicLink(), true);
    assert.equal(await readlink(agentsPath()), target);
    assert.equal(await readFile(target, "utf8"), "via link");
    assert.equal((await stat(target)).mode & 0o777, 0o640);

    await rm(target);
    const broken = await service.read();
    assert.equal(broken.kind === "error" && broken.code, "BROKEN_LINK");
    const brokenWrite = await service.write({
      content: "x",
      expectedRevision: null,
      eol: "lf",
      hasBom: false,
    });
    assert.equal(brokenWrite.kind === "error" && brokenWrite.code, "BROKEN_LINK");
    await assert.rejects(stat(target));
  },
);

test("普通文件保存后保留权限位", { skip: isWindows }, async () => {
  await mkdir(join(tempHome, ".zcode"), { recursive: true });
  await writeFile(agentsPath(), "v1");
  await chmod(agentsPath(), 0o604);
  const service = createUserInstructionsService();
  const read = expectOk(await service.read());
  const write = await service.write({
    content: "v2",
    expectedRevision: read.revision,
    eol: "lf",
    hasBom: false,
  });
  assert.equal(write.kind, "ok");
  assert.equal((await stat(agentsPath())).mode & 0o777, 0o604);
});

test("CLAUDE.md 导入源：缺失 / 正常（LF 规范化）/ 非 UTF-8", async () => {
  const service = createUserInstructionsService();
  assert.equal((await service.readClaudeImportSource()).kind, "missing");

  await mkdir(join(tempHome, ".claude"), { recursive: true });
  const claudePath = join(tempHome, ".claude", "CLAUDE.md");
  await writeFile(claudePath, "claude\r\nrules\r\n");
  assert.deepEqual(await service.readClaudeImportSource(), {
    kind: "ok",
    path: claudePath,
    content: "claude\nrules\n",
  });

  await writeFile(claudePath, Buffer.from([0xc3]));
  const invalid = await service.readClaudeImportSource();
  assert.equal(invalid.kind === "error" && invalid.code, "NOT_UTF8");
});

test("非法写入参数被拒绝", async () => {
  const service = createUserInstructionsService();
  await assert.rejects(
    service.write({ content: "x", expectedRevision: null, eol: "cr" as "lf", hasBom: false }),
    TypeError,
  );
});
