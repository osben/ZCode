import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertInstalledLockfileSnapshot,
  stripPnpmEnvLockfileDocument,
  createPnpmLockfileOnlyEnv,
  createInstallablePackageFilter,
  productionPackages,
  readLockfilePlatformConstraints,
} from "../third-party-npm.mjs";

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      sharp:
        specifier: ^0.34.0
        version: 0.34.5

packages:

  '@emnapi/runtime@1.9.2':
    resolution: {integrity: sha512-a}

  '@img/sharp-linux-s390x@0.34.5':
    resolution: {integrity: sha512-b}
    cpu: [s390x]
    os: [linux]
    libc: [glibc]

  '@img/sharp-linuxmusl-x64@0.34.5':
    resolution: {integrity: sha512-c}
    cpu: [x64]
    os: [linux]
    libc: [musl]

  '@img/sharp-wasm32@0.34.5':
    resolution: {integrity: sha512-d}
    cpu: [wasm32]

  fsevents@2.3.3:
    resolution: {integrity: sha512-e}
    os: [darwin]

  not-windows@1.0.0:
    resolution: {integrity: sha512-f}
    os: ['!win32']

snapshots:

  '@img/sharp-wasm32@0.34.5':
    dependencies:
      '@emnapi/runtime': 1.9.2
    cpu: [arm]
