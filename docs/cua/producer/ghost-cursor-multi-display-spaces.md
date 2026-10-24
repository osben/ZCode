# Ghost cursor overlay multi-display visibility (window follows the target screen)

## Problem

The ghost cursor overlay used to be **one** borderless window covering the union of all displays
(`ComputeDisplayUnion()`). macOS defaults to "Displays have separate Spaces" (`com.apple.spaces
spans-displays` unset / false); there a window spanning several screens appears only on **the screen where
it has the largest area**, and the canvas on other screens is never shown.

Measured (2026-10-10, primary 1512x982 + external 2560x1440 on the left): the union window was
`[-2560,-458, 4072x1440]` and appeared only on the external screen; all CUA action feedback on the laptop
screen (glide, ripple, focus-rect, keyboard cue) was invisible while native `ghostState().shown` still
reported `true`. With a single screen the union is that screen, so the problem occurs only with multiple
screens + default Spaces.

## Decision

The overlay stays a **single window**, but its frame changes from "the whole union" to "**the screen of the
current feedback point**":

1. Before feedback lands on a global DIP point (pointer move, click ripple, focus-rect, screen-configuration
   change), compute the `NSScreen` containing the point; if it differs from the window's current frame,
   `setFrame` to that screen.
2. On a frame change, reuse the `ScreenParamsChanged` position-preserving logic: read the dot/bloom position
   back to global DIP from the old frame, switch frame, then map back to new content-local coordinates.
3. If the point is in no screen (race right after a screen is unplugged), fall back to the nearest screen,
   then the primary screen, without throwing.
4. The coordinate system is unchanged: layer writes still go through `GlobalDipToContent` (converted from the
   `g_window.frame` origin), and the CG-global to NS-global flip base is still the primary-screen height.

### Known cost

A cross-screen glide jumps at the screen boundary: once the window switches to the new screen, the part of
the animation path on the old screen is outside the window. CUA actions usually land in one target window and
cross-screen moves are rare, so this is accepted.

## Second root cause: flip base used the key window's screen

After the window-follows-screen fix, a real machine still showed "clicking the search box on the external
screen shows no cursor, scrolling in the map area does". Converting CG-global (top-left origin) to NS-global
(bottom-left origin) used `NSScreen.mainScreen` for the flip base height. Its semantics is **the screen of the
key window**, not the primary display at origin (0,0): with focus on the external screen it returns 2560x1440,
the base goes from the primary's 982 to 1440, and all feedback shifts down 458px. The top of the external
screen then falls outside the overlay window, so the top search-box click is invisible while the lower map
area is visible.

Decision: all flips, frame read-backs and fallback frames use `PrimaryScreenFrame()` (the first screen of
`[NSScreen screens]`, i.e. the primary display). CG-global coordinates already use the primary display's
top-left as origin. The issue depends on which screen has focus; earlier live cases passed only because
focus happened to be on the primary screen.

### Rejected

"One overlay window per screen" would keep cross-screen animation, but show/hide, level, the occlusion
probe's exclusion of the overlay itself (`g_window_server_id`) and capture switches would all become
multi-window, with a clearly larger change surface and risk.

## Invariants

- The screen containing the feedback point matches the overlay window frame: `ghostState().windowFrame`
  equals that screen's frame (CG-global DIP, top-left origin).
- The dot's on-screen position does not change across a frame switch (no jump).
- The overlay window identity (window number) is unchanged, so the occlusion probe's self-exclusion logic
  needs no change.

## Verification

- Source contract: the window frame no longer uses `ComputeDisplayUnion()`; `MoveGhostTo` / ripple /
  focus-rect / `ScreenParamsChanged` all go through `EnsureWindowOnScreenForGlobalDip` first.
- Live (`ZCODE_CUA_LIVE_NATIVE=1`): `ghostMove` to the center of each active display and assert
  `windowFrame` equals that display's bounds.
- Real machine: with multiple screens + default Spaces, the cursor is visible to the eye on both screens
  (screenshots are useless for this window; default `NSWindowSharingNone`).
