# Session Title Generation

## Background

`session.title` is first derived by truncating the user input at first persistence: stable and cheap, but poor
for long prompts, mixed Chinese/English input and file attachments. Core constraints:

- User titles and AI titles are separate. A user-set title always wins; an AI title is regenerable
  enhancement metadata.
- The title is generated asynchronously after the first real user message of a root session and written
  back to session metadata.
- Title generation is a low-risk sidecar. It must not affect the main agent loop or overwrite an explicit
  user name, and it must reach the database and session events so the local TUI session list, resume and
  debug can reuse it.

## Goals

1. Only for the local TUI root interactive session, generate a more readable title after the first real
   user message completes.
2. Use `ModelRole.Lite`. Without `model.lite`, use the current default/main model; never error or force
   the user to configure a second model.
3. By default disable thinking/reasoning control fields inherited from the main session, so a short
   sidecar request does not slow down or waste output budget on a high/max thinking tier.
4. An AI title may overwrite only a default / first-input / older AI title, never a custom user title.
5. The title is written through `SessionStorePort` and persisted by the SQLite adapter.
6. A title update emits an observable session event with traceId/sessionId/turnId/modelRef/source.
7. On failure, timeout, unparsable or invalid model output, keep the current title and leave the main
   turn unaffected.

## Non-goals

- No new environment variable; enablement, timeout and model selection go through runtime/session config.
- No automatic renaming of child, subagent, workflow-child or fork sessions.
- Title generation is not a tool and cannot call tools; the TUI does not access the model or database, it
  only enables the runtime config and consumes the session projection/list/events.
- ZCode app-server, headless `--prompt` and SDK/test hosts do not enable it by default. They trigger it
  only when `runtimeConfig.titleGeneration` is passed explicitly.
- The first version has no manual `/rename` command, but the database and port must keep the
  non-overwritable semantics for `custom` titles.

## Data contract

`SessionInfo` gains optional title metadata:

```ts
type SessionTitleSource = "default" | "first_input" | "generated" | "custom";

interface SessionInfo {
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  time: {
    titleUpdated?: number;
  };
}
```

The SQLite `session` table gains:

| Column | Type | Description |
| --- | --- | --- |
| `title_source` | text not null default `first_input` | Title source. |
| `title_message_id` | text null | The user message the title was generated from or set for. |
| `time_title_updated` | integer null | Last title update time. |

`SessionStorePort.updateSession` supports a title CAS:

```ts
interface UpdateSessionInput {
  title?: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId | null;
  expectedTitleSources?: SessionTitleSource[];
}
```

When `expectedTitleSources` is non-empty and the current `title_source` is not in the list, the adapter
must no-op and return the current session. AI title writes use
`["default", "first_input", "generated"]`, so a `custom` title is never overwritten by a late AI result.

## Trigger rules

The core runtime starts title generation, but the outer host must enable it explicitly. In the first
version only the CLI TUI entry passes `runtimeConfig.titleGeneration`; headless `--prompt`, ZCode
app-server sessions, workflow children and external SDK hosts do not.

When enabled, all of these must still hold:

1. Both `sessionStore` and `modelAdapter` exist.
2. `titleGeneration.enabled !== false`.
3. The session is a root interactive session: no `parentSessionId`, and `taskType` is absent or
   `interactive`.
4. The turn is the first real user turn, counted after resume.
5. The user prompt is not a summary, compact, rewind, hook synthetic, slash-command expansion or blank.
6. The session title source is not `custom`.

The async sidecar request starts after the main turn completes; it stays out of the main
`TurnResult.usage` and emits its own model request / model complete / session title events.

## Bootstrap and entry boundary

Bootstrap does not auto-enable globally. It only fills in the title model reference and provider options
when `runtimeConfig.titleGeneration` already exists.

The CLI TUI entry passes this when creating the app:

```ts
runtimeConfig: {
  titleGeneration: {},
}
```

Headless `--prompt` and `--target` and app-server sessions do not pass `titleGeneration`, so they send no
extra background model request and incur no extra cost, events or model calls, and script output and exit
timing are unaffected. If a ZCode protocol client later needs titles, design the protocol capability and
display semantics first, then enable it explicitly. A test or external host that injects a custom
`modelAdapter` gets no title request unless `runtimeConfig.titleGeneration` is passed explicitly.

