# Open-source Export Integrity

## Scope

Create a fix branch from the latest staging and repair the export tooling, placeholder types, docs
and test metadata. Application runtime logic, protocol values, request timing, UI behavior and test
assertions stay unchanged.

## Contract

1. The Computer Use placeholder package provides public build and type-check entries, and its log
   callback types match the real producer; the build only verifies the bundled declarations and
   produces no native capability; the root unit-test project entry is kept and verifies the
   placeholder behavior.
2. Orphaned-test detection matches by full file name or path and must not delete public tests
   because file names share a substring.
3. The public case catalog, coverage matrix and account fixture tests keep being exported;
   official-version-specific content goes into existing topic files.
4. Docs and comments describe this project's behavior, with personal paths, accounts and product
   benchmarking removed; protocol, provider and compatibility-import names stay.
5. The competitor gate recognizes full names, allows explicit pagination terms and protocol keys; a
   descriptive product mention on the same line is still blocked.
6. The E2E manifest `providerFixtures` points to existing upstream fixtures; candidate specs are not
   moved and the promotion state is not changed.
7. License identification fixes are bound to the exact package version and the publisher's original
   text; no broad allowlist or updated hash may mask a material gap.
8. The latest version in the open-source README matches the source version.

### Legacy admission for an independent Git history

After export, lint and architecture checks cannot depend on unpublished Git objects. The exporter
first verifies that the existing admission commit belongs to the specified source ref, then
generates a fixed manifest of Git blobs and file modes for source that still matches the admitted
version after export, while keeping upstream-added public paths. The open-source policy uses this
manifest; the closed-source side keeps the original commit admission; the two sources cannot be
enabled together.

The manifest describes only the files made public this time, does not reveal excluded paths, and
does not automatically admit rewritten files. Newly added paths are filtered by the rule effective
date of the specified source ref; the export commit date must not bring legacy paths that were not
retroactive back into admission. Legacy paths entering the public history for the first time are
stored with fixed content and mode, only restoring the date attribution of the source history; they
do not take part in lint line-count admission. The checker compares both the staging area and the
working tree; edits after commit, restore after staging, renames, mode changes and untracked files
cannot inherit the exemption. Legacy admission reuses only the original max-lines and
unmanaged-new-file rules and exempts no other lint or module-structure errors.

```text
specified source ref + merged admission commits -> exporter -> fixed content and mode manifest of public files
                                           ↓
staging area + working tree in the independent open-source history -> compare as is -> original lint / architecture rules
```

Regression must run in a brand-new Git repository, proving the check works without closed-source
commit objects and covering exiting admission after a modification. The placeholder package's
`vitest.config.ts` only assembles the unit-test project and registers that test config by exact
path; it is not widened to producer implementation files.

## Acceptance

- First reproduce the placeholder build/type problem, the orphan-test wrong deletion and the term
  false positive, then verify the fix.
- Re-export; the hard gate is zero; public docs and tests exist; the patch stack is empty.
- In the independent open-source tree, install with a frozen lockfile and run the build entry, root
  and CLI type checks, lint, the full unit tests and the coverage-manifest audit.
- On the closed-source side run the architecture check, affected tests, type check and lint. The
  fixture check covers all modified manifests.
- Basic license checks and strict material checks are reported separately; existing material gaps do
  not count as fixed.
