# Cloud content dialog: implementation and acceptance plan

Status: the Desktop mock and shared components P0–P5 are delivered; production
integration is out of scope for this round. The current contract and usage live in
`docs/cloud-content-dialog.md`; test evidence lives in
`docs/testing/cloud-content-dialog-coverage.md`. The phased plan and baselines
below are the retained design trajectory, not a list of current gaps.

Delivered: P0/P1 contract and runtime validation, P2 Desktop ZIP asset service,
P3 four Hero kinds and the shared shell, P4 App HTTP mock entry, P5 Weekend
adapter. Full App preview 4/4 and Weekend 4/4 passed; real WebM/Lottie,
ZIP download/verify/cache/release, HTML, dynamic buttons, zh/en, themes, 390px
layout, and reduced-motion were verified. Close-focus restoration for controlled
dialogs was added; final results are recorded in the coverage doc.

Dev mock startup: `node packages/desktop/scripts/cloud-content-mock.mjs`, default
`http://127.0.0.1:4319/dialog`; then start Desktop dev and pick content from the
preview entry at the bottom right. The mock and App are wired together; parameters
are in the current spec.

P2 uses a host-exclusive cache directory, randomized lease resource URLs, and
release-on-close/cancel-on-exit. The cache only promises reuse within one host
lifecycle — no cross-process or restart-persistent cache. Web/mobile never got ZIP
asset hosting; only shared-component compatibility, unreachable-asset degradation,
and a Web build — no claim of real-device acceptance. P6 production
CDN/signing/delivery and the shared banner are out of scope for this round.

New E2E stays manual-review/pending; automated passes do not imply human
promotion. Earlier rounds' failures and their fixes stay in the coverage record.

## 1. Goals, state, and boundaries

Acceptance follows the actual run evidence in the coverage doc; a Web build or a
narrow desktop test is not treated as a mobile field test.

Goal: from the App's dev entry, fetch dialog JSON over real HTTP, download the
ZIP, verify and unzip it, load the isolated Hero, and fully display and execute
the cloud-declared controlled content. Campaigns are just one consumer; feature
introductions and notices can reuse the same components.

Confirmed: dialog first; support image, video, interactive animation, and lottie;
resource-ify existing animation and interaction assets; bundle.url is a ZIP;
support simple HTML; full in-App mock verification.

Not in this round: shared banner, an ops backend, automatic
delivery/segmentation/priority/frequency-control, rewriting real campaign
business, or arbitrary remote scripts calling client capabilities. Production
integration is accepted separately; local mock success is not a launch
conclusion.

## 2. Data contract: every field has a consumer

The authoritative v1 schema is now `packages/shared/src/cloudContent.ts`
(documented in `docs/cloud-content-dialog.md`); this section records the plan-time
contract decisions:

| Field              | Semantics / consumer                                      | Validation / failure handling                                                                 |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| schemaVersion      | decoder protocol version                                  | unsupported major version: refuse to display and log why                                      |
| id / revision      | content identity and version; used by logs, close records | non-empty id, positive integer revision; not the ZIP cache key                                |
| kind               | campaign / feature / notice classification                | no kind-based Weekend special-casing                                                          |
| locale             | actual language of returned content                       | request carries locale; mock provides zh/en fixtures; fallback language is visible            |
| dialog.title       | shared title component                                    | plain text, length cap                                                                        |
| dialog.description | format + text                                             | plain_text / html; markdown's official support policy is an open item                         |
| dialog.hero        | union-type renderer                                       | unknown type never executes; degrade to no Hero; shell and close stay usable                  |
| dialog.buttons[]   | render id, label, variant, actionId in order              | unique ids, count/copy caps, actionId must resolve                                            |
| actions            | host ActionDispatcher whitelist                           | undeclared/unavailable actions are not executable; no dynamic code or arbitrary service names |

Hero-specific fields (image: src/darkSrc?/alt/fit?; video: src/darkSrc?/poster/
autoplay?/loop?/muted:true/fit?; lottie: src/darkSrc?/autoplay?/loop?/speed?/
fallback?; interactive_bundle: runtime/bundle/viewport/data/events/fallback?) are
consumed by the shared HeroRenderer. The interactive bundle adds
`format:"zip"`, `sha256`, `sizeBytes`, and keeps `url` plus relative `entry`;
SHA-256 must be really generated by the build, never a placeholder hash. `data`
is size-limited JSON only — no account credentials, host paths, or service
handles. HTTP exceptions are enabled only in explicit dev/test mode; production
accepts only trusted HTTPS sources, and redirects are re-validated.

