import { requestSecurityClientConfig } from "./request-security-edition/index.js";
/* eslint-disable max-lines -- The E2E fixture server needs to centrally maintain the ZCode client config and BigModel purchase API responses */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { createMarketingTouchFixture } from "./marketing-touch-fixture.js";
import { rewardsWebsiteFixture } from "./rewards-website-fixture.js";

export type CodingPlanUpgradeMockScenario =
  | "manual-claim-experience"
  | "personal-sold-out"
  | "personal-system-busy"
  | "webview-refresh-provider";

export interface CodingPlanUpgradeMockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  keyCreation?: { name?: unknown; usageScene?: unknown };
}

export interface CodingPlanUpgradeMockServer {
  baseUrl: string;
  scenario: CodingPlanUpgradeMockScenario;
  stop(): Promise<void>;
}

interface CodingPlanUpgradeMockState {
  webviewMode: "hold" | "fail" | "ready";
  webviewWaiters: Array<() => void>;
  customerInfoHeld: boolean;
  customerInfoWaiters: Array<() => void>;
  inventoryMode: "hold" | "fail" | "ready";
  inventoryWaiters: Array<() => void>;
  clientConfigPayload: CodingPlanClientConfigFixture;
  manualClaimBucketReady: boolean;
  manualClaimCompleted: boolean;
  manualClaimShouldFail: boolean;
  startPlanExpired: boolean;
  purchaseCompleted: boolean;
  scenario: CodingPlanUpgradeMockScenario;
}

const DEFAULT_FULL_E2E_SPEC_GLOB = "./test/e2e/**/*.test.ts";

export function resolveCodingPlanUpgradeMockScenario(
  specs: readonly string[],
): CodingPlanUpgradeMockScenario | null {
  if (specs.some((spec) => spec.includes("marketing-touch-"))) {
    return "manual-claim-experience";
  }
  if (specs.some((spec) => spec.includes("coding-plan-upgrade-personal-system-busy"))) {
    return "personal-system-busy";
  }
  if (specs.some((spec) => spec.includes("coding-plan-upgrade-personal-sold-out"))) {
    return "personal-sold-out";
  }
  if (
    specs.some(
      (spec) =>
        spec.includes("coding-plan-upgrade-webview-refresh-provider") ||
        spec.includes("account-key-usage-scene"),
    )
  ) {
    return "webview-refresh-provider";
  }
  return null;
}

export function shouldPrepareCodingPlanUpgradeMockForBuild(specs: readonly string[]): boolean {
  return (
    resolveCodingPlanUpgradeMockScenario(specs) !== null ||
    specs.some((spec) => spec.replace(/\\/gu, "/") === DEFAULT_FULL_E2E_SPEC_GLOB)
  );
}

export async function resetCodingPlanUpgradeMockServer(
  baseUrl: string,
  scenario: CodingPlanUpgradeMockScenario,
): Promise<void> {
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/reset`, {
    body: JSON.stringify({ scenario }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Coding Plan E2E mock reset failed: ${response.status} ${await response.text()}`,
    );
  }
}

