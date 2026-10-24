# Provider Stabilization: Final Review and Delivery for This Round

Scope: Todo113 round two and Todo115-132 (19 items) from baseline `1bc2e9bc42`; code branch
`provider-stabilization-20260911`. Each Todo's specification and implementation record is still the item-by-item
basis; this page records the final batch results. A local pass does not equal full real multi-end acceptance.

Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/provider-stabilization-20260911-final-review.md`

## Item Results

| Todo          | Requirement implemented and reviewed                                                                                         | Commit         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 113 round two | Verified new model directory, smart configuration, aggregated differences, retired-member cleanup; real SDK request and frozen capability transfer | `262c42e592` |
| 115           | Provider title bar, menu and switch hit area; model row layout unchanged                                                     | `8d16f98136`   |
| 116           | Single fetch-Key URL; cleaned up the team second entry in config, types, Schema, transmission and display                    | `3c22794269`   |
| 117           | Keep account domain and explicit plan selection; account Provider cannot be disabled; manual Key can still be enabled/disabled | `30bb5f7005` |
| 118           | First import keeps custom Provider outer-layer enabled; no re-migration overwriting new config                               | `8481a34543`   |
| 119           | Connectivity test restores green feedback and shows the Provider name                                                        | `875b5578ac`   |
| 120           | Two official URLs and explicit Coding Plan Key share the complete signature chain; paired and real request acceptance        | `ad3277af02`   |
| 121           | Appended 0022 supplements recoverable historical tier; covers upgrade paths with 0020 executed and not executed              | `7b2bd3968d`   |
| 122           | Subagent failure reason and model identity projection; does not claim the un-reproduced startup root cause                   | `e1a28f23eb`   |
| 123           | History capacity queries the Registry by saved model identity; unknown is null; keeps history usage                          | `6d4c3cc571`   |
| 124           | Disabled Provider connectivity test prompt changed to non-executable, avoiding a false "non-existent" report                 | `875b5578ac`   |
| 125           | 9 help descriptions and dual-size interaction                                                                                | `1c1da97537`   |
| 126           | Coding Plan GLM-5.3 hidden visual badge (display only), Flash PDF, plan API Turbo default                                    | `1bf21bee22`   |
| 127           | Online Built-in download, strict validation, lifecycle update, expired-request failure, atomic release fact                  | `036c3dd3c8`   |
| 128           | Provider startup contract and idle qualification consistent; merge concurrent startup; discard old account query results     | `b2e2b31ea3`   |
| 129           | Telemetry boundary restores old ID, Team classification and home-page idle gate; report and actual model identity unchanged  | `ba119dde2f`   |
| 130           | Manual field editing contract; keeps non-edited fields and the formal save boundary                                          | `dcb231de22`   |
| 131           | Smart configuration placement, atomic recovery, old-request failure                                                          | `1c1da97537`   |
| 132           | Name explicit confirmation save, option background color, interaction feedback                                               | `8d16f98136`   |

The final browser batch exposed a test-fixture issue (global subscriptions overwriting each other); scene
initialization was isolated and rerun, all pass (`0ac735ee98`); not an account-state product regression.

The push gate's expanded correlation regression covered 968 files: 964 passed, 4 files / 16 tests failed (10,267
passed). Handling (the first gate is not written as passed):

- 11 model-editor failures: the help button embedded in a label falsely took the input label association. Failing
  assertion kept; the input is now bound by unique id/`htmlFor`, the help button sits outside the label, and the group
  title does not impersonate a single-field label. Rerun 40/40; the dual-size browser adds "title click focuses the
  input, and none of the nine help items is embedded in the label".
- 2 renamed old tests received the explicit-confirmation mark; the idle home-page test now verifies the shared
  freshness notification instead of the component skipping initialization notification itself. The real Store
  concurrent dedup and old-request failure remain verified by this round's special tests; the product was not changed
  to fit old assertions.
- 2 resource monitor failures are a baseline Linux CPU caliber fixture issue (simulating four cores but using the whole
  machine value as the Electron single-core value); only the fixture input conversion was fixed, not the monitor or
  metric caliber.

The restore button JSX moved into the original Actions file to keep the main popup within the 400-line gate (behavior
and callback unchanged; old structure test tag expectation synchronized). The **complete push gate then passed**: root
lint, architecture, 53 directly modified test files and 118 correlation-regression files, against baseline
`1bc2e9bc42`, no hook skipped (`/tmp/provider-stabilization-final-push3.log`). Code result `7c62534821` was pushed and
verified against remote `origin/provider-stabilization-20260911` (the two earlier failed gates produced no remote
release). The label correction passed typecheck and lint/architecture; the help/recovery dual-size real browser 4/4
passed (`/tmp/provider-final-help-browser3.log`). No MR created, no other branch pushed, no online config released.

## Batch Verification

| Check                                    | Result and evidence                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root related unit tests, 68 files        | **1028/1028** (`/tmp/provider-final-root-tests2.log`)                                                                                                |
| Agent SDK / Signature / Model, 6 files   | **173/173**, including 58 new round-two real SDK wire tests (`/tmp/provider113-sdk-final.log`)                                                       |
| Migration / Bootstrap / Core, 7 files    | **241/241** (`/tmp/provider-final-cli-tests.log`)                                                                                                    |
| Independent entry contract               | **4/4** (`/tmp/provider-final-entry-tests.log`)                                                                                                      |
| Real React browser interaction           | **20/20**, desktop width English dark and mobile width Chinese light (`/tmp/provider-final-browser2.log`, screenshots `/tmp/zcode-provider-settings-batch`) |
| Typecheck                                | Root, Adapter and Bootstrap pass (`/tmp/provider-final-{types,adapter-types,bootstrap-types}.log`)                                                   |
| Root lint / architecture                 | Lint **0 errors / 42 warnings**; architecture **0 violations** (`/tmp/provider-final-lint3.log`, `/tmp/provider-final-architecture2.log`)           |
| CLI Adapter full lint                    | **Not passed**, 26 max-lines; error files and rule set match the opening log; the original long files were not expanded (`/tmp/provider-final-cli-lint.log`) |
| Fresh Desktop / Agent build              | Passes; the later Electron startup SIGTRAP cannot be recorded as E2E pass (`/tmp/provider-final-electron.log`)                                       |
| Final release file integrity             | Revision **22**, 14 tests pass; SHA256 `f94d2fe55eebbfda79c667c6ea90c71eb28d40bf2d020013c20288ab2a70f623` (`/tmp/provider-final-release.log`)       |

A previous batched Core run (410 passed / 5 failed) reproduces at the baseline: old cold-recovery fixture, remote Cron
disable list, account Provider serialization expectation. The failures are kept; this round is not full green, nor
expanded to unrelated fixes.

Todo120 went through the ordinary Key / explicit Coding Plan Key entry to each of the two official services: all 4
handshakes succeed with signature, model returns 200 and text. The original Key is only in the ignored local
environment file (not in code, documents or the Air). Other paid endpoints of the new model were captured only by the
real SDK local fetch and cannot be called real-service acceptance.

## Pro Supplementary Acceptance (2026-09-12)

The earlier "Pro ordinary SSH command fails" cannot be attributed to network or Pro unavailability: `macbook-pro` uses a
tunnel-only key / forced command; the existing `macbook-pro-admin` is the management connection and works. Private
dependency re-download is still limited by keychain permission, but existing dependencies can be copied into an
isolated directory and rebuilt from the current commit without operating daily configuration or transmitting
credentials.

- Isolated directory `/Users/dev/provider-stabilization-pro.euQzIZ`, source `git archive fc757c0ec9`; only the old test
  directory's `node_modules` reused; App, Host and Agent rebuilt; test configuration / Session independent.
- Electron cold recovery **1 file, 1 scene passed**, covering CW01-CW06: 1M/64K, Compact cold watermark, missing tier
  identity still queries capacity, unknown-model history opens without a pseudo denominator
  (`/tmp/provider-20260912-pro-cold-resume.log`).
- Electron settings **3 files, 4 items passed**: real file round-trip of smart configuration and recovery, cancel/failure
  draft, Map editing, model repair and delete prompt, connectivity test success/failure, original selection retention
  (`/tmp/provider-20260912-pro-settings.log`).
- Pro Chrome dual-size interaction **20/20** with the real shared React component and an isolated fixture (default
  Playwright lacks the browser; installed Chrome used; the first startup failure is not a product failure);
  Chinese light help, title bar / single-link screenshots checked manually
  (`/tmp/provider-20260912-pro-browser2.log`, `/tmp/provider-20260912-pro-artifacts/`).
- Electron account CTP-12 **passed**: full application with an isolated plan service fixture, long team-name width
  layout, plan switching persistence, selection kept across re-entry/restart (`/tmp/provider-20260912-pro-account.log`).
- Same batch `provider-readiness-agent-startup` **failed**: after reaching the empty configuration draft the test
  requires clicking send but the button is disabled. The test file and the `ConversationComposer.canSend`
  `submissionReady` gate equal baseline `1bc2e9bc42`; later steps also depend on the revoked account-menu `preset:` API
  Key entry. This is an old test inconsistent with the current interaction contract; do not enable send or restore the
  old menu to fit the test; the existing case was not rewritten and its second half is not recorded as verified. The
  lifecycle's targeted unit tests remain valid but cannot replace the missing real-machine evidence.
- Browser scenarios do not equal mobile shared-host / SSH joint real-machine and do not prove the logged-in console or a
  real paid Team service.
- Todo116 native link: new K116-N01 **passed** (two templates, with/without Key through the real settings button, the
  platform interface and the unmocked Electron shell opening the system browser; a unique canary GET confirms the
  precise URL; config file bytes unchanged; `/tmp/provider-20260912-pro-native-key2.log`; the first run omitted
  templateId and passed after test correction per the "only the template provides the entry" rule, no product change).
  Final review added exclusion of Electron internal navigation (`/tmp/provider-20260912-pro-native-key3.log` passes
  again, 0 model requests on the network). Root/E2E types, lint, architecture and coverage audit pass; the fixture
  checker does not support the settings directory (recorded, framework not expanded). The remaining SSH formal case needs
  test host/username/password not configured on this machine and the Pro session; both ends lack `docker`; no daily
  account or un-isolated directory is borrowed. Official console login is not claimed.
- Todo127: Pro real HTTP slow body / two real consumer processes / Registry config consumption 3 items passed
  (`/tmp/provider-20260912-pro-builtin-runtime.log`). New complete-Electron BR117-N02 **passed**: settings refresh drives
  the formal control surface -> HTTPS CDN -> Active -> Registry, capacity 500K -> 700K; 2 real model requests use the
  same model; `top_p` changes 0.17 -> 0.37; Personal file bytes and recent selection cache unchanged
  (`/tmp/provider-20260912-pro-builtin-refresh3.log`, wire `/tmp/provider-20260912-refresh-asserted-wire.json`,
  control surface/CDN records `/tmp/provider-20260912-refresh-network.json`). The model response is from the case's local
  synthetic server (not the official model, not the running Model, not mobile/SSH). The case reuses the existing network
  proxy, CA, planted isolated config and the formal button after exit; it does not write Active directly nor replace the
  downloader or Registry. Root/E2E types, root lint (0 errors / 42 pre-existing warnings), architecture and coverage
  audit pass (`/tmp/provider-20260912-refresh-{root-types,e2e-types,lint,architecture,audit}.log`). The case and the 2
  request manifests stay pending (no unauthorized promotion, no unsupported settings fixture checker).
- Full-page `settings-ui-polish` rerun: the first run exposed this round's un-updated delete menu, group label, final
  DeepSeek 2-member assertion, and an unclosed avatar menu contaminating the later real scroll; only tests and
  wrap-up were fixed (no product change, no scroll check removed). Final
  `/tmp/provider-20260912-pro-settings-polish4.log`: 8 items executed; 1 Windows item returns early on macOS (WDIO counts it
  as pass but this record does not count it verified); 1 SSH item skipped for missing environment; individual
  create/scroll also passes. Covers create, delete real Personal, model reorder, edit/cancel/save, Map original text, 2
  visual entries and 390px Chinese/English dark/light layout (screenshots
  `/tmp/provider-20260912-pro-editor-{dark,light}-390.png`). Root/E2E types, lint, architecture and coverage audit pass;
  no new formal test created and no unauthorized pending promotion.

## Final Intersection Review (Contract)

- **Migration and recovery.** The 0020 checksum is untouched; 0022 only backfills same-model records that are
  recoverable and not yet overwritten by later edits. Old fields, message body, time and existing options are not
  overwritten. History display query metadata does not require creating the execution Model, and formal execution
  validation is not relaxed.
- **Config and account.** Account disable cancellation goes through the joint parsing and write boundary; a manual
  Provider switch affects only itself. Config save no longer clears the account domain; startup, online update and idle
  query have a version boundary for old results; no business pre-send strong sync or second fact source added.
- **Request and identity.** Signing reuses the existing formal chain; the old telemetry ID is projected only at the
  output boundary (never into selection, execution or storage). New Schema capability is frozen at Model binding time;
  no Runtime vendor-name judgment; a running model does not change on config update.
- **UI and multi-end.** Settings and model selection display share the rule; the visual-badge exception is only at the
  display layer the product specified. Edit draft, save and recovery have independent boundaries. Desktop continuous,
  mobile replayable/shared-host and workspace identity protocols are not modified. Dual-size browser passes do not
  replace mobile remote-control real-machine verification.

## Retained Items and Delivery Boundary

1. **Real desktop / multi-end acceptance.** Linux Electron startup limitation remains, but the Pro supplied cold
   recovery, real file interaction of settings, real Chinese characters and native URL opening. The Air independent
   environment still has the private dependency permission limitation. Real paid Team status and the mobile / SSH joint
   chain have no real-machine evidence this round; browser fixture passes cannot substitute.
2. **Online config not auto-published.** The actual CDN is still revision 19 with deleted fields, which strict parsing
   rejects. The repository and acceptance products are revision 22; a release process with permission must publish the
   final file (local HTTP / dual-process success is not an online update).
3. **Unconfirmed model supply.** Omni Beijing Messages, Bailian Kimin high-speed version protocol/attachment, MiMo
   UltraSpeed commercial availability, etc., stay as in the Todo113 research record; IDs and capabilities are not
   guessed; verified models are not blocked.

Independent work was handled; the current branch was pushed per user authorization; no config released, no MR created.
The 19 items are not claimed fully real-machine verified, and these limitations are not moved into Todo102 to close
this Goal.
