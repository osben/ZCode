# Streaming Markdown Reveal (current state)

Streaming visual effect of assistant body text: **per-character / per-word reveal** (CJK by character, Latin by word). The source of truth for body text is still `ConversationSnapshot.rows`; the render entry is `packages/ui/src/v4/ConversationRowView.tsx` -> `MessageResponse` (`packages/ui/src/components/ai-elements/message.tsx`).

## The one hard constraint: never build a second copy of the text

Three generations were built between 2026-05 and 2026-07 (`useStreamingTextReveal` -> `streaming-markdown-animation` -> `typewriterController` + `Intl.Segmenter`) and all were reverted; one generation's auto-follow fix was reverted the same day. All three failed on the same thing: each kept a `visibleText` that grows over time.

```text
visibleText grows step by step
   -> element height grows every frame
   -> ResizeObserver fires continuously
   -> collides with virtual-scroll height compensation and bottom-follow arbitration
   -> scroll position is rewritten again and again
Also: a non-prefix change on snapshot backfill swallows the start; switching session replays the whole text.
```

So the current generation's dividing line is: **the DOM text is complete from the first frame; only opacity changes.**

|                         | Previous three  | Current         |
| ----------------------- | --------------- | --------------- |
| DOM text                | grows stepwise  | complete        |
| Element height          | grows per frame | constant        |
| Virtual-scroll measure  | disturbed       | not involved    |
| copy / search / restore | may be half     | always complete |

`opacity: 0` does not affect `innerText` (only `display:none` / `visibility:hidden` do), so E2E that waits for completion, reads the full text and asserts is unaffected.

## Why not Streamdown's built-in animation

Streamdown 2.5 `animated` + `isAnimating` wraps each word in `<span data-sd-animate>`, but the animation rules live in `streamdown/styles.css`, which this project never imports, so the spans are generated and nothing consumes them. Adding the stylesheet does not help either: in the `static` completed state its `prevContentLength` is always 0, the fixed 40ms stagger has no cap (a 1000-word message is fully visible only after 40 seconds), and it cannot adapt its pace.

## Implementation

One rehype plugin, appended to the end of `messageRehypePlugins` only when `streaming === true`. Completed and history messages use `static`: no plugin, no spans.

### One plugin instance per message; the function name must be unique

The plugin is stateful: each message's `MessageResponse` holds its own progress and reveal clock in `useRef`, and the plugin function reads and writes it through a closure. Streamdown's unified-processor cache is module-level (one per App, LRU of 100) and its key is built from the rehype/remark plugin function `name`, not the function reference.

Bugfix (2026-11-06): every instance used to be named `streamingRevealRehypePlugin`. After the first streaming message built the processor, every later streaming message hit the same cache entry and got the first message's plugin instance with its finished state (`incremental = false`), so every character was treated as `settled` and appeared at once. Symptom: only the first message after App start animated. Now each instance is named with an increasing sequence (`streamingRevealRehypePlugin$N`), like Streamdown's own `rehypeAnimate$N`. Cost: one more processor per streaming message in the cache, bounded by the LRU. This depends on an undocumented Streamdown cache rule, so **rerun SWR01 whenever streamdown is upgraded**; its second-round case fails if an instance is shared again.

### Split units

- `Intl.Segmenter` at `word` granularity with a module-level cached instance; without Segmenter fall back to `/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu`.
- Latin text splits by word. Fragments containing Han, Hiragana or Katakana are further split per code point: ICU dictionary segmentation would cut a two-character Chinese word into one chunk whose characters appear together, with no per-character typing feel.
- Text under `pre` / `svg` / `math` is skipped: code highlighting is async and would fight per-character reveal. Skipped text still counts toward offsets so prefix comparison and render order stay consistent.
- Inline code (a `code` not inside `pre`) is one unit as a whole element: `data-zcode-reveal` and the delay are written on the `<code>` itself, the inline-code renderer passes attributes through, and background and text fade in together. It cannot be skipped, otherwise it would be fully lit on mount while the text to its left is still fading, so inline code appears first. Inline math is still `code.math-inline` at this point and is later replaced whole by rehype-katex (ordered after this plugin); it only counts offsets and is not scheduled.
- List bullets and numbers are `li::marker` pseudo-elements, not text nodes, so they cannot be wrapped in a span. The plugin writes `data-zcode-reveal-marker` on a newly mounted `li`, taking its delay from that `li`'s first unit, so the bullet fades in with the first character (see "CSS").
- Known limits: when inline code is still growing during streaming, characters added after its background shows appear directly; blockquote left borders, table borders, dividers and task-list checkboxes appear directly with their element mount and are not scheduled.

