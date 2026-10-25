# 08 · Skills and custom commands

A skill is a task description loaded on demand; it does not automatically add operating system permissions. Commands in a skill are still constrained by the current tools, permissions and runtime environment.

## Write a skill

Create `.agents/skills/greet/SKILL.md` in the project:

```markdown
---
name: greet
description: 用户要求问候时使用，用一句话问候。
---

请用一句话问候用户，并在末尾加上 READY。
```

(The sample skill: use when the user asks for a greeting; greet the user in one sentence and append READY.)

The current default discovery paths include the user and project `.zcode/skills` and `.agents/skills`. In a Git workspace, skill directories are searched up to the worktree root; a sibling `.zcode` takes precedence over `.agents`. Enabled plugins can also contribute skills. Duplicate names and the metadata budget affect the final visible set, so check the source with the listing:

```sh
zcode skills list --cwd /absolute/path/to/project --json
zcode commands list --cwd /absolute/path/to/project --json
```

`skills.roots` can add skill root directories. `features.skill`, `skills.enabled`, the plugin enabled state and per-item overrides in the runtime configuration all affect the result. After a change, verify with a new process; do not treat a SKILL.md on disk as loaded.

## Invocation and custom commands

An ordinary prompt can describe the task and let the model use a skill per its description; the explicit invocation format and whether a command exists are determined by `commands list`, `skills list` and the help of the build. `commands/hello.md` in a plugin can define a custom slash command:

```markdown
---
description: 简短问候
argument-hint: "[名字]"
---

请对 $ARGUMENTS 说一句问候。
```

(The sample command: short greeting; the argument hint is "[name]"; say one greeting to `$ARGUMENTS`.)

Once the plugin is loaded, run `zcode --prompt "/hello reader"`. A custom command expands into instructions that take part in the model call; do not confuse it with the output of locally returning commands such as `/help`.

Batch tasks should fix the skill version and the enabled list. For a no-skill control group, also check the user directory, project directory and plugin contributions, so the development machine environment does not contaminate results.