Description and actions:

- Simple HTML keeps p/br/b/strong/i/em/u/s/ul/ol/li/code/a/span/time; the client
  controls typography. Scripts, style, event attributes, images, forms, embedded
  content, and dangerous URLs are forbidden. Untrusted DOM is never mounted
  directly; the whitelist is rebuilt and parser boundaries tested. Input cap
  20,000 characters / depth 32; over-limit falls back to plain text.
- Links allow absolute HTTP(S) only and open through platform interfaces;
  dynamic business values are escaped first. zh, en, long text, lists, and
  keyboard navigation are all covered.
- `close` closes only the current instance; `dismiss_content` means "do not show
  again" — the two must not be conflated. Mock dismissal stays in a dev-only
  namespace; formal account/revision frequency control belongs to later delivery
  design.
- `navigate` accepts registered destinations only; `copy_text` / `open_external`
  fire only from host-button user actions.
- `claim_plan`, if kept, must go through the injected business handler re-running
  login/eligibility/confirmation/idempotency; the shared component never executes
  the claim. The mock uses a handler with no real side effects.
- iframe events allow only registered display events (for example Replay). iframe
  messages must never map directly to sensitive actions such as claim, navigate,
  or clipboard; "unknown events pass through under the original id" was removed.

## 3. Architecture and state ownership

```text
App dev preview / Weekend adapter
        |
        v
ContentSource -> HTTP JSON -> runtime schema -> shared ContentDialog
                                                   | title / description / buttons
                                                   |                    |
                                                   v                    v
                                              HeroRenderer       ActionDispatcher
                                                   |              -> injected handler
                                                   v
                                            ContentAssetResolver
                                                   |
                     +-----------------------------+--------------------+
                     | Desktop                     | Web/mobile         |
                     v                             v                    |
              local host asset service      platform asset adapter      |
              ZIP -> verify -> safe unzip   same bundle contract        |
              -> cache -> scoped URL        -> browser-loadable URL     |
                     +-----------------------------+--------------------+
                                                   v
                                            sandboxed iframe
                                       load -> init -> ready
```

| State / fact            | Authority                                      | Cache or mirror            | Side effects                   |
| ----------------------- | ---------------------------------------------- | -------------------------- | ------------------------------ |
| content payload         | mock / future content service                  | ContentSource memory cache | never changes claim results    |
| display/focus/loading   | the single Dialog instance                     | no cross-window sync       | React local state              |
| ZIP and integrity       | content asset service                          | cached by hash             | App cache, never the workspace |
| Hero-internal animation | iframe                                         | no business mirror         | the iframe's own DOM/RAF       |
| navigate/share/claim    | existing host capability / business controller | not copied into the iframe | injected handlers              |
| dismissal               | dev preview namespace only, for now            | by id+revision             | formal account scope TBD       |

Main only injects necessary platform paths and registers/forwards the asset
channel; it does not own ZIP download or unzip business. The UI goes through
hooks/services and platform injection, never directly to Repos, the filesystem,
or the window bridge.

ZIP cache and failure timing: staging (`<unique-attempt>`) then verified
promotion by `<sha256>`; `absent -> downloading -> verifying -> extracting ->
ready`, failure discards staging as a retryable error; `ready -> acquire lease ->
render -> release lease -> eligible for eviction`. All IO is async; concurrent
downloads of the same hash dedupe; closing an instance releases its reference and
must not cancel downloads other instances still use. Download
size/time, expanded size, per-file size, and file count use fixed client caps
that server declarations cannot loosen; actual counts never trust ZIP metadata
alone. Absolute paths, `..`, symlinks, duplicate/conflicting entries, and
cross-platform path escapes are rejected; entry existence and allowed-HTML file
types are checked; ZIP bombs, hash mismatch, interrupted downloads, full disks,
and concurrent writes are handled. Staging promotes atomically on the same
filesystem after full verification; an incomplete cache is never visible;
resource URLs expose only verified in-package paths. Cleanup follows a size
budget and LRU while skipping active leases; dev controls expose cache clearing
and retries with observable evidence. Suggested bounds (5s ready, 30s download)
were to be frozen after testing against real asset sizes; failures show fallback
or an empty Hero without blocking title/buttons/close.

