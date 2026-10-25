# ZCode release notification card

## Goal

After a formal release, `release:notify:feishu` uses Zara to send a Card 2.0 update note to the configured Feishu
groups. The card content comes from the infra-edited shared-directory `macos-arm64/latest.yml.releaseNotes`, and
keeps a clear, restrained information hierarchy on both mobile and desktop.

## Information structure

- Header: version number, formal-release status and a notification icon, in the blue theme.
- Summary block: shows only "本次更新已发布" (this update has been released) and the counts of new features / bug
  fixes; it shows no CI, publisher or internal address.
- Changelog: shows only non-empty sections; "新功能" (new features) expands first, a pure-fix version expands
  "问题修复" (bug fixes) directly, and unknown headings go under "其他更新" (other updates) keeping the complete
  entries.
- Links: the bottom keeps only two jump buttons, to the official site and docs, producing no server callbacks.

## Visuals and compatibility

- Use Card 2.0 `schema: "2.0"` and `default` width.
- The main colors are limited to blue, white and gray; no gradients, large images, celebration emoji or
  high-saturation decoration.
- Long text density is controlled with container padding, light backgrounds and collapsed sections, not stacked
  large headings.
- The Feishu conversation preview must contain the version number; the card may be forwarded, and Feishu itself
  degrades the display for unsupported old clients.

## Sending boundary

- Test tags, sandbox releases and `ZCODE_ENV=test` do not send the formal notification.
- Only after a stable release succeeds does a manual `release:notify:feishu` send.
- A tag pipeline automatically uses `CI_COMMIT_TAG` as the version; a non-tag rehearsal with
  `CI_RELEASE_BRANCH=1` must provide `ZARA_RELEASE_NOTIFY_VERSION` explicitly, otherwise the notify job fails
  before calling Zara.
- The default recipients cover the 5 confirmed ZCode users and the internal and platform beta groups; they are
  maintained uniformly through the comma-separated `ZARA_RELEASE_NOTIFY_RECEIVE_ID`, and the CI regression
  assertion is updated when a group is added.
- The formal notification reads `releaseNotes` of `${ZCODE_CI_SHARED_ROOT}/${TARGET_OUTPUT_DIR}/macos-arm64/latest.yml`;
  a missing manifest, a version different from the notified version or empty notes fail directly, without
  falling back to the repo `CHANGELOG.md`.
- Each recipient is sent independently with a stable Feishu `uuid` derived from "version + recipient"; one
  group's failure does not stop later groups, and the final error lists the failures. After Feishu's one-hour
  de-duplication window, failed groups can only be re-sent precisely through
  `ZARA_RELEASE_NOTIFY_RETRY_RECEIVE_ID`.
- Before sending, Markdown link targets and bare internal-network URLs are removed, and a card over the 24 KiB
  safety budget is refused, leaving serialization margin under Feishu's 30 KiB request limit.
- dry-run outputs only the card JSON and does not call the Feishu API.
- Zara/Feishu failure logs keep only the status code, error code and a sanitized summary of at most 500
  characters, never the full third-party response.
