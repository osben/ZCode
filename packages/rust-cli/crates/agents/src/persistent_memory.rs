//! Fork (rule 18, specs/fork-rust-subagent-runtime-config.md): a subagent's persistent memory (Node
//! `subagent/persistent-memory.ts` and `subagent/persistent-memory-prompt.ts`).

use std::path::{MAIN_SEPARATOR, Path, PathBuf};

use rust_cli_kernel_api::subagent_config::AgentMemoryScope;

use crate::definitions::AgentDefinition;

/// The tools a memory child gets on top of its `tools` list (Node `PERSISTENT_MEMORY_TOOLS`).
const MEMORY_TOOLS: [&str; 2] = ["Write", "Edit"];
/// The index file in the memory root (Node `MEMORY_INDEX_FILE_NAME`).
const INDEX_FILE: &str = "MEMORY.md";
/// The index text when there is no index yet (Node's baseline empty-index wording).
const EMPTY_INDEX: &str =
    "Your MEMORY.md is currently empty. When you save new memories, they will appear here.";

/// Node `PERSISTENT_AGENT_MEMORY_PROMPT_TEMPLATE` (core `subagent/persistent-memory-prompt.ts`), lines joined with `\n`.
const TEMPLATE_LINES: &[&str] = &[
    "# Persistent Agent Memory",
    "",
    "You have a persistent, file-based memory system at `<MEMORY_ROOT>/`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).",
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    "## Types of memory",
    "",
    "There are several discrete types of memory that you can store in your memory system:",
    "",
    "<types>",
    "<type>",
    "    <name>user</name>",
    "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
    "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
    "    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>",
    "    <examples>",
    "    user: I'm a data scientist investigating what logging we have in place",
    "    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]",
    "",
    "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
    "    assistant: [saves user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]",
    "    </examples>",
    "</type>",
    "<type>",
    "    <name>feedback</name>",
    "    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>",
    "    <when_to_save>Any time the user corrects your approach (\"no not that\", \"don't\", \"stop doing X\") OR confirms a non-obvious approach worked (\"yes exactly\", \"perfect, keep doing that\", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>",
    "    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>",
    "    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>",
    "    <examples>",
    "    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed",
    "    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]",
    "",
    "    user: stop summarizing what you just did at the end of every response, I can read the diff",
    "    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]",
    "",
    "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
    "    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]",
    "    </examples>",
    "</type>",
    "<type>",
    "    <name>project</name>",
    "    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>",
    "    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., \"Thursday\" → \"2026-03-05\"), so the memory remains interpretable after time passes.</when_to_save>",
    "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>",
    "    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>",
    "    <examples>",
    "    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch",
    "    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]",
    "",
    "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
    "    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]",
    "    </examples>",
    "</type>",
    "<type>",
    "    <name>reference</name>",
    "    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>",
    "    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>",
    "    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>",
    "    <examples>",
    "    user: check the Linear project \"INGEST\" if you want context on these tickets, that's where we track all pipeline bugs",
    "    assistant: [saves reference memory: pipeline bugs are tracked in Linear project \"INGEST\"]",
    "",
    "    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone",
    "    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]",
    "    </examples>",
    "</type>",
    "</types>",
    "",
    "## What NOT to save in memory",
    "",
    "- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
    "- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.",
    "- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
    "- Anything already documented in AGENTS.md files.",
    "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
    "",
    "These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.",
    "",
    "## How to save memories",
    "",
    "Saving a memory is a two-step process:",
    "",
    "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
    "",
    "```markdown",
    "---",
    "name: {{short-kebab-case-slug}}",
    "description: {{one-line summary — used to decide relevance in future conversations, so be specific}}",
    "metadata:",
    "  type: {{user, feedback, project, reference}}",
    "---",
    "",
    "{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].}}",
    "```",
    "",
    "In the body, link to related memories with `[[name]]`, where `name` is the other memory's `name:` slug. Link liberally — a `[[name]]` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.",
    "",
    "**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.",
    "",
    "- `MEMORY.md` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise",
    "- Keep the name, description, and type fields in memory files up-to-date with the content",
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
    "",
    "## When to access memories",
    "- When memories seem relevant, or the user references prior-conversation work.",
    "- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
    "- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.",
    "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.",
    "",
    "## Before recommending from memory",
    "",
    "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
    "",
    "- If the memory names a file path: check the file exists.",
    "- If the memory names a function or flag: grep for it.",
    "- If the user is about to act on your recommendation (not just asking about history), verify first.",
    "",
    "\"The memory says X exists\" is not the same as \"X exists now.\"",
    "",
    "A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.",
    "",
    "## Memory and other forms of persistence",
    "Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
    "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
    "- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
    "",
    "<SCOPE_GUIDANCE>",
];

