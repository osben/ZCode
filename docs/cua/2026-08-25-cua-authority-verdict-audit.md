# CUA Authority Verdict Deduplication Audit

Status: implementation contract.

## Target

Audit the whole official CUA verdict chain from producer identity/foreground verification to consumer media projection. Delete duplicate state that overwrites an authoritative result with a weaker mirror, downgrades a concrete conflict to success, or has no reader; keep TOCTOU rechecks across async boundaries and the independent invariants carried by different layers.

## Principles

```text
Same fact, same moment
  authoritative source has given a conclusion
    └─ cache / mirror / weaker source must not re-veto or re-allow

Across await / native dispatch / hook / provider projection
  system state may have changed
    └─ the new-moment recheck stays (TOCTOU gate)

Different invariants
  identity / focus / raster bytes / adjacency / budget
    └─ each stays; they must not be merged just because they all "fail a check"
```

This round's authority map:

```text
producer direct applicationInfo(pid)
  ├─ exact result ───────────────> PID identity authority
  ├─ absent/error ───────────────> exact listApplications(pid) availability fallback
  └─ concrete conflicting PID ──> fail closed (the list must not whitewash it)

producer activateAppFrameSurface
  ├─ LiveFrontmostPid + exact focus ──> activation transaction authority
  └─ later captureApp exact surface ──> later TOCTOU identity/focus check (kept)

consumer official MCP authority
  └─ modelContentProtection=official_cua_frame_v1 ──> the only Host protection switch

consumer provider projection
  image immediately followed by image_ref ──> one deliverable coordinate pair
  orphan image_ref / unrelated image ───────> whole result unavailable
```

## Accepted cases and pruning

| ID | Input | Expected | Evidence |
| --- | --- | --- | --- |
| CUA-AUTH-01 | direct PID lookup returns a concretely different PID while the list contains the requested PID | Reject immediately; no launch, no activate | producer unit |
| CUA-AUTH-02 | direct PID lookup missing or transiently throws, list has a unique requested PID | Exact PID fallback allowed | producer unit |
| CUA-AUTH-03 | native surface activation already proved WindowServer foreground, but the app-list active mirror then lags | Does not override native success | producer unit + live macOS |
| CUA-AUTH-04 | native success lacks/mismatches foreground PID | fail closed | producer unit |
| CUA-AUTH-05 | exact surface replaced or unfocused after activation | later TOCTOU gate fails closed | producer unit |
| CUA-MEDIA-01 | deliverable image directly adjacent to image_ref | Atomic pair and order kept | adapter unit |
| CUA-MEDIA-02 | blank/any block between image and image_ref | Whole result errors; frame_id not exposed | adapter unit |
| CUA-MEDIA-03 | result has an unrelated deliverable image plus an orphan image_ref | The unrelated image cannot authorize the orphan; whole result errors | adapter unit |
| CUA-HOST-01 | authority-verified official CUA registration | Sets only `modelContentProtection`; no parallel preserve flag | core unit + typecheck |

Pruning conclusions:

- No new conversation session state combinations; the change does not touch desktop continuous, mobile replayable, owner/lease, queue or workspace identity.
- The Windows/Linux activation live postcondition is a separate platform fact and is not derived from the macOS native surface authority; this round only ran static/unit regression and does not claim those live platforms pass.
- The executor's final attestation after hooks, the frontmost recheck before/between global keyboard dispatches and the exact surface capture after activation all span mutable moments and are explicitly kept.
- The media bridge's inbound integrity and the adapter's provider deliverability are different invariants and are kept; the adapter only tightens "every reference must be directly adjacent to its own raster", without guessing authority by tool name.

## Acceptance

- Make the negative cases above fail on the old implementation first, then do the minimal fix.
- producer/consumer targeted tests all green.
- producer full tests; consumer typecheck, lint and affected unit tests all green.
- Real macOS model covers at least one observation, file panel activation/upload and subsequent input.
- The MR stays Draft until the audit is done; after completion re-run review/gate and restore Ready.
