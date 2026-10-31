import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "../helpers/desktop-app.js";
import { reloadElectronSessionSafely } from "../helpers/e2e-electron-reload.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

// Contract: specs/ollama-local-provider.md (OL2, OL3, OL4, OL5). A mock Ollama server on a random loopback port
// stands in for a real one; the host's detector reaches it like any local server.

const SETTINGS_FILE = join(getE2EAppDataPaths().appDataDir, "setting.json");
const NAV_OLLAMA = "local:ollama";
const navSelector = (key: string) => `[data-testid="${testId(TID_MODEL_PROVIDER_NAV_ITEM, key)}"]`;

const MODELS: Record<string, { capabilities: string[]; contextLength: number }> = {
  "e2e-chat:latest": { capabilities: ["completion", "tools"], contextLength: 32768 },
  "e2e-tts:latest": { capabilities: ["speech"], contextLength: 8192 },
};

function startMockOllama(): Promise<Server> {
  const server = createServer((request, response) => {
    const send = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/api/version") return send({ version: "0.0.0-e2e" });
    if (request.url === "/api/tags") {
      return send({ models: Object.keys(MODELS).map((name) => ({ name, details: {} })) });
    }
    if (request.url === "/api/show" && request.method === "POST") {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      request.on("end", () => {
        const model = MODELS[(JSON.parse(raw) as { model: string }).model];
        if (!model) {
          response.writeHead(404).end();
          return;
        }
        send({
          capabilities: model.capabilities,
          model_info: { "e2e.context_length": model.contextLength },
        });
      });
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function visibleNav(key: string, timeout = 20000) {
  await browser.waitUntil(
    async () => {
      for (const element of await $$(navSelector(key))) {
        if (await element.isDisplayed()) return true;
      }
      return false;
    },
    { timeout, timeoutMsg: `nav item not visible: ${key}` },
  );
  for (const element of await $$(navSelector(key))) {
    if (await element.isDisplayed()) return element;
  }
  throw new Error(`nav item disappeared: ${key}`);
}

async function readOllamaProvider(): Promise<
  { access?: unknown; api?: unknown; models: string[] } | undefined
> {
  const configFile = getE2EAppDataPaths().configFile;
  if (!existsSync(configFile)) return undefined;
  const file = JSON.parse(await readFile(configFile, "utf8")) as {
    config?: {
      providerConfigRules?: {
        providerRules?: {
          providerId?: string;
          config?: { access?: unknown; api?: unknown; personalModelIds?: string[] };
        }[];
      };
    };
  };
  const rule = file.config?.providerConfigRules?.providerRules?.find(
    (provider) => provider.providerId === "ollama",
  );
  return rule
    ? {
        access: rule.config?.access,
        api: rule.config?.api,
        models: rule.config?.personalModelIds ?? [],
      }
    : undefined;
}

function checkbox(name: string) {
  return $(`[data-testid="ollama-model-checkbox"][data-model-name="${name}"]`);
}

describe("Ollama local provider", () => {
  let server: Server;
  let root: string;

  before(async function () {
    this.timeout(180000);
    server = await startMockOllama();
    root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await skipOccupationOnboardingIfPresent();
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: async () => {
        const settings = existsSync(SETTINGS_FILE)
          ? JSON.parse(await readFile(SETTINGS_FILE, "utf8"))
          : {};
        await writeFile(
          SETTINGS_FILE,
          JSON.stringify({ ...settings, locale: "en-US", localePreference: "en-US" }),
        );
      },
    });
    await skipOccupationOnboardingIfPresent();
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 20000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await clearAppData();
  });

  it("OLLAMA-E2E-01: detects the server and lists chat models as selectable, others disabled", async function () {
    this.timeout(60000);
    await (await visibleNav(NAV_OLLAMA)).click();
    const address = await $("#ollama-address");
    await address.waitForDisplayed({ timeout: 20000 });
    await address.click();
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
    await browser.keys("Backspace");
    // The pasted OpenAI-compatible URL is normalized to the server root (OL7).
    await address.addValue(`${root}/v1/`);
    await (await $('[data-testid="ollama-detect-button"]')).click();

    await (await checkbox("e2e-chat:latest")).waitForDisplayed({ timeout: 20000 });
    await expect($('[data-testid="ollama-status"]')).toHaveText(
      expect.stringContaining("Ollama 0.0.0-e2e · 2 models"),
    );
    assert.equal(await (await checkbox("e2e-chat:latest")).isEnabled(), true);
    assert.equal(await (await checkbox("e2e-tts:latest")).isEnabled(), false);
  });

  it("OLLAMA-E2E-02: Save creates the ollama provider in provider_config.json with the checked model", async function () {
    this.timeout(60000);
    await (await checkbox("e2e-chat:latest")).click();
    await (await $('[data-testid="ollama-save-button"]')).click();

    await browser
      .waitUntil(async () => (await readOllamaProvider())?.models.length === 1, { timeout: 20000 })
      .catch(async () => {
        const configFile = getE2EAppDataPaths().configFile;
        const config = existsSync(configFile) ? await readFile(configFile, "utf8") : "<missing>";
        const detail = await (await $('[data-testid="ollama-detail"]')).getText();
        throw new Error(
          `the ollama provider was not written; detail: ${detail}; config: ${config}`,
        );
      });
    assert.deepEqual(await readOllamaProvider(), {
      access: { type: "api-key", apiKey: "ollama" },
      api: { type: "openai-chat-completions", baseUrl: `${root}/v1` },
      models: ["e2e-chat:latest"],
    });
    assert.equal(
      existsSync(join(getE2EAppDataPaths().appDataDir, "fork_ollama.json")),
      false,
      "Ollama must not use a fork sidecar",
    );
    // The synced provider is an ordinary custom provider.
    await visibleNav("custom:ollama");
    const screenshotDir = process.env.ZCODE_E2E_SCREENSHOT_DIR?.trim();
    if (screenshotDir) await browser.saveScreenshot(join(screenshotDir, "ollama-detail.png"));
  });

  it("OLLAMA-E2E-03: unchecking a detected model and saving removes it from the provider", async function () {
    this.timeout(60000);
    await browser.waitUntil(
      async () =>
        (await (await checkbox("e2e-chat:latest")).getAttribute("aria-checked")) === "true",
      { timeout: 10000 },
    );
    await (await checkbox("e2e-chat:latest")).click();
    await (await $('[data-testid="ollama-save-button"]')).click();

    await browser.waitUntil(async () => (await readOllamaProvider())?.models.length === 0, {
      timeout: 20000,
      timeoutMsg: "the unchecked model stayed in the provider",
    });
  });
});
