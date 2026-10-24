# CUA Tool App Identity Summary

## Goal

When the Agent has observed an app identity through `list_apps` and later calls carry an explicit PID,
the CUA tool summary shows the target app name and icon from the start of execution, so consecutive CUA
operations are easy to tell apart.

## Identity source in the node_repl era (2026-09-17)

Once Computer Use became a JS surface of `node_repl`, the only model-visible tool name is
`mcp__node_repl__js`. The `mcp__computer-use__*` tool-name checks used by "Fact source and timing" and
"CUA Tool Call Group" below no longer apply to new sessions and hold only for **historical session
replay**. New sessions use this projection.

```text
Helper application_info / capture
        |
        v
producer wrapper attaches _meta["zcode.cua/app-associations-v1"].primary
  { appKey, displayName?, icon? }
        |
        v  broker response (invisible to the sandbox)
node-repl-host CUA bridge — the only trusted recording point
        |
        v  trusted slot of the run result
node_repl tool result _meta["zcode/nodeReplCuaApp"] = { appKey, displayName? }
        |
        v
Core display `node_repl_images.app`
        |
        v
Node REPL tool card leading icon -> IPlatformService.getApplicationIcon(locator)
```

- **Trust boundary:** identity is recorded only by the node-repl-host CUA bridge when it receives the
  broker response. `nodeRepl.setResponseMeta` and `nodeRepl.emitStructuredResult` hang on the
  model-visible sandbox globals, so any `zcode.cua/app-associations-v1` arriving through those channels
  is **dropped** and never used for display (same treatment as
  `zcode/nodeReplBrowserScreenshotContentIndices`). The host-written `zcode/nodeReplCuaApp` is the only
  key Core consumes.
- **Several calls in one cell:** the last CUA method that produced a `primary` wins, matching the
  existing last-write-wins semantics of `_meta`. `request_access` and `stop_computer_control` declare
  `none`, `list_apps` declares `items`; none produces a `primary`, so none overwrites an earlier
  identity.
