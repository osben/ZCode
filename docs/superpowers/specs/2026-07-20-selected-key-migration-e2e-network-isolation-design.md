# SelectedKey Migration E2E Network Isolation Design

## Problem and goal

I32–I34 of `conversation-session-model-provider-selected-key-migration.test.ts` verify only the local `modelProviderFamilySelectedKeys` startup migration, but the WDIO default fixture writes `oauth:active_provider=zai`, a Z.AI access token, and `zcodejwttoken`. After app reload the suite entered OAuth recovery refresh and used the fake `e2e-oauth-token` against real Z.AI provider, API key, and entitlement endpoints. The goal: I32–I34 depend on no external network while keeping the real app-reload and local-settings migration chain intact. Post-OAuth-recovery remote refresh semantics stay covered by existing UI unit tests, not repeated in these three migration cases.

## Chosen approach

An explicit startup credential strategy for the selectedKey migration spec:

- Keep the fake `auth_token` for generic E2E helper paths still reading the legacy token.
- Do not write `oauth:active_provider`.
- Do not write `oauth:zai:access_token`, OAuth user info, or `zcodejwttoken`.
- Keep the existing fake settings, model providers, and replay fixture.

Credential selection is extracted into a side-effect-free pure function called by WDIO `seedE2EStartupState()`. Unit tests assert the selectedKey migration spec's result contains no credentials that could trigger recovery refresh or Plan network requests.

## Startup sequence

Before:

```text
fake active OAuth session
  -> restoreCachedSession
  -> refreshCodingPlanApiKey(Z.AI Coding + Start)
  -> 真实 provider/API Key/权益请求
  -> 再次按 selectedKey 刷新
  -> 本地 selectedKey migration
```

After:

```text
fake local settings/providers + legacy auth_token
  -> restoreCachedSession: active provider 不存在
  -> 跳过 OAuth provider family 刷新
  -> 本地 selectedKey migration
  -> I32/I33/I34 读取 setting.json 断言
```

## Combinations and pruning

| Combination                                                 | Handling | Reason                                                                         |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| Local mode/selectedKey conflict + no active OAuth           | keep     | minimal product semantics of I32–I34                                           |
| Local migration + Z.AI OAuth recovery success               | prune    | recovery refresh already covered by `rootOAuthCallbackHandling.test.ts`        |
| Local migration + real Z.AI network success/failure/timeout | prune    | unrelated to the selectedKey migration algorithm; adds external nondeterminism |
| BigModel Team complete/malformed identity                   | keep     | core boundary of I33/I34                                                       |

## Code and test scope

- New pure helper: build the default or network-isolated credentials fixture per worker spec.
- WDIO startup seed uses it; other specs keep the default OAuth fixture.
- Unit tests first prove the current implementation wrongly produces active OAuth credentials, then the helper makes them pass.
- Run I32–I34: cases complete, with no `model-provider.refreshCodingPlanApiKey` or real `billing/balance` requests in the logs.
- `pnpm typecheck` and `pnpm lint`.

## Non-goals

- No product changes to OAuth, provider refresh, retry, or timeout logic.
- No shortened real-network timeouts.
- No full OAuth HTTP mock server for this migration spec.
- No changes to desktop continuous, mobile remote replayable, workspace identity, or Agent runtime semantics.
