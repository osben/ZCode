# 18 ZCode Built-in Config remote sync and LKG fallback

> Status: done
>
> Date: 2026-08-25
>
> Source discussion: closing the release mechanism of ZCode Built-in Provider/Model config after the Provider Refactor
>
> Related tasks: [`10`](./todo-10-zcode-builtin-provider-config-naming-cutover.md),
> [`13`](./todo-13-target-host-model-selection-authority.md),
> [`15`](./todo-15-provider-release-validation.md),
> [`17`](./todo-17-provider-registry-settings-authority-boundary-closure.md),
> [`19`](./todo-19-zcode-builtin-release-integrity-validation.md)
>
> Related design: [`configuration.md`](../design/registry/configuration.md),
> [`registry.md`](../design/registry/registry.md),
> [`runtime.md`](../design/registry/runtime.md),
> [`environment.md`](../design/environment/environment.md)

## 0. Position

ZCode Built-in Provider Config and ZCode Built-in Model Config Rules were read only from
`config/provider/zcode-builtin.json` shipped with the repo and installer. This Todo adds
`/api/v1/client/configs` as a remote-first release channel for the same Built-in facts and stores, per
Environment, the last confirmed usable remote config (Last Known Good, LKG). It makes only the minimal change
needed and does not refactor the Client Config infrastructure:

- no global `ClientConfigService`; no change to `BigModelCodingPlanSubscriptionProvider`'s existing `/client/configs` request, TTL or cache;
- no merging of Desktop Main's Force Update, Computer Use and Desktop Context Prompt requests;
- no change to config ownership of Coding Plan, official-version security signing, Off-Peak or `modelContextBudget.strategy`;
- one independent `/client/configs` request for Built-in Config is allowed in this phase (unifying public Client Config is a separate task).

Only the Source and release timing of ZCode Built-in Config change; the Provider domain chain does not:
ZCode Built-in Provider Config -> Account Provider Config -> Personal Provider Config -> Effective Provider
Config; ZCode Built-in Model Config Rules + Personal Model Config Rules -> Effective Model Config Rules ->
Registry / ModelFactory. Remote, LKG and installer config are three candidates of the same ZCode Built-in
Source, not new Overlay layers.

## 1. Confirmed decisions

### 1.1 `/client/configs` uses a two-layer atomic structure

The server adds one first-level field under `data.configs`:

```ts
interface ZCodeBuiltinConfigContent {
  readonly providers: Record<string, ProviderConfigObject>; // pure content of ZCode Built-in Provider Config
  readonly modelConfigRules: readonly ModelConfigRuleObject[]; // pure content of ZCode Built-in Model Config Rules
}
interface ZCodeBuiltinRelease {
  readonly schemaVersion: number;
  readonly revision: number; // strictly increasing per release; a content rollback also gets a larger revision
  readonly config: ZCodeBuiltinConfigContent;
}
interface ClientConfigFields {
  readonly zcodeBuiltin?: ZCodeBuiltinRelease;
}
```

Example: `{ "code": 0, "data": { "configs": { "zcodeBuiltin": { "schemaVersion": 1, "revision": 42, "config": { "providers": {}, "modelConfigRules": [] } } } } }`.

Only two layers: the inner `config` is the pure content of the existing Provider Config and Model Config
Rules (no `schemaVersion`, `revision`, `fetchedFor` or cache state); the outer Release carries format
version and publish order. `config.providers` and `config.modelConfigRules` appear, parse and apply
together as one release; two independent first-level fields are unsupported and mixing remote Providers
with local Model Rules (or the reverse) is forbidden. `zcodeBuiltin` is an atomic grouping at the Client
Config transport boundary, not a new Provider domain object or Overlay layer; after parsing it is
immediately projected into the `ProviderConfigMap + ModelConfigRules` the existing
`ProviderConfigLayerSnapshot` needs. The repo/installer Built-in stays one complete JSON; Provider grouping
and Model Rule layering are expressed by the single-file declaration order of
[`configuration.md`](../design/registry/configuration.md) (not split into several source files, no
generation/assembly pipeline). Remote, Environment Active Cache and Bundled all use this same two-layer shape.

### 1.2 Remote config is a full replacement, not a patch against Bundled

Remote `config.providers` is the complete ordered set of current ZCode Built-in Providers and
`config.modelConfigRules` the complete ordered Built-in Rule array. When the server removes a Provider,
model member or Rule, the client removes it in the new snapshot too and does not add it back from Bundled
Config. A single Model Config Rule may still be sparse; Personal Rules stay after Built-in Rules and
remote sync never changes that order. Built-in Release business-integrity publish gating is not part of
the first client sync (the old Todo 19 was abandoned; a future gate would be a separate task).

