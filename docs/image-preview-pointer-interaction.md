# Image preview pointer interaction constraints

## Problem

The desktop fullscreen image preview is a modal Dialog. Opening the Dialog sets the page root interaction layer to `pointer-events: none`; the Electron top area may also take part in window-drag hit testing, and the image viewport captures the pointer while dragging. If the preview does not explicitly restore pointer hit testing, leave the drag region, or clear leftover pointer capture after dragging, the top-right download and close actions show no hover or click feedback.

## Interaction boundaries

```text
Electron native mouse events
        |
        v
Image preview Dialog (pointer-events-auto + app-region:no-drag)
        |
        ├── top action buttons (never captured by the image viewport)
        ├── previous / next
        ├── image drag and zoom (released on pointerup/cancel/lostcapture)
        └── bottom zoom buttons
```

- The preview Dialog must explicitly use `pointer-events-auto` and `[app-region:no-drag]`.
- Every clickable button keeps its existing hover visuals; the interaction fix must not change styling.
- Image dragging is handled only by the preview viewport and must not cover floating buttons' hit areas.
- The image viewport must clear drag state on `pointerup`, `pointercancel`, and `lostpointercapture`; resetting the preview must actively release any remaining pointer capture.
- The top-right action area inside the Electron title-bar range must declare `[app-region:no-drag]` as a whole, wrapping both download and close so two adjacent actions do not form a discontinuous native hit region.
- macOS desktop uses `titleBarStyle: hidden`; its native title-bar hit testing cannot be offset by CSS `no-drag` alone — the top-right action area must sit below the title bar. Web, mobile, Windows, and Linux use their own layouts and do not inherit the macOS safe spacing.
- Desktop and Web share this interaction boundary; Electron-specific attributes must be no-ops on Web.
