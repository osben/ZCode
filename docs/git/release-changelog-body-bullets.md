# Release Changelog Body Bullets

Update date: 2026-05-08

`npm run release` uses `release-it` to generate version changelog. Release configuration migrates to `.release-it.mjs`, because `@release-it/conventional-changelog` `writerOpts.transform` and template require JavaScript functions, JSON configuration cannot express.

Generation rules:

- commit header continues to be grouped by Conventional Commits, e.g. `feat` enters `Features`, `fix` enters `Bug Fixes`
- independent bullets in commit body such as `- xxx`、`* xxx`、`+ xxx` will be appended under that commit entry
- non-bullet paragraphs do not enter changelog
- `BREAKING CHANGE` / `BREAKING-CHANGE` are still handled by conventional changelog notes mechanism, not output as normal body bullet

Examples:

```text
fix(web-remote): harden mobile reconnect flow

- add safe home-only services
- extend workspace reconnect timeout
```

Will generate:

```md
* **web-remote:** harden mobile reconnect flow ([38dd68b](...))
  * add safe home-only services
  * extend workspace reconnect timeout
```

Related implementation: `scripts/release-it/changelog-writer.mjs`.
