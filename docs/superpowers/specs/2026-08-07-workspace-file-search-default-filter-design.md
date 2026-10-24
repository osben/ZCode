# Workspace File Search Default Filter

> Status: design confirmed, 2026-08-07. The `.zcodeignore` single-source-of-truth chapter was added 2026-09-15
> (ZCT-2096811705629528064).

## 2026-09-28 Auto-creation temporarily disabled

The UI entry for managing workspace search rules is temporarily hidden, and the `.zcodeignore` auto-creation
code and its logs are commented out; the implementation is kept for later restoration. The auto-creation
behavior in the 2026-09-15 chapter below does not run in the meantime; the rest of rule matching and the
explicit save API are unchanged.

```text
search → workspace File Service → .zcodeignore exists: read the rules
                               └→ file missing: .gitignore + default rules, in memory only
```

Desktop and remote workspaces share this rule-loading path; the session/task stream and the
continuous/replayable boundaries are unchanged.
Acceptance: search does not create `.zcodeignore`, the in-memory rules still filter build/dependency
directories, and a manually provided `.zcodeignore` still takes effect.

## Background

The Composer `@` file candidates, the Command Center workspace file search and the Workspace File Tree search
all call `IFileService.listWorkspaceFiles`. The old implementation hard-coded the default blacklist as a
boolean function and pruned every directory starting with `.` wholesale, so user files under
`.github/workflows`, `.vscode` and similar could not be found by name; generic names and suffixes such as
`build`, `vendor`, `*.map` and `*.min.js` were also over-filtered.

September 2026 addition: after the blacklist stopped excluding build directories such as `bin`/`obj`, the `@`
index of .NET-style workspaces traversed tens of thousands of files under `obj/` and `bin/Debug`, spinning for
seconds and raising renderer filtering cost (ZCT-2096811705629528064). The index ignored repository ignore
semantics although build outputs are almost always in `.gitignore`; this repo converges it to a workspace-level
`.zcodeignore` single source of truth (own chapter below).

## Goals of the first phase

- Wrap the workspace file blacklist in a stable filter interface internal to the service, with a default
  implementation that fixes the over-broad default rules.
- `fileService` depends only on the finally injected filter (the default when none is injected); a full
  replacement (not a union with the default blacklist) lets a custom filter re-include `node_modules`, `.env`
  and similar. Custom rule sources (file, settings page) compile into the same interface; reading ignore files
  and the settings editor landed with the `.zcodeignore` chapter below.
- Not in scope: passing rules via renderer/RPC; merging default and custom rules (`.zcodeignore` is the only
  rule file).

```text
now:    createFileService() └─ DefaultWorkspaceFileSearchFilter └─ default blacklist
future: custom rule source └─ CustomWorkspaceFileSearchFilter └─ injected into createFileService (full replacement)
```

## Filter contract

The filter receives the full context of one workspace entry: `name`, `path`, `relativePath`, `type`.

It decides separately:

- `include`: whether the entry is returned to the search caller;
- `traverse`: for a directory entry, whether to keep scanning its descendants.

Splitting the two decisions is what makes hidden directory behavior correct:

```text
ordinary dir src/                   include=true   traverse=true
hidden dir .github/                 include=false  traverse=true
default-excluded dir node_modules/  include=false  traverse=false
ordinary file App.tsx               include=true   traverse=false
```

File system errors such as unreadable or vanished paths are not the content filter's concern and stay with
`fileService`. Directory symlinks and Windows Junctions are first passed to the filter by target type, but the
index does not recurse along links, avoiding link loops and scanning beyond the workspace root.

## Default rules

### Default-excluded directories

The default filter keeps excluding, and stops traversing, explicit heavy dependency, cache, report or tool
internal directories, including:

- `.git`, `.hg`, `.svn`;
- `node_modules`, `bower_components`, `jspm_packages`;
- `__pycache__`, `site-packages`, `venv`;
- `coverage`, `htmlcov`, `lcov-report`;
- `CMakeFiles`, `cmake-build-*`, `bazel-*`, `Pods`, `DerivedData`;
- `storybook-static`, `playwright-report`, `test-results`, `allure-results`, `allure-report`, `cdk.out`;
- `eggs`, `pip-wheel-metadata`, `wheels`, `*.egg-info`, `*.dist-info`.

