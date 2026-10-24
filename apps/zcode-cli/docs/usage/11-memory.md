# 11 · Instructions and memory

`AGENTS.md` holds instructions provided by the user or project; Memory is what is stored and retrieved during runs. Both can affect the model input, but they are controlled differently.

## AGENTS.md

The current instruction assembly merges `~/.zcode/AGENTS.md` in the user directory with the project `AGENTS.md` found from the workspace, user first and project second. The workspace scope and the current effective directory affect what is found; do not assume the instruction files of every parent directory stack, and do not assume instruction file names of other products are imported automatically.

To verify that instructions entered the context, use a controlled non-sensitive marker or inspect the actual request; do not rely on the model claiming it "has read" them. Concurrent evaluations should use an isolated user directory and a fixed workspace, and record the content hashes of these two instruction files.

## Memory switches

The overall memory capability is controlled by `features.memory`, and use is also controlled by `memory.use`. For a no-memory control group, turn both off explicitly in the runtime configuration:

```json
{
  "features": { "memory": false },
  "memory": { "use": false }
}
```

An ordinary `--prompt` and `--target` do not enable automatic memory extraction by default; this does not mean existing memories are not read or do not influence the context. For isolation, also use a fresh user directory and data base directory.

## Memory experiments

```sh
zcode --prompt "执行本次记忆实验任务" --memory-bench --mode yolo --json
```

(The sample prompt means "run this memory experiment task".) `--memory-bench` is for prompt only and requires memory to be enabled first. It enables automatic extraction and waits for the extraction work to finish before returning the result. By default there is no fixed deadline for waiting on extraction; the experiment launcher should set its own run limit and record the cancellation state.

A successful main task does not guarantee successful extraction. Observe the main task result, the extraction diagnostics and the later recall separately. Design single-round results, cross-round learning and cross-task reuse as separate experiments, so memory from one sample is not carried into the next independent sample.

Do not edit the active session database directly to clean up memory. Prefer creating a new data directory for the experiment; when memory must be kept for a cross-round experiment, reuse it explicitly and record the reuse relationship.
