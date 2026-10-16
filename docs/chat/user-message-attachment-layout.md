# User Message Attachment Layout

## Goal

In the conversation timeline, sent file and image attachments appear above the user message bubble rather than taking up space inside it. Desktop and mobile Web remote control share the same structure and display rules.

## Display Structure

```text
User message row (right-aligned)
├─ Attachment area (when media, files, or context references are present)
│  ├─ Media-card row: images + videos (interleaved in insertion order)
│  └─ Pill row: files → comments → webpage elements → PPT elements → conversation references
├─ Conversation bubble (when visible prompt text exists; width determined automatically by its flex item and max width constrained by the conversation container)
└─ Message actions
```

Display rules:

| Attachments/context references | Visible prompt text | Result |
| --- | --- | --- |
| Present | Present | All attachments/references share one row; the bubble appears below |
| Present | Absent | Show only the attachment area; do not render an empty conversation bubble |
| Absent | Present | Show only the conversation bubble |
| Absent | Absent | Do not render the conversation bubble |

Images and videos share the media-card row. First show them as `size-20` (80 CSS px) square cards with `rounded-xl`, interleaved in insertion order. Do not use a real border that participates in the box model; draw the border with a non-interactive `::after` overlay. The reference image is 2x, so do not use the screenshot's physical pixel size directly. For a video in the sent state, after the message row enters the virtual list's visible mount range, resolve the preview source against a stable row target: Desktop local first uses a local-path URL precisely authorized by Main; other platforms, or when the local path is unavailable, read a bounded video Blob. Show the first frame with `<video>` configured without controls, muted, and `playsInline`; fall back to a video icon if reading or decoding fails. Overlay a centered play badge on all grid video thumbnails using the shared preview component: circular, translucent black background, backdrop blur, and a white play icon. The overlay must not intercept card clicks. Images and videos belong to the same media gallery. Its navigation set includes only previewable media in the current user message, in attachment order. Clicking any item opens the gallery at that item's position; previous/next and left/right arrow keys cycle between images and videos. Images retain shared-preview zoom, drag, and download. Videos use native `controls + playsInline` and do not inherit image transforms. Non-media files and comment, webpage-element, PPT-element, and conversation-selection references appear in the next pill row, strictly ordered “file → comment → webpage element → PPT element → conversation reference.” Keep original insertion order within a type. Both rows use `flex-wrap`, naturally wrap when short of space, and remain right-aligned. Copy and Edit actions remain below all user-message content.

Sent videos still use stable row-target authorization. For Desktop local, an artifact/local_ref path must first be resolved through a Host request to Main `realpath` and added to an exact authorization set before creating a local media URL. An absolute path or MIME declaration in a Renderer URL is not authorization. Use a chunked Blob only when an authorized local path cannot be obtained. Reuse the URL obtained while the message row is visibly mounted for both the first-frame thumbnail and gallery playback, avoiding a second read on click. If thumbnail reading fails, allow a new read when the gallery first switches to that video. When moving to another media item, closing the Dialog, or unmounting the message row, abort unfinished temporary reads, pause the current video, and release Blob URLs no longer in use. A read failure applies only to that video item; retain previous/next navigation and close actions. If an image thumbnail read fails, exclude it from the previewable gallery to avoid an empty navigation item. Preview state belongs to the Renderer only; do not write it to session, snapshot, queue, or protocol.

Split the attachment area only by visual type into the media-card row and pill row. Files and the four context-reference types remain direct DOM children of the same pill row; do not add layout wrappers by source or simulate a flat layout with `display: contents`. Align the attachment area and prompt bubble to the same right edge.

Comments, webpage elements, PPT elements, and conversation-selection references reuse one context-attachment pill shell. The shell centrally handles icon, name, group-removal entry, focus styling, and detail popover. Use `pl-3 pr-1.5` when a close button exists in the input; without a close button in the conversation stream, restore symmetric `px-3`. The icon/name content layer handles only `flex min-w-0 items-center gap-1.5`; do not add another radius or horizontal padding. The group-level removal action on the second layer retains existing behavior: a default-hidden `size-5 rounded-full` ghost button appears on pill hover, text changes from `text-foreground-subtle` to `text-foreground`, and its X icon uses `size-3.5`. Each type-specific component supplies only its label, icon, and detail list. Render detail popovers through a Portal without adding a layout node to the message attachment container; reuse Tooltip tokens `bg-tooltip` and `border border-border` for popover background/border.