### Every unit gets a span

During streaming every non-whitespace unit in a block is wrapped in a span; pure whitespace stays a text node:

```html
<span data-zcode-reveal="settled">A</span>
<span data-zcode-reveal="new" style="--zcode-reveal-delay:12.0ms">B</span>
```

Wrapping only new units does not work. `hast-util-to-jsx-runtime` builds React keys from tag name plus sibling index (`span-0`, `span-1`, ...). With only new units wrapped, next frame's new unit gets `span-0`, which is exactly the previous frame's old unit's DOM element; React only changes the text and the new unit does not restart its fade. With everything wrapped, on pure append the old units' spans keep their position and DOM; a new unit at the end gets a new key and is always a newly mounted element.

Cost: during streaming the whole message has one span per unit; with CJK split per character the span count is about twice that of word splitting. After the switch to `static` on completion the whole markdown is rebuilt and all spans disappear.

### Progress is recorded per block

Streamdown renders per block in `streaming` mode, running rehype on each block's own content, so the plugin sees a tree that is only one block. Progress therefore cannot be one length for the whole message:

- The plugin records the current block's rendered text (`pending`).
- The revealed length is decided by the longest common prefix with the most recently committed block texts (`committed`, at most 16). Only an older version of the same block counts: the tail of the old text after the common prefix is at most 8 characters and contains only whitespace and punctuation. The next version of the same block only rewrites trailing whitespace and punctuation (trailing whitespace trimmed, remend completion); a tail containing words means a different paragraph that happens to start with the same words and is not progress.
- On commit the same rule deletes superseded old versions; deleting by strict prefix only is not enough.
- Bugfix (2026-11-05): the first rule only required "old text except its last 8 characters is a prefix of the current text". An old text shorter than 8 characters satisfies that for any common prefix: the first frame of an ordered list `\nitem three\n` was taken as a new version of the unordered-list old entry `\nitem one\n` (common prefix `\nitem `), so the shared prefix and the number appeared with no fade; adjacent short headings "Step 1" / "Step 2" behaved the same. That old entry should have been deleted when the unordered list became `\nitem one revealClock\n`, but commit deleted only by strict prefix and the rewritten trailing newline prevented deletion. The rule prefers strict over loose: judging "not an old version" wrongly only costs a few schedule slots because mounted unit keys stay and do not replay; judging "is an old version" wrongly makes new units appear directly.
- A new paragraph has a common prefix of about 0 and reveals from the first unit.
- Judgement looks at where a unit starts: a unit starting before the progress point is the same element mounted in the previous frame and extended (Latin tokens often arrive in pieces and the key, by sibling index, is unchanged). `@starting-style` does not replay on a mounted element, so it is marked `settled`, takes no schedule slot, and the extended letters follow its current opacity.

Earlier blocks are frozen by Streamdown's memo and no longer run the plugin, so only the last few need recording.

### Incremental decision (message level)

- Only a pure append (`next.startsWith(prev)`) with a single-frame increment of at most 600 characters counts as a live delta.
- A non-prefix change (snapshot backfill, session switch, model rewrite) or an oversized increment (mid-stream mount, restore) marks every word of the whole message `settled`: **no animation**, and the body is never clipped by old progress.
- A re-render with unchanged text (theme or other prop change) keeps the previous decision.
- Known limit: remounting a message of at most 600 characters mid-stream (switch away and back) cannot be told from "first frame of a new message", so the whole text fades in once. Messages over 600 characters are unaffected.

### Commit order

```text
MessageResponse render (decide incremental, read progress)
  -> commit -> Streamdown effect: startTransition(update block list)
           -> MessageResponse effect: commit the pending recorded by the last transition
  -> transition render: tail Block runs the plugin, reads committed, writes pending
```

Render only reads progress; committing happens in an effect. Text pushed twice by StrictMode double render is deduped at commit. A transition render that is interrupted and discarded may make a few units appear without fading; this affects visuals only, not the body.

## Pacing: a cross-frame reveal clock