Cross-platform boundaries: desktop paths are not mobile URLs — cross-platform
asset loading was never implemented. The recommended path (restricted local
resource channel on Desktop; trusted-service same-hash static URLs or a
controlled Web asset adapter on Web/mobile) depends on existing hosting and must
not silently add a public asset server. If shared-host forwarding is needed,
reuse the existing authenticated attachment, start no new Agent/runtime, and read
the remote-control architecture doc before defining the interface. iframe
subresources, CSP, isolated origin, MIME, cache and invalidation must be
verified; plain Web/mobile without the capability gets an explicit fallback —
never claim all four Hero kinds work everywhere. In SSH/WSL/Docker workspaces,
resources stay App-local and are never uploaded to the remote workspace.

## 4. Security boundaries

- The ZIP hash proves content consistency, not publisher trust; production still
  needs trusted HTTPS sources and a publishing authentication policy — whether
  signing is mandatory is decided by the publishing architecture.
- The iframe keeps `sandbox="allow-scripts"`; no same-origin, forms, popups, or
  top navigation, and no access to Node/preload.
- The host asset channel enforces CSP/source isolation and must not trust a
  remote HTML's own CSP; restrict connect/frame/object/form and similar egress so
  resources cannot quietly exfiltrate data.
- Message checks cover the current contentWindow, instanceId, channel, type, the
  event whitelist, and payload size caps; stale iframes/other windows/duplicate
  ready/out-of-order messages must never cross state.
- Untrusted-content logs never output full HTML, data, credentials, or URLs with
  sensitive parameters; high-frequency animation events stay out of production
  info logs.

## 5. Impact brief

Pattern: planning. Layers: presentation, validation, commit-effect, persistence.
Main seeds: CloudDialogHero, createWeekendPlanResultDialogMock,
ManualClaimPlanResultDialog.

| Surface / entry       | Shared implementation            | Default source and validation        | Commit / persistence                     | Mode isolation                                       |
| --------------------- | -------------------------------- | ------------------------------------ | ---------------------------------------- | ---------------------------------------------------- |
| Weekend claim result  | shared Dialog + business adapter | existing claim result, shared schema | original controller navigate/share/claim | no change to login/security/provider refresh         |
| App dev preview (new) | same Dialog                      | HTTP fixture, explicit scenario      | mock actions, dev dismissal/cache        | no real claim, no production entry                   |
| plain Web/mobile      | same UI, different asset adapter | same schema + capability check       | current navigation/platform capabilities | no desktop file paths copied, no task-recovery state |

Shared: field parsing, typography, Hero protocol, action whitelist. Different:
asset loading method, platform action availability, entry business data, and
dismissal scope — business owners are not forcibly unified.

| Level          | Relation and reason                                                                   | Evidence                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| must-inspect   | ManualClaimPlanBanner -> ResultDialog -> Hero/mock; the only found production entry   | the component sources, direct rg callers, depth 2                                                                                     |
| must-inspect   | mock fixture -> types -> renderer, the three were not fully aligned                   | the cloud-content-dialog directory                                                                                                    |
| should-inspect | platform services, asset channel and cache; new IO boundary                           | `packages/shared/src/platform.ts`; `packages/desktop/src/main/localMediaPreviewProtocol.ts` as an adjacent seed, not assumed reusable |
| conditional    | Web/mobile reachable asset plan                                                       | transport adaptation TBD, no task/Agent protocol extension                                                                            |
| invariant-only | login/claim/provider authority, continuous/replayable, workspace isolation            | existing manual-claim coverage and repository architecture constraints                                                                |
| evidence-only  | Hero unit tests, manualClaimPlanBannerInteraction, start-plan-manual-claim-experience | existing tests; they do not replace new ZIP-flow tests                                                                                |