- **Icon resolution:** `appKey` prefix derives the locator: `darwin:` -> `darwin-bundle-id`,
  `windows-aumid:` -> `windows-aumid`, `windows-exe:` -> `windows-executable-path`. `linux-exe:` has no
  locator and, like Web/mobile remote, falls back to the generic Node REPL icon. The inline `icon` PNG in
  the producer `_meta` is **not projected**: the session protocol carries no data URLs (see "Protocol
  and display") and one app's icon would repeat dozens of times in a long session.
- **Out of scope:** the app name does not enter the summary line (the `js` `title` already describes
  the action by the model); `list_apps` `items` are not projected (no per-item list card under
  node_repl); CUA Group grouping still applies to historical sessions only.

## Fact source and timing

> This section and "CUA Tool Call Group" branch on `mcp__computer-use__*` tool names and apply to
> historical replay only; new sessions follow the section above.

```text
list_apps #1 success ── snapshot #1 ── pid tool ── pid tool
list_apps #2 success ── snapshot #2 ── pid tool ── ...
```

- The snapshot scope is one task's ordered event stream; never reused across tasks/sessions.
- Only a successful official CUA `list_apps` result replaces the snapshot as a whole; a failed result
  keeps the old snapshot.
- When a later official CUA tool is scheduled, the current snapshot is queried first by the `app_ref.pid`
  already in the input; without a PID, by exact `bundle_id` equality. `name` is not a query key.
- `app_ref` / the equivalent AppRef position accepts a structured object or a JSON string parseable to
  an object, matching CUA execution-layer input normalization; an invalid string does not participate
  in matching.
- No reverse lookup from `state_id`; no implicit `list_apps` call for the summary; no guessing the app
  for global actions such as screenshot or wait.
- Cold recovery rebuilds the snapshot from the same event log; continuous and replayable consume the
  same `ToolCallRow` facts.

## Protocol and display

`ToolCallRow` optionally carries:

```ts
cuaApp?: {
  pid: number;
  name: string;
  bundleId?: string;
};
```

Display identity prefers the app in the same tool's completion result, then the `cuaApp` frozen at
scheduled time, then falls back to `Computer Use`. On a match the row shows `App Icon + App Name +
Action`; the icon is resolved asynchronously through the platform service by `bundleId`, and no data URL
enters the session protocol. When the platform does not support it, there is no bundle id, or the icon
read fails, the CUA icon stays but the app name is still shown.

### Element action target tag

- The action target tag uses `text-ui-sm` as secondary compact information next to the app/action text.
- After `left_click`, `right_click` and `type` complete, the summary tag prefers the readable name of the
  target element from the result state.
- If the target element only has a numeric placeholder name equal to its index, the flat element list in
  the result state may supply consecutive text nodes after it up to the next operable element, combined
  into the label. Example: the text after `[59] 59 (pressable)` ("智谱 / 快速 / 订餐") shows as
  "智谱快速订餐".
- The read must stop at the next `pressable` or `editable` element and must not join unrelated text across
  search results; without reliable text it falls back to the element index.
- When only the bare numeric index is available, the tag shows the localized `元素 #57` / `Element #57`,
  never a bare `57`; an already-resolved readable name is unchanged.

### Expansion timing

- During `pending` / `running`, every CUA tool shows only the summary: no expand entry, and the upper
  `forceOpen` is ignored.
- Expansion follows the existing detail rules only after the tool reaches a completed state; a failed
  screenshot without image data renders no screenshot item.

## CUA Tool Call Group

The CUA Group is a V4 renderer-only display projection, but the response ownership it needs is a protocol
fact. V4 `ReasoningRow`, `AssistantTextRow` and `ToolCallRow` point to the runtime's existing
`assistantMessageId` through the optional `assistantResponseId`; desktop continuous and mobile replayable
build the Group deterministically from the same ordered row facts.

```text
Assistant response start
                 ── create a stable ResponseEnvelope, text streams normally
response has only official CUA
                 ── reasoning + message + CUA join or continue the active Group
response has a non-CUA tool
                 ── close the old Group; message/non-CUA stay outside, CUA starts a new Group
response has no tool ── message stays outside; the Group closes at response/turn completion
unclassified reasoning / message
                 ── shown outside, does not close the Group
marker / status  ── shown outside, does not close the Group
turn / work segment / user boundary
                 ── force-close the Group
```

- A single official CUA also forms a Group; a third-party MCP with the same tool name does not take part.
- The Group's stable identity and position anchor to the first Assistant response containing an official
  CUA, keyed by its `assistantResponseId`, no longer to a tool call. Only a tool-only response uses its
  first CUA as the visual fallback.
- At response start, reasoning and text always stream in place and are not created in, closed in, or
  parked inside a CUA Group; once an official CUA of the same response arrives, reasoning, text and the
  container leave the outside and enter the Group together.
- When a non-CUA arrives the text stays outside and the old Group closes; only when the response
  completes with still no tool is it confirmed text-only and the old Group closed. An unclassified
  streaming message does not enter the rolling summary.
- After a response is confirmed pure-CUA, the outside Assistant render item is removed whole, including
  RowShell, spacing and actions container; when the Group expands, the same row renders one complete
  message container inside. Moving only the text and leaving an empty shell is not allowed.
- History chunks in the outer flow projection must also pass the inner visibility and tool-grouping
  projection; if nothing renderable remains, no `CollapsibleContent`, padding or work-items container
  may be created. This prevents an empty history structure occupying spacing outside the Group when CUA
  consumes a message or a running tool is classified late.
- `request_access`, `list_apps` and other official `mcp__computer-use__*` tools are treated alike. A
  third-party MCP with the same name is a non-CUA tool. Markers and todo/status neither join nor
  proactively close the Group.
- An old snapshot without `assistantResponseId` aggregates only CUA tools and does not guess adjacent
  reasoning/message (compatible degradation).
- Both the active Group and a closed Group let the user expand all CUA children by click or keyboard; the
  active Group still ignores the upper `forceOpen` (no passive auto-expand while running) but its manual
  expand entry is not disabled.
- Expanded detail uses an internal scroll viewport with a fixed max height; on first expand, appended
  child or height change it scrolls to the bottom so the latest CUA event stays visible, and the outer
  conversation does not grow without bound.
- The internal scroll viewport reuses Thinking's conditional top/bottom edge mask: the 24px fade shows
  only when hidden content remains in that direction and is removed at the top/bottom; light and dark
  themes share the same transparency semantics.
- The running collapsed summary is `<rolling content> · N events[, M messages]`; when complete it
  settles to `<CUA Icon> Computer Use · N events, M messages` without keeping the last app/action. The
  completed product name always goes through the locale (English `Computer Use`, Chinese `电脑控制`) and
  the message count is shown, including `M=0`. `N` counts the reasoning, CUA and Assistant messages
  currently visible in the Group; reasoning hidden by "show thinking" is not counted, and the first
  reasoning still follows the global visibility contract. `M` counts Assistant messages only; plural and
  Chinese classifiers go through i18n. The separator dot and counts are separate layout nodes, not
  space-joined.
- The completed CUA Icon uses the leading icon slot of an ordinary tool summary with
  `text-foreground-subtlest`, same as other tool icons; the completed state no longer passes through the
  rolling summary container, avoiding an empty primary slot adding spacing between product name and dot.
  The running app/CUA icon still belongs to the rolling content and does not take part in the text
  gradient.
- Rolling content projects only terminal CUA: without app identity `CUA Icon + Computer Use + Action`;
  with identity `App Icon + App Name + Action`. An Assistant message does not enter the rolling
  candidates or trigger rolling animation; it still counts toward events/messages and, in the expanded
  timeline, shows its text in a secondary text color without repeating an icon. An app icon failure falls
  back only the icon, never the app name.
- Dynamic action copy in the CUA summary must use declared zh/en locale keys. When the input holds a key
  combination, `key` and `hold_key` show the localized action plus a combination tag; `list_windows`
  shows a localized window count when the completed result is parseable. No render path may leak a
  message id to the user.
- The Group summary's app/CUA icon sits in a `shrink-0 size-4 flex items-center justify-center
  [&_svg]:size-4` container: the CUA fallback SVG stays `size-4`; a real app icon is given `size-5`
  explicitly by `CuaAppSummaryIcon` at Group projection time, not through a parent descendant selector
  overriding its default `size-4`. Neither takes part in text compression; icon container and rolling
  text use `gap-2`.
- Child CUA tools inside an expanded Group likewise receive app icon `size-5` through an explicit render
  context; the child tool renderer also wraps the icon in a fixed parent
  `shrink-0 size-4 flex items-center justify-center` so the 20px app icon is centered in a 16px slot. An
  ordinary standalone CUA tool keeps the default `size-4` without that wrapper; neither uses a CSS
  descendant selector to override image size.
- While the virtual parent is `in_progress`, the app name and action in the rolling summary use the
  CUA-specific legacy fast wide light band: `1s / 200% / 40%–60% weak band / 0.5s delay`. Icon, separator,
  counts and failure state do not animate; reduced-motion disables scrolling and the gradient.
- Rolling items consume only terminal CUA children: `success / error / cancelled` map through the legacy
  adapter to `completed / failed / stopped`. An Assistant message's streaming, completed or failed state
  produces no rolling key; other active CUA and messages never overwrite the previous terminal tool
  summary.
- A business failure is terminal and enters the rolling queue, but a long error appears only in the
  tooltip and details.
- Rolling reuses Explore's live-update playback semantics; cold recovery shows the last terminal item
  directly without replaying history animation.
- Expanded detail mixes items in original response/part order: reasoning reuses the existing collapsible
  Reasoning component and visibility rules, but since the Group is already the parent boundary, expanded
  child thinking shows no left guide line or left indent; CUA reuses the existing tool detail; an
  Assistant message is a lightweight text row without icon and without the final text's
  copy/fork/retry/preview actions.
- The main turn flow and the history/background-result compatible work-item path must pass the full
  `events` to the same CUA Group renderer. The compatible path may not pass only the virtual parent,
  otherwise an Assistant message consumed by the outer projection disappears from the expanded timeline.
- "Raw data" in a CUA child tool detail must show the complete `toolCall` JSON, not only input/output;
  `toolId`, tool name, status, `raw.display`, `v4Status` and streaming metadata are facts needed for
  troubleshooting. The full data sits in a secondary disclosure, collapsed by default, so normal detail
  stays readable.
- A Group does not cross user input, turn, work segment, workspace or session.

## Compatibility and failure semantics

- An old snapshot without `cuaApp` keeps the existing summary.
- On Linux `bundle_id` may be empty and the name is still usable; on Windows `bundle_id` may be an AUMID.
- A PID is the Agent's most recently observed fact between two explicit `list_apps` calls; system changes
  trigger no implicit refresh.
- A third-party MCP, even with a similar tool name, never gets the official CUA identity projection.