The upstream 30ms coalescing only batches tokens and does not even out output; model and network are bursty, and coalescing makes blocks more likely. A real buffer is needed: a cross-frame reveal clock that flattens bursts.

The buffer shows up only in each unit's `transition-delay`. The DOM text is still complete from the first frame; no rAF, no timer.

```text
State (kept across frames, becomes official after commit):
  clock = start time of the last scheduled unit (performance.now timeline)
  rate  = EWMA of arrival speed (units/ms); gap = EWMA of the interval between batches
          an interval over 300ms counts as a pause and is not used to update

For count new units this frame, now = scheduling time:
  e         = 1 / rate (30ms / count when there is no reference yet)   // arrival interval per unit
  lag       = clamp(max(6 x e, 1.5 x gap), 80, 250)                    // target lag: about 6 units of buffer
  tail      = max(clock, now)
  available = min(now + 250 - tail, max(now + lag - tail, 15))
  interval  = min(40, available / count)
  start     = max(now, clock + interval)                               // follow the previous batch
  delay(i)  = start + i x interval - now
  clock     = start + (count - 1) x interval
```

Bugfix: lag was first fixed at 250ms. A unit is one Chinese character or one English word; one Chinese token is about 1-1.5 characters; common models emit 30-60 units per second and fast ones over 100. Above 25 units per second the queue sits at the 250ms cap, and with the 300ms fade a fast model reaches 90% opacity only after about 460ms, which looks like rendering cannot keep up. Target lag now scales with arrival speed, about 6 units of buffer, so it keeps up however fast the stream is.

Bugfix: the first adaptive version also scaled the fade duration (`clamp(8 x e, 120, 300)`). Real models measured about 150 units per second (a reply of about 510 units streamed in 3.4 seconds), so the duration was pushed to the 120ms floor: under ease-out 30ms already reaches 38% and 90ms reaches 91%, so each character fades over only 2-3 frames, which the eye reads as no animation, for every model. Whether the fade is visible depends only on how many frames a single character spends fading, not on emit speed, so the fade duration is fixed at 300ms and only the lag scales.

Schedule simulation (30ms frame, per-frame arrival count jittered +-50%; visible fade frames = frames in which one character is below 90% opacity):

| Units/s | To 90% opacity | Concurrently translucent units | Visible fade frames |
| ------: | -------------: | -----------------------------: | ------------------: |
|      60 |          318ms |                             20 |                   7 |
|     150 |          290ms |                             45 |                   7 |
|     300 |          289ms |                             89 |                   7 |

For comparison: with the lag fixed at 250ms, 150 units/s needs 460ms; with the duration also adaptive it is 157ms but only 2 fade frames are visible.

- Slow emit (slower than one unit per 40ms): the interval is capped at 40ms, characters are distinguishable, lag is near 0.
- Fast emit: target lag shrinks to about 6 units of arrival time (minimum 80ms); the fade is always 300ms.
- When the queue already exceeds the target lag, each batch spreads at least 15ms and falls back gradually, so nothing starts at once.
- `1.5 x gap` makes the lag cover the gap between two batches: with mobile replayable at 150ms per frame the lag is never below the frame interval, so there is no "play a batch, stall, next batch" stutter.
- A burst right after a pause: the previous batch is scheduled only up to the lag cap, so the next batch still has time to spread and does not clump. Bursts are scheduled at the pre-pause speed: a fast model's whole sentence after a pause spreads in about 80ms, tighter than a slow model's; this is a deliberate trade-off.
- The 250ms hard cap also bounds the accumulated delay of one large batch in a single frame: Streamdown's built-in animation has no cap (1000 words x 40ms = 40 seconds until the end is visible).

The fade duration comes from `:root` `--zcode-reveal-duration` (300ms), not written on units; scheduling writes only the delay.

Scheduling order:

- When several blocks have new units in the same render pass, later blocks are scheduled after earlier ones (`pendingSchedules`).
- When the same block content renders again before commit (a transition is interrupted and redone), the already scheduled delays are reused; otherwise it would schedule after itself again and double the delay.
- Commit and progress both sit in MessageResponse's effect, see Commit order.

Known costs:

