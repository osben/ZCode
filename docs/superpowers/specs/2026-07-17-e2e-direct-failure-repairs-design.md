# Eleven Directly Fixable E2E Failure Repairs Design

## Scope

Only the 11 failures already confirmed as directly fixable from `summary.json`:

- I35–I39 and I42 (6 Turbo provider cases): fix the WDIO Coding Plan mock's spec recognition.
- I25 and I29 (2 DeepSeek cases): the case-local replay covers both the seed provider's OpenAI `/chat/completions` and the Anthropic `/messages` a restart window may restore to first; the case validates provider/model only and never folds the transport-protocol race into semantics.
- `conversation-session-v4-refresh-permission`: stop depending on exact rule text that the product design already hides; locate "always allow" through the stable permission option semantics.
- `conversation-session-v4-queue`: the queue-conflict toast assertion accepts both the Chinese and English copy the product supports.
- `conversation-session-v4-load-older`: record a real visible turn anchor when triggering pagination, then correct the viewport by the DOM geometry delta after prepend; the existing total-height delta stays as the fallback when no DOM anchor exists.

I27 and I28 stay out of scope; even if a shared repair changes their results, they are not declared fixed.

## Root causes and boundaries

### Provider startup and replay contract

After the Turbo spec split, `shouldUseCodingPlanTeamMock` still recognized only the old specs, leaving the provider registry without a usable Coding Plan. The DeepSeek startup provider already used `anthropic-messages`, but the two legacy fixtures still matched `/chat/completions` and returned OpenAI SSE.

```text
formal spec -> WDIO spec gate -> Coding Plan mock -> provider registry -> toolbar/session
                                  ^
                                  | 漏掉两个拆分后的 Turbo spec

startup DeepSeek(apiFormat=anthropic-messages) -> POST /anthropic/v1/messages
seeded DeepSeek(apiFormat=openai-compatible)   -> POST /chat/completions
case-local fixture                             -> 两种稳定响应合同
```

The repair touches only E2E infrastructure and fixtures — no provider product logic changes.

### Permission option location

Exact rules are not displayed by product design, so the E2E helper can no longer infer allow-always from `data-permission-rule-scopes`. `PermissionDialog` exposes the normalized display kind on the option button; the helper selects by `allowAlways`. The refresh case still proves rule recovery through "dialog restored, approval succeeds, repeated exact command no longer asks" — it never asserts hidden text.

### Queue draft-conflict toast

```text
workspace locale=zh-CN -> 产品显示中文 toast
                           |
旧 E2E 只匹配英文 ----------+-> 误报 toast 缺失
```

Runtime logs confirmed the product correctly blocked the recall and showed the Chinese toast; the failure was the test inheriting the workspace locale while matching English only. The assertion now accepts both zh-CN and en copy of the same i18n key; queue admission, desktop continuous, and Web replayable behavior are untouched.

### Load-older anchor

```text
用户接近顶部
  -> 记录首个可见 turnId + viewport offset
  -> onLoadOlder
  -> prepend commit
  -> 同一 turn 新 offset - 旧 offset
  -> scrollTop += delta（绘制前）
```

The old logic compared only `virtualizer.getTotalSize()`; when a prepend's new estimated height had not entered that value, the delta was 0 and the next commit had already lost the "first row shrank" detection window. The real DOM anchor takes priority; the existing total-height-delta fallback covers virtualized windows where the anchor is not mounted.

## Verification

- Second-level unit tests for the Turbo spec gate, permission option kind, and prepend anchor delta.
- Fixture check for the two model-provider specs.
- Affected targeted UI/desktop tests, then root `pnpm typecheck` and `pnpm lint`.