These rules are only the default implementation and not a safety boundary that a future custom filter cannot
override.

### Hidden paths

- An ordinary hidden directory itself is not a candidate, but its descendants keep being scanned.
- `.github/workflows/release.yml` is found by searching `release`, but `.github` does not occupy a directory
  candidate for an empty query.
- Ordinary hidden files such as `.gitignore` are candidates.
- `.env` and `.env.*` are excluded by the default filter, including same-named files inside hidden
  directories.
- `.git`, `.hg`, `.svn` still stop traversal under the explicit directory rule.

### No longer excluded by default

These names may hold user-maintained source, scripts or config and were removed from the default directory
blacklist in the first phase:

- `vendor`, `env`, `dist`, `build`, `out`, `target`;
- `bin`, `obj`, `classes`, `_build`, `deps`, `dist-newstyle`, `renv`.

These file suffixes are also no longer excluded by default: `*.map`, `*.min.js`, `*.min.css`.

No ranking weight is introduced in the first phase; the restored content takes part in the existing search and
ordering as ordinary candidates.

### Files still excluded by default

Explicit compile caches, binaries and package artifacts stay excluded by default, for example `.pyc`, `.class`,
`.dll`, `.exe`, `.o`, `.jar`, `.so`, `.tsbuildinfo`, and `coverage.out`, `lcov.info`.

## `.zcodeignore`: single source of truth for workspace search ignores (2026-09-15)

### Role and data flow

`.zcodeignore` is the **only rule file** under the workspace root that controls this workspace's file search
index (gitignore syntax). It is not a second layer parallel to `.gitignore`: the first time rules are needed
and the file does not exist, the Host automatically creates a `.zcodeignore` containing "a copy of the root
`.gitignore` + a comment-separated built-in default exclusion section"; afterwards search follows only
`.zcodeignore`, and later `.gitignore` changes do not affect search (the user can rebuild explicitly with
"re-sync from .gitignore" in settings). The extra default section (node_modules/ etc.) is a behavior
compatibility requirement: for a repository whose `.gitignore` does not declare those directories, a pure copy
would release dependency directories to a full scan and regress performance; the user removes the section to
release the matching directories, keeping the promise that "the rule file is the only directory source of
truth, with no code-level union". `.zcodeignore` itself is tool configuration and is not an `@` candidate.

```text
workspace root
  ├─ .gitignore ──(copied once)──┐
  │                              ▼
  └─ .zcodeignore <──auto-created── Host: before listWorkspaceFiles scans
        ▲                        │ missing → atomic create (gitignore copy + default exclusion section;
        │                        │   no .gitignore → explanatory comment + default exclusion section)
        │                        │ read/create fails → fail-open: run with equivalent in-memory content, do not block the scan
        │                        ▼
        │            ignore package parsing (gitignore spec 2.22 reference implementation)
        │                        ▼
        │            directory hit → whole subtree not traversed; file hit → not a candidate
        │
  Settings "Workspace search" (工作区搜索) section
        ├─ fileService.readWorkspaceFileSearchIgnore (resolved via the workspace service; remote = remote Host)
        ├─ textarea edit → writeWorkspaceFileSearchIgnore (atomic write, effective on the next scan)
        ├─ "Sync from .gitignore" (从 .gitignore 同步) button (section operation: rewrites only the gitignore sync section)
        └─ "Restore default rules" (恢复默认规则) button (section operation: resets only the default exclusion section)
```

### Rule semantics

