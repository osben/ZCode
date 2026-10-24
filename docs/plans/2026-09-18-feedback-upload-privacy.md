# Feedback and ticket upload privacy

Status: client implementation and verification complete, not released. Current default behavior is defined
in `docs/feedback-simplified-flow.md`: new feedback logs are on by default and can be unchecked; log
collection and redaction boundaries are unchanged.

**Goal:** A ticket carries only the description, contact details and images the user confirmed, plus
necessary device information. Optional logs are on by default and cancelable, the collected scope is
explicitly limited, and every feedback archive path redacts consistently.

**Architecture:** shared provides I/O-free feedback text redaction; the services feedback domain is the
single owner of diagnostic archive collection, filtering, redaction, ZIP and cleanup; desktop injects extra
diagnostic log sources; UI only shows the draft and submit choices. The existing ticket/attachment protocol
and background-job owner are unchanged.

## Scope and decisions

Repository snapshots, automatic telemetry, model requests and the remote-control protocol are not modified.
The changed layers are draft-default, validation, commit-effect and presentation. Client privacy work does
not replace server retention, access authorization, deletion mechanisms or legal confirmation.

- New feedback logs are on by default and cancelable. Help, task, error and remote-connection entries behave
  the same; an explicit cancel and a restored draft's `false` are never overwritten. Resuming the same
  background job keeps the choice made at submit time.
- No automatic screenshot when feedback opens. File picking, paste, drag, preview and delete remain; the
  user inspects image content, and the copy says so.
- The upload archive accepts only same-day text logs from app `logs/`, desktop CLI `log/` and CUA
  `*.exit.log`. Databases, config, rollout, session bodies, binaries and symlinks are excluded. The fallback
  implementation follows the same policy and omits missing sources.
- Limits: 8 MiB per file, 32 MiB total input for a full package, 2 MiB for compact. Over-limit files are
  skipped, never truncated (no half structures leaked). Traversal depth and count are bounded.
- Structured logs recursively drop secrets and body/message/tool input-output fields. Text redaction covers
  common credentials, private keys, URL credentials and user home directories. Unsupported encodings,
  binary and unreadable files are skipped; the raw file is never copied as a fallback.
- The auto-troubleshooting template is redacted first; the hidden appended model-config list is removed.
  User body and contact fields keep user intent; the server adds one protection pass for common
  credentials in title/description before sending and does not alter user-supplied contact details.
- Local manual "export logs" keeps its contract and is no longer the full source for feedback upload.

## Impact brief

| UI entry                                                                   | Draft owner / default                                                                    | Submit / authority owner                                       | Mode and invariants                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Help menu, task menu, chat/subscription errors, remote-connection failures | feedbackStore -> FeedbackSubmitForm; logs true (cancelable), images empty                | feedbackSubmissionJob -> feedbackService -> FeedbackHttpClient | desktop uses the local service; mobile stays unsupported |
| New feedback / feature request                                             | Separate drafts: new feedback defaults logs on; standalone feature request attaches none | same                                                           | User can edit the description and inspect attachments    |
| Background job resume                                                      | `job.formDraft` snapshot at submit                                                       | job registry, located by jobId                                 | Does not affect other jobs; no re-capture of screenshots |
| Supplement a ticket                                                        | User-picked attachments and text                                                         | feedbackService                                                | No new automatic collection                              |
| Local export logs                                                          | User-explicit export                                                                     | desktop exportLogs                                             | Not affected by the feedback source allowlist            |

Chain: UI default / no auto screenshot -> `job.includeLogs` -> `prepareCompactLogArchive` -> desktop
injection / services fallback -> ZIP -> `uploadFile`; auto context -> create/comment HTTP. State owners keep
the existing layering, with no new queue. Login token / deviceMid are used for existing authentication and
never written into log archives. The feature graph has no dedicated node for feedback upload
(graph-drift-candidate); registering that upload boundary is a follow-up.

## Acceptance matrix and E2E handoff

| Case ID    | State / action                                                               | Assertions                                                                                                     | Evidence                       |
| ---------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| FB-PRIV-01 | New feedback, every entry                                                    | Logs default on and cancelable; no automatic capture call                                                      | UI test + E2E                  |
| FB-PRIV-02 | Default submit / submit after cancel / resume background job                 | Only attachments chosen this time are uploaded; resume keeps the original choice                               | job/UI test + service-mock E2E |
| FB-PRIV-03 | full / compact / desktop archives                                            | SQLite, config, rollout, symlinks, binaries, expired / oversized files are absent                              | temp dir + ZIP extraction      |
| FB-PRIV-04 | Nested JSON / escaped strings / multi-line private key / Authorization / URL | Synthetic secrets appear in no ZIP entry                                                                       | shared + ZIP regression        |
| FB-PRIV-05 | Diagnostics containing prompt/messages/tool data                             | Bodies removed; event types / error codes / counts remain usable                                               | text redaction tests           |
| FB-PRIV-06 | Ticket create and supplement                                                 | Common credentials in title/description are cleaned; user contact and explicit body intent kept; no model list | service/UI mock HTTP           |
| FB-PRIV-07 | Local export / cancel / failure                                              | Manual export compatible; archive failure cleans up; cancelled create triggers no attachment                   | existing regressions           |
| FB-PRIV-08 | Desktop/mobile, zh/en                                                        | Switch meaning and hints consistent, accessible on narrow screens; mobile unsupported unchanged                | shared UI + E2E                |

Main dimensions: source desktop/fallback; logs default-on/off/restored; file text/binary/link/expired/
oversized; authorization new/background resume; language/viewport. Pruned: repository snapshot and telemetry
(excluded by instruction); no model-provider cross product (the policy is provider-independent); automatic
pixel recognition of screenshots is out of scope and handled by explicit selection plus preview hints. E2E
uses a local mock service and temp log directories, never real accounts/tickets; new cases stay
`manual-review/pending` and are not auto-promoted.

FB-PRIV-02: mount the real `FeedbackSubmitForm`, submit helper and background job in an isolated Chromium
window, replacing only `IFeedbackService` with an in-memory mock. Default submit must call archive and log
upload; submit after cancel must make zero archive/upload calls; after a real job creation failure, unmount
and resume by jobId, and a second submit keeps the original true/false. Zero calls are confirmed from the
job terminal state, not a short timeout. This verifies the Renderer-to-service boundary only, not real
HTTP/OSS or mobile remote control.

E2E file: `packages/desktop/test/e2e/feedback/manual-review/pending/feedback-upload-privacy.test.ts`
covers FB-PRIV-01/02/08. FB-PRIV-01/08 open the form from the real help menu, check logs on by default,
user can cancel, no automatic image, and repeat at wide and narrow windows in zh and en. It reuses the help
client/config local fixture and creates no real ticket or model request. Mobile remote ticket upload stays
unsupported; the narrow viewport is only responsive-UI evidence.

## Known limitations and external confirmation

- Server ticket/OSS retention, deletion, access audit and cross-region storage are not verifiable in this
  repository and are not replaced by the client behavior or any privacy approval.
- Automatic redaction cannot recognize arbitrary business secrets; users who pick images must still check
  them.
- Mobile remote-control ticket upload remains the existing unsupported state; no mobile upload validation
  is claimed.