### 1.3 Roles of Bundled, LKG and Remote

| Input                    | Meaning                                                          | Lifecycle          | Rewritten at runtime   |
| ------------------------ | ---------------------------------------------------------------- | ------------------ | ---------------------- |
| Bundled Config           | the compatible baseline carried by the current installer         | App release        | no                     |
| Environment Active Cache | the Built-in the Environment accepted and uses now; also the LKG | across restarts    | yes, atomic replace    |
| Remote Config            | the current `/client/configs.data.configs.zcodeBuiltin` response | one remote refresh | not persisted directly |

Runtime never rewrites `config/provider/zcode-builtin.json` or read-only installer assets. A successful
remote result only atomically replaces the owning Environment's writable `active.json`, which is both the
active Source that Host/Worker read and the LKG on restart (no second LKG file). The repo/installer config
is still updated with each Built-in release so new installs and clients without a valid LKG have a sensible
baseline (a release-process matter, not the client rewriting the repo).

### 1.4 LKG means last known good, not naturally newer

LKG may be older than the new installer's Bundled Config, fetched by an older App version, in a Schema the
current client no longer supports, corrupt, or from a wrong platform/Environment cache path. So startup
never lets LKG override Bundled unconditionally; the Active Cache is a candidate only if: (1) the Release
envelope is readable; (2) `schemaVersion` is supported; (3) Provider Config and Model Config Rules parse with
the current formal Parser; (4) `Active.revision >= Bundled.revision`. Then pick the maximum revision; an
incompatible/older LKG is ignored in favor of Bundled; if Bundled and LKG are both invalid, fail Provider
Runtime startup (no empty/fake fallback). The first version isolates the Cache by the physical path
`<platform>/<appVersion>/<endpointKey>/active.json`, writes no `fetchedFor` in the JSON, and does not reuse
across versions just because JSON parses; reuse across patch versions would need an explicit compatibility range first.

### 1.5 `revision` must be sortable and generated by the same release flow

A content hash or HTTP ETag can only say same/different, not which of LKG and Bundled is newer.
`zcodeBuiltin.revision` is a server-side strictly increasing integer, written into the Bundled Config
generated by the same release (a content rollback also gets a new revision: 40 -> A, 41 -> B, 42 -> A).
Clients compare revisions, never local file time or content hashes; a normalized content hash may still
dedupe identical content in-process but does not replace the revision.

### 1.6 Only the Environment composition root syncs remotely

Each execution Environment owns its Built-in config and LKG: Local Environment Host (fetch `/client/configs`,
Local LKG, Local Registry, Local Core Workers read/watch the selected local file) and SSH / Server
Environment Host (same with Remote LKG/Registry/Workers). When Desktop controls a remote Workspace it reads
only the Remote Host's Settings/Selection Facade and never pushes the local `zcodeBuiltin`, LKG, Registry
Snapshot or static Provider/Model facts to the remote. Ordinary Core Workers do not request
`/client/configs` themselves: the Host picks the startup candidate and gives Workers the same readable
Built-in file path; after a successful remote update the Environment's active file is atomically replaced
and the Host's and Workers' existing Source watchers refresh (so Workspaces do not request repeatedly and
one Environment never holds several revisions).

### 1.7 Remote updates affect only later-created Models

Remote Built-in refresh -> Source change -> Account refresh -> Registry rebuild -> Facade update -> later
`ModelFactory.create()`. An already-created Active Model stays frozen for its execution: a refresh may change
new Settings/Selection Views, Provider members and later-created Models, but never hot-edits the Endpoint,
API Type, Properties, Option Specs or Reasoning Mapping of an Active Model.

### 1.8 Client Config is not unified this round

`/client/configs` is still read by several differently-lived chains (the Coding Plan subscription provider's
products, plans, official-version signing, Off-Peak, Context Budget; Desktop Main's Computer Use and Desktop
Context Prompt gating; the Desktop Force Update gate). This Todo does not reorder those owners nor build a
public `IClientConfigService`. The Built-in sync may reuse the existing `ApiClient`, Endpoint and platform
parameter tools but must not depend on the Coding Plan Provider, nor let the Provider Config Source depend
on the Subscription Service. The minimal new relation: Environment composition root's existing `ApiClient`
-> ZCode Built-in remote fetch/synchronizer -> Built-in active Source file (also LKG). A later unification may
move this read into a public Transport/Service without changing the Environment ownership, the atomic
`zcodeBuiltin` contract and the Active Cache selection boundary.

### 1.9 Environment-level on-disk refresh debounce