The codegraph tool was unavailable; exact rg traced the seeds and direct callers,
and statically-reachable components were not counted as impact. The existing
feature graph already has cloud-content-dialog/shared-cloud-dialog-hero and the
Weekend relations; graph drift (names suggesting full capability) is clarified by
this document's status, and the graph delta (dev surface, asset-service/cache
relations) is proposed until the adapter plan is confirmed — unimplemented owners
are not written as facts.

## 6. Phases and delivery gates

P5 migration rules: the Weekend success state only builds the payload, injects
navigate/copy capabilities and the local copy-success toast, and no longer builds
its own button/description shell; the failure state keeps the original business
confirmation box. The shared component keeps the 480px cap, 4:3 Hero, and
same-row wrappable buttons, with scrolling content on narrow screens. The
copy-success label is a host-localized string; resource messages must never
trigger the clipboard. Production Weekend still uses the App-bundled HTML as an
explicit `resolvedUrl`, not the dev HTTP service; the remote mock's bundle must
be a real ZIP going through host prepare. The two sources must be distinguished
in types and docs — production is not claimed to be cloud-connected.

Each phase runs spec/cases -> tests -> implementation -> verification, and ends
with artifact paths, test output, and remaining risks.

| Phase                                                | Work                                                                                                                                                     | Completion gate                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P0 contract and validation                           | freeze fields, error policy, action permissions; verify Desktop/Web asset loading; resolve the unfinished HTML test state                                | schema/fixture/adapter interface designs agree; cross-platform plan evidenced; open items explicit                      |
| P1 assets and mock HTTP                              | pack the current HTML into a ZIP; generate real hash/size; JSON/ZIP/error-scenario routes and a startup command                                          | real JSON fetchable, ZIP downloads, unzipped animation is self-contained; no Vite URL swapping                          |
| P2 asset service                                     | async download, verification, safe unzip, cache, URL resolution, cancel/cleanup/error codes                                                              | first download and cache hit, polluted cache, malicious ZIP, and concurrency pass integration tests                     |
| P3 shared components                                 | Dialog shell, four Hero kinds, title, simple HTML, dynamic buttons, ActionDispatcher, loading/error states                                               | editing JSON changes every visible field and allowed behavior; no Weekend special-casing; keyboard and focus work       |
| P4 App mock loop                                     | dev-only preview entry; scenario selection, theme/language, cache clear, retry, status info                                                              | the HTTP -> ZIP/cache/iframe-ready chain is visible in-App without login or claiming                                    |
| P5 migration and regression                          | migrate the Weekend adapter to the shared components; remove the temporary duplicate description/button implementations; add cross-platform verification | original claim flow, failure result, navigate and share intact; four Hero kinds pass zh/en, both themes, narrow screens |
| P6 production cloud integration (separate follow-up) | replace the data source, trusted CDN/publishing auth, account isolation, formal delivery policy, gray release/rollback                                   | server contract integration, security and release gates pass; before that, only "mock complete"                         |

P2 and P3 both depend on the P0/P1 contract; only after P4 merges is the mock
user-verifiable end to end. Building React components alone is not "done".

## 7. Case planning, pruning, and E2E handoff

