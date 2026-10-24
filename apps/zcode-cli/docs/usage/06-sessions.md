# 06 · Sessions

## Create and resume

An ordinary `--prompt` creates a new session by default. A successful JSON output contains `sessionId`; to resume, save it and pass it back explicitly:

```sh
zcode --prompt "继续检查上一步的文件" --resume sess_example --cwd /absolute/path/to/task --mode yolo --json
```

(The sample prompt asks to continue checking the files from the previous step.) Keep the same data directory and effective working directory. `--continue`/`-c` selects the most recent session of the current directory and is mutually exclusive with `--resume`; concurrent tasks must not rely on "most recent" to associate results.

```text
首次 prompt → 新 session → 保存 sessionId 与运行记录
后续 prompt + resume → 加载历史 → 新 turn → 保存本次运行记录
```

(First prompt: new session, save the sessionId and the run record. Later prompt + resume: load history, new turn, save this run record.)

Resuming does not mean workspace files, external services and plugin state automatically return to the historical moment. For exact reproduction, save the repository commit, file snapshots and the task environment separately. Record `traceId` and `turnId` as output each time; do not assume that all identifiers stay unchanged after a cross-process resume.

## Targets and workflows

`--target "<objective>"` is mutually exclusive with `--prompt`; to replace an existing target, use `--target-replace` explicitly. It is not an equivalent way to "run an ordinary prompt once". Evaluations usually use an ordinary prompt; when a target or workflow must keep advancing, set a separate termination condition and save its events.

The workflow modes in the current source are `disabled`, `onDemand` and `alwaysOn`, default disabled. Different modes change the tools visible to the model and the run process; do not mix them within one comparison experiment.

## Persistence and usage

The default CLI session database is at `~/.zcode/cli/db/db.sqlite` and can be redirected through configuration or environment variables. The database structure is an implementation detail; do not treat SQL table structures from old manuals as a stable API, and never delete or modify rows directly to "reset a task".

To analyze the database, use a read-only connection; back up an active SQLite database with the SQLite backup API, or stop the related processes first and handle the WAL files. Copying only the main file can miss records not yet checkpointed.

The `usage` in JSON reflects the usage statistics provided with this output. Providers report cache and reasoning tokens differently, and a missing value is not zero. Do not infer from one result the whole session, background tasks or the account bill.

TUI slash commands are dispatched differently from headless. For automation, switch sessions with `--resume` and models with the [configuration file](03-config.md); do not assume that every TUI slash command put into `--prompt` will run.
