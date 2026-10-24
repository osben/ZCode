# SQLite Concurrent Agent Startup Design

## Background

Local and remote workspaces each start an independent Agent process; Agents under the same system user share `~/.zcode/cli/db/db.sqlite`. Window-scoped SSH host pooling lets multiple workspaces on one SSH host start Agents in parallel after the host is ready, so database initialization must tolerate multiple processes entering at once. On 2026-07-15, two remote workspaces starting simultaneously on `mac-studio` both entered SQLite migration; one threw `database is locked` in the migration prelude and exited, and the app saw only `ZCode agent transport closed` — the sibling workspace appeared to never reconnect. The legacy `migration-runner` set `pragma journal_mode = wal` before `pragma busy_timeout = 5000`, and the `schema_migration` table creation sat outside the migration transaction, so the first lock-needing operation had no wait or serialization protection.

## Behavior contract

1. Local and remote Agents use one session-store startup entry and one concurrency semantic — no workspace-type branches.
2. When multiple Agents open the same session DB, SQLite is the sole authority for initialization ordering; UI, Host, and SSH reconnect layers never serialize database migration.
3. The database connection has a finite busy timeout from open, not set after the first locking operation.
4. WAL journal-mode initialization retries only `SQLITE_BUSY` from external writer contention, finitely; `SQLITE_LOCKED` fails immediately (no waiting on same-connection conflicts). Already-WAL never re-executes the journal-mode write.
5. `schema_migration` table creation, checksum verification, pending migrations, and migration record writes live in one `BEGIN IMMEDIATE` transaction. The second process, after acquiring the write lock, re-checks migration state and never re-applies committed migrations.
6. Exceeding the lock wait closes the database and returns a structured `lock_timeout`; non-lock errors (checksum mismatch, SQL errors, open failure) are never retried or degraded.
7. After migration, the SessionStorePort, database path, session data model, and read/write APIs are unchanged; local workspace startup, history read/write, and session recovery flows keep their order.
8. The `:memory:` store keeps SQLite's native `memory` journal mode; it is not cross-process, never forced to WAL, and existing local test/injection paths keep working.

## Startup sequence

```text
Agent A                                  Agent B
   |                                        |
   +-- open DB (busy timeout active)        +-- open DB (busy timeout active)
   +-- ensure WAL --------------------------+-- ensure WAL / observe WAL
   +-- BEGIN IMMEDIATE (lock owner)          +-- BEGIN IMMEDIATE (wait)
   +-- create migration table               |
   +-- verify/apply migrations              |
   +-- COMMIT ------------------------------+-- acquire lock
                                            +-- verify migrations (no-op)
                                            +-- COMMIT
   +-- startup continues                    +-- startup continues
```

## Non-goals

- No serial reconnect for workspaces on one SSH host.
- No per-workspace session DB split.
- No migration lock held in UI, desktop main, Host, or relay.
- No indiscriminate retry of every Agent startup failure.

## Regression verification

1. Two real Agent processes opening the same fresh DB concurrently both complete migration; final migration ids are unique and complete.
2. While one Agent holds the migration lock, the other waits and succeeds after the first commits instead of throwing `database is locked` immediately; concurrency tests need repeated runs to widen the race window.
3. A lock held past the deadline returns `SqliteSessionMigrationError(kind=lock_timeout)`.
4. Checksum mismatch still returns `checksum_mismatch` immediately — never swallowed by lock retry.
5. All existing session-store unit tests pass, proving no behavior regression in the shared local create/read/write/recovery paths.
6. The `:memory:` store completes all migrations, verifying the existing local bootstrap injection path.

## Large-database startup supplement (2026-09-14)

CLI/TUI and Protocol startup use an async entry; the WAL and BEGIN external-lock waits share a 60-minute budget, with 25 ms per native busy and 10–200 ms async backoff. The synchronous constructor keeps the legacy 5-second compatibility entry; after async migration, the business connection restores the 5-second policy. Long SQLite SQL still runs synchronously, but each stage's control frame flushes first, so Host/UI can keep showing status thanks to process isolation.

Migrations/ledgers stay inside one IMMEDIATE transaction; ready is sent only after a successful COMMIT. Historical SQL/ids/checksums are unchanged; the whitelist-equivalence executor applies only to unrecorded items. Full design, errors, and verification boundaries: `docs/desktop/database-migration-startup-gate-plan.md` and Todo 144. Host tasks-index initialization is not part of this loading.
