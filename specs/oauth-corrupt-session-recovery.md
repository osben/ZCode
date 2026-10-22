# OAuth Corrupt Session Recovery

When the local OAuth credential store (`~/.zcode/v2/credentials.json`) cannot be decrypted, the
app must start signed-out. Unreadable credentials must never block startup or leave the splash
screen up.

Decryption fails when the cipher key (platform, home directory, username) changes, for example
after a renamed home directory, a renamed user, or a restored backup.

## Problem

`useRootOAuthEffects` keeps the splash visible (`isRestoringOAuthSession`) until
`oauthService.restoreCachedSessionState()` settles. On a decrypt failure, the repo cleared the OAuth
namespace and then awaited `onCorruptOAuthSessionCleared`. That callback awaits
`notifyProvidersLogout` → `refreshAccountProviders`, which has no timeout and includes a network
probe. A hang there kept `restoreCachedSessionState()` pending forever, so the splash never went away.

## Product rules

- Unreadable OAuth credentials are treated as a forced sign-out. The app boots signed-out.
- Recovery never waits on derived-provider cleanup (Start/Coding Plan model keys, account refresh,
  network probes). Derived cleanup runs detached.
- Derived cleanup failure, including a rejection, is logged at `warn` and does not change the
  restore outcome.
- Restore outcome for this case is `{ status: "signed-out" }`. No new protocol reason is added.
- No timeout is used to bound the derived cleanup. A timeout would hide the synchronization
  problem; detaching removes the dependency instead.

## Owners and order

Owner of the credential namespace: `OAuthCredentialRepo` (`packages/services/src/oauth/repo/oauthCredentialRepo.ts`).
Owner of derived provider cleanup: `OAuthService.notifyProvidersLogout`, reached only through the
repo callback `onCorruptOAuthSessionCleared`.

```mermaid
sequenceDiagram
  participant Root as Renderer splash gate
  participant Svc as OAuthService.restoreCachedSessionState
  participant Repo as OAuthCredentialRepo
  participant Cred as credentialService
  participant Cleanup as derived provider cleanup (detached)

  Root->>Svc: restoreCachedSessionState()
  Svc->>Repo: getActiveProvider()
  Repo->>Cred: load(oauth:active_provider)
  Cred-->>Repo: decrypt error
  Repo->>Cred: delete provider keys and oauth:active_provider
  Repo-)Cleanup: start onCorruptOAuthSessionCleared (not awaited)
  Repo-->>Svc: null
  Svc-->>Root: { status: "signed-out" }
  Note over Cleanup: may hang or reject; rejection logged at warn only
```

## Acceptance scenarios

1. `load("oauth:active_provider")` throws a credential decrypt error and the derived-provider
   logout callback returns a promise that never settles. `restoreCachedSessionState()` resolves to
   `{ status: "signed-out" }` within the test timeout.
2. In that scenario, the OAuth provider keys and `oauth:active_provider` are deleted before the
   derived-provider callback starts.
3. The derived-provider callback is invoked once per corrupt-session recovery, with the known
   provider ids.
4. The derived-provider callback rejects: recovery still returns `signed-out`, and a `warn` entry is
   logged from the `oauthCredentialRepo` scope.
5. Non-decrypt errors from `load` still propagate (unchanged behavior).