/// The key of an agent's memory directory: every character outside `[a-zA-Z0-9_-]` becomes `-`; empty becomes `unknown`.
pub(crate) fn sanitize_key(agent_name: &str) -> String {
    let key: String = agent_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if key.is_empty() {
        "unknown".to_owned()
    } else {
        key
    }
}

/// The memory root of an agent in `scope` (Node `resolvePersistentAgentMemoryRoot`).
pub(crate) fn root(
    scope: AgentMemoryScope,
    storage_root: &Path,
    workspace: &Path,
    agent_name: &str,
) -> PathBuf {
    let key = sanitize_key(agent_name);
    match scope {
        AgentMemoryScope::User => storage_root.join("agent-memory").join(key),
        AgentMemoryScope::Project => workspace.join(".zcode").join("agent-memory").join(key),
        AgentMemoryScope::Local => workspace
            .join(".zcode")
            .join("agent-memory-local")
            .join(key),
    }
}

fn scope_guidance(scope: AgentMemoryScope) -> &'static str {
    match scope {
        AgentMemoryScope::User => {
            "- Since this memory is user-scope, keep learnings general since they apply across all projects"
        }
        AgentMemoryScope::Project => {
            "- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project"
        }
        AgentMemoryScope::Local => {
            "- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine"
        }
    }
}

/// The persistent-memory prompt with the index embedded (Node `buildPersistentAgentMemoryPrompt`). The index goes
/// through the memory crate's index formatter, which trims it and elides an over-long one.
pub(crate) fn prompt(index: &str, root: &Path, scope: AgentMemoryScope) -> String {
    let mut memory_root = root.display().to_string();
    if !memory_root.ends_with(MAIN_SEPARATOR) {
        memory_root.push(MAIN_SEPARATOR);
    }
    let index = rust_cli_memory::entrypoint::truncate(index);
    let index = if index.is_empty() {
        EMPTY_INDEX.to_owned()
    } else {
        index
    };
    let template = TEMPLATE_LINES
        .join("\n")
        .replace("<MEMORY_ROOT>/", &memory_root)
        .replace("<SCOPE_GUIDANCE>", scope_guidance(scope));
    format!("{template}\n\n## MEMORY.md\n\n{index}")
}

/// Adds the memory tools to a memory child's `tools` list (Node `withPersistentAgentMemoryTools`). A child with no list
/// already has every tool, and a child without a memory scope is unchanged.
pub(crate) fn project_memory_tools(definition: &mut AgentDefinition) {
    if definition.memory.is_none() {
        return;
    }
    let Some(tools) = definition.tools.as_mut() else {
        return;
    };
    // A wildcard list already names every tool, so it stays as it is.
    if tools.iter().any(|name| name == "*") {
        return;
    }
    for tool in MEMORY_TOOLS {
        if !tools.iter().any(|name| name == tool) {
            tools.push(tool.to_owned());
        }
    }
}

/// The memory root of a child run, created on first use, and its prompt. A root that cannot be created is logged and
/// the prompt is still built: the child then reads an empty index.
pub(crate) async fn load(
    scope: AgentMemoryScope,
    storage_root: &Path,
    workspace: &Path,
    agent_name: &str,
) -> String {
    let root = root(scope, storage_root, workspace, agent_name);
    if let Err(error) = rust_cli_fs::create_dir_all(&root).await {
        tracing::warn!(
            %error,
            root = %root.display(),
            "persistent agent memory root could not be created"
        );
    }
    // An unreadable or missing index reads as empty (Node ignores the read error the same way).
    let index = match rust_cli_fs::read_optional(&root.join(INDEX_FILE)).await {
        Ok(Some(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => String::new(),
    };
    prompt(&index, &root, scope)
}

#[cfg(test)]
#[path = "persistent_memory_tests.rs"]
mod tests;