An in-process `inFlight` cannot stop several Desktop Hosts, CLIs or Server Entries of one Environment from
requesting repeatedly. Each Environment keeps `refresh-control.json` next to the endpoint-isolated Active
Cache, coordinating refresh with a file lock and an expirable lease:

```text
several entries request refresh -> lock refresh-control.json
  nextEligibleAt not reached or a live lease exists: skip the network
  else write a short lease, release the lock -> request the remote
  -> lock again and compare revision
  success: atomically replace active.json, record the next time
  failure: keep active.json, record increasing backoff
```

The file lock is not held during the network request; a crashed process's lease can be taken over after
expiry. Successful refresh uses roughly a one-hour interval, failure a capped increasing backoff. An
explicit refresh may bypass `nextEligibleAt` but not a still-valid lease. An Endpoint change must change the
`endpointKey` in the control file so a new Endpoint is not blocked by the old TTL.

## 2. Failure and refresh semantics

Startup: read Bundled + read LKG -> choose the compatible max revision -> publish immediately -> start the
remote refresh in the background. The network request never blocks Provider Runtime's first ready on a
valid local candidate; with no valid local candidate startup fails (no empty Registry, no half-complete Provider).

| Remote response case                          | Handling                                                     |
| --------------------------------------------- | ------------------------------------------------------------ |
| HTTP/timeout/JSON/Envelope failure            | keep the current Snapshot and LKG, log a diagnosable error   |
| `configs.zcodeBuiltin` missing                | treat as not yet delivered, keep the current Snapshot        |
| Schema unsupported                            | reject the response, keep the current Snapshot and LKG       |
| Provider/Rule strict parse failure            | reject the whole response, no partial application            |
| revision below the current valid revision     | stale response, ignored                                      |
| revision equal and content identical          | dedupe, no write, no notification                            |
| revision equal but content different          | publish protocol error, reject and log                       |
| revision higher and compatible parse succeeds | atomically replace the Active Cache, then publish the change |

Write and publish order: remote payload -> strict envelope/domain parse -> atomic replace `active.json` ->
publish Source changed. If persistence fails the update does not enter the Host's in-memory Registry, so a
running Host, later-started Worker and restart recovery never see different facts. Writing uses the
Environment's explicit writable path, a file lock and atomic replace, never source paths, broad environment
variables or a cross-Environment shared cache.

## 3. Scope

Step 0 update the formal Design first (Environment Design's Management Service blueprint narrowed to this
round's `/client/configs.zcodeBuiltin` entry; Configuration/Runtime Design stating Bundled/LKG/Remote are
candidates of one Built-in Source; Environment composition root is the sync owner and Core Workers only read
the active file; no unified Client Config Service now). Step 1 two-layer Release Schema and cache path
(strict runtime Schema for `configs.zcodeBuiltin`, monotonic `revision` and `schemaVersion`, inner `config`
holds only existing Provider Config and Model Config Rules content, Bundled/Remote/Active Cache share the
two-layer structure, cache compat range by the `<platform>/<appVersion>/<endpointKey>/active.json` path, no
`fetchedFor`, no Remote Config Document type in the Provider Domain). Step 2 local candidate selection and
atomic Repository (compatible parsing of Bundled and Active Cache, choose by compatibility and revision,
missing/corrupt/old/incompatible Active Cache naturally falls to Bundled, `active.json` is both active
Source and LKG with one locked atomic replace, never write the repo/installer file). Step 3 minimal remote
synchronizer (Environment composition root requests `/client/configs` with the existing `ApiClient`, the
Environment's Endpoint, App Version and platform parameters; strict Envelope + existing Provider/Model
Config Parser compatible parsing; on-disk `refresh-control.json`, expirable lease, request timeout and
increasing backoff for Environment-level dedupe; with several Hosts sharing one Environment path re-compare
revision under the lock so a late request cannot overwrite with a stale one; other Client Config consumers
untouched). Step 4 wire the Host/Worker Source path (Local Host and Remote Host each use their own
Environment's active Built-in file; spawned Core Workers get the same path and use the existing file
Source/watcher; Environment Entries without a Desktop Local Host such as Prompt CLI, TUI and standalone
server own an equivalent sync owner; Desktop attached remote only consumes the Remote Host Facade with no
local push path). Step 5 refresh and lifecycle (background refresh once after the local valid candidate's
first ready; later roughly a one-hour TTL plus an explicit refresh entry; network recovery may trigger
retry but failure never empties the current Snapshot; after dispose a late request cannot write disk or
publish; a config change triggers the existing Account Source and Registry refresh, with no second Registry
sync). Step 6 cleanup and verification (delete path hardcodes that exist only because of the old
single-file Source assumption; other `/client/configs` chains not removed or refactored; make the release
build take Bundled and the remote release revision from the same config release flow; unit, integration and
target-Environment verification).

