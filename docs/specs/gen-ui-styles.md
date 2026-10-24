# Gen UI Unified Styles

## Goal and Scope

DESIGN.md is the target spec; App native components are the reference for sizes and states. Only the Gen UI theme projection and the visualize base assets change; App native components and third-party MCP App standard projection are untouched. Existing fragment class names keep working, and standalone HTML export shares the base CSS with inline rendering.

## Style Contract

- Body text, buttons and forms use the host body size. h1/h2/h3–h6 use body +4/+2/+0; helper text -2, tooltip -1, inline code -2. Chart author labels may keep a readability floor.
- Radius uses independent sm/md/lg/xl tokens (default 4/6/8/12px), not derived by ratio. card/widget start at xl and nested ones step down lg/md/sm; plain wrappers add no level. Controls use lg inside xl or radius-less parents, md inside lg, sm inside md/sm.
- card uses card/card-border. Control primary uses App primary; links and chart accent keep the brand color independently. A selected plain button uses the selected surface, not the brand color.
- btn defaults to outline; primary/secondary/ghost use their semantic colors. Default min-height 28px; xs/sm/lg 20/24/32px; disabled opacity 0.5. Size variants use compact line-height 1 and height may grow with font size and content; text must stay inside the button and never be clipped by a fixed height. Regression covers 14/18px font sizes, adjacent button boundaries and a visible focus outline.
- Plain input/select are 36px high; compact sm/xs 28/24px. Use input background, input-border/hover/focused and focused background; placeholder uses the tertiary foreground. Textarea min-height 64px, padding 8px, native vertical resize kept.
- Checkbox 16px with checked/indeterminate; Switch 32×18px, thumb 16px. Indeterminate hover keeps the primary background and contrast mark rather than the unchecked hover. Standalone export without the host focused token uses a ring border so focus differs from hover. Range keeps native behavior and geometry with unified color and disabled state; no new Slider implementation.
- Keep visible keyboard focus, native select expansion, 44px coarse-pointer targets and the 16px minimum for editable fields (anti-zoom). Fully isomorphic menus are out of scope.

## Single Source and Theme Sync

```text
App styles.css → Gen UI variable mapping → existing HostContext → guest root CSS variables
                                                   ↓
                                      visualize.css → author HTML controls
Standalone export: same visualize.css → light/dark defaults
```

Font size and radius use the MCP standard variables. Dedicated colors use the `zcode/genUiStyles` HostContext extension, validated by the shared schema as Gen UI CSS variable keys with string values. The SDK's standard variable object is a strict enum; no custom keys go into it. New variables live only in the Gen UI projection. Theme/font switches reuse the existing root attribute observation and HostContext path; no cache, timer or extra state source. Size protocol, sandbox registration, workspace identity, desktop continuous and mobile replayable paths are unchanged. Mobile without a Gen UI sandbox keeps the unsupported state; narrow-screen and touch rules still apply in content.

## Expanded Preview

1. Loading state shows a spinning loading icon (hidden from assistive tech) and the text "正在加载…" (English: Loading…) in text-ui-base. Offline and error states show no loading icon.
2. The expanded toolbar shows the existing DialogTitle on the left when the content has a title; a missing title is for accessibility only and does not show "交互视图" (Interactive view). The title is single-line ellipsis with a full `title`, keeps the Dialog `aria-labelledby` link, and right-side action buttons stay reachable. App native components and the inline toolbar are unchanged.
3. Expanded content is a top-layer popover, so the outer Dialog's overflow-hidden cannot clip it. The Gen UI preview anchor inherits the Dialog's left/right/bottom radii via the existing host layer, which syncs radius and applies its own overflow-hidden. The top meets the toolbar and stays square; with the Tweak panel open the bottom meets the panel and stays square. Closing the panel restores the bottom radius without rebuilding the webview. App native Dialog and shared host layer are unchanged.

## Verification

- Mapping unit tests: dedicated control tokens, full font-size/radius set, font changes, missing-item fallback; standard MCP projection unchanged.
- Real Electron regression: light/dark themes, 390/1100px, computed style after font change; nested wrappers do not change radius levels; button variants, input focus/hover/disabled, checkbox checked/indeterminate, switch, native select and textarea; standalone export default styles; host-layer four corners, clipping and instance retention across panel toggles.
- Existing Gen UI E2E: expand/collapse, copy, interaction state, height measurement and scrolling still hold.
- architecture, typecheck, lint, asset hash consistency and focused unit tests.

Evidence: 16 theme/protocol/assembly/asset unit tests and 3 standalone-export vendor tests; focus styles verified via CDP forced pseudo-classes in the active iframe and touch styles via touch emulation in the standalone export iframe, not real devices. Limitations: verified on macOS only; native select menu appearance on Windows/Linux is system-decided and needs visual acceptance on those platforms; no Windows/Linux machines, mobile Web Gen UI support or signed-in production validation.