- **At the end of a reply, the tail not yet reached appears directly.** After `streaming` becomes false it switches to `static` and rebuilds, so the spans vanish. The tail length equals the lag at that moment: near 0 for slow models, about 80ms for fast models, at most 250ms. Removing it would need the UI to wait for the animation to finish before switching to static, i.e. synchronizing state with time; not adopted.
- **Scheduling has small deviations.** The delay is counted from scheduling time while the transition is counted from the first style computation after mount; Streamdown's block updates go through `startTransition` and the time between them varies.
- During the delay a unit becomes `settled` next frame and `--zcode-reveal-delay` is removed. Per the CSS Transitions spec, an already created transition (including its delay phase) is not affected by later delay changes; SWR01 verifies this.
- If E2E shows interruption during the delay, or pacing jitter is visible, switch to rAF: write only visual marks, not through React state, compute progress from elapsed time, and catch up directly when a background window returns.

## CSS

```css
[data-zcode-reveal] {
  transition: opacity var(--zcode-reveal-duration) … var(--zcode-reveal-delay, 0ms);
}
@starting-style {
  [data-zcode-reveal="new"] {
    opacity: 0;
  }
}
[data-zcode-reveal-marker]::marker {
  transition: color var(--zcode-reveal-duration) … var(--zcode-reveal-marker-delay, 0ms);
}
@starting-style {
  [data-zcode-reveal-marker="new"]::marker {
    color: transparent;
  }
}
```

It uses transition + `@starting-style`, not `@keyframes`: a word changes from `new` to `settled` on the next frame (30ms), and when the keyframes selector no longer matches the animation is removed immediately, so the fade plays for one frame. A transition runs to completion as long as `transition-property` still includes opacity; `@starting-style` applies only on first mount, so `new` on an already mounted element does not replay. `will-change` is deliberately not added: with one span per unit, promoting compositor layers drags down long messages.

List bullets: `::marker` supports only a few properties and opacity has no effect, so color is used. A probe on Electron 44.7 (Chrome 152) confirmed that a color transition works on `::marker`, is not cancelled when switched to `settled` during the delay, can override Tailwind's layered `marker:text-foreground-subtlest`, and interpolates from transparent without passing through black first. The marker delay uses its own variable name so the value on `li` is not inherited by words in child elements; the duration shares `--zcode-reveal-duration` with the body.

History: in 2026-06 a bullet fade was done with keyframes on `li::marker` (`b55e915d387`) and deleted with the typewriter rewrite (`67a2a559136`); afterwards bullets simply appeared with their `li` mount.

## Motion baseline

`DESIGN.md` Motion asks for fast, low-drama, non-decorative motion. The duration and easing for body text, preview cards, change summary and chat loading are centralized on `:root`:

| Variable                  | Value                           | Use                                                             |
| ------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `--zcode-reveal-duration` | 300ms                           | per-character / per-word reveal, list bullets                   |
| `--zcode-reveal-ease`     | `ease-out`                      | per-character / per-word reveal, list bullets                   |
| `--zcode-enter-duration`  | 260ms                           | whole-block entry (preview cards, change summary, loading rows) |
| `--zcode-enter-ease`      | `cubic-bezier(0.16, 1, 0.3, 1)` | whole-block entry                                               |

The per-character reveal duration is fixed at 300ms and does not vary with emit speed; emit speed only affects the start delay (lag), see "Pacing".

Whether a single unit's fade is visible depends on how many frames it spends mid-fade at any moment; the curve matters more than the duration. At 30ms per frame, frames below 90% opacity per combination:

| Duration | `cubic-bezier(0.16, 1, 0.3, 1)` | `ease-out` |
| -------- | ------------------------------- | ---------- |
| 180ms    | 2 (first frame already 69%)     | -          |
| 200ms    | 2                               | 4          |
| 300ms    | 3                               | 7          |

A fast-start curve is nearly fully lit on the first frame and looks like direct appearance. So the per-character reveal uses its own 300ms + `ease-out`; whole-block entry is one-shot and keeps the fast-start curve. Whole-block entry used to be 900ms and has been tightened to 260ms. All animations are disabled under `prefers-reduced-motion: reduce`.

## Boundary

The animation may only be a disposable visual layer: it must not change copy, search, restore, virtual-scroll height measurement or final row content. The turn currently streaming stays in ordinary document flow as the live tail (not in the virtualizer); this is the only area the animation acts on. If it spills into a turn already in virtual history, the "replay fade" and "whole area flashes blank" recorded in SSV05/SSV06 reappear.

Acceptance case: `packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-streaming-word-reveal.test.ts` (SWR01).
