import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createBuildTimeConfigDefines, resolveBuildTimeConfig } from "../build-time-config.mjs";

const dir = await mkdtemp(join(tmpdir(), "zcode-build-time-config-"));
after(() => rm(dir, { recursive: true, force: true }));

async function writeDefaults(name, content) {
  const path = join(dir, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("没有私有默认配置也没有环境变量时三项能力都关闭", async () => {
  const config = await resolveBuildTimeConfig({}, { defaultsPath: join(dir, "missing.json") });
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "",
    autoUpdateEnabled: false,
    webRemoteControlRelayWsUrl: "",
    webRemoteControlUrl: "",
  });
});

test("私有默认配置启用三项能力", async () => {
  const defaultsPath = await writeDefaults("defaults.json", {
    ZCODE_ARMS_RUM_ENDPOINT: " https://rum.example.com/x ",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    ZCODE_AUTO_UPDATE: "1",
  });
  assert.deepEqual(await resolveBuildTimeConfig({}, { defaultsPath }), {
    armsRumEndpoint: "https://rum.example.com/x",
    telemetryReportEndpoint: "https://report.example.com/event",
    autoUpdateEnabled: true,
    webRemoteControlRelayWsUrl: "",
    webRemoteControlUrl: "",
  });
});

test("环境变量优先于私有默认配置，显式空字符串关闭单项能力", async () => {
  const defaultsPath = await writeDefaults("override.json", {
    ZCODE_ARMS_RUM_ENDPOINT: "https://rum.example.com/x",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    ZCODE_AUTO_UPDATE: "true",
  });
  const config = await resolveBuildTimeConfig(
    {
      ZCODE_ARMS_RUM_ENDPOINT: "",
      ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://other.example.com/event",
      ZCODE_AUTO_UPDATE: "0",
    },
    { defaultsPath },
  );
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "https://other.example.com/event",
    autoUpdateEnabled: false,
    webRemoteControlRelayWsUrl: "",
    webRemoteControlUrl: "",
  });
});

test("remote-control 地址同时配置时解析为构建默认值", async () => {
  const config = await resolveBuildTimeConfig(
    {
      ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: " wss://relay.example.com/ws ",
      ZCODE_WEB_REMOTE_CONTROL_URL: "https://web.example.com/remote/v4/",
    },
    { defaultsPath: join(dir, "missing.json") },
  );
  assert.equal(config.webRemoteControlRelayWsUrl, "wss://relay.example.com/ws");
  assert.equal(config.webRemoteControlUrl, "https://web.example.com/remote/v4/");
});

test("remote-control 地址只配置一项时构建失败", async () => {
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "wss://relay.example.com/ws" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /set both/,
  );
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZCODE_WEB_REMOTE_CONTROL_URL: "https://web.example.com/remote/v4/" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /set both/,
  );
});

test("remote-control 地址协议不符时构建失败", async () => {
  await assert.rejects(
    resolveBuildTimeConfig(
      {
        ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "https://relay.example.com/ws",
        ZCODE_WEB_REMOTE_CONTROL_URL: "https://web.example.com/remote/v4/",
      },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /wss: scheme/,
  );
  await assert.rejects(
    resolveBuildTimeConfig(
      {
        ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "wss://relay.example.com/ws",
        ZCODE_WEB_REMOTE_CONTROL_URL: "http://web.example.com/remote/v4/",
      },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /https: scheme/,
  );
});

test("remote-control 地址来自私有默认配置", async () => {
  const defaultsPath = await writeDefaults("remote-defaults.json", {
    ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "wss://relay.example.com/ws",
    ZCODE_WEB_REMOTE_CONTROL_URL: "https://web.example.com/remote/v4/",
  });
  const config = await resolveBuildTimeConfig({}, { defaultsPath });
  assert.equal(config.webRemoteControlRelayWsUrl, "wss://relay.example.com/ws");
  assert.equal(config.webRemoteControlUrl, "https://web.example.com/remote/v4/");
});

test("私有默认配置格式错误时直接报错，不静默关闭", async () => {
  const defaultsPath = await writeDefaults("broken.json", "[1]");
  await assert.rejects(resolveBuildTimeConfig({}, { defaultsPath }), /必须是 JSON 对象/);
});

test("define 以 JSON 字面量注入", () => {
  assert.deepEqual(
    createBuildTimeConfigDefines({
      armsRumEndpoint: "https://rum.example.com/x",
      telemetryReportEndpoint: "",
      autoUpdateEnabled: true,
      webRemoteControlRelayWsUrl: "wss://relay.example.com/ws",
      webRemoteControlUrl: "",
    }),
    {
      __ZCODE_ARMS_RUM_ENDPOINT__: '"https://rum.example.com/x"',
      __ZCODE_TELEMETRY_REPORT_ENDPOINT__: '""',
      __ZCODE_AUTO_UPDATE_ENABLED__: "true",
      __ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL__: '"wss://relay.example.com/ws"',
      __ZCODE_WEB_REMOTE_CONTROL_URL__: '""',
      __ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE__: '""',
    },
  );
});

test("relay identity mode is a baked default that only accepts known modes", async () => {
  const config = await resolveBuildTimeConfig(
    { ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE: " device-key " },
    { defaultsPath: join(dir, "missing.json") },
  );
  assert.equal(config.webRemoteControlIdentityMode, "device-key");
  const unset = await resolveBuildTimeConfig({}, { defaultsPath: join(dir, "missing.json") });
  assert.equal(unset.webRemoteControlIdentityMode, undefined);
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE: "open" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE/,
  );
});

test("a public release bakes the device-key mode and never an enrollment secret", async () => {
  const secret = "enrollment-secret-fixture-0123456789abcdef";
  const config = await resolveBuildTimeConfig(
    {
      ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE: "device-key",
      ZCODE_WEB_REMOTE_CONTROL_RELAY_ENROLLMENT_SECRET: secret,
      ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET: secret,
    },
    { defaultsPath: join(dir, "missing.json") },
  );
  assert.equal(config.webRemoteControlIdentityMode, "device-key");
  const serialized = JSON.stringify([config, createBuildTimeConfigDefines(config)]);
  assert.equal(serialized.includes(secret), false);
  assert.equal(/enrollment/i.test(serialized), false);
});
