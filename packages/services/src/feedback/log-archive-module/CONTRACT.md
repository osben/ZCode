# services-feedback

Diagnostic log archive builders used by feedback upload and Desktop log export. Only `feedbackLogArchive.ts` and `compactLogArchive.ts` (one level up; the upstream files stay in place) belong to this module; the feedback service and HTTP client stay unmanaged.

Invariants:

- Each source declares a content policy; `cli-memory` (3.18.1 backport, `specs/upstream-backport-3.18.1.md`) reads at most 16 files of at most 64 KiB from `~/.zcode/cli/memory-diagnostics`, parses each whole file, re-sanitises it with `sanitizeCliMemoryDiagnostic` and skips invalid files with `invalid-memory-diagnostic`.
- Archive building never fails because of one unreadable or oversized file; skips are listed in the archive notes.
