# Comparison Baseline for Affected Unit Tests Before Push

When a new branch is pushed for the first time, the remote ref has no comparable commit, so the affected unit-test runner falls back to a default baseline. The default baseline prefers `origin/staging`, then `origin/HEAD`, `origin/main`, `origin/master`, `main` and `master`.

Full test runs are not forced by filenames such as lockfiles, package files, Vitest, TypeScript or gate scripts. Whenever a usable comparison baseline exists, run affected/related unit tests based on the actual changes.

Run the full `pnpm test:unit` suite only when no usable baseline can be found, or when a deleted source file cannot be passed to Vitest related analysis.