The App mock acceptance entry is implemented:
`ui-shell/manual-review/pending/cloud-content-preview.test.ts` covers the
representative paths of CCD-01/02/03/04/05/06. The case owns a loopback 4319
fixture server (same default address as the dev entry; port-in-use fails the
run; no one else's fixtures are used); the host uses an E2E-isolated data
directory. No model requests and no real claiming; new cases stay pending — an
automated pass is not a human promotion.

Clarified: the user confirmed dialog first, four Hero kinds, ZIP, and simple
HTML; production delivery rules are undefined, and nothing about auto-popup or
"don't show again" policy is derived from "shared dialog".

Domains: content display, asset download/persistence, platform capabilities, and
security validation are in; model config, conversation state, and the Agent
runtime are out of the implementation, kept only as isolation regressions.
Dimensions: Hero type × content validity × network/cache state ×
theme/language/screen × action capability. High-risk crossings: ZIP paths vs
Windows path rules; multi-instance cancel/cleanup; mobile vs desktop resource
URLs; HTML with links/dynamic interpolation; iframe events vs business
permissions.

| Case ID | setup -> action                                                  | Assertions and evidence layers                                                                                          | Status                                                 |
| ------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| CCD-01  | empty cache -> open the interactive Hero in App preview          | HTTP JSON/ZIP requests, cache file matching the hash, iframe ready, content from the fixture                            | accepted/planned E2E                                   |
| CCD-02  | cached -> reopen / switch revision with the same hash            | No repeat ZIP download; new copy takes effect; package content identical; network + file evidence                       | accepted/planned integration + E2E                     |
| CCD-03  | 404/interrupt/timeout/wrong hash/malicious ZIP -> open           | Bad assets not executed; no ready polluted cache; fallback and close usable                                             | accepted/planned integration, representative error E2E |
| CCD-04  | four Hero kinds -> open, theme switch, background, close         | Correct display, pause/destroy, no leftover listeners or animations; UI + runtime                                       | accepted/planned E2E                                   |
| CCD-05  | zh/en, narrow screens, long HTML -> display/keyboard             | Typography, scrolling, focus restoration, tag whitelist, safe URLs; UI + DOM                                            | accepted/planned unit + E2E                            |
| CCD-06  | fixture changes button order/copy/action -> click                | Renders from data; only registered handlers hit; unknown actions not executable                                         | accepted/planned unit + E2E                            |
| CCD-07  | wrong window/instanceId/event -> postMessage                     | No state cross-writes, navigation, copy, or claim side effects                                                          | accepted/planned unit + runtime test                   |
| CCD-08  | multiple windows same hash, close one, clear cache -> keep using | Download not mis-cancelled; in-use packages not deleted; lease/file evidence                                            | accepted/planned integration                           |
| CCD-09  | Weekend success/pending/failure -> operate                       | Original claim refresh/navigate/share assertions unchanged; success uses the shared description, failure builds no Hero | accepted/update existing E2E                           |
| CCD-10  | Desktop local/remote workspace, Web/mobile -> open               | No new runtime; assets reachable or explicit degradation; task flow unchanged                                           | accepted/planned; transport plan TBD                   |
| CCD-11  | markdown / dismiss_content formal policy                         | Product semantics not frozen; no coverage claimed                                                                       | undefined                                              |

Pruning: malicious-ZIP path variants are enumerated at the service integration
layer, E2E keeps one; theme/language pair on the shared renderer instead of
enumerating every network failure; remote workspaces are not multiplied across
SSH/WSL/Docker because assets are App-owned, but representative runs are
required. Auto-delivery/account frequency-control combinations are pruned as
explicitly out of mock scope — not assumed supported.

E2E fixture: a standalone local mock server on a random port, a temporary cache
root, generated verifiable ZIPs, an action recorder instead of real claiming;
wait on requests/ready states, no fixed sleeps. Network, file, and UI evidence
are all recorded. Docker/container presets follow the existing harness when
implemented; the current formal-proof (conversation-only) must not impersonate
dialog coverage.

Quality gates: focused unit/integration, App E2E, `pnpm typecheck`, `pnpm lint`,
affected format checks, Web build; macOS/Windows/Linux and mobile items that
cannot be field-tested are listed as risks, not recorded as passed.

## 8. Launch, rollback, and open items

Mock sources and preview are enabled only in explicit dev/test; production builds
show no entry. During migration, a switchable data source/business adapter is
kept so rollback does not roll back user claim state. Unknown protocols are
rejected, asset failures degrade, and cached versions are immutable; production
can stop publishing an item while clients can still close open instances.

Defaults before implementation:

1. First round guarantees plain_text + simple HTML; markdown either gets safe
   typography or is explicitly removed from the v1 support set — no "type
   accepted but feature missing" state.
2. Mocks are manually triggered, no auto delivery; close is not persisted;
   formal dismiss_content account/revision semantics await product confirmation.
3. Web/mobile asset hosting needs technical validation and deployment
   confirmation; without it, only "Desktop mock complete" may be claimed — never
   "all platforms".
4. Production signing, trusted domains, asset budgets, and retention are
   undetermined; they block P6, not the offline fixtures and Desktop mock.

Final mock acceptance: switching only the HTTP fixture in-App shows a campaign
or feature introduction; all four Hero kinds, title, HTML description, and
dynamic buttons follow the data; the interactive Hero really goes through ZIP
download verification and caching; first open/reopen/failure/retry are provable;
business side effects are controlled; the compatible scope and remaining limits
are written down.