export async function startCodingPlanUpgradeMockServer(
  scenario: CodingPlanUpgradeMockScenario,
  options: { marketingTouch?: boolean } = {},
): Promise<CodingPlanUpgradeMockServer> {
  // Reason for the fix: pnpm filter switches the E2E cwd to packages/desktop, so the repo-level fixture cannot be
  // located via cwd.
  const clientConfigFixtureUrl = new URL(
    "../fixtures/coding-plan-client-configs.json",
    import.meta.url,
  );
  const baseClientConfigPayload = JSON.parse(
    await readFile(clientConfigFixtureUrl, "utf8"),
  ) as CodingPlanClientConfigFixture;
  const requests: CodingPlanUpgradeMockRequest[] = [];
  const state = createCodingPlanUpgradeMockState(baseClientConfigPayload, scenario);
  // The same-plan scenario is also reused by older tests, so a marketing-claim pause requiring release must not be
  // injected implicitly.
  const marketing = options.marketingTouch ? await createMarketingTouchFixture() : null;
  const server = createServer((request, response) => {
    void (async () => {
      if (
        marketing &&
        /^\/(cn|en)\/rewards$/.test(new URL(request.url ?? "/", "http://localhost").pathname)
      ) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(rewardsWebsiteFixture);
        return;
      }
      if (await marketing?.handle(request, response)) return;
      await handleRequest(baseClientConfigPayload, state, requests, request, response);
    })().catch((error) => {
      if (!response.headersSent) {
        sendJson(response, { code: 500, msg: formatErrorMessage(error) }, 500);
        return;
      }
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Coding Plan E2E mock server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get scenario() {
      return state.scenario;
    },
    stop: async () => {
      marketing?.stop();
      state.webviewWaiters.splice(0).forEach((release) => release());
      state.customerInfoWaiters.splice(0).forEach((release) => release());
      state.inventoryWaiters.splice(0).forEach((release) => release());
      server.close();
      await once(server, "close");
    },
  };
}

async function handleRequest(
  baseClientConfigPayload: CodingPlanClientConfigFixture,
  state: CodingPlanUpgradeMockState,
  requests: CodingPlanUpgradeMockRequest[],
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/__e2e/coding-plan/webview-state") {
    sendJson(response, { pending: state.webviewWaiters.length });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/webview-mode") {
    const { mode } = await readJsonBody<{ mode: "hold" | "fail" | "ready" }>(request);
    state.webviewMode = mode;
    state.webviewWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/__e2e/coding-plan/requests") {
    sendJson(response, { requests });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/customer-info-hold") {
    const { held } = await readJsonBody<{ held: boolean }>(request);
    state.customerInfoHeld = held;
    if (!held) state.customerInfoWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/inventory-mode") {
    const { mode } = await readJsonBody<{ mode: "hold" | "fail" | "ready" }>(request);
    state.inventoryMode = mode;
    state.inventoryWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/reset") {
    const payload = await readJsonBody<{ scenario?: unknown }>(request);
    if (!isCodingPlanUpgradeMockScenario(payload.scenario)) {
      sendJson(response, { code: 400, msg: "Invalid Coding Plan E2E scenario" }, 400);
      return;
    }
    // Bug root cause: the full suite's webview origin is fixed before build, but each worker's business scenario
    // differs; when reusing an origin, the scenario, purchase state, and request ledger must be reset together.
    state.webviewWaiters.splice(0).forEach((release) => release());
    Object.assign(
      state,
      createCodingPlanUpgradeMockState(baseClientConfigPayload, payload.scenario),
    );
    requests.splice(0, requests.length);
    sendJson(response, { ok: true, scenario: state.scenario });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-failure" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.manualClaimShouldFail = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-bucket-ready" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.manualClaimBucketReady = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-next-window" &&
    state.scenario === "manual-claim-experience"
  ) {
    // Bug cause: resetting only completed at the next period would leak a failing case's one-shot switch into later
    // successful cases.
    state.manualClaimCompleted = false;
    state.manualClaimShouldFail = false;
    sendJson(response, { ok: true });
    return;
  }

  const recordedRequest = recordRequest(requests, request, url);

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/start-expired" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.startPlanExpired = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/zcode-plan/billing/preview" &&
    state.scenario === "manual-claim-experience"
  ) {
    sendJson(response, {
      code: 0,
      msg: "ok",
      data: {
        server_time: Math.floor(Date.now() / 1_000),
        plans: state.manualClaimCompleted
          ? []
          : [
              {
                plan_id: "weekend-plan-e2e",
                name: "ZCode Weekend Build",
                description: "Deterministic manual claim fixture",
                priority: 100,
                entitlements: [
                  {
                    entitlement_id: "weekend-glm-flash",
                    show_name: "GLM-5.3-Flash",
                    meter: "model_usage",
                    unit_type: "token",
                    capabilities: ["model:glm-5.3-flash"],
                    grant_units: 10_000_000_000,
                    period: "one_time",
                    priority: 10,
                  },
                ],
              },
            ],
      },
    });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/v1/zcode-plan/billing/claim" &&
    state.scenario === "manual-claim-experience"
  ) {
    if (state.manualClaimShouldFail) {
      state.manualClaimShouldFail = false;
      state.manualClaimCompleted = true;
      sendJson(response, { code: 1003, data: null, msg: "already claimed" });
      return;
    }
    state.manualClaimCompleted = true;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    sendJson(response, {
      code: 0,
      msg: "ok",
      data: {
        server_time: nowSeconds,
        plan: {
          user_plan_id: "user-weekend-plan-e2e",
          plan_id: "weekend-plan-e2e",
          status: "active",
          starts_at: nowSeconds,
          ends_at: nowSeconds + 86_400,
          entitlements: [
            {
              entitlement_id: "weekend-glm-flash",
              show_name: "GLM-5.3-Flash",
              effective_at: nowSeconds + 3_600,
            },
          ],
        },
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/coding-plan") {
    if (state.webviewMode === "hold")
      await new Promise<void>((resolve) => state.webviewWaiters.push(resolve));
    if (state.webviewMode === "fail") {
      response.destroy();
      return;
    }
    sendHtml(response, buildCodingPlanWebviewFixtureHtml(state.scenario));
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/purchase-complete") {
    state.purchaseCompleted = true;
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v2/releases/latest") {
    sendJson(response, {
      code: 0,
      data: { config_version: "coding-plan-upgrade-e2e" },
      config_version: "coding-plan-upgrade-e2e",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/client/configs") {
    sendJson(response, state.clientConfigPayload);
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/zcode-plan/billing/balance" &&
    (state.scenario === "manual-claim-experience" || state.scenario === "webview-refresh-provider")
  ) {
    // Bug cause: the claim fixture only mocked the legacy quota API; Start availability is now judged by
    // billing/balance, and when it is missing a refresh would converge the just-written Start selectedKey back to
    // Individual.
    sendJson(
      response,
      state.startPlanExpired
        ? {
            code: 0,
            msg: "ok",
            data: {
              server_time: Math.floor(Date.now() / 1000),
              plans: [],
              balances: [],
            },
          }
        : buildManualClaimStartPlanBalance(
            state.manualClaimCompleted,
            state.manualClaimBucketReady,
          ),
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/biz/pay/batch-preview") {
    if (state.scenario === "personal-system-busy") {
      // Reason for the fix: "system busy" is the API's whole-endpoint failure semantics and must not be faked as a
      // sold-out product.
      // The service layer converges WAF/HTML-style non-displayable responses into coding_plan_system_busy and then
      // hands them to UI localization.
      sendJson(response, {
        code: 503,
        msg: "<html>request has been blocked</html>",
        data: null,
      });
      return;
    }
    const personalProducts =
      state.clientConfigPayload.data.configs.codingPlanStaticProducts[
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
      ] ?? [];
    sendJson(response, {
      code: 200,
      data: {
        isAuthenticated: true,
        isSubscribed: false,
        productList: personalProducts.map((product) => ({
          ...product,
          canPurchase: false,
          soldOut: true,
        })),
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/monitor/usage/quota/limit") {
    if (state.scenario === "webview-refresh-provider") {
      sendJson(response, { code: 200, data: { level: "pro", limits: [] } });
      return;
    }
    if (state.scenario === "manual-claim-experience") {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      sendJson(response, {
        code: 0,
        msg: "ok",
        data: {
          plans: [
            {
              plan_id: "weekend-plan-e2e",
              name: "ZCode Weekend Build",
              status: "active",
              starts_at: nowSeconds,
              ends_at: nowSeconds + 86_400,
              entitlements: [{ meter: "model_usage", period: "one_time" }],
            },
          ],
          balances: [
            {
              plan_id: "weekend-plan-e2e",
              entitlement_id: "weekend-glm-flash",
              show_name: "GLM-5.3-Flash",
              capabilities: ["model:glm-5.3-flash"],
              total_units: 10_000_000_000,
              used_units: 0,
              remaining_units: 10_000_000_000,
              available_units: 10_000_000_000,
              expires_at: nowSeconds + 86_400,
            },
          ],
        },
      });
      return;
    }
    // Reason for the fix: the sidebar upgrade entry uses entitlement to tell an account that is connected but has no
    // plan;
    // the mock must carry the business-level no_plan over HTTP 200, otherwise readApiJson throws early and
    // the purchase panel is treated as an unusable account and skips batch-preview.
    sendJson(response, {
      code: 404,
      msg: "当前用户不存在coding plan",
      data: null,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/biz/subscription/list") {
    sendJson(response, {
      code: 200,
      data:
        state.scenario === "webview-refresh-provider" ||
        (state.scenario === "manual-claim-experience" && state.manualClaimCompleted)
          ? [
              {
                productId: "glm-coding-pro-e2e",
                productName: "GLM Coding Pro",
                status: "VALID",
                inCurrentPeriod: true,
              },
            ]
          : [],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/biz/customer/getCustomerInfo") {
    // Park the single-card provider at the network boundary, to verify the Subscribe loading feedback after the
    // global query has completed.
    if (state.customerInfoHeld) {
      await new Promise<void>((resolve) => state.customerInfoWaiters.push(resolve));
    }
    sendJson(response, {
      code: 200,
      data:
        state.purchaseCompleted ||
        // The current account service obtains credentials via organization/project; in the inventory scenario the
        // account already owns the personal plan before purchase, so faking only the subscription list is not enough.
        state.scenario === "webview-refresh-provider" ||
        (state.scenario === "manual-claim-experience" && state.manualClaimCompleted)
          ? {
              organizations: [
                {
                  organizationId: "org-e2e",
                  projects: [{ projectId: "proj-e2e", projectType: 0 }],
                },
              ],
            }
          : { organizations: [] },
    });
    return;
  }

  if (
    (request.method === "GET" || request.method === "POST") &&
    url.pathname === "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys"
  ) {
    if (request.method === "POST" && recordedRequest) {
      // Record only the creation purpose and name; never write an arbitrary request body that may contain credentials
      // into the E2E ledger.
      const { name, usageScene } = await readJsonBody<{
        name?: unknown;
        usageScene?: unknown;
      }>(request);
      recordedRequest.keyCreation = { name, usageScene };
    }
    sendJson(response, {
      code: 200,
      data: !state.purchaseCompleted
        ? request.method === "GET"
          ? [{ name: "zcode", apiKey: "bigmodel-personal-api-key" }]
          : { name: "zcode", apiKey: "bigmodel-personal-api-key" }
        : request.method === "GET"
          ? [{ name: "zcode", apiKey: "bigmodel-webview-refreshed-key" }]
          : { name: "zcode", apiKey: "bigmodel-webview-refreshed-key" },
    });
    return;
  }

  if (
    request.method === "POST" &&
    /^\/api\/biz\/v1\/organization\/org-e2e\/projects\/proj-e2e\/api_keys\/[^/]+\/access_tokens$/.test(
      url.pathname,
    )
  ) {
    const body = await readJsonBody<{ clientType?: string }>(request);
    if (body.clientType !== "zcode" || !request.headers.authorization?.startsWith("Bearer ")) {
      sendJson(response, { code: 400, msg: "invalid_token_request" });
      return;
    }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: Math.floor(Date.now() / 1000) + 600 })}.e2e-signature`;
    sendJson(response, {
      code: 200,
      data: {
        enable: true,
        accessToken: token,
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      },
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname ===
      "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-webview-refreshed-key" ||
      url.pathname ===
        "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-personal-api-key")
  ) {
    sendJson(response, {
      code: 200,
      // Bug cause: Z.ai's resolver needs a copy secret, but BigModel's apiKey is already
      // a complete credential. If the fixture unconditionally returns the Z.ai secret, the BigModel key gets wrongly
      // assembled as key.secret.
      data: {
        secretKey:
          request.headers.authorization === "Bearer zai-webview-oauth-token"
            ? "zai-webview-refreshed-secret"
            : "",
      },
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/api/biz/subscription/enterprise/v2/pricing" ||
      url.pathname === "/api/biz/campaign/partner/enterprise/pricing")
  ) {
    if (url.pathname === "/api/biz/subscription/enterprise/v2/pricing") {
      if (state.inventoryMode === "hold")
        await new Promise<void>((resolve) => state.inventoryWaiters.push(resolve));
      if (state.inventoryMode === "fail") {
        sendJson(response, { code: 503, msg: "inventory unavailable" }, 503);
        return;
      }
    }
    sendJson(response, { code: 200, data: { productList: [] } });
    return;
  }

  sendJson(
    response,
    {
      code: 404,
      msg: `Unhandled E2E mock path: ${request.method} ${url.pathname}`,
    },
    404,
  );
}

function createCodingPlanUpgradeMockState(
  basePayload: CodingPlanClientConfigFixture,
  scenario: CodingPlanUpgradeMockScenario,
): CodingPlanUpgradeMockState {
  const clientConfigPayload = structuredClone(basePayload);
  enrichClientConfigPayloadForUpgradeE2E(clientConfigPayload, scenario);
  return {
    clientConfigPayload,
    manualClaimBucketReady: false,
    manualClaimCompleted: false,
    manualClaimShouldFail: false,
    startPlanExpired: false,
    customerInfoHeld: false,
    customerInfoWaiters: [],
    inventoryMode: "ready",
    webviewMode: "ready",
    webviewWaiters: [],
    inventoryWaiters: [],
    purchaseCompleted: false,
    scenario,
  };
}

function buildManualClaimStartPlanBalance(claimed: boolean, newBucketReady: boolean) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const oldPlanId = "zcode-v3-start-plan";
  const newPlanId = "weekend-plan-e2e";
  const oldPlan = {
    ends_at: nowSeconds + 4 * 86_400,
    entitlements: [
      {
        effective_at: 0,
        entitlement_id: "start-glm-turbo-e2e",
        show_name: "GLM-5-Turbo",
      },
    ],
    name: "ZCode V3 Start Plan",
    plan_id: oldPlanId,
    starts_at: nowSeconds - 86_400,
    status: "active",
  };
  const oldBalance = {
    available_units: 1_000_000_000,
    capabilities: ["model:glm-5-turbo"],
    entitlement_id: "start-glm-turbo-e2e",
    expires_at: nowSeconds + 4 * 86_400,
    plan_id: oldPlanId,
    remaining_units: 500_000_000,
    show_name: "GLM-5-Turbo",
    total_units: 1_000_000_000,
    used_units: 500_000_000,
  };
  const newPlan = {
    ends_at: nowSeconds + 86_400,
    entitlements: [
      {
        // The scheduled time has arrived but the quota bucket has not been generated yet, driving the settings page to
        // show "刷新权益" (refresh entitlements).
        effective_at: nowSeconds - 60,
        entitlement_id: "weekend-glm-flash",
        show_name: "GLM-5.3-Flash",
      },
    ],
    name: "ZCode Weekend Build",
    plan_id: newPlanId,
    starts_at: nowSeconds - 60,
    status: "active",
  };
  const newBalance = {
    available_units: 10_000_000_000,
    capabilities: ["model:glm-5.3-flash"],
    entitlement_id: "weekend-glm-flash",
    expires_at: nowSeconds + 86_400,
    plan_id: newPlanId,
    remaining_units: 10_000_000_000,
    show_name: "GLM-5.3-Flash",
    total_units: 10_000_000_000,
    used_units: 0,
  };
  return {
    code: 0,
    data: {
      server_time: nowSeconds,
      balances: [oldBalance, ...(claimed && newBucketReady ? [newBalance] : [])],
      plans: [oldPlan, ...(claimed ? [newPlan] : [])],
    },
    msg: "ok",
    success: true,
  };
}

function isCodingPlanUpgradeMockScenario(value: unknown): value is CodingPlanUpgradeMockScenario {
  return (
    value === "manual-claim-experience" ||
    value === "personal-sold-out" ||
    value === "personal-system-busy" ||
    value === "webview-refresh-provider"
  );
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

interface CodingPlanClientConfigFixture {
  data: {
    builtinProviders?: Array<{
      id?: string;
      name?: string;
      schema?: string;
      baseUrl?: string;
      models?: string[];
    }>;
    builtinModels?: Array<{
      modelId: string;
      name?: string;
      contextWindow?: number;
      maxCompletionTokens?: number;
      priority?: number;
    }>;
    configs: {
      codingPlanStaticProducts: Partial<
        Record<
          string,
          Array<{
            productId: string;
            productName: string;
            priceUnit: "month" | "quarter" | "year";
            payAmount?: number;
          }>
        >
      >;
    };
  };
}

function enrichClientConfigPayloadForUpgradeE2E(
  payload: CodingPlanClientConfigFixture,
  scenario: CodingPlanUpgradeMockScenario,
) {
  if (scenario === "manual-claim-experience") {
    // Bug cause: the claim fixture must deliver both Individual and Start; and BigModel's OAuth
    // resolver picks the first Anthropic provider from the remote list of the same family, so Individual must come
    // first, otherwise the Start model gets wrongly reused for Individual and the real switch path is not covered.
    payload.data.builtinProviders = [
      {
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        name: "BigModel - Coding Plan",
        schema: "anthropic",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        models: ["GLM-5.3-Flash"],
      },
      {
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        name: "BigModel - Start Plan",
        schema: "anthropic",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        models: ["GLM-5.3-Flash", "GLM-5-Turbo"],
      },
    ];
    payload.data.builtinModels = [
      {
        modelId: "GLM-5-Turbo",
        name: "GLM-5-Turbo",
        contextWindow: 1_048_576,
        maxCompletionTokens: 131_072,
        priority: 101,
      },
      {
        modelId: "GLM-5.3-Flash",
        name: "GLM-5.3-Flash",
        contextWindow: 1_048_576,
        maxCompletionTokens: 131_072,
        priority: 100,
      },
    ];
    Object.assign(payload.data.configs, requestSecurityClientConfig());
    return;
  }
  if (scenario !== "webview-refresh-provider") {
    return;
  }
  payload.data.builtinProviders = [
    {
      id: "bigmodel",
      name: "BigModel - Coding Plan",
      schema: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      models: ["glm-5.1-highspeed"],
    },
    {
      id: "zai",
      name: "Z.ai - Coding Plan",
      schema: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      models: ["glm-5.1-highspeed"],
    },
  ];
}

function buildCodingPlanWebviewFixtureHtml(scenario: CodingPlanUpgradeMockScenario): string {
  const label =
    scenario === "personal-system-busy"
      ? "System busy"
      : scenario === "personal-sold-out"
        ? "Sold out"
        : "Complete purchase";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Coding Plan E2E</title>
  </head>
  <body>
    <main data-testid="coding-plan-webview-fixture">
      <h1>Coding Plan E2E</h1>
      <button id="complete" type="button">${label}</button>
    </main>
    <script>
      document.getElementById("complete").addEventListener("click", async () => {
        await fetch("/__e2e/coding-plan/purchase-complete", {
          method: "POST",
          keepalive: true
        });
        window.zcodeBridge.notifyPurchaseComplete({
          provider: "bigmodel",
          timestamp: Date.now()
        });
      });
    </script>
  </body>
</html>`;
}

function recordRequest(
  requests: CodingPlanUpgradeMockRequest[],
  request: IncomingMessage,
  url: URL,
) {
  if (url.pathname === "/__e2e/coding-plan/requests") {
    return;
  }
  const recorded: CodingPlanUpgradeMockRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(
      Object.entries(request.headers).flatMap(([key, value]) => {
        if (Array.isArray(value)) return [[key, value.join(",")]];
        return typeof value === "string" ? [[key, value]] : [];
      }),
    ),
  };
  requests.push(recorded);
  return recorded;
}

function sendHtml(response: ServerResponse, html: string) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, payload: unknown, statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}
