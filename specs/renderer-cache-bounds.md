# Renderer cache bounds and subscription lifecycle

Covers the renderer-side caches, hosts and observers touched by the React performance audit
(osben/ZCode#272). Each item is renderer memory only: nothing is persisted, and the rules apply the same
way on Desktop and Web.

## Shiki token cache (`packages/ui/src/lib/shikiHighlighter.ts`)

- **Owner:** the module-level `tokensCache`. `highlightCode` is the only read and write path.
- **Key:** `${theme}:${language}:${code}`, which includes the full code. The key must never be a sample
  of the code (length, head or tail). Two blocks that differ only in the middle must get separate entries
  and separate subscriber sets.
- **Bounds:** the cache is LRU. A hit re-inserts its entry, and eviction removes the oldest entry while
  either limit is exceeded:
  - `SHIKI_TOKENS_CACHE_MAX_ENTRIES` = 200 entries;
  - `SHIKI_TOKENS_CACHE_MAX_CODE_CHARS` = 2,000,000 characters of cached source in total.
  - The newest entry is always kept, even if it alone exceeds the character budget.
  - An evicted block is re-highlighted on its next mount.
- **Diagnostics:** `uiMemoryDiagnosticsRegistry` reports `tokensCache`, `tokensCacheCodeChars` and
  `highlighters`.

## Shiki highlighter retry

- **Owner:** the module-level `highlighterCache`, keyed by `${theme}:${language}`.
- A rejected `createHighlighter()` gets at most one retry per key per app session
  (`SHIKI_HIGHLIGHTER_MAX_ATTEMPTS` = 2 attempts):
  - After the first failure, the rejected promise is removed, so the next request tries again.
  - After the second failure, the rejection stays cached. Later requests reject immediately, and
    components keep their plain-text (`createRawCodeTokens`) rendering without re-initializing Shiki.
- Each distinct error object is logged once. A cached rejection that reaches many later mounts does not
  log again.
- An app reload resets the budget.

## Toast host (`packages/ui/src/components/ui/toast.tsx`)

- **Owner:** the single `#zcode-toast-host` element and its React root.
- `ensureHost()` creates the host only when no container is mounted (`addToast` is unset) and no mount
  is pending (`hostMountPending`).
- `ToastContainer`'s mount effect clears `hostMountPending` and installs `addToast`. Toasts fired before
  that commit queue through `requestAnimationFrame` and are delivered to the same container.
- If the container unmounts, `addToast` is cleared, and the next `toast()` creates a fresh host.

## Code viewer gutter observers (`packages/ui/src/components/ui/code-viewer.tsx`)

- **Owner:** the gutter-utility effect. It keeps a `Map<ParentNode, MutationObserver>` with one observer
  for the viewer root and one for each `@pierre/diffs` shadow root it visits.
- On every patch, observers whose target `ShadowRoot.host` is no longer connected are disconnected and
  removed. A file switch remounts `<File>` with a new shadow root, so the number of observers stays
  bounded by the live shadow roots.
- Effect cleanup disconnects every remaining observer.
- A pruned root that is attached again is observed again; nothing marks it as permanently seen.

## `useSyncExternalStore` subscribe identity

- `useConversationProjection` memoizes `subscribe` on `store`, and `useSourceSettingsServices` uses a
  module-level `subscribe`.
- Re-rendering with the same store must not unsubscribe and resubscribe. Changing the store must
  resubscribe exactly once.

## Acceptance

Covered by:

- `packages/ui/test/shikiHighlighterCache.test.ts`: key collision, a single retry, repeated failure
  (N mounts call `createHighlighter` at most twice and log once per failure), LRU by entries, and the
  character budget.
- `toastHost.test.ts`.
- `codeViewerComponent.test.ts`: release of detached shadow roots.
- `v4UseConversationProjectionSubscribe.test.ts`.