- Parsing is delegated to the `ignore` npm package (same as ESLint, the gitignore spec reference
  implementation), covering later-overrides-earlier, `!` negation (including git's native constraint that a
  child file cannot be re-included once its parent directory is excluded), anchored and basename matching,
  cross-level `**`, the directory suffix `/`, character classes and escapes. Hand-written parsing is forbidden
  (repo-wiki's private subset implementation does not satisfy these semantics).
- Only the single workspace-root `.zcodeignore` exists; subdirectory `.gitignore`/`.zcodeignore` files are not
  merged (transparent semantics, editable as a whole; a deliberate simplification of ripgrep's nested
  semantics).
- The rules affect only the "search index" (`@` candidates / Command Center / File Tree search), not file tree
  browsing, upload, Agent file access or other file capabilities.
- The built-in `defaultWorkspaceFileSearchFilter` keeps file-level rules (`.env`/binary suffixes) and the
  searchable-hidden-directory-descendants semantics, executed in addition to the `.zcodeignore` rules; its
  directory blacklist part is retired into "initial content of the default template + fail-open fallback" and
  is no longer a union rule on the regular path.

### Auto-creation and fail-open

- On the first scan, if `.zcodeignore` does not exist, create it with an atomic write (temp file in the target
  directory + rename; content is deterministically identical, so concurrent creates overwriting each other are
  harmless). Content = root `.gitignore` copy + comment-separated built-in default exclusion section; without
  `.gitignore` = explanatory comment + default exclusion section (behavior consistent with the old default
  blacklist).
- If creation or reading fails (read-only filesystem, permissions), execute with equivalent in-memory content
  (the "copy + default section" if `.gitignore` is readable, else the default section only). Degradation must
  log a warn and must not interrupt the scan (the `@` panel must not fail because the rule file is
  unavailable).
- Creation/degradation events are low-frequency lifecycle events logged at info/warn, not flooding the scan
  hot path.

### Multi-client boundary

Reading, creating and matching `.zcodeignore` all happen in the file service Host on the machine where the
workspace lives (local = the window's Local Host utility process; remote = the remote zcode-server process).
The settings page reaches the same Host through workspace service resolution, so it naturally writes to the
right machine. The UI keeps no second copy of the rules and does no local prediction.

## Multi-client and call boundary

Filtering happens in the Host of the corresponding workspace's file service: a local workspace uses the Local
Host, a remote workspace the Remote Host. The UI does not read local paths to infer remote filtering results
and keeps no second blacklist.

Session/task stream, continuous/replayable, remote attachment and workspace identity semantics are unchanged.
Composer `@`, Command Center and Workspace File Tree search share `listWorkspaceFiles` and so use the same
default filter. File tree search reuses only the candidate index, Host filtering and fuzzy match ordering;
after search it follows the file tree's own behavior, such as opening `PreviewPane` or locating/expanding a
directory, and inserts no Composer mention.

## Acceptance

- Descendants of ordinary hidden directories such as `.github` can be found by file name, while the hidden
  directory itself is not a candidate.
- `.git` and `node_modules` are not candidates by default and their descendants are not scanned.
- `.env`, `.env.*` are not candidates by default; `.gitignore` can be a candidate.
- Files once filtered for generic directory names or `.map`, `.min.js`, `.min.css` are restored as ordinary
  candidates.
- After injecting a replacement filter the default rules no longer run additionally; the replacement may
  include `node_modules` and `.env`.
- Unreadable-directory tolerance, the return structure and existing ordering are unchanged.
- Workspace File Tree search and `@` file candidates use the same candidate set and match ordering for the same
  workspace and query; the difference shows only in the post-search UI behavior.

`.zcodeignore` (2026-09-15) additional acceptance:

- The first scan auto-creates `.zcodeignore` with a `.gitignore` copy + built-in default exclusion section;
  without `.gitignore`, an explanatory comment + default exclusion section (behavior consistent with the old
  built-in blacklist). `.zcodeignore` itself is not a candidate.
- A directory hit by `.zcodeignore` is not traversed at all and a file hit is not a candidate; `!` negation,
  anchored, `**` and the directory suffix `/` follow git semantics (guaranteed by the ignore package).
- Editing `.gitignore` does not change search results for an existing `.zcodeignore`; after "Sync from
  .gitignore" in settings the new content takes effect.

Section operations (added 2026-09-15): `.zcodeignore` is internally divided by two marker comment lines: the
gitignore sync section (above the SYNC marker), the default exclusion section (between the two markers) and the
custom rules section (below the DEFAULTS marker). "Sync from .gitignore" rewrites only the gitignore sync
section; "Restore default rules" resets only the default exclusion section; the user's edits to the default
section (such as releasing node_modules) and the custom rules section are never overwritten by either button.
When the marker lines were deleted (old format/manual cleanup), the sections cannot be located structurally and
the buttons degrade to rebuilding the whole initial content. Both buttons only fill the result into the editor;
saving writes to disk.

- A read-only filesystem or permission failure does not interrupt the scan, and the degradation chain
  (.zcodeignore → .gitignore → built-in blacklist) produces a warn log.
- Rule reading/creation/matching for a remote workspace happens in the remote Host, consistent with local
  behavior.
