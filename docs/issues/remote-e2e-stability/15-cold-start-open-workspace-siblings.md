# Cold start did not restore the other open remote workspace

Status: done

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test patch 07, batch
`r3-server-20261011125749338-152f05`. `mixed` failed after 407.4 s.

## Initial evidence

Before restart, `mixed-entries.json` showed workspaces A and B of one Source both online with different
identities, active A, persisted entries A/B. After the cold start only A had a navigation item; a 240 s wait
never saw A and B restored together. The new Main logged a single connect ready (matching A) and no new
ready/bound for B.

Same batch: `boundary` (last active B) saw only B reconnect and failed waiting 180 s for A, with the Profile
credential going from present to missing (see [issue 11](11-ssh-credential-missing-after-restart.md));
`rdux14` failed after 251.2 s (only B's lastOpenedAt set to 8 days back, but the run failed earlier waiting for
A, active still B, one connect ready, one `credential.delete`); `coldreconnect` stopped waiting for A after
cold start (291.1 s).

```text
before restart: A online + B online, persisted open set = {A, B}, active = A
cold restart:   old Main/Host exit → new Main/Host → A ready
afterwards:     B never restored (240 s observed); active still A
```

## Contract under test

The [Renderer recovery contract](../../remote/desktop-remote-session-renderer-reattach.md) restores, after the
Source is online, all open/disconnected/stable-identity projects of the window without dropping siblings by
age or last connection state, keeping the original focus. Source connected is not workspace restored.

## Re-verification after the credential fix

Batch `r3-server-20261012003650390-d1994e` (`bc61ed5cc9` plus issue 11's fix, restore logic unchanged):
`mixed` failed 404.6 s (only A online), `boundary` 326.6 s, `coldreconnect` 242.3 s, `project-order` 234.4 s,
`rdux14` 220.0 s; `recov` passed. Probes showed passwordRefs=1 / presentRefs=1 throughout, so credential
deletion no longer explained the failures.

## Root cause review: the "cold start drops siblings" classification is withdrawn

For `bc61ed5cc9` plus the issue 11 fix, the runtime settings logs of all five failures contain both the old
`lastWorkspaceSession` A/B projection and the new `lastActiveWorkspace` single active directory (A for
`mixed`, B for the rest). Actual cold-start restore matched the active selection.
`readPersistedWorkspaceSessionEntries` returns only the active directory when the new field exists; this is an
explicit requirement of the virtual-project spec F5 and must not be reverted to read the old list. Earlier
remote docs treated the old open-set contract as current, which produced the wrong classification and test
expectations.

A real-module probe with the same active selection plus old A+B projection (either A or B active) produced one
matching tab and no `deferredRestore`; together with adjacent legacy-import coverage 30 tests pass.
`project-order` is corrected separately: the old failure was at line 102 (after a manual `connectHost`,
waiting for an inactive A tab); restoring B at line 88 had completed. Per G3/F5, connecting a device only
refreshes saved project entries and creates no Renderer tab for an inactive directory, so the ordering case
must assert project online state and order retention.

```text
new active selection A + old A/B projection → reader returns A → A attachment ready (matches F5)
old test kept waiting for B to appear on its own → timeout → misclassified as a business failure
corrected acceptance: A auto-restores + A/B project entries kept → user opens B → B attachment/tasks usable
```

Resolution: only the five E2E cases and their acceptance docs were corrected and a unit test for the new
remote active-directory semantics was added; recovery business logic is unchanged. RDUX-14 now sets the
authoritative active B's lastOpenedAt to 20 days back instead of the old field that no longer participates in
recovery.

## Final verification

Batch `r3-server-20261012012923737-60d156` (business build from issue 11's verified fix; source manifest
SHA-256 `b7ef08e140b79ff69cda860e617b4f910fc6971e4b56f1780cf6d31bc82811c7`):

| Case          | Result        | Accepted behavior                                                                               |
| ------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| boundary      | PASS, 141.6 s | active B auto-restores, directory read after restart succeeds, password refs 1/1                |
| mixed         | PASS, 156.3 s | A auto-restores, project entries kept, B opened on demand, separate session, resume             |
| coldreconnect | PASS, 186.8 s | B auto-restores its session, A opened on demand, both resume, auto-reconnect off/manual restore |
| project-order | PASS, 142.8 s | drag, cold restart, disconnect/connect keep project order and online state                      |
| rdux14        | PASS, 132.4 s | authoritative active B set 20 days back still auto-restores, A on demand, one Host              |

Affected Vitest: 408 files / 4531 tests passed; Node scripts 34 passed; typecheck, lint (207 pre-existing
warnings), architecture, 5 fixtures, format and link checks pass. Product behavior was not relaxed and no
failure branch was removed. Issue 25's diagnostic case failed separately with the expected raw Worker
evidence and is not part of this acceptance.

Evidence: `packages/desktop/.e2e-artifacts/r3-server-20261011125749338-152f05-mixed/` (run log keeps old/new
process ready and bound records).