## Model selection

When an entry enables title generation explicitly, bootstrap produces `titleGeneration.modelRef`.

Selection order:

1. If `model.lite` is configured, use its provider/model.
2. Otherwise use the current default/main provider/model.
3. In both cases `modelRef.role` in events is `lite`, marking a lightweight sidecar request.

Provider options follow the final provider/model; without `model.lite` the default/main provider options
are reused. Before the title request is sent, a title-specific transform applies:

- Keep endpoint, apiFormat, metadata and extra-body fields that concern the connection or non-thinking
  behavior.
- Read the original reasoning options first, then remove the `effort`, `reasoningEffort`,
  `reasoning_effort` inherited from the main request; never infer model capability from the options after
  removal.
- Anthropic namespace with `thinking`: set `thinking.type = "disabled"` and remove effort.
- OpenAI namespace: write `reasoningEffort = "none"` only for GPT base models that explicitly support
  `none`; for other models only remove the inherited effort and do not fabricate a disable value the
  provider does not support.
- OpenAI-compatible namespace: disable in the existing shape first: `thinking.type = "disabled"` or
  `enable_thinking = false`. For GLM-5.2 and GPT base models that explicitly support `none`, if the
  original options only carry effort, convert to canonical `reasoningEffort = "none"`.
- MiniMax M3 gets the official off parameter by existing `apiFormat` even without reasoning options:
  OpenAI Chat `openaiCompatible.thinking.type = "disabled"`, Anthropic
  `anthropic.thinking.type = "disabled"`, Responses `openai.reasoningEffort = "none"`. This affects only
  the title sidecar, not the main request or model tier.
- Models without a safe off contract (Kimi K3, GPT Pro/Codex, MiniMax M2.x, ...) only get the inherited
  effort removed; no `none` or other off field is fabricated. Other models without reasoning options are
  left as is.

The main conversation keeps the chosen thinking effort; the short requests sharing the title sidecar (title,
goal summary title) do not inherit high/max thinking.

## Prompt and output cleanup

The system prompt requires:

- A recognizable title of 3-7 words.
- The user's main language.
- Sentence case; keep proper nouns, file names and technical names.
- No explanation, markdown, numbering, quotes or multi-line text.

Cleanup:

1. Strip `<think>...</think>`. This compensates for models that ignore the disable fields; it does not
   mean the request may inherit thinking.
2. Prefer parsing JSON `{ "title": "..." }`; also accept JSON wrapped in a complete Markdown fenced code
   block (language tag `json`); on failure take the first non-empty text line.
3. Strip surrounding quotes and markdown markers.
4. Collapse whitespace and cap the length.
5. An empty result, short noise or punctuation-only text counts as failure.

## Events

New `session_title_updated`:

```ts
interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  modelRef?: ModelRef;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}
```

Title generation also emits ordinary `model_request` / `model_complete` with
`querySource: "session_title"`, so debug and cost analysis can see the sidecar request.

## Error handling

- Model request failure, timeout, cancellation, empty output or CAS failure never affects the main turn.
- The runtime writes only structured warn/debug logs and never adds a visible assistant message.
- A CAS failure is not an error; it is logged as `session_title_generation.skipped` with reason
  `title_source_changed`.

## Tests

Minimum coverage:

- The SQLite migration gives old sessions the default `first_input`.
- `createSession` writes `title_source`; `updateSession` can update a generated title.
- The generated-title CAS cannot overwrite a custom title.
- Without `model.lite`, the title request uses the main provider/model with role `lite`.
- With `model.lite`, the title request uses the lite provider/model.
- The title request strips inherited thinking/reasoning provider options; the main request keeps its
  original provider options.
- When the title model fails the main turn still succeeds and the session title keeps the first-input
  fallback.
- With TUI explicitly enabled, the first root interactive turn triggers; child/fork/workflow/subagent do
  not.
- Headless prompt and ZCode app-server do not pass `titleGeneration` by default and trigger no title
  model request.
