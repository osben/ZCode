# Chat Model Select Menu

> Current state: the chat side has migrated to the V4 composer.

## Goal

The composer reuses `ModelConfigSelect`, and model selection uses a simple menu, reducing the interaction cost of a search-style Command list for small-scope model switching.

## Current implementation

- `packages/ui/src/ModelConfigSelect.tsx`
  - Renders the model menu with the existing `DropdownMenu` component, keeping `bg-menu`, compact row height and keyboard menu semantics.
  - With several providers, the merged menu has the currently browsed provider row at the top; expanded (hover, click or keyboard) it is the provider list, and the Models list below shows the models of the browsed provider. The provider row is for browsing only: click, keyboard confirm, or hovering / arrow-moving to a provider in the desktop submenu only switches the Models list; model, thinking level and account connection change only when a model row is selected (ISSUE-058, see [`specs/composer-model-picker-browse-only-providers.md`](../../specs/composer-model-picker-browse-only-providers.md)).
  - The Z.ai / BigModel family shows the current connection method as a short badge on the group title, for example `Start`, `Individual`, `Team`, `API`; the badge is a borderless, faint-surface round pill, and model items do not repeat it. The connection method is switched only in settings; the composer menu only consumes the current selection.
  - With a single provider, the first-level menu shows the model list directly without wrapping a provider layer.
  - The selected model uses `DropdownMenuRadioItem` to keep single-select state; a model restricted by the currently running task uses disabled semantics and a lock hint and does not trigger a switch.
  - When the model config's input types include any non-Text value, a compact localized "视觉 / Vision" badge follows the model name. The badge is a light round pill: thin border, faint surface background, `text-ui-xs` medium weight; it belongs to the left model content and the row-end selected check keeps its position. It only describes the input types already declared in the provider registry and does not promise the current adapter can send the corresponding attachment.
  - `Ctrl+M` only opens the model menu and does not cycle models in order; model switching must be an explicit user selection in the menu.
  - When the trigger text changes it reuses the toolbar rolling label animation, consistent with the mode / thought level controls; under system reduced motion it is replaced statically.
  - The display identity of a custom provider resolves as `providerName.trim() || providerId`, consistent with the menu; when the name is missing, empty or whitespace-only the trigger still produces the `providerId/` prefix and the full title. Prefix visibility is still decided by the seven-step compression. Built-in account plans keep showing only the model name.
  - The composer trigger applies a seven-step cumulative compression by actual free space: Computer Use square -> mode square -> Plan square -> think icon + small green bar -> hide provider-text -> think square (small green bar hidden) -> model square. Each step stops once enough, and relaxing restores in reverse order. While the model name is shown it stays a full single line with the dropdown arrow; the last step directly becomes a 28px Lucide `Package` icon button with the arrow hidden, with no extra width-threshold truncation of the model text. See the [CUA composer layout contract](../superpowers/specs/2026-08-18-cua-composer-entry-design.md). The provider prefix and model name must stay structured nodes and are never split from the final text by `/`; the button title and rolling animation key keep using the full identity text. Normal and reduced motion share the same single-line container structure, so the provider and model are not split into two lines by truncation styles. Desktop split view, plain Web and mobile Web share this rule.
  - Model items likewise treat the model ID as an opaque string; `openrouter/ox-alpha` or more `/` levels play no part in capability judgment or name splitting, and the selection value keeps the full ID.
  - While a model switch is pending, the loading spinner goes after the text, so a width change to the left of the model name does not cause visual jumping.
  - The "manage models" entry stays controlled by the caller; only the host component changes and the settings navigation chain does not.
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
  - Only passes the chat toolbar's model groups, lock state and switch callback into `ModelConfigSelect`.
- `packages/ui/src/v4/ConversationComposer.tsx`
  - The mode, model and thinking-depth pickers share composer-local open state; at most one picker is expanded at any time. When another trigger is clicked, the old picker must leave the visible state first, and the picker clicked later stays open.
  - A late callback that closes the old picker may only clean up itself and must not close the sibling picker that has already taken over.
  - The picker owner is valid only inside the current `workspaceKey + sessionId/draft scope`; on a scope switch it must be cleared synchronously. The `ConversationComposer` React instance may be reused across task/draft, but the open state must not be kept or auto-popped across scopes.

## Compatibility boundary

- Desktop and Web share one React component; the menu interaction introduces no platform-specific logic.
- Picker mutual exclusion belongs to a single composer instance, does not enter a global store, and is not synchronized across pane, window or the desktop continuous / web-remote replayable boundary.
- Mobile Web keeps avoiding forced restoration of input focus after the menu closes, to prevent touch devices from raising the system keyboard over the menu; the model trigger keeps no mobile-specific fixed width, text truncation or provider clipping logic and relies uniformly on the composer's available-space decision.
- The ZCode Agent provider model menu filters by runtime endpoint format; the current catalog may contain Anthropic-compatible, OpenAI-compatible Chat Completions and OpenAI Responses models; the Bot `/model` entry reuses the same provider capability boundary.
- For an existing session the selection writes to the CLI through V4 `switchModelConfig`; a draft selection is written by `useDraftConfigControl` to `draftConfigRef`, the workspace default and the pre-warmed session. Remote recovery must keep workspaceIdentity / remoteSessionId and not go through the legacy task model write.
