# Update button release notes hover

## Background

After the desktop auto update finishes downloading, the top-left update button only shows an "installable
update" entry. The release chain already injects the single-version changelog into the update feed's
`releaseNotes`, but the renderer does not show it when the button is hovered.

## Goals

- Hovering the update button shows the changelog of the version being downloaded or installable.
- The displayed content follows the UI language: `zh-CN` prefers the Chinese changelog and `en-US` the English
  one.
- The main flow of auto check, download and install is unchanged.
- Hover adds no network request, so the update feed/CDN state does not affect UI responsiveness.

## Design

When collecting desktop artifacts, CI keeps the electron-updater-compatible `releaseName` / `releaseNotes`
fields and additionally appends `releaseNotesByLocale` to the update YAML. The field holds the title and
Markdown for `zh-CN` and `en-US`, for new-version clients to read directly from the `update-downloaded` event
payload.

On `update-available` the main process already normalizes the multi-language release notes into
`PostUpdateReleaseNotesPayload.releaseNotesByLocale` and broadcasts it to the renderer with the
`update-available` / `download-progress` states; after download completes it keeps broadcasting with
`update-downloaded` and persists it for the post-install popup. The old `onUpdateReady(version)` event is kept
for compatibility only; the button displays details from `UpdateStatePayload.releaseNotes`.

The main process treats the manifest electron-updater currently read as the `zh-CN` content; to fill in the
English notes it fetches the same server manifest endpoint again and merges it as the `en-US` content. The extra
request keeps the current `platform` / `device_mid` / `channel` query parameters and the `X-Platform` /
`X-Release-Channel` / `X-Device-Mid` headers. This extra read only affects the release notes payload and takes
no part in version judgment, download URL resolution or installer verification, so the main auto-update flow is
unchanged.

The UI layer reuses the existing tooltip and Markdown rendering: with no release notes the original short
tooltip stays; with release notes, hovering the downloading button or update button shows a compact popover
whose title is fixed to `v{version} 更新日志` / `v{version} Release Notes` in the current language; below the
title only the feed `releaseDate` date formatted in the current language is shown, with no extra "更新日期" or
"Release date" prefix; the body renders the corresponding Markdown. If the current language has no content, it
falls back to the payload's default Markdown. The button's visible short copy, aria label, confirm dialog and
downloading hint all go through i18n.

## Verification

- A YAML injection test covers `releaseNotesByLocale`.
- Auto-update main-process tests cover the `update-available`, `download-progress` and `update-downloaded` states
  carrying release notes.
- A UI unit test covers the hover tooltip choosing Chinese/English Markdown by the current locale.
- A main-process test covers the default feed merged with the English sibling feed and broadcast to the
  renderer with the state.
