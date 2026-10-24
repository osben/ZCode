# 19 ZCode Built-in Release Integrity Publish Gate

> Status: abandoned (no longer a standalone Todo)
>
> Date: 2026-08-25
>
> Source: Todo 18 design review; the first remote-sync version explicitly excludes this gate.

> Update 2026-08-28: stage B later added static/integration proofs in
> `packages/provider-node/test/zcode-builtin-integrity.test.ts`: duplicate members in the real Built-in files, full
> Model Config parsing, Registry assembly after access material is filled in, and a ban on saving API keys.
> This does not make this Todo complete. The publish command, publish ownership, CI admission, mis-publish/rollback
> and a minimal client gate remain undecided. The file is kept as a historical discussion record and is not restored
> as an execution item; if a publish gate is ever needed, open a new Todo under the release process of that time.
> The live Models API catalog evidence tool is recorded separately in
> [`todo-45-models-api-publisher-evidence-tool.md`](./todo-45-models-api-publisher-evidence-tool.md).

## 0. Scope

Who proves the business integrity of ZCode Built-in Provider Config and Model Config Rules, and how the publish
pipeline, the shared validation implementation and the client runtime split that work.

Current decision: Todo 18 adds no client-only Built-in integrity validator and injects no fake API key, fake Account
`accessId` or fake Request Auth to simulate an executable Registry. The Todo 18 client only handles the Release
Envelope, `schemaVersion`, `revision` and compatible parsing by the existing Provider/Model Config parsers.

## 1. Open questions

- Must the publisher prove that all static Built-in Provider/Model facts are complete before generating a revision?
- How does the gate reuse the repository's formal Domain Parser so backend, CI and client do not keep three rule sets?
- How is static completeness of API, Account and Request Auth Providers separated from executability after
  account/credential injection?
- Is there a standalone `zcode-builtin validate` publish command or an equivalent CI entry?
- Who owns and audits validation failure, mis-publish and emergency rollback?
- Does the client need any minimal business safety gate beyond compatible parsing?

## 2. Boundary with Todo 18

Todo 18 keeps implementing:

- the two-layer Release Schema for Bundled, Remote and Environment Active Cache;
- revision selection, environment-level refresh debounce, atomic persistence and Source refresh;
- keeping the current Active Cache on unparsable payloads, unsupported schema, stale revision and disk failure.

Todo 18 does not implement:

- a new Built-in static integrity rule set;
- deciding from the current account or Personal Config whether a remote Release may be published;
- a publish service, publish audit or business-integrity CI.

This Todo is not in the execution sequence and does not block Todo 18 transport, cache and refresh.
