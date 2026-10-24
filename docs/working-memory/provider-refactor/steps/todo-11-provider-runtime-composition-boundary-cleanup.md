# 11 Provider Runtime Composition Boundary Cleanup

> Status: Draft (2026-08-25)
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Related design: [`../design/registry/runtime.md`](../design/registry/runtime.md), [`../design/environment/environment.md`](../design/environment/environment.md), [`../design/registry/configuration.md`](../design/registry/configuration.md)
>
> Related tasks: [`06`](./todo-06-config-storage-envelope-repository-privatization.md), [`08`](./todo-08-legacy-model-catalog-retirement.md), [`10`](./todo-10-zcode-builtin-provider-config-naming-cutover.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-11-provider-runtime-composition-boundary-cleanup.md`

## 0. Draft Boundary

This records the 2026-08-25 review of the composition boundaries of the new Provider implementation. Discussion is
unfinished: target structure, public API, names and deletion scope are **not decided**. Until the status moves from
"Draft" to "Pending execution": do not change production code from this document, do not write candidate structures
into the formal Design, do not delete existing Runtime shells or change process lifecycle, and do not treat example names
as stable contracts. The work is shelved; resume from the section 8 questions, not from the section 6 candidate direction.

## 1. Review Question

Not M4 and not further old-model-abstraction cleanup. The question: do the Config, Registry, Settings Facade and
execution-process assemblies form multiple duplicate Runtime shells, blurred resource ownership and awkward bridge code
because the abstraction boundary was not carried through? Objects: `NodeProviderConfigRuntime`,
`NodeProviderRegistryRuntime`, Services `ProviderConfigRuntime`, Services `ProviderRuntime`, and the Host and Agent
execution-process composition roots.

## 2. Confirmed Current State

### 2.1 Four Runtime Shells

| Object                           | Owns / assembles                                                                                        | Current use                                                                                | Review fact                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `NodeProviderConfigRuntime`      | ZCode Built-in file Source, Personal Repository, `ProviderConfigService`, watcher/dispose               | used by the two layers above; `createNodeProviderConfigRuntime()` has no production caller | mostly a Node IO resource set; `start()` only calls `configService.read()`, no own running state         |
| `NodeProviderRegistryRuntime`    | the Config Runtime above, `ProviderRegistryService`, optional Account Source                            | production use by the Agent process root; factory has no production caller                 | wraps another Registry lifecycle and embeds a second Empty Account fallback                              |
| Services `ProviderConfigRuntime` | Node Config Runtime, Personal default path, Legacy Personal importer                                    | Host production composition root                                                           | file comment calls it a "compat assembly layer"; once Legacy reading retires it may only resolve paths   |
| Services `ProviderRuntime`       | Config, Registry, Settings/Selection Facade, RPC service adapter, ready promise, Account Source dispose | Host production composition root; generic factory mostly used by tests                     | Host behavior is a real need, but the name and public surface describe Host-specific assembly as generic |

Not all are wrong: Node file Source, Personal Repository, Registry, Facade, Account Source and watcher have real roles.
The problem is that they are wrapped several times as "Runtime", repeating `start`, `dispose`, empty Source and ownership
at different layers.

### 2.2 Two Real Process Composition Roots

```text
same static Config file facts
  -> Host process root: Account Service/Source -> Host-local Registry -> Provider Settings RPC Facade + Model Selection RPC Facade
  -> Agent execution process root: Account Snapshot/Source -> Worker-local Registry -> ModelFactory / Core model execution
```

Each side keeping its own in-process Registry is the existing design, not duplication to remove: Host Registry serves
Provider settings, Personal write preview and user model candidates; Agent Registry serves `ModelFactory`; both read the
same static Config facts but own their in-memory index and lifecycle; Host syncs standard Model Selection and the Account
Config snapshot/revision to the Agent, never a mutable Registry snapshot.

### 2.3 Host Composition Root

In `packages/services/src/node.ts` the Host assembles: `createProviderConfigRuntime` ->
`createAccountProviderConfigSource(configService, settings, account services)` -> `createProviderRuntimeFromConfigRuntime`
(`ProviderRegistryService`, `ProviderSettingsFacade`/RPC service, `ModelSelectionFacade`/RPC service, Account
refresh/dispose ownership). It lives as long as the window-scoped Local Host / Service Collection; Config Service must be
created first because Account Source depends on it; Settings can modify Personal Config and read the authoritative
Effective Preview; RPC channels may register synchronously, so first calls share one Registry ready promise;
connectivity tests run through the Agent while the authoritative Settings/Selection View stays on Host; Desktop
continuous, Mobile replayable, remote workspace and queue semantics do not change.

### 2.4 Agent Execution Process Composition Root

`startProcessProviderRegistryRuntime()` serves Protocol Worker, Prompt CLI and TUI: `resolveNodeProviderRuntimePaths` ->
`NodeProviderRegistryRuntime` (Config Runtime + process-local Registry), `MutableAccountProviderConfigSource`, Model
Selection Config Repository, standalone credential subscription (Prompt/TUI only), request-auth/runtime-header port per
entry. The Protocol Worker receives the Account Config snapshot from the Host protocol; standalone Prompt/TUI derives
Account Config from the local Credential Store and watches credential changes; the Worker only reads Config/Registry (no
Settings write entry); Registry must be explicitly started before App/ModelFactory use (no Host-RPC-style lazy ready
barrier); Prompt owns lifecycle per command, TUI shares process resources across `/new`, resume, fork, and Protocol
Worker lives with the process.

### 2.5 Concrete Lifecycle Bug Candidate

`startProcessProviderRegistryRuntime()` returns two disposable layers: outer `result.dispose()` (cancels the Credential
Store subscription, disposes the Model Selection Repository, then `runtime.dispose()` = Registry + Config
watchers/repositories) and `result.runtime.dispose()` (only the innermost Registry/Config cleanup). Prompt and TUI call the
outer one; the Protocol entrypoint calls `providerRegistryRuntime?.runtime.dispose()`, bypassing the Model Selection
Repository (and any standalone entry calling the inner one would leak the credential subscription). This is a concrete
bug caused by exposing nested owners. It does not wait for this document's architecture ruling and is fixed separately by
[`Todo 11A`](./todo-11a-provider-runtime-disposal-functional-fix.md); this document does not implement candidate refactors.

## 3. Boundaries to Keep Whatever Is Decided

1. Host and Agent each own an in-process Registry.
2. Node file Source and Personal Repository watcher, lock, atomic write and dispose are real IO responsibilities.
3. Account Source and the static Config Source are different fact sources.
4. Provider Settings mutation target and the RPC facade adapter are real ports; the Renderer never operates Repositories directly.
5. Worker execution needs a read-only Registry, Host settings need Personal mutation; the two do not need identical public capabilities.
6. Account Snapshot, Model Selection and Request Auth keep the existing standard boundaries.
7. No catch-all Runtime with many optional parameters serving Host/Worker/Prompt/TUI.

## 4. Node Config Resource Boundary Candidate

`NodeProviderConfigRuntime` is essentially a set of shared Node Config resources rather than a new domain Runtime (a
candidate understanding, not a decided name or API).

Candidate contents: Node ZCode Built-in read-only file Source (strict parsing, content revision, watch/change event,
dispose); Node Personal Repository (read/update, file lock, atomic private write, revision, watch dedup, dispose);
`ProviderConfigService` (layered reads and Personal mutation); one symmetric dispose; Repository-private schema/migration
(Legacy importer only temporarily during its compat period).

Not included: Account Provider Source; Effective Provider Registry; Provider Settings / Model Selection Facade; Account
credential, Request Auth, runtime headers; Model Selection Config Repository; `ModelFactory`, Active Model, Adapter; RPC
service; Host/CLI default path decisions and packaging materialization. Minimal output could be `{ configService, dispose }`;
whether it is a class, factory, public export, or still uses the word `Runtime` is undecided.

## 5. Differences Between the Two Composition Roots

Why they cannot be forced into one catch-all Runtime (not a final API design):

| Dimension               | Host root                                                   | Agent execution process root                                                |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| Main consumers          | Provider Settings, Model Selection RPC                      | ModelFactory, Core, Adapter                                                 |
| Config capability       | read + Personal mutation                                    | read only for execution                                                     |
| Account source          | Account Service driven by Settings/OAuth/Entitlement        | Protocol snapshot or Standalone Credential Store                            |
| Startup order           | RPC may register first; first access shares a ready barrier | `await` Registry start before creating the App                              |
| Model Selection         | candidate View and user validation                          | reads the configured default for execution Model creation                   |
| Settings capability     | yes                                                         | no                                                                          |
| Credential subscription | managed by Host account services                            | standalone Prompt/TUI may have one; Protocol Worker has no local derivation |
| Lifecycle               | with Local Host / Service Collection                        | Prompt per command, TUI long process, Protocol Worker per process           |
| Output                  | Services/RPC registration objects                           | Registry, Selection repo, auth port as needed                               |
| Dispose principle       | Host outermost owner releases everything once               | process root outermost owner releases everything once                       |

## 6. Candidate Direction (Undecided)

Candidate B, judged cleaner in the review: keep the shared Node Config resources and let Host and Agent assemble the rest
directly at their real composition roots.

```text
Node Config resources (Built-in Source, Personal Repository, ProviderConfigService, dispose)
  -> Host root: Account Source, Registry, Settings Facade, Selection Facade, one dispose
  -> Execution process root: Account Source, Registry, Selection Repository, optional auth resources, one dispose
```

Possible cleanups (none to be implemented now): delete Services `ProviderConfigRuntime` (Host decides the Personal path
and temporary importer); delete `NodeProviderRegistryRuntime` (Agent process root assembles Registry); narrow Services
`ProviderRuntime` to a Host-specific composition owner; make Account Source an explicit dependency of the root (no silent
Empty fallback inside); flatten each root's return value so only the outermost owner exposes `dispose()`; delete
production-caller-less convenience factories and test-only wide entries; let the Worker consume Config only through
read-only interfaces such as `ProviderSource<ProviderConfigSnapshot>` even if the same object can mutate Personal.
Example names (`createNodeProviderConfigResources`, `createHostProviderServices`, `startProcessProviderEnvironment`) are
discussion aids only.

## 7. Alternatives

- A: keep the four layers and only fix the lifecycle bug. Minimal change/risk, but duplicate Runtimes, Empty fallback,
  blurred owners and a wide public API stay; applicable if the wrappers' convenience outweighs long-term comprehension cost.
- B: shared Node Config resources plus two explicit composition roots. Boundaries match real process roles, a single
  dispose owner, fewer behavior-free wrappers; needs synchronized migration of Host, Protocol, Prompt, TUI and test
  helpers; risk of deleting the independent Registries or bringing Host write capability into the Worker.
- C: one unified Provider Runtime. Fewest entries on paper but needs many optional dependencies and mode switches that
  hide the Host/Worker differences in startup, write capability and Account source; the review leans against it but leaves
  the formal ruling open.

## 8. Questions Pending Ruling

1. Accept "Node Config is an IO resource set, not a domain Runtime".
2. Class, factory or composition-root-private helper, and whether it is exported publicly.
3. Delete `NodeProviderRegistryRuntime` so the Agent process root assembles the Registry directly?
4. After Legacy Personal importer compat reading retires, delete Services `ProviderConfigRuntime`?
5. Keep Services `ProviderRuntime` as explicitly Host-specific, or inline it fully into the Host composition root?
6. Must each composition root supply the Account Source explicitly; do no-account entries create an explicit empty Source?
7. Rule that only the outermost owner exposes dispose and no individually disposable nested owner is returned?
8. Keep the Host ready barrier and Worker eager start separately, not abstracted into one start state?
9. Does Todo 11 still depend on the finished Todo 06/08/10, or can it be implemented independently?
10. Final names, public exports and package responsibility wording.

The document cannot become "Pending execution" before these are confirmed one by one.

## 9. Impact Brief (Draft)

### 9.1 Impact

| Level          | Relation                                    | Reason                                                                                   |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| must-inspect   | `provider-node` Config/Registry runtime     | direct objects of candidate deletion or narrowing                                        |
| must-inspect   | Services Host composition                   | Account Source, Settings/Selection Facade, ready/dispose owner                           |
| must-inspect   | Bootstrap process runtime                   | Registry, Selection repo, Credential subscription of Protocol/Prompt/TUI                 |
| must-inspect   | Protocol shutdown                           | existing outer-dispose bypass bug candidate                                              |
| should-inspect | Provider Node/Services/Bootstrap tests      | tests depend heavily on wide Runtime factories                                           |
| invariant-only | Provider Domain Resolver/Registry semantics | Overlay, completeness and candidate rules unchanged                                      |
| invariant-only | UI and cross-end state                      | settings interaction, selection state, continuous/replayable, remote workspace unchanged |

No codegraph query tool was available; evidence is target source reading, exact `rg` call-site scans and export
reference checks; rerun the dependency graph and affected-test discovery before implementing.

### 9.2 State Owners

| State/resource                                | Current owner                                | Candidate target                                  |
| --------------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| Built-in Source / Personal Repository watcher | Node Config Runtime                          | Node Config resource owner                        |
| Personal Config mutation                      | ProviderConfigService                        | unchanged                                         |
| Host Account Source                           | Host Services composition                    | unchanged, but explicitly handed to Host owner    |
| Agent Account Source                          | Process runtime                              | unchanged, but explicitly handed to Process owner |
| Host Registry ready promise                   | Services `ProviderRuntime`                   | stays with a Host-specific owner                  |
| Agent Registry startup                        | `NodeProviderRegistryRuntime` + process root | process root awaits explicitly                    |
| Model Selection Repository                    | process root outer result                    | stays with the process root                       |
| Credential subscription                       | process root outer result                    | stays with the process root                       |
| All resource release                          | multi-layer `dispose()`                      | one outer dispose per composition root            |

### 9.3 Invariants

1. Host/Agent Registries both exist; no mutable Registry is passed between them.
2. Host Settings write only Personal Config; Effective Preview is still computed authoritatively server-side.
3. Agent model execution still goes Registry -> ModelFactory -> Model.
4. Account Config snapshot/revision and Model Selection protocols do not change.
5. Config watcher updates, revision, file lock, atomic write and importer behavior are not lost by changing wrappers.
6. On start failure or partial creation failure, all created resources are released symmetrically by owner.
7. dispose is idempotent and cannot be bypassed through nested objects.
8. Desktop continuous, Mobile replayable, remote workspace, Queue and recovery state unchanged.
9. No second Config, Registry, Account or Model fact is introduced.
10. Composition cleanup does not change Account, Access, Request Auth or model product semantics.

## 10. Candidate Acceptance Cases (Not Accepted)

Structure for the next discussion only; not a test commitment until the Todo is "Pending execution".

| Case ID | Setup                                        | Action                         | Candidate assertion                                                                                |
| ------- | -------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| PRC-01  | Host needs both Settings and Selection       | concurrent first RPC calls     | Registry starts once, ready result shared                                                          |
| PRC-02  | Host Config and Account Source assembled     | save Personal Config           | authoritative Effective Preview/Registry update; Account Source still uses the same Config Service |
| PRC-03  | Protocol Worker received an Account snapshot | create App and run a model     | Worker-local Registry started before the App, not dependent on the Host Registry object            |
| PRC-04  | Standalone TUI started                       | `/new`, resume, fork           | one process Registry/watchers shared, no repeated creation                                         |
| PRC-05  | Prompt/Protocol/TUI each exit                | call their outer dispose       | Registry, Config watcher, Selection repo, Credential subscription all closed                       |
| PRC-06  | any step fails at start                      | observe cleanup                | all created resources released; the original error is not masked by cleanup errors                 |
| PRC-07  | Config or Account Source updates             | Host and Agent refresh each    | both local Registries end on the same facts; no Registry snapshot passed                           |
| PRC-08  | desktop/mobile/remote representative paths   | settings, selection, execution | UI state, queue, replayable and workspace identity semantics unchanged                             |

## 11. Non-Goals

No M4; no further Core, ModelRef, Catalog or Off-Peak cleanup; no change to Provider/Model Overlay, member ownership,
enabled, visibility or conflict semantics; no change to Account Connection, Access ID, credential resolution or
server-side authentication; no refactor of Provider Settings UI, Model Selector or cross-process protocol; no merging of
Host/Agent Registry; no new domain intermediate states; no Telemetry, Queue, Recovery or Remote Provisioning work.

## 12. Gate From Draft to Execution

Status becomes "Pending execution" only when: section 8 is ruled item by item; the final conclusion is written into the
formal Design and Feature Graph; the real call surface is refreshed with the dependency graph, `rg` and TypeScript export
checks; retained/deleted objects, final names, package public API and the single dispose owner are explicit; section 10
becomes an accepted test plan with failing tests written first; the start-failure and release regression scope for Host,
Protocol, Prompt and TUI is explicit; and Desktop continuous, Mobile replayable and remote workspace state boundaries are
confirmed unchanged.
