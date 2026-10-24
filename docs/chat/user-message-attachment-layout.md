# User Message Attachment Layout

In the conversation timeline, sent file and image attachments appear above the user message bubble rather than inside it. Desktop and mobile Web remote control share the same structure and display rules.

## Display structure

```text
User message row (right-aligned)
├─ Attachment area (when media, files, or context references are present)
│  ├─ Media-card row: images + videos (interleaved in insertion order)
│  └─ Pill row: files → comments → webpage elements → PPT elements → conversation references
├─ Conversation bubble (when visible prompt text exists; width determined automatically by its flex item and max width constrained by the conversation container)
└─ Message actions
```

| Attachments/context references | Visible prompt text | Result |
| --- | --- | --- |
| Present | Present | All attachments/references share one row; the bubble appears below |
| Present | Absent | Show only the attachment area; no empty bubble |
| Absent | Present | Show only the bubble |
| Absent | Absent | No bubble |

Layout rules:

- Split the attachment area only by visual type into the media-card row and the pill row. Files and the four context-reference types are direct DOM children of the same pill row: no layout wrappers by source and no `display: contents` to fake a flat layout. Both rows use `flex-wrap` and stay right-aligned. Order inside the pill row is strictly file → comment → webpage element → PPT element → conversation reference, keeping insertion order within a type. The attachment area and prompt bubble align to the same right edge. Copy and Edit actions stay below all user-message content.
- Images and videos share the media-card row as `size-20` (80 CSS px) square cards with `rounded-xl`, interleaved in insertion order. The border is a non-interactive `::after` overlay, not a real border that participates in the box model (the reference image is 2x; do not use its physical pixel size).
- Comments, webpage elements, PPT elements and conversation-selection references reuse one context-attachment pill shell that centrally handles icon, name, group-removal entry, focus styling and detail popover. Use `pl-3 pr-1.5` when the input shows a close button; without a close button in the conversation stream use symmetric `px-3`. The icon/name layer is only `flex min-w-0 items-center gap-1.5`, with no extra radius or horizontal padding. The group removal action keeps its behavior: a default-hidden `size-5 rounded-full` ghost button appearing on pill hover, text going from `text-foreground-subtle` to `text-foreground`, X icon `size-3.5`. Each type supplies only label, icon and detail list. Detail popovers render through a Portal without adding a layout node to the attachment container and reuse Tooltip tokens `bg-tooltip` and `border border-border`.
- In the message stream, the four context-reference detail popovers use `align="end"` (right edge aligned with the pill, opening leftward). Editor attachments keep the default `align="start"`.

### Video thumbnails and gallery

- Video thumbnails show the first frame in a `<video>` without controls, muted, `playsInline`; fall back to a video icon if reading or decoding fails. All grid video thumbnails overlay a centered play badge from the shared preview component (circular, translucent black, backdrop blur, white play icon) that must not intercept card clicks.
- Images and videos belong to one media gallery. Its navigation set is only the previewable media of the current user message, in attachment order and never crossing messages. Clicking any item opens the gallery there; previous/next and left/right arrow keys cycle (wraparound) between images and videos. Images keep shared-preview zoom, drag and download; videos use native `controls + playsInline` and do not inherit image transforms. Pause video and reset image transforms when leaving an item. An image whose thumbnail fails to load shows a static placeholder and is excluded from the previewable gallery.
- Sent-video preview source is resolved against a stable row target (`entityId` + original attachment index) once the message row enters the virtual list's visible mount range. Desktop local first uses a local-path URL precisely authorized by Main: an artifact/local_ref path is resolved via a Host request to Main `realpath` and added to an exact authorization set before a local media URL is created. An absolute path or MIME declaration in a Renderer URL is not authorization. Only if no authorized local path is obtainable, read a bounded video Blob in chunks (other platforms always do this).
- The URL obtained while the row is visibly mounted is reused for both the thumbnail and gallery playback (no second read on click). If thumbnail reading fails, a new read is allowed when the gallery first switches to that video. On moving to another item, closing the Dialog or unmounting the row: abort unfinished temporary reads, pause the current video and release only Blob URLs created by this component. A read failure applies only to that video item; previous/next and close remain. Preview state belongs to the Renderer only and is never written to session, snapshot, queue or protocol.

## Acceptance criteria

- Attachment area and bubble are both right-aligned in the user message row; files, images and context references are not children of the bubble.
- Image/video attachments are clickable `size-20 rounded-xl` media cards; borders use the `::after` overlay without affecting card size; an image that fails to load shows a static placeholder and is marked unpreviewable.
- Sent videos in a visible row show the actual first frame (local URL or chunked Blob) in a control-free `<video>`, reuse the same source in the gallery, use a static video placeholder on read/decode failure, and on row unmount release only this component's Blob URLs.
- Gallery behavior as above: ordered by attachment order within one message, previous/next, arrow keys, wraparound; image zoom/drag/download retained; video native controls.
- Desktop local plays only a canonical path explicitly registered by Main; on failure keep gallery navigation/retry.
- Every sent non-image file/reference uses a borderless pill with `bg-surface` and `rounded-full`. File-pill content is a `FileDisplay` file icon plus filename, with no file size or MIME type.
- An attachment-only message produces no blank bubble with background, border or padding.
- With visible prompt text, do not set `w-fit` or `w-full` on the bubble: keep the automatic width of a right-aligned flex item, constrained by `max-w-full`; once the named `conversation` container reaches `624px` (`max-w-xl` at `576px` plus `48px` margin), cap at `max-w-xl`.
- Desktop hover/focus action-bar behavior and the always-visible action bar for mobile remote control are unchanged.

## Input attachments

The input attachment area has two layers: first "media (images/videos) → files", interleaving media by insertion order; second "comments → webpage elements → PPT elements → conversation references". Each layer has its own `flex-wrap`; context pills never share a layout row with media/files.

- Image/video cards are `size-12` (48 CSS px) with `rounded-lg`. When both have a local `objectUrl` they join the same pre-send media gallery, with the same open-at-position, previous/next, arrow and wraparound behavior in insertion order. Video cards show the first frame from the local `objectUrl` with the same circular translucent-black blurred play badge as the sent state; the gallery uses the native player and images keep zoom, drag and download.
- File cards are content-driven `h-12 w-fit max-w-full rounded-lg` with a `rounded-md` file-icon base, file icon, filename and extension; reserve `pr-6` for the upper-right close button. Text area `max-w-40`; filename on one line with ellipsis and the full name in the native title on hover. Insertion order is preserved within each type.
- Images and files share the same close button: `size-3.5 rounded-full bg-primary text-primary-foreground` at `top-0.5 right-0.5`; hidden by default on desktop and shown on attachment hover or keyboard focus; always visible on touch devices.

The inline editor for user messages reuses the two-layer rules. Even when a historical message's original order puts a file first, media (images/videos) show before files in the first layer, preserving media order; original attachment indexes remain the basis for deletion and submission. In the second layer, comments, webpage elements, PPT elements and conversation references are parsed from the prompt's trailing protocol and shown as context pills in the same fixed order as the main input. The edited body shows only visible prompt text, not the raw context protocol. On context deletion only the remaining context is reserialized at submission. Edit mode must not fall back to the sent-message `size-20` thumbnails or file pills, and read-only sent-message styles are unaffected by edit-mode rules.