## 4. Tests

Schema and atomicity: full `zcodeBuiltin` strict parse; missing `config.providers`, `config.modelConfigRules`, `schemaVersion` or `revision` rejects the whole; unknown old `builtinProviders/builtinModels` never enter the formal Source; Rule regex, Provider API/Access, Model Properties and Reasoning Mapping use the current formal Schema; no extra Built-in business-integrity ruleset (that of the abandoned Todo 19) on the client. Bundled/LKG selection: no LKG uses Bundled; valid newer LKG wins; older LKG revision uses Bundled; wrong platform/old appVersion isolated by cache path, unknown Schema/corrupt JSON/Domain Parser failure Caches ignored; Bundled and LKG both invalid fails clearly; no old-version LKG reuse after an App upgrade. Remote refresh: higher revision parses, atomically replaces `active.json` and publishes one change; same revision same content dedupes; same revision different content rejected; lower revision and late stale requests do not overwrite; HTTP, timeout, JSON, Envelope, Schema, Domain Parser and write failures keep the current Snapshot/Active Cache; after dispose late responses neither write nor notify; several Hosts/Entries refreshing at once: only the on-disk lease holder requests the server; a crashed lease owner can be taken over after expiry; an Endpoint change is not blocked by the old TTL; failure uses capped increasing backoff and an explicit refresh does not bypass a valid lease. Environment and execution: Local Host and its Core Worker read the same active Built-in revision; Remote Host and Remote Worker use the remote Environment's own LKG; Desktop attached remote does not use Desktop's local Built-in; multi-Workspace Workers do not each request `/client/configs`; Settings/Selection Views update after a Built-in update; Account Provider re-constrained by the new Built-in; created Active Models unchanged and later ones use the new revision; Personal Provider/Model Config is not rewritten by remote updates and remains the last Overlay. Regression: Coding Plan products, plans, official-version signing, Off-Peak and Context Budget Client Config behavior; Desktop Computer Use, Desktop Context Prompt and Force Update chains; Desktop continuous and Web Remote replayable Session/Task data chains; Provider settings, model selection, Connectivity, Automation, Subagent, Repo Wiki and Off-Peak still go through the target Host Facade; `pnpm typecheck`, `pnpm lint`, affected unit tests and related Desktop/Remote E2E.

## 5. Definition of done and non-goals

Done: `/client/configs.data.configs.zcodeBuiltin` is the only transport field of remote Built-in; Provider and Model Rules are published, validated and applied atomically; Bundled and Active Cache are chosen correctly by compatibility and revision; `active.json` is both active Source and LKG and writing never modifies the repo or installer assets; each Environment composition root fetches, caches and publishes itself and Core Workers do not request independently; a Remote Workspace accepts no Desktop local Built-in push; remote failure, stale, corrupt and incompatible config never break the currently usable Registry; refresh affects only later-created Models; other Client Config consumers were not refactored in passing; Design, tests, typecheck and lint done and committed as a Conventional Commit.

Not done: a global or cross-process Client Config singleton; unifying the Client Config requests of `BigModelCodingPlanSubscriptionProvider`, Desktop Main and Force Update; persisting the whole `/client/configs` (only the validated `zcodeBuiltin`); modeling remote/LKG/Bundled as three Provider Overlay layers; mixing remote Provider Config with Bundled Model Rules; restoring old `builtinProviders`, `builtinModels`, Catalog, Preset or model-specific hardcode; changing Account Access, Personal Config, credentials, request auth or server final authorization semantics; changing model selection, queue, recovery, Continuous/Replayable or Session lifecycle.

## 6. Implementation record (2026-08-25)

- `@zcode/provider-node` gained the strict two-layer Release Schema, Bundled/Active candidate selection, the atomic Active Source, the cross-process refresh-control file and the Remote Synchronizer; the formal `config/provider/zcode-builtin.json` was migrated to a two-layer Release with `revision=1`.
- The Services Environment composition root reads `/api/v1/client/configs` in the background with the current Endpoint, App Version, platform parameters and the existing `ApiClient`; Local/Remote Hosts inject the Active path into Workers. Standalone Server reuses the Services owner; standalone Prompt CLI/TUI own their Active/LKG and background refresh, and when a Host explicitly injects the path it does not refresh again.
- A Settings explicit refresh triggers the existing refresh chain of Built-in Remote, Account Source and Registry; other Client Config consumers were not modified and no publisher-side business integrity validation was added.
- Automated coverage: strict parsing, candidate selection, same-revision conflict, remote newer/older revision, atomic update, cross-process lease, Endpoint change, late response after dispose, the Services composition root, Remote Host owner, Worker Active path, and CLI/SEA entries.
