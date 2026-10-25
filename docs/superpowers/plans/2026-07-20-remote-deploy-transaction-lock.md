# Remote deploy transaction lock

> Implemented (2026-07-20). `packages/server/src/remote/remoteDeployLock.ts` and
> `deployServer()` own the behavior; this file is the only doc of the contract.

**Goal:** Deployments to one remote install root serialize across hosts and processes, and
directory uploads stop interleaving fixed-name archives with final-directory replacement.

## Contract

- Lock: `${REMOTE_BASE}/.deploy.lock` acquired by a remote atomic `mkdir`, owned by an
  unpredictable UUID owner token, kept alive with a 30-second heartbeat and taken over after
  600 seconds of staleness. Release and takeover never use broad globs — only the exact
  owner token. `deployLockAcquireTimeoutMs` bounds the wait (default 120 seconds); release
  is idempotent.
- `deployServer()` acquires the lock for the whole transaction, re-runs
  `checkServerDeployDecision()` after acquiring (a waiter must not overwrite based on a
  stale decision; in-process single-flight cannot cover different Desktop builds or
  backends), and releases on every success and failure exit — a release failure is
  aggregated with the deployment error instead of masking it. `options.force` keeps its
  force-deploy semantics.
- `DeployLockMode` is `"remote" | "caller-serialized"` (`packages/server/src/remote/deploy.ts`).
  Default is the remote install-root lock; `"caller-serialized"` is reserved for a caller
  that itself serializes deployments to the same install root. The 2026-07-23 SSH exception
  intended the desktop single-window shared-SSH-host path to declare caller-side
  serialization; no production caller currently passes `"caller-serialized"`, so all
  existing calls take the remote lock.
- Owner-unique staging: every directory deployment uses unique
  `${remoteDir}.tar.gz-<owner>`, `${remoteDir}.extract-<owner>` and staging paths
  (`packages/server/src/remote/remoteAssetInstaller.ts`,
  `zcodeAgentDevDeploy.ts`); failure cleanup (shell trap and upload-failure catch) touches
  only those owner paths. `RemoteDownload` keeps its existing unique staging inside the
  transaction lock. No fixed `packages.tar.gz`.
- Boundaries: install root stays `~/.zcode/server`; no `wsl --terminate`. POSIX-backend
  compatible only — no `flock`, GNU `mv -T`, or system tar assumptions; WSL, Docker and
  lock-using SSH calls must all work through `IRemoteBackend` stdio.
