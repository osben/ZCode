# OAuth Loopback Callback Page

The browser tab that the user lands on after an OAuth redirect to a local loopback
listener (ChatGPT plan sign-in, ChatGPT usage link, MCP OAuth) shows a designed,
self-contained page instead of plain text, with a primary **Open ZCode** button.

## Product rules

- One shared renderer produces every callback page. Loopback listeners must not
  hand-write response bodies.
- Outcomes: `success`, `denied` (provider `error=` on a matching state), `invalid`
  (missing code, state mismatch, unknown path), `failed` (internal error).
- Flows: `sign-in` and `usage-link` change only the copy; the renderer takes the copy
  as input so other OAuth flows (MCP, future providers) reuse it.
- Surfaces:
  - `app` (desktop/server host): primary button **Open ZCode** links to the app deep link
    (`zcode://` by default, overridable); secondary **Close tab** on success.
  - `cli`: no app button; text tells the user to return to the terminal.
- Page is centered card: status icon, title, message, optional detail, buttons. Light and
  dark via `prefers-color-scheme`. English only (no i18n runtime in a loopback response).
- Error pages never echo provider-supplied text unescaped; `error_description` is shown only
  escaped and length-limited.

## Security constraints

- No external resources. Inline CSS/JS guarded by a per-response CSP nonce:
  `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'`.
- `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- The inline script strips the query string (`code`, `state`) from the address bar via
  `history.replaceState` and wires the Close button.
- The app button href must be a custom-scheme URL (`scheme://…`); `http(s):`, `javascript:`,
  `data:`, `file:` etc. are rejected and the button omitted.

## Interfaces

`packages/shared/src/node/oauthCallbackPage.ts` (exported from `@zcode/shared/node`):

- `renderOAuthCallbackPage(options) → { html, contentSecurityPolicy }`
- `buildOAuthCallbackPage(outcome, { flow, surface, appUrl?, detail? }) → options`
- `respondWithOAuthCallbackPage(response, httpStatus, options)`

Consumers: `localhost-callback.ts` (CLI, `surface: "cli"`), `siwcAuthService.ts` loopback and
`siwcCodexLoopback.ts` (`surface: "app"`).

## Acceptance scenarios

1. Success page: 200, `text/html`, contains Open ZCode link to `zcode://`, CSP header nonce
   matches inline tags.
2. Denied/invalid/failed pages: right status codes preserved (400/404/500), error icon, no
   Open button on `cli`.
3. `error_description="<script>…"` is escaped in the output.
4. `appUrl: "javascript:alert(1)"` produces no button.
5. CLI callback server returns the HTML page; existing callback semantics (state check,
   settle-once, client_id surfacing) are unchanged.
