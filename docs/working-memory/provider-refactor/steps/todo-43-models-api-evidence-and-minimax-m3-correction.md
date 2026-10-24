# Todo 43: Models API Evidence Boundary and MiniMax M3 Correction

> Status: Completed

## 1. Finding

A Provider Endpoint may offer a protocol-level Models API. It lists the models visible to the current `Endpoint + API
Schema + access material`, not to a Base URL detached from the account:

```text
Endpoint + API Schema + Access -> live Models API response
   ├─ Model ID membership evidence
   └─ capability metadata the interface explicitly provides
 -> publisher diff report and manual review -> Built-in Release
```

It never directly overrides runtime Config and forms no fourth Overlay layer (Design states the Models API is only
publish-time verification, a diff report, or user-initiated import evidence). A documentation example proves only the
interface shape, not a live response with current access material; capabilities the vendor does not return are still
proven by official docs and content-consumption tests.

## 2. MiniMax correction

Old research wrongly relied on an outdated interface overview and a Models API example and treated `MiniMax-M3` as a
candidate not proven by an official direct Endpoint. The current China-region official "model call" docs state: M3 is
the newest M-series model; 1,000,000 context, Text/Image/Video; China Anthropic Endpoint
`https://api.minimaxi.com/anthropic`; China OpenAI Endpoint `https://api.minimaxi.com/v1`; both compatible call
examples use `MiniMax-M3` directly.

So revision 4 puts M3 first in MiniMax `builtinModelIds`, default enabled. M2.7 and highspeed remain enabled as
speed/cost tiers; older M2.x stay disabled.

## 3. Acceptance (test first; revision 3 must fail)

Real Built-in integrity test: release revision is 4; the first three MiniMax members are M3, M2.7,
M2.7-highspeed; all three Exact Rules are `enabled=true`; M3 resolves on the current Anthropic Endpoint to 1M and
Text/Image/Video. Verify Provider/Provider Node directed tests and typecheck, root `pnpm typecheck`, `pnpm lint`,
format check and `git diff --check`.

## 4. Outcome

Built-in Config is revision 4 with MiniMax members M3, M2.7, M2.7-highspeed all default enabled; M3's existing 1M
and Text/Image/Video Model Rule is unchanged, with a new real-Config test pinning its Effective Model Config on the
China Anthropic Endpoint. The old research conclusion "M3 not proven on compatible Endpoint" was marked and
corrected; Todo 41 keeps the historical trail but is no longer the current basis. Provider Node 47 and Provider 151
tests, both packages' typecheck and root typecheck passed; root lint passed with 33 unrelated pre-existing warnings.