`;

const TARGETS = { os: ["darwin", "linux", "win32"], cpu: ["arm64", "x64"], libc: null };

test("锁图查询强制使用 pnpm lockfile-only 模式", () => {
  assert.equal(
    createPnpmLockfileOnlyEnv({ NPM_CONFIG_LOCKFILE_ONLY: "false" }).NPM_CONFIG_LOCKFILE_ONLY,
    "true",
  );
});

test("安装快照与根 lockfile 内容一致即通过，换行风格差异不算漂移", () => {
  assert.doesNotThrow(() => assertInstalledLockfileSnapshot("same", "same"));
  // Review CR-03 regression: on a Windows autocrlf workspace the root lockfile is CRLF while
  // the install snapshot is LF; when the dependency graph matches, it must pass.
  assert.doesNotThrow(() => assertInstalledLockfileSnapshot("a\r\nb\r\n", "a\nb\n"));
  // Real content differences (still different after normalization) still fail strictly.
  assert.throws(
    () => assertInstalledLockfileSnapshot("current\r\n", "stale\n"),
    /pnpm install --frozen-lockfile/,
  );
});

test("pnpm 12 env-lockfile document is ignored by the installed snapshot comparison", () => {
  const env =
    "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n---\n";
  const graph = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n";
  assert.equal(stripPnpmEnvLockfileDocument(`${env}${graph}`), graph);
  assert.equal(stripPnpmEnvLockfileDocument(graph), graph);
  assert.doesNotThrow(() => assertInstalledLockfileSnapshot(`${env}${graph}`, graph));
  assert.throws(
    () => assertInstalledLockfileSnapshot(`${env}${graph}`, "lockfileVersion: '9.0'\n"),
    /pnpm install --frozen-lockfile/,
  );
});

test("只读取 packages 段的 os/cpu/libc 约束，snapshots 段不参与", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  assert.deepEqual(constraints.get("@img/sharp-linux-s390x@0.34.5"), {
    cpu: ["s390x"],
    os: ["linux"],
    libc: ["glibc"],
  });
  assert.deepEqual(constraints.get("@img/sharp-wasm32@0.34.5"), { cpu: ["wasm32"] });
  assert.deepEqual(constraints.get("fsevents@2.3.3"), { os: ["darwin"] });
  assert.deepEqual(constraints.get("not-windows@1.0.0"), { os: ["!win32"] });
  assert.equal(constraints.has("@emnapi/runtime@1.9.2"), false);
});

test("与 pnpm 可安装规则一致：非目标 cpu/os 排除，libc 只在宿主 libc 已知时参与", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  assert.equal(installable("@img/sharp-linux-s390x", "0.34.5"), false);
  assert.equal(installable("@img/sharp-wasm32", "0.34.5"), false);
  assert.equal(installable("fsevents", "2.3.3"), true);
  // pnpm's negation semantics: if any target platform is negated, the whole package is not installed.
  assert.equal(installable("not-windows", "1.0.0"), false);
  assert.equal(installable("@img/sharp-linuxmusl-x64", "0.34.5"), true);
  assert.equal(installable("@emnapi/runtime", "1.9.2"), true);

  const glibcHost = createInstallablePackageFilter(constraints, { ...TARGETS, libc: ["glibc"] });
  assert.equal(glibcHost("@img/sharp-linuxmusl-x64", "0.34.5"), false);

  const darwinOnly = createInstallablePackageFilter(constraints, { ...TARGETS, os: ["darwin"] });
  assert.equal(darwinOnly("not-windows", "1.0.0"), true);
  assert.equal(darwinOnly("fsevents", "2.3.3"), true);
  const linuxOnly = createInstallablePackageFilter(constraints, { ...TARGETS, os: ["linux"] });
  assert.equal(linuxOnly("fsevents", "2.3.3"), false);
});

test("不可安装的平台包及只经由它引入的依赖不进生产图", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  const wasm = {
    version: "0.34.5",
    dependencies: { "@emnapi/runtime": { version: "1.9.2" } },
  };
  const onlyViaWasm = [
    {
      name: "app",
      dependencies: {
        sharp: {
          version: "0.34.5",
          optionalDependencies: {
            "@img/sharp-wasm32": wasm,
            "@img/sharp-linux-s390x": { version: "0.34.5" },
          },
        },
      },
    },
  ];
  assert.deepEqual([...productionPackages(onlyViaWasm, installable).keys()], ["sharp@0.34.5"]);

  const alsoDirect = [
    { ...onlyViaWasm[0], optionalDependencies: { "@emnapi/runtime": { version: "1.9.2" } } },
  ];
  assert.deepEqual([...productionPackages(alsoDirect, installable).keys()].sort(), [
    "@emnapi/runtime@1.9.2",
    "sharp@0.34.5",
  ]);
});

test("带 peer 或 patch 后缀的版本按基础版本匹配锁文件约束", () => {
  const constraints = readLockfilePlatformConstraints(LOCKFILE);
  const installable = createInstallablePackageFilter(constraints, TARGETS);
  assert.equal(installable("@img/sharp-wasm32", "0.34.5(patch_hash=abc)"), false);
});

test("production peers retain subtrees first expanded below development dependencies", () => {
  const runtime = { name: "runtime", version: "1.0.0", path: "/modules/runtime" };
  const packages = productionPackages([
    {
      name: "app",
      dependencies: {
        sdk: {
          version: "1.0.0",
          path: "/modules/sdk",
          dependencies: {
            runtime: { ...runtime, path: "/modules/sdk/node_modules/runtime", deduped: true },
          },
        },
      },
      devDependencies: {
        runtime: {
          ...runtime,
          dependencies: { license: { version: "2.0.0", path: "/modules/license" } },
        },
        "dev-only": { version: "1.0.0", path: "/modules/dev-only" },
      },
    },
  ]);
  assert.deepEqual([...packages.keys()].sort(), ["license@2.0.0", "runtime@1.0.0", "sdk@1.0.0"]);
});

test("expanded workspace links do not promote development dependencies to production", () => {
  const packages = productionPackages([
    {
      name: "app",
      dependencies: {
        library: {
          version: "link:../library",
          dependencies: { "dev-only": { version: "1.0.0" } },
        },
      },
    },
    { name: "library", dependencies: { runtime: { version: "2.0.0" } } },
  ]);
  assert.deepEqual([...packages.keys()], ["runtime@2.0.0"]);
});
