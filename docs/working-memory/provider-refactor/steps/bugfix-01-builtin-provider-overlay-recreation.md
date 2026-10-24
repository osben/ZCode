# Bugfix 01: Built-in Provider Personal Overlay Cannot Be Re-Added After Deletion

> Status: Completed
>
> Date: 2026-08-27
>
> Source: runtime reproduction in release ZCode 3.9.2 Provider Settings
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-01-builtin-provider-overlay-recreation.md`

## 1. Problem

Deleting a normal Built-in Provider correctly removes its Personal Overlay and returns it to the "Add provider"
candidates, but adding it again in the same Host process failed:

```text
provider-settings.addBuiltinProvider FAIL
Provider deepseek 已删除或重命名
```

`ProviderSettingsFacade` wrote the Provider ID into an in-process `retiredProviderIds` set when a delete started
and kept it forever. The set came from the old rename/delete race design; Provider IDs are now read-only and
normal Built-in Providers must be creatable and deletable repeatedly under a stable ID, so the set was a second,
wrong existence fact outside Config.

## 2. Target Boundary

```text
ZCode Built-in Provider Config
        |
        +-- no Personal Overlay --------> "Add provider" candidate
        +-- addBuiltinProvider() -------> creates { enabled: true } Overlay
        +-- savePersonalProvider() -----> updates an existing Overlay only
        `-- deletePersonalProvider() ---> deletes Overlay, becomes a candidate again
```

1. `standard-builtin` Personal Overlays are created only by `addBuiltinProvider()`; `standard-personal` only by
   `createPersonalProvider()`. `savePersonalProvider()` is update-only for both.
2. `zai-family` / `bigmodel-family` are fixed Family areas with no "Add" entry; first account or API Key setup may
   create the Personal Overlay.
3. The Facade only serializes operations per Provider. It keeps no retired identity across revisions or Overlay
   lifecycles.
4. A save in flight before a delete finishes first, then the delete runs. A late save after deletion is rejected by
   the Repository because the Overlay does not exist.
5. An explicit re-add is a new valid config operation unaffected by the earlier delete.
6. Personal Repository stays the sole authority for Overlay existence (atomic update, `providerOrder`, dedicated
   Rule deletion unchanged). Desktop, Web and Remote Workspace all go through the target Environment Host's same
   Settings Facade/Config Service; no Renderer fallback.

## 3. Acceptance Cases

| Case    | Setup                                  | Action                    | Assertions                          |
| ------- | -------------------------------------- | ------------------------- | ----------------------------------- |
| BF01-01 | Built-in DeepSeek has no Overlay       | Add                       | Creates `{ enabled: true }` Overlay |
| BF01-02 | Built-in DeepSeek added                | Delete, then add again    | Becomes candidate; re-add succeeds  |
| BF01-03 | Built-in Overlay deleted               | Late normal save          | Save fails; Overlay not resurrected |
| BF01-04 | Personal-only Provider deleted/missing | Normal save               | Save fails; must go through create  |
| BF01-05 | Family Provider has no Overlay         | First API Key/account save | Sparse Overlay allowed             |
| BF01-06 | Save in flight for same Provider       | Delete                    | Save completes, then delete; no Overlay |

No new E2E: the gap was in the pure Provider domain and Facade lifecycle; unit tests cover the Config/Facade
boundary and the existing Provider Settings E2E covers page entry.

## 4. Outcome

- `retiredProviderIds` and the "已删除或重命名" message are gone from production code; per-Provider mutation queue
  unchanged.
- Normal Built-in/Personal-only saves are update-only; Family first-save sparse Overlay is preserved.
- Unit tests cover re-add after delete, late save, explicit Personal-only create, Family first save and
  save/delete ordering (625 targeted tests passed at the time; root `typecheck` and `lint` passed).
