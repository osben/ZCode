# Subsequent Task: The Host tasks-index Initialization Observability

> Latest scope: Merged into [Todo 145: Unified Database Preparation Before Entering ZCode](./todo-145-global-database-startup-loading.md); no longer delayed separately. The following is the scope record of the previous round; the Repo construction and the actual open/migration timing must be re-checked according to the new TODO.

Status: Pending separate design; not part of the Todo 144 this session library hotfix.

The 2026-09-14 user discussion on the change scale confirms to complete the session library scope first.
The Host's partial Repo synchronously opens or migrates the tasks-index.sqlite before the service release; at this time, the session library status service is not yet available.
The status provider, the database execution thread, the admission order of the dependency service, the startup of the background scheduler/bot, and the failure retry boundary must be designed first, and then implemented.

- [ ] Review the initialization and migration timing of the AutomationRepo, OffPeakTaskRepo, and TaskIndexRepo.
- [ ] Decide the migration Worker or the delayed service initialization plan; the Main maintains the scheduling/passthrough responsibility.
- [ ] The SQLite keeps the unique migration coordinator of the same physical library, avoiding the additional Host migration lock.
- [ ] The observability stage is available before the service release; the business depending on the Repo can only be opened after the transaction is committed.
- [ ] Verify the multi-window, remote Host, mobile shared-host, crash/reconnection, and failure recovery.

The session library and the task index are different files; the lock and the completion status of each cannot be mixed.
