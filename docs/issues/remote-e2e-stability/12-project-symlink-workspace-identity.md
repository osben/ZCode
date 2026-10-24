# Remote project created from a symlink does not converge to the realpath identity

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test build. Batch
`r3-server-20261011105317614-4a6780`, case `sourcelines`.

## Reproduction

1. On one SSH Source create a real directory A and a symlink to A.
2. Create a remote project for A, then a draft from it: canonical workspace attachment.
3. Create another project for the symlink, then a draft from it.
4. Wait for the execution identity to converge to A. It still fails after 60 s.

The Host logged `bound remote workspace context` with path `/home/dev/r3-workspace-link`
(sessionId `5fd8a173-9662-4a51-8970-602e7b97a241`); Main/Renderer then used
`remote:server:<same Source ID>:/home/dev/r3-workspace-link`. In the failure snapshot the active
identity/path is still the link, while A's tab stays `remote:server:<same Source ID>:/home/dev/r3-workspace-a`
(sessionId `569d26f6-a878-4c6e-998e-733fa916ce0e`).

```text
project A root = realpath → workspace A / attachment 1
project B root = symlink  → workspace link / attachment 2
expected: projects may differ; the execution workspace converges via remote realpath to the same A
```

## Contract and impact

[R3 identity contract](../../architecture/r3-source-server-remote-architecture.md) §3.2 requires a remote
realpath before opening a workspace so symlink aliases do not create two identities.
[Current project contract](../../superpowers/specs/2026-10-10-session-manage-upstream-integration.md) allows
several projects to share a directory, so the old "no second project" assertion was migrated; several
projects sharing a directory does not permit several execution identities for one real directory.

The symptom is confirmed from the Host binding log and the Renderer snapshot. It affects attachment reuse
and task run-context ownership. The call site that misses realpath is still to be located; product code is
unchanged and the expected path was not changed to the symlink. The test helper gained a strict project
identity readiness check that still needs same-baseline revalidation; static checks do not count as E2E pass.

Evidence: `packages/desktop/.e2e-artifacts/r3-server-20261011105317614-4a6780-sourcelines/` and the run log in
the same batch's `r3-server/run-logs/`.
