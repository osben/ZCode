# Web upstream sync (3.16.1, non-relay)

Full history: git show 6ae5de9cc5a4703673894f4cd92b4b7db336e2cf:specs/web-upstream-sync.md

Scope: `packages/web` and `packages/web-share`, plus the Android test removal. Base `aac47556`
(3.15.1), upstream target `0a1fc56d` (3.16.1), fork state `origin/integration`. Branch base:
`origin/claude/upstream-sync-ui` (PR #215). This sync landed; the relay-deferred bucket below was
resolved later by the relay v2 migration (`specs/relay-v2-migration.md` and the `relay v2 desktop` /
`Relay v2 web client (S2)` sections of `specs/upstream-sync-final-ledger.md`).

Relay (web remote control protocol v1 fork vs v2 upstream) was out of scope: do not touch
`packages/web/src/web-remote-control/**`, `webRemoteControlTransport*`, relay auth or pairing,
`packages/remote-relay`, the `ws` dependency, or the remote proxy.

## Product rules

- Fork-only behavior survives: English test copy, English code comments, self-hosted conversation
  share (`specs/self-hosted-conversation-share.md`), and the BigModel OAuth origin.
- Where the fork did not change behavior (fork == base), the upstream code and test win.
- Where the fork changed behavior on purpose, the fork test is the spec.
- Comment-only fork changes (the fork translated Chinese comments to English) are kept as English
  when the upstream code is merged. Comments that upstream added and that were not reviewed here
  may remain Chinese; see Known gaps.

## Fork feature note

`specs/oauth-callback-page.md` describes the loopback callback renderer in `packages/shared`
(`oauthCallbackPage.ts`), not the web app. The web fork changes are the BigModel `authCode` handling
and the OAuth state and dev redirect details, kept below. `WebLoginPage.tsx` is identical to base in
the fork.

## Bucket: taken (upstream file applied as is)

- `packages/web/src/auth/WebLoginPage.tsx` (fork == base).
- `packages/web/src/auth/oauthStateCodec.ts` (fork == base).
- `packages/web/src/styles.css` (new upstream file; used by `main.tsx` via `import "./styles.css"`).
- `packages/web/test/oauthStateCodec.test.ts`, `viteConfigLoad.test.ts`, `communityUrl.test.ts`,
  `browserOAuthCredentialRepo.test.ts`, `conversationSharePreviewClient.test.ts`,
  `webAuthService.test.ts` (fork changes were comment translations only; 12 cases skipped then, see
  below).
- `packages/web/test/webLoginPage.test.ts` (new upstream file, rewritten to English copy only).
- `packages/web/test/e2e/manual-review/pending/share-content.mjs`,
  `share-input-images.mjs`, `share-oauth-callback.mjs`, `share-workflow-parity.mjs`,
  `share-workflow.mjs`.

Count: 15 paths.

## Bucket: already equal or equivalent (no change)

- `packages/android/app/src/test/.../ExampleUnitTest.kt`: absent on both sides.
- `packages/web-share/vite.config.ts`: HEAD already has the upstream alias array; only comments
  differ.
- `packages/web/test/shareHeaderLayout.test.ts`: HEAD already has the upstream version.
- `packages/web/test/homeOnlyMediaPreviewService.test.ts`: already deleted at HEAD.
- `packages/web/test/conversationShareRoute.test.ts`: fork and upstream both remove the same four
  source-string tests.

Count: 5 paths.

## Bucket: merged (both sides changed, reapplied by hand)

- `packages/web/src/auth/browserOAuthCredentialRepo.ts`: upstream `loadActiveAccount` and pending
  redirect URI storage added; fork English comments kept.
- `packages/web/src/auth/webAuthService.ts`: upstream redirect URI handling, `getActiveAccount`,
  pending redirect URI, fork English comments kept.
- `packages/web/src/auth/webAuthLocale.ts`: upstream provider-keyed copy (`loginAction`,
  `loginRegion`) plus fork system-locale resolution. Four waiting-page copy keys were kept as
  TEMPORARY because `WebLoggedInWaitingPage.tsx` was still rendered by the relay auth gate in
  `main.tsx`.
- `packages/web/src/auth/webZaiOAuthConfig.ts`: upstream dev return URL shape, fork English comments.
- `packages/web/src/share/ConversationShareLandingPage.tsx`: upstream error kinds, rate limit,
  feature-disabled and service-unavailable copy, error details, `contentBlocks`. Fork kept: the
  `light`/`dark` theme names, `readStoredThemeSelection` palette retention, `data-share-status` and
  `data-share-artifact-count` attributes.
- `packages/web/src/share/conversationSharePreviewClient.ts`: upstream error classification and
  request ID handling. Fork kept: `ServiceLocale`/`toServiceLocale` route locale, English comments.
- `packages/web/vite.config.ts`: only the BigModel OAuth origin hunk (`resolveBigModelApiOrigin`,
  `VITE_BIGMODEL_OAUTH_ORIGIN`).
- `packages/web/src/main.tsx`: only two hunks: `import "./styles.css"` (was `@zcode/ui/styles.css`)
  and `authCode` accepted by `isWebOAuthCallback`.
- `packages/web/test/conversationShareLandingPage.test.ts`: fork test kept (English locale, data
  attributes); upstream `it.each` for rate_limited, service_unavailable and feature_disabled added.

Count: 9 paths.

## Bucket: relay-deferred (resolved later by the relay v2 migration)

Each file below depended on relay protocol v2, the `web-remote-control/` tree, or the relay
bootstrap, and stayed on the fork's relay code until the relay unit was decided:

- All `packages/web/src/web-remote-control/**` (new upstream tree, about 50 files) and the fork-side
  `packages/web/src/webRemoteControl*.ts(x)` files that upstream moved or deleted.
- `packages/web/test/webRemoteControl*.test.ts` (upstream-changed or added), and
  `externalRelayFrameGapRecovery.test.ts`.
- `packages/web/test/homeOnlyWebRemoteControlServices.test.ts`: imports `src/main.js`, whose
  `createHomeOnlyWebRemoteControlServices` is relay-coupled.
- `packages/web/test/webOAuthCallbackEntry.test.ts`: targeted upstream `/remote/v4` routes; it failed
  on the fork main (six cases) and was removed from this PR.
- `packages/web/test/webRemoteControlBootstrapShell.test.ts`: source-string test over relay
  bootstrap.
- `packages/web/test/e2e/manual-review/pending/remote-*.mjs` (including `remote-version.mjs`), and
  the remote fixtures and helpers.
- `packages/web/src/auth/WebLoggedInWaitingPage.tsx` deletion: still rendered by the relay auth gate
  (`shouldUseWebRemoteAuth` in `main.tsx`).
- `packages/web/src/main.tsx`: all other upstream hunks (relay bootstrap, `WebRemoteControlEntry`,
  `#src` imports, `WebLoggedInWaitingPage` removal, `WebCallbackPage` routing, relay callback path).
- `packages/web/package.json`: `"imports": { "#src/*" }` is used only by the relay tree.
- `packages/web/vite.config.ts`: `/api/v1/remote` websocket proxy and
  `__ZCODE_MIN_COMPATIBLE_VERSION__` (no consumer outside vite config).
- `packages/web-share/src/main.tsx`: import of `webRemoteControlThemeSeed.js` moved to
  `web-remote-control/adapters/` upstream.
- `packages/web/src/webRemoteControlFailureScreen.tsx`: #215 compile-only TEMPORARY edit, left as
  is.

Count: 86 paths in the upstream diff. The merged files `main.tsx`, `web/vite.config.ts` and
`webAuthLocale.ts` also carried deferred hunks, listed above.

## Previously skipped tests (resolved)

12 `webAuthService.test.ts` cases were skipped with `it.skip` during this sync and are enabled now
(`packages/web/test/webAuthService.test.ts` has no skip left):

- uses `VITE_ZAI_OAUTH_ORIGIN` for the test authorize URL.
- starts ZAI login with nonce, dev return_to, and original app_return_to.
- `it.each` over zai and bigmodel with `/remote/v4/`, `/remote/__test__`, `/remote/__test__/`
  (six cases).
- keeps the public authorization redirect through a private development callback.
- does not exchange or consume the pending redirect before nonce validation.
- ignores an abandoned new redirect when an older page starts another login.
- exchanges token, persists complete session, and returns sanitized app_return_to.

Reason for the original skip: upstream `packages/shared` sets `webRemoteCallbackUrl` to
`/remote/v4`, while the fork kept `/web-remote/callback`; resolved by the relay V2 decision
(`specs/relay-v2-migration.md`).

## Acceptance (at merge time)

- `pnpm typecheck` passed after the merges.
- `node scripts/run-vitest.mjs run packages/web packages/web-share`: 27 files, 181 tests passed,
  12 skipped (the skipped set above, since re-enabled).
- `node scripts/check-test-copy.mjs` passed.

## Known gaps

- Upstream comments that were not reviewed may remain Chinese in taken files (for example in
  `conversationShareLandingPage` upstream comments). Test copy is checked by `check-test-copy.mjs`,
  which does not check comments.
- The `WebAuthPageCopy` waiting keys were a temporary compatibility shim; they were removed with the
  relay v2 web client migration (S2).
