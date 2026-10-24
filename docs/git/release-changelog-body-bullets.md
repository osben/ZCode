# Release Changelog Body Bullets

`npm run release` uses `release-it` to generate the version changelog. The configuration lives in `.release-it.mjs` because `@release-it/conventional-changelog` `writerOpts.transform` and the template need JavaScript functions, which JSON configuration cannot express.

Generation rules:

- The commit header is grouped by Conventional Commits: `feat` enters `Features`, `fix` enters `Bug Fixes`.
- Independent bullets in the commit body (`- xxx`, `* xxx`, `+ xxx`) are appended under that commit entry.
- Non-bullet paragraphs do not enter the changelog.
- `BREAKING CHANGE` / `BREAKING-CHANGE` are handled by the conventional changelog notes mechanism and are not output as normal body bullets.

Example:

```text
fix(web-remote): harden mobile reconnect flow

- add safe home-only services
- extend workspace reconnect timeout
```

Generates:

<!-- prettier-ignore -->
```md
* **web-remote:** harden mobile reconnect flow ([38dd68b](...))
  * add safe home-only services
  * extend workspace reconnect timeout
```

Implementation: `scripts/release-it/changelog-writer.mjs`.
