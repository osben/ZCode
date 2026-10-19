// Pre-commit counterpart of lint-staged.config.mjs, kept in a separate file on
// purpose: scripts/run-affected-unit-tests.mjs reuses the shared config via
// `lint-staged --diff` during pre-push, so tasks added there would also run at
// push time — and a formatter in write mode would rewrite working-tree files
// mid-push. This file is only consumed by the pre-commit job in lefthook.yml.

// The task is a plain string on purpose: lint-staged appends the matched
// staged files to string tasks directly as spawn argv — no shell, no
// string-argv parsing — which keeps filenames containing quotes, spaces or
// percent signs intact. (Function tasks get no appended files and would have
// to embed the list into a command string; that route corrupted paths with
// apostrophes because string-argv does not understand POSIX quote escapes.)
// scripts/run-pre-commit-checks.mjs then runs oxfmt (write mode) and oxlint
// over the appended paths in a fixed order.

// The glob covers exactly the files `pnpm fmt:check` checks (one shared list
// in scripts/fork-format.mjs; spec: specs/fork-format-scope.md), so a fork
// edit to e.g. a .yml file is formatted here instead of failing later in CI.
// oxlint simply finds nothing lintable in the non-JS types.
import { formattableFilesGlob } from "./scripts/fork-format.mjs";

export default {
  [formattableFilesGlob()]: "node scripts/run-pre-commit-checks.mjs",
};
