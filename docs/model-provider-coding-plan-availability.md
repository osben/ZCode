# Coding Plan Provider Availability Semantics

Coding Plan provider model-menu visibility converges on the provider state in
`model-providers.json`:

- `apiKey` means local credentials exist; it does not imply Coding Plan entitlement.
- `enabled` controls whether the provider may enter the Agent registry and the model menu.
- `systemDisabledReason` is the automatic disable reason; `enabled=false` with it empty means the
  user disabled the provider manually.
- Z.AI / BigModel Coding Plan availability only checks that the provider apiKey can access
  `/api/biz/subscription/list`.
- Having a Coding Plan subscription is no longer used to system-disable a provider; no plan,
  non-Coding-Plan plans and expired plans are handled by the detail page's plan list and upgrade
  entry.
- Z.AI Start Plan still separately checks that `data.plans` of
  `/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>` contains an active Start Plan.
- After login, BigModel Start Plan uses the persisted ZCode JWT to validate
  `/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>`; the entry enables whenever JWT
  auth succeeds. The user can still disable it manually in settings.

## System disable reasons

- `coding_plan_not_authenticated`: Z.AI / BigModel Start Plan not logged in or missing login
  credentials.
- `coding_plan_not_connected`: BigModel Coding Plan not connected or missing authorization
  credentials.
- `coding_plan_auth_failed`: credentials exist but auth failed.
- `coding_plan_not_entitled`: Z.AI Start Plan credentials valid but no active Start Plan. Z.AI /
  BigModel Coding Plan no longer write this reason for missing entitlement. BigModel Start Plan no
  longer uses the active plan field to decide enablement.

## Auto-recovery rules

Only system-disabled providers auto-recover:

- `enabled=false` with a non-empty `systemDisabledReason`: a later successful check may set
  `enabled=true` and clear the reason.
- `enabled=false` with an empty `systemDisabledReason`: user-disabled; later successful checks must
  not re-enable it.

## Entry status cache

The Model Providers left-entry status is cached in `~/.zcode/v2/coding-plan-cache.json` — entry
availability only, never status-card details. Cache TTL is 24 hours; it avoids loading flicker while
Z.AI Start/Coding entitlement queries run on opening Model Providers.

Cache sources:

- Z.AI Start Plan: `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>`,
  `Authorization: Bearer <zcodejwttoken>`; entry availability from `data.plans`, balance from
  `data.balances`.
- The Start Plan balance request must also send `X-Device-Mid` (the `deviceMid` from
  `telemetry-state.json`); the server treats it as required and returns
  `400 {"code":3001,"msg":"parameter error"}` when missing, which the client maps to `unknown` and
  hides the Start Plan entry. Desktop host, remote `zcode-server` and CLI must ensure the host's
  `deviceMid` exists before the first query — see `docs/zcode-endpoint-device-mid-header.md`.
- BigModel Start Plan: the OAuth callback no longer calls `tokenByAuthCode`; it persists the ZCode
  JWT directly via `https://zcode.z.ai/api/v1/oauth/token` using the one-time callback
  `code/state/redirect_uri` and `provider: "bigmodel"`. Enablement checks and balance queries read
  only `zcodejwttoken`, calling
  `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>` with
  `Authorization: Bearer <zcodejwttoken>`.
- Z.AI Coding Plan: `https://api.z.ai/api/biz/subscription/list`
- BigModel Coding Plan: current environment BigModel API main domain +
  `/api/biz/subscription/list`; production is `https://bigmodel.cn`, `ZCODE_ENV=test` is
  `https://bigmodel.cn`

Background stale refresh triggers (never blocking startup or the Model Providers first screen):

- After app startup, only when a Coding Plan provider already exists locally.
- After `modelProviderService.getAll()` finishes preset sync.

Forced refresh triggers:

- OAuth login or re-login success.
- After app startup restores local login state.
- Clicking connect or refresh Coding Plan in settings.
- After purchase or upgrade completes.
- Logout, unlink or clear API key writes the unavailable state immediately.

On API failure or unknown status, keep the old cache. The input-box model menu never calls
entitlement APIs directly; it only consumes the provider's `enabled`, endpoint, model and local
state.

Status-card details stay out of this cache:

- Z.AI / BigModel Start Plan balance:
  `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>`; one response
  carries both `plans` and `balances`; never call the deprecated `billing/current` first.
- Z.AI quota: `/api/monitor/usage/quota/limit`

## Z.AI / BigModel dual entry display

Z.AI Coding Plan and Z.AI Start Plan display side by side in Model Providers:

- `Z.AI - Coding Plan` uses the provider apiKey against `/api/biz/subscription/list`; business
  success keeps it enabled.
- `Z.AI - Start Plan` uses the ZCode JWT against the Start Plan billing balance API; auto-enable
  requires an active Start Plan in `data.plans`.

BigModel Coding Plan and BigModel Start Plan use the same entry semantics:

- `BigModel - Coding Plan` uses the provider apiKey against the current environment BigModel API
  main domain + `/api/biz/subscription/list`.
- `BigModel - Start Plan` uses the ZCode JWT persisted during the BigModel OAuth callback and, like
  Z.AI Start/Coding, calls the Start Plan billing balance API with `Bearer <zcodejwttoken>`;
  enablement depends on JWT auth success only, with no second exchange of a BigModel access token
  during balance queries.