User attachments in the message stream are on the right. All four context-reference detail popovers use `align="end"` so their right edge aligns with the pill and they open to the left. Keep the default `align="start"` for editor attachments to preserve the existing direction in the input area.

## Acceptance Criteria

- The attachment area and bubble are both right-aligned in the user message row.
- Files, images, and context references are no longer children of the bubble.
- Image/video attachments use clickable `size-20 rounded-xl` media cards. Draw borders with a `::after` overlay without affecting card dimensions; if an image fails to load, show a static image placeholder and mark it unpreviewable.
- For sent videos in a visible message row, resolve a local URL or chunked Blob against a stable row target and show the actual first frame in a control-free `<video>`. Reuse the same source in the gallery. On message-row unmount, release only Blob URLs created by this component; use a static video placeholder on read/decode failure.
- Clicking an image/video card opens the shared media gallery. Within the same message, previewable images and videos follow original attachment order and support previous/next, left/right arrow keys, and wraparound at either end; navigation must not cross messages.
- Image items retain zoom, drag, and download; video items use native `controls + playsInline`. Pause video and reset image transforms when leaving an item.
- Authorize sent videos using a stable row target (`entityId` + original attachment index). Desktop local may play only a canonical path explicitly registered by Main; other platforms read chunks on demand. On failure, retain gallery navigation/retry; abort pending reads and release Blob URLs on close, switch, or unmount.
- Every sent non-image file/reference uses a borderless pill container with `bg-surface` and `rounded-full`.
- File-pill content is a `FileDisplay` file icon plus filename; do not show file size or MIME type.
- An attachment-only message must not produce a blank bubble with background, border, or padding.
- When visible prompt text exists, do not explicitly set `w-fit` or `w-full` on the user bubble; retain the automatic width of a right-aligned flex item. Constrain it to the host width with `max-w-full`; once the named `conversation` container reaches `624px` (`max-w-xl` at `576px` plus `48px` margin), cap it at `max-w-xl`.
- Desktop hover/focus action-bar behavior and the always-visible action bar for mobile remote control remain unchanged.

## Input Attachments

Explicitly split the input attachment area into two layers: first “media (images/videos) → files,” interleaving media by insertion order; second “comments → webpage elements → PPT elements → conversation references.” Each layer has its own `flex-wrap`; context pills must not share the same layout row with media/files. Use `size-12` (48 CSS px) and `rounded-lg` for image/video cards. When both have local `objectUrl`s, include them in the same pre-send media gallery. Clicking any item opens the gallery at that position and supports previous/next, left/right arrows, and wraparound for mixed images/videos in original insertion order. Video cards show their first frame from the local `objectUrl`, using the same circular, translucent black, blurred play badge as the sent state. Use the native player in the gallery; retain zoom, drag, and download tools for images. Use content-driven file cards sized `h-12 w-fit max-w-full rounded-lg`, with a `rounded-md` file-icon base, file icon, filename, and extension; reserve room for the upper-right close button with `pr-6`. Limit the text area to `max-w-40`; keep the filename on one line with ellipsis and expose the full name via the native title on hover. Preserve insertion order within each type. Images and files use the same primary-color close-button structure, `size-3.5 rounded-full bg-primary text-primary-foreground`, positioned at `top-0.5 right-0.5`. Hide by default on desktop, showing on attachment hover or keyboard focus; keep visible on touch devices with no hover.

The inline editor for user messages reuses the two-layer attachment rules above. Even if the original attachment order in a historical message puts a file first, show media (images/videos) before files in the first layer while preserving media order; retain original attachment indexes as the basis for deletion and submission. In the second layer, parse comments, webpage elements, PPT elements, and conversation references from the prompt's trailing protocol and display them as context pills in the same fixed order as the main input. Show only visible prompt text in the edited body, not raw context-protocol text. On context deletion, reserialize only the remaining context at submission. Edit mode must not fall back to sent-message `size-20` image thumbnails or file pills; read-only sent-message styles are unaffected by edit-mode rules.
