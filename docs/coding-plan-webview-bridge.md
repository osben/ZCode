# Coding Plan WebView Bridge

The official-site `/coding-plan` page is embedded only inside the ZCode App WebView. The App must open it with `embedded=app` and inject the current provider's purchase credentials through the WebView.

Sync chain:

```text
user clicks upgrade/renew
  -> CodingPlanUpgradeDialog receives providerId, audience, and optional teamPlanKey
  -> App resolves the official-site origin
     - local dev:      http://localhost:3000
     - test env:       https://zcode.z.ai
     - production:     https://zcode.z.ai
     - explicit override: VITE_CODING_PLAN_WEBVIEW_ORIGIN
  -> WebView opens /coding-plan?provider={zai|bigmodel}&audience={personal|team}&teamPlanKey={optional}&embedded=app&lang={cn|en}&theme={zai-light|zai-dark}
  -> after dom-ready, read the token from credentialService
  -> executeJavaScript first clears the old provider token, then writes it to the WebView origin's localStorage, and syncs the App theme class
  -> dispatch zcode-coding-plan-auth-ready
  -> the official-site page re-fetches batch-preview / preview / purchase
```

`lang` and `theme` are first-paint hints: the site uses them to render the right language and theme before the App's injected script runs. `theme` in particular avoids a first-open flash between the site's SSR-default dark and the App's light theme; the live theme is still whatever the later injected script writes as `zcode-theme` and class.

`audience` and `teamPlanKey` express the plan intent of the click. The Z.ai/BigModel family is decided by Provider ID alone; a personal plan passes `audience=personal`, a team plan passes `audience=team` with the current team connection key. They play no role in auth and do not replace the site's own judgment of the actual plan and team permissions.

The WebView shell keeps the App purchase page's original structure: full-screen overlay, top 「升级套餐」 (Upgrade plan) title bar with a close button on the right, and the 150% quota campaign notice under the title bar. The official-site page carries only the plan body and the following payment flow.

The WebView integration layer hides the host scroll container and the native scrollbars inside the guest page but does not disable page scrolling. After every `dom-ready` the App injects the `zcode-coding-plan-hide-scrollbar` style, covering the official-site page and later third-party payment/return pages, so site content and the App's global scrollbar styling do not stack into extra visual noise.

Injected keys match the App purchase API:

| Provider                 | WebView localStorage key      |
| ------------------------ | ----------------------------- |
| Z.ai                     | `oauth:zai:access_token`      |
| Z.ai Start Plan fallback | `zcodejwttoken`               |
| BigModel                 | `oauth:bigmodel:access_token` |

The token never goes into the URL query, so it cannot leak through browser history, logs, analytics, or Referer. The WebView page can only read injected values via the current origin's localStorage.

## Load-failure fallback

By user decision, when the WebView is unavailable it does **not** fall back to the old React Dialog; it reports the error and guides the user to buy on the official site:

- Listen for `<webview>` `did-fail-load` (main frame) and `render-process-gone`.
- On trigger, show the error state: `settings.modelProvider.codingPlan.webview.loadFailed` plus error details.
- In the error state the webview element is `hidden`, with two actions:
  - **Buy on the official site**: `IPlatformService.openExternal(webviewUrl)` opens the system browser.
  - **Retry**: `webview.reload()`.
- Credential-injection failure (`executeJavaScript` throwing) uses a separate `authInjectFailed` retry banner, distinct from load failure.

## Purchase-completion callback

After a successful purchase, the official-site page notifies the App in real time over the **preload + ipc-message** channel; the App refreshes plan state and closes the webview automatically.

### Protocol

```text
[official-site page] purchase success (Alipay polling / Stripe / enterprise order onSuccess)
    │
    │ window.zcodeBridge?.notifyPurchaseComplete?.({ provider })   ← no-op guard
    ▼
[preload: packages/desktop/src/preload/codingPlanWebview.ts]
    │ ipcRenderer.sendToHost("zcode:coding-plan-purchase-complete", {
    │   provider: "zai" | "bigmodel",
    │   timestamp: number,            ← client timestamp, logs/dedup only
    │ })
    ▼
[host renderer: CodingPlanEmbeddedWebviewDialog]
    │ webview.addEventListener("ipc-message", ...)
    │   if (event.channel !== CodingPlanWebviewChannels.PurchaseComplete) return
    │   validate payload.provider ∈ {"zai","bigmodel"}
    │   onPurchaseCompleteRef.current?.()
    ▼
[CodingPlanUpgradeDialog.handlePurchaseComplete]
    │ closeAndRefreshCodingPlanUpgradeFromWebview(...)
    │   1. onClose()   ← close the webview first, so a slow-network refresh does not block the user's return to the main UI
    │   2. refreshCodingPlanUpgradeCompletion(...)
    │      ├─ refreshCodingPlanApiKey (per provider)
    │      ├─ refreshModelProviders
    │      ├─ refreshCodingPlanEntitlements
    │      └─ codingPlanSubscriptionService.getEnterprisePricing({
    │           authenticated: true,
    │           family: teamPlanFamily,   ← "zai" | "bigmodel"
    │         })
```

### Channel and payload

- Channel: `zcode:coding-plan-purchase-complete` (defined as `CodingPlanWebviewChannels.PurchaseComplete` in `packages/shared/src/channels.ts`)
- Payload type: `CodingPlanPurchaseCompletePayload`
  - `provider`: `"zai" | "bigmodel"`, same shape as the auth-ready event's `detail.provider`
  - `timestamp`: `number`, client timestamp; the App uses it for logs/dedup only, never for equality

### Preload routing

The `will-attach-webview` hook in `desktopWindowChrome.ts` routes by `params.src`:

- `/coding-plan?...&embedded=app` (http/https) → `codingPlanWebviewPreloadPath` (mounts `window.zcodeBridge`)
- all other webviews (embedded browser etc.) → `embeddedBrowserJavaScriptDialogPreloadPath` (the original alert/confirm bridge)

Both share the same webPreferences (contextIsolation=true / sandbox=true / nodeIntegration=false).

### Official-site call sites

Three call sites in `components/coding-plan/coding-plan-page.tsx` (the helper `notifyZcodeBridgePurchaseComplete(provider)` has a built-in no-op guard, so the site runs standalone with zero impact):

| Payment scenario                                      | Location                    | provider   |
| ----------------------------------------------------- | --------------------------- | ---------- |
| Alipay QR polling success (bigmodel personal)         | alipay-qr useEffect         | `bigmodel` |
| Enterprise order polling onSuccess (bigmodel team)    | `pollEnterpriseOrderStatus` | `bigmodel` |
| Stripe payment success (zai personal + overseas team) | `onStripePay`               | `zai`      |

### Security

- The host renderer validates the `provider` field on `ipc-message`, accepting only `zai`/`bigmodel` and ignoring invalid payloads.
- The official-site page is an external https site; `will-attach-webview` still applies the `isAllowedEmbeddedBrowserUrl` protocol allowlist.
- The preload-exposed `window.zcodeBridge` keeps a minimal business surface: `notifyPurchaseComplete`, `getLang`, `onLangChange`, `openExternal` — no `ipcRenderer` / Node primitives; `openExternal` allows only `http:` / `https:` in both the preload and main process.
- The WebView uses the dedicated persistent partition `persist:zcode-coding-plan`. Before the App injects credentials and when the purchase page closes, it clears `oauth:zai:access_token` / `zcodejwttoken` / `oauth:bigmodel:access_token`; logout and Clear All Data clear the whole partition via the desktop command, so the site's first paint never reads a stale token after an account switch.
