# Subsequent Task: Host tasks-index Initialization Observability

> Latest scope: merged into [Todo 145: Unified Database Preparation Before Entering ZCode](./todo-145-global-database-startup-loading.md); it is no longer delayed separately. The items below record the earlier round's scope; the Repo construction and the actual open/migration timing must be re-checked against the new TODO.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/host-tasks-index-startup-followup.md`

Status: pending separate design; not part of the Todo 144 session-library hotfix (decided 2026-09-14: finish the session
library scope first).

Problem: the Host's partial Repo synchronously opens or migrates `tasks-index.sqlite` before the service is released,
when the session library status service is not yet available. The status provider, database execution thread,
dependency-service admission order, background scheduler/bot startup and failure retry boundary must be designed before
implementation.

- [ ] Review the initialization and migration timing of AutomationRepo, OffPeakTaskRepo and TaskIndexRepo.
- [ ] Decide a migration Worker or delayed service initialization (Main keeps scheduling/passthrough duties).
- [ ] SQLite keeps a single migration coordinator for the same physical library (no extra Host migration lock).
- [ ] Observability is available before service release; business depending on the Repo opens only after the
      transaction commits.
- [ ] Verify multi-window, remote Host, mobile shared-host, crash/reconnection and failure recovery.

The session library and the task index are different files; their locks and completion states must not be mixed.
