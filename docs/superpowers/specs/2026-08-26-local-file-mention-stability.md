# File Mention Stability and Host Search

> 2026-09-16: Composer `@` queries file candidates through the Host and no longer downloads the full file
> index.

## Scope and contract

- Only the query and index ownership of `@` file candidates move; the file tree and Command Center keep using
  the original chunked list interface.
- Reuse the current `.zcodeignore`, directory filtering, hidden file and symlink rules, and the existing fuzzy
  matching/ordering. The pure matching algorithm lives in shared, and the old UI entry keeps reusing the same
  algorithm.
- Add `IFileService.searchWorkspaceFiles({ rootPath, workspaceIdentity?, query, limit?, refresh? })`,
  returning `WorkspaceFileEntry[]`. Default/max 1000 entries; an empty query keeps the existing
  files-first ordering, and the Composer keeps its existing preview count.
- The interface goes only through the existing file RPC; the public RPC, attachment, Agent protocol and
  continuous/replayable recovery semantics are unchanged.

## State, cache and sequence

```text
Renderer (keyword, current query result, error state)
    -> file.searchWorkspaceFiles(query, limit, workspaceIdentity)
    -> Host of the workspace (the only owner of file scanning/indexing)
       -> .zcodeignore + 60s index cache + bounded candidate matching
    <- at most limit candidates

query / workspace / service / enabled changes
    -> old query result invalidated -> only the latest query may update the panel

loaded + non-empty query with no hit
    -> at most one refresh:true for this query -> Host bypasses the cache and rescans
error -> stop automatic requests -> only closing and reopening, or switching workspace or service, recovers
```

- The cache belongs to the file service instance, is isolated by `workspaceIdentity?.trim() || rootPath`, and
  validates rootPath and the `.zcodeignore` fingerprint. The index short TTL is 60s, consistent with the
  existing Host policy; scans for the same key are deduplicated; the cache has a size cap and drops expired
  entries.
- After a rule change the next query runs with the new rules; a refresh must not be swallowed by an old cache,
  and a finishing old scan must not overwrite a later scan.
- Closing the panel clears the Renderer query/error state; reopening requests the Host. The UI no longer holds
  the full candidate array or a file search Worker.
- The Host builds candidates and matches in batches, yielding the event loop between batches; query results are
  bounded by the count cap, and the input does not bear the transfer/decoding of a full index.
- Local and remote both use the file service of the current workspace; the same path with a different identity
  or service shares neither cache nor in-flight queries. Mobile reuses the same hook and RPC and builds no
  separate Host.

## Impact brief

| Item              | Conclusion                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Capability/layer  | Composer file reference; option-source, cache owner migration                                                                          |
| UI Surface Matrix | Desktop/mobile Composer `@` -> MentionPlugin -> useFileMentionProvider -> file service; input/display belong to the UI, the index to the Host, and the Markdown after selection is unchanged |
| Shared vs divergent | `.zcodeignore` and the matching algorithm are shared; the file tree/Command Center keep the full packed+Worker data path             |
| must-inspect      | file service interface, index owner, provider latest-result/error state, cross-workspace isolation                                     |
| invariant-only    | RPC protocol, the other mention groups, file tree/Command Center, desktop continuous / mobile replayable                               |
| State and commit  | Host in-memory index; bounded UI result; the canonical mention after selection and the send behavior are unchanged, no new persistence |
| Codegraph         | useFileMentionProvider -> MentionPlugin -> LexicalChatInput (depth 2); the service list interface code follows the fast-forwarded disk, and the index is being rebuilt |
| Graph drift/update | The existing @ surface lacks a file-index owner; add the Host search service node and options-from relation                          |
| Open questions    | None; this session confirmed only the @ search is adjusted, the public RPC is unchanged                                                |

## Acceptance and test plan

| Case  | Setup and action                                                  | Assertion/evidence                                                              |
| ----- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| MFH01 | Open @ in a large workspace, search, select; desktop and mobile width | The search interface returns a bounded result, no length/range calls; the file can be selected and input stays responsive; UI E2E |
| MFH02 | Query the same index with empty/name/path/Chinese/case/no hit     | Consistent with the existing fuzzy ordering; service + algorithm unit tests     |
| MFH03 | After a no-hit, create a file externally, then query/rescan       | refresh bypasses the cache; service and hook unit tests                         |
| MFH04 | Change keyword, identity, service or close the panel during a delayed response | A stale result must not overwrite; hook unit test                   |
| MFH05 | Type more text after a query error                                | No retry loop; close and reopen recovers; hook unit test                        |
| MFH06 | Change .zcodeignore; two services/identities with the same path   | The new rule takes effect, isolation holds; service unit test                   |
| MFH07 | Original file tree and Command Center interfaces                  | Chunked returns and shared matching stay compatible; existing unit tests        |

Confirmed boundary: keep the empty query, count, ordering, terminal failure state and miss-refresh; no new
persistent index, file watcher system or search UI. Theme and language do not change the semantics; the same UI
and canonical mention are used, and the focus is the query contract and desktop/mobile interaction. The new E2E
case stays manual-review/pending; promotion/CI admission follows the existing process and is not auto-promoted
here.
