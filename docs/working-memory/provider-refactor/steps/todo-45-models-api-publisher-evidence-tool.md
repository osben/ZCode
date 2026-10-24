# Todo 45: Models API Publisher Evidence Tool

> Status: Pending; real catalog calibration blocked by access credentials
>
> Date: 2026-08-28
>
> Source: Built-in model fact review after Todo 41/43

## 0. Task Positioning

A pre-release evidence tool for Built-in Provider Config maintainers. Using the `Endpoint + API Schema` of the formal
Provider config plus access material supplied at execution time, it calls the vendor Models API and produces a diff
report between the models visible to the current access material and `builtinModelIds`.

```text
ZCode Built-in Provider Config (Endpoint + API Schema + builtinModelIds)
  -> Publisher Models API Inspector (+ execution-time access material)
  -> live model catalog / recorded Fixture -> structured diff report -> publisher manual review -> edit Built-in Config
```

It is a publisher maintenance tool, not client Runtime, Registry, Config Source or a fourth Config Overlay. By
default it only reports and must never rewrite `zcode-builtin.json` automatically.

## 1. Placement and boundary

Reusable implementation lives in `packages/provider-node/src/publisher/model-discovery/` (it may reuse the formal
Built-in Release Parser, Provider Schema and Node networking but must not be exported from the
`@zcode/provider-node` public root, so the app runtime never depends on publisher tooling). A thin command entry in
`scripts/provider/inspect-builtin-models.mjs` handles arguments, access material input and report output; protocol
requests, response parsing and diff computation are testable implementation. The command name expresses "collect and
inspect evidence", not a generic `validate`:

```bash
pnpm provider:inspect-models --provider minimax
```

## 2. Evidence modes

- `live`: real access material calls the Models API, producing evidence stamped with time, Endpoint, Schema and
  Provider identity.
- `fixture`: reads sanitized, reviewed response fixtures to verify protocol parsing and the diff algorithm.
- `static`: checks Built-in members, Rule parsing and other static facts through the formal Parser with no network.

Reports label the evidence level explicitly; documentation examples, Fixtures and live responses are never mixed as
one kind of "verified".

## 3. Credentials and security

Most vendor Models APIs need an API key, OAuth token or account access material; without it you usually get only
`401/403`, which does not prove the model set visible to the Endpoint. Access material is injected only at execution
time: preferably from environment variables or stdin; never written to Built-in Config, Fixtures, diff reports or
Git; never passed as a plain command-line argument (shell history, process list); reports record only credential type
and an irreversible identifier. A vendor's OpenAI-compatible and Anthropic-compatible Endpoints are requested and
recorded separately, never extrapolated from one another. Start/Individual/Team account-specific members stay
governed by Account product interfaces and the Account Overlay; the generic Models API does not replace account
entitlement interfaces. When a vendor has no Models API, the Endpoint does not support catalog queries or the access
material lacks permission, the report returns explicit `unsupported`, `unauthorized` or `unavailable` and never
guesses a catalog.

## 4. Current blocker

Blocked is "calibrating Built-in Config against live interfaces", not the offline tool code: no usable access
material for the Built-in vendors in the working environment; Models API returns the catalog visible to the current
access material (accounts, regions and plans differ, anonymous requests cannot substitute); vendors' Models paths,
auth and capability fields are not uniform, so each protocol must be adapted and confirmed with real responses;
OpenAI-compatible responses usually prove only model identity, not context, output limit or multimodality; and no
automatic edit of the release config is allowed before live evidence and manual review. So the current Built-in
revision is a "vendor docs and product facts calibrated" version and cannot claim live Models API calibration for all
vendors. Unblocking needs the maintainer to provide test access material for target vendors, or sanitized real
responses collected in a trusted environment.

## 5. Scope

Unified discovery result, evidence metadata and error classification; OpenAI-compatible and Anthropic-compatible
Models API adapters; read Provider, Endpoint, Schema and `builtinModelIds` from the formal Built-in Release; report
added, missing, common, case-different and duplicate members; JSON and Markdown output; Fixtures sanitized with
source Endpoint, Schema, collection time and evidence state; one Provider failing does not swallow other Providers'
reports but the process exits non-zero for incomplete runs; no entry into app startup, Registry refresh, model
selection or ordinary model requests; no automatic Config writes and no mapping of unknown interface capabilities
into Model Rules.

## 6. Tests and completion

- Fixtures cover OpenAI-compatible, Anthropic-compatible, unauthorized, unsupported, malformed responses and
  pagination.
- The real Domain Parser reads the Built-in Release (no copied Provider/Model Schema).
- Reports never contain the input secret.
- Catalog diffs compare only by Provider identity, Endpoint and Schema, never merging across Providers.
- At least one OpenAI-compatible and one Anthropic-compatible Endpoint have real sanitized evidence.
- Reports generated and manually reviewed for all Built-in Providers that have a Models API and supplied access
  material; Providers without access material or Models API keep an explicit evidence gap, not a fake pass.
- Related unit tests, `pnpm typecheck`, `pnpm lint`; Conventional Commit.

## 7. Relation to the historical publish gate

This Todo only collects live model catalog evidence and diff reports. The abandoned
[Todo 19](./todo-19-zcode-builtin-release-integrity-validation.md) discussed a larger Built-in Release business
integrity publish gate (publish ownership, static integrity, mis-publish/rollback, CI admission, minimal client
defense). If a publish gate is re-established, Todo 45's report can be an evidence input, but Todo 45 itself does
not become a mandatory publish gate.
