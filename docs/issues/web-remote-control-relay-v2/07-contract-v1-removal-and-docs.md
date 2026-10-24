# 07 — Wrap-up: remove the V1 contract and old Docker build chains, align docs and acceptance

**What to build:** With both ends on V2 only, do the contract phase: delete the V1 relay contract in shared and
the QR `hash`/`t` support; delete the three old `/remote`, `/remote/v3`, `/remote/v4` Docker build chains and
references to the migrated infrastructure; bring the architecture and static-deployment docs to the final
behavior; mark the superseded old design; and run the complete real-device acceptance matrix in the test
environment. Afterwards the repo has no V1 code path and no script that could ship the V2 page to the old
single deployment.

**Blocked by:** 03, 04, 05, 06

**Status:** in-progress

**Parent:** [Web remote control on Relay V2: phone logs in, then connects to the desktop](./01-relay-v2-login-pairing.md)

## Acceptance criteria

- [x] shared deletes V1 relay message types, the V1 parse branch, proof test vectors, QR `hash`/`t` build and
      parse support and V1 heartbeat constants; no reference remains in either end or in tests.
- [ ] Delete the Dockerfiles, nginx configs, build/push/verify scripts and package.json commands of `/remote`,
      `/remote/v3`, `/remote/v4`; helper scripts used only by these Docker chains go too, those reused by the OSS
      pipeline or `/remote/__test__` stay. The `/remote/__test__` chain and the OSS pipeline keep working.
- [x] Delete references in scripts and docs to the old infrastructure repo, its path environment variables and
      old Deployment files.
- [x] Docs closed out: the architecture doc drops V1 and Docker deployment sections and its "static deployment"
      section describes only the OSS multi-version chain, noting the old Docker deployment is frozen at the last V1
      image; `remote-v4-static-deployment.md` drops the Docker/Jenkins sections; the top of
      `docs/superpowers/specs/2026-04-28-web-remote-login-design.md` marks it superseded by this spec;
      `relay-v2-pairing.md` gains known limitations (old link to a new desktop stalls at the waiting page, offline
      devices have no `meta`, `KICKED` semantic compromise) and the external-dependency table.
- [ ] Execute the full test-environment real-device matrix and record it in `relay-v2-pairing.md`: first scan
      with login, logged-in direct connect, no-code device selection, account mismatch and switching, takeover by
      another phone (this phone stops reconnecting and says so), phone disconnect after desktop logout and recovery
      after login, automatic `KICKED` recovery after relay rolling restarts.
- [ ] All doc link, command and reference consistency checks pass; `pnpm typecheck`, `pnpm lint`,
      `pnpm architecture:check --changed`, affected unit tests and `pnpm verify:pre-push` pass.

## Implementation record (2026-09-19)

- V1 relay types, proof vectors, QR overloads and heartbeat constants are deleted. The QR default parses V2 and
  rejects old credential parameters; the shared payload serializer's default timestamp is unified to Unix
  seconds.
- The three old single-directory Docker build/push/verify entries and their npm commands are removed. OSS
  tooling is kept; the standalone test publish script only builds and pushes an image, with the old
  infrastructure-repo update/MR logic deleted.
- Building the test Dockerfile revealed missing patches; patches, provider, public and Git install tools were
  added and the regression passes. A second build failed on authentication for the private CUA Git dependency,
  so the Docker smoke is incomplete and full availability is not checked off.
- Architecture, static-deployment and login docs match the final behavior; historical deployment steps are
  archived with a link to the current entry. The real-device matrix and external dependencies are in
  [Relay V2](../../web-remote-control/relay-v2-pairing.md#测试环境真机验收矩阵07); all real-device scenarios are
  still to be run.
- Full verification results are in the same doc's 07 verification record. Required verification is incomplete,
  so the status stays `in-progress`; per repo rules the workspace changes are kept and not auto-committed.
