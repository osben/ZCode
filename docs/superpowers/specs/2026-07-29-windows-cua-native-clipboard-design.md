# Windows CUA Native Text Clipboard Design

## Goal

Give the Windows source Helper a real text implementation of `read_clipboard` and `write_clipboard`, so
`broker_info.capabilities.clipboard` is `true` only when the full native read/write chain exists. The
implementation uses Win32 `CF_UNICODETEXT` and must not call PowerShell, a shell, external commands or the
Electron clipboard.

This phase covers only the source Helper in a local Windows interactive-user Session. macOS, Linux, SSH, WSL,
Docker, remote workspaces, mobile `/remote` and the product packaging/signing chain are unchanged.

## Confirmed design

An additive native async ABI:

- `readClipboardTextAsync(): Promise<NativeClipboardReadOutcome>`
- `writeClipboardTextAsync(text): Promise<NativeClipboardWriteOutcome>`

Windows `ax_native.node` runs bounded Win32 clipboard operations on a libuv worker. `createNodeAutomationAdapter`
uses them if and only if both exports exist. An old Windows addon missing either export keeps reporting
`clipboard=false`; no half implementation or sync fallback.

Rejected alternatives:

1. Inject native clipboard into `WindowsNodeSystemSurface`: widens the Helper factory and SystemSurface
   constructor parameters, while the adapter already holds both native and system, so the indirection gains
   nothing.
2. TypeScript FFI: adds a runtime dependency and ABI risk and duplicates the platform isolation N-API already
   provides.
3. PowerShell / `Get-Clipboard` / `Set-Clipboard`: violates the rule that the source Helper depends on no
   external commands and introduces encoding, process lifecycle and command-policy differences.

## Boundary and non-goals

Included:

- reading and writing Windows `CF_UNICODETEXT`;
- true semantics for empty text and an empty/no-text clipboard;
- strict UTF-8 <-> UTF-16 conversion;
- bounded worker, in-Helper serialization, retry on external occupation;
- capability, broker error, delivery-state and source runbook updates;
- an explicitly opt-in real broker round-trip that restores the original text in `finally`.

Not included:

- images, HTML, RTF, file lists, delayed rendering or clipboard history;
- preserving non-text clipboard formats present before the write;
- cross-device or remote clipboard sync;
- WGC, window pixel capture or UIA worker isolation;
- adding, removing or renaming MCP tools.

The product semantics of `write_clipboard` is to replace the current clipboard with plain text. The explicit
live smoke briefly performs this action too; it can restore the original text but not extra formats such as
HTML or images that coexisted. The smoke is therefore off by default and runs only with a dedicated opt-in.

## Architecture and data flow

```text
read_clipboard
  │  READ_ONLY
  ▼
broker handler ──await──> Node automation adapter
                              │
                              ├─ win32 + both native async exports
                              │       │
                              │       ▼
                              │   ClipboardReadWorker
                              │       │
                              │       ├─ Helper clipboard mutex
                              │       ├─ bounded OpenClipboard retry
                              │       ├─ CF_UNICODETEXT / GlobalLock
                              │       └─ CloseClipboard → UTF-8 outcome
                              │
                              └─ macOS/Linux existing SystemSurface

write_clipboard
  │  T1_INPUT + possibly_sent
  ▼
broker handler ──await──> Node automation adapter
                              │
                              ▼
                         ClipboardWriteWorker
                              │
                              ├─ UTF-8 → UTF-16 + pre-allocated HGLOBAL
                              ├─ Helper clipboard mutex
                              ├─ bounded OpenClipboard retry
                              ├─ EmptyClipboard
                              ├─ SetClipboardData(CF_UNICODETEXT)
                              └─ on success, HGLOBAL ownership passes to the system
```

The broker's action delivery-state is unchanged: once `write_clipboard` enters the possibly-sent interval, a
transport error must not auto-replay. Native failure before `EmptyClipboard` guarantees system state is
unmodified; failure after `EmptyClipboard` returns an explicit write failure, and the caller still treats it
as possibly-sent.

## Native ABI and memory ownership

### Outcome

Read:

```ts
type NativeClipboardReadOutcome =
  | { ok: true; text: string }
  | {
      ok: false;
      error: "busy" | "unavailable" | "invalid_data" | "too_large";
    };
```

Write:

```ts
type NativeClipboardWriteOutcome =
  | { ok: true }
  | {
      ok: false;
      error: "busy" | "unavailable" | "too_large" | "write_failed";
    };
```

Outcomes never contain clipboard text, pipe, token, process path or raw Win32 error messages.

### Serialization and time bounds

- A dedicated `std::timed_mutex g_clipboardMutex` serializes this Helper's reads and writes; it does not
  reuse the input sequence lock.
- A worker waits at most 250ms for the Helper mutex, then returns `busy` with no clipboard side effect.
- After acquiring the mutex, `OpenClipboard(nullptr)` is tried at most 8 times, 10ms apart.
- The normal worker upper bound is below 500ms, so Helper graceful stop can wait for already-accepted
  operations to finish.
- After broker freeze no new clipboard operation is accepted, so the clipboard worker need not join the input
  stop latch.

The Win32 clipboard has only synchronous APIs; running them in a `Napi::AsyncWorker` is required so the
broker/N-API thread is not blocked. Polling or sleeping on the JS main thread is not allowed.

### Read

1. After opening the clipboard, RAII guarantees `CloseClipboard` on every exit.
2. If `CF_UNICODETEXT` is absent, return `{ok:true,text:""}` (the clipboard currently has no text).
3. If the format exists but `GetClipboardData` / `GlobalLock` fails, return `invalid_data`.
4. Bound the readable range with `GlobalSize` and look for the first UTF-16 NUL within it; unbounded `wcslen`
   is forbidden.
5. Text over 8 Mi UTF-16 code units returns `too_large`.
6. Convert strictly to UTF-8; conversion failure returns `invalid_data`.

### Write

1. The N-API thread only reads arguments and copies the UTF-8 string; it does not call the Win32 clipboard.
2. The worker converts UTF-8 to UTF-16 strictly, at most 8 Mi code units including the trailing NUL.
3. `HGLOBAL` allocation and content copy finish before `OpenClipboard` / `EmptyClipboard`.
4. After `SetClipboardData` succeeds, Windows owns the `HGLOBAL`; the worker no longer frees it.
5. Any earlier failure makes the worker free its own `HGLOBAL`.
6. If `SetClipboardData` fails after `EmptyClipboard`, return `write_failed`; never report success falsely.

## Adapter, capability and error semantics

`HelperNativeAddon` gains two optional async methods and the outcome types.

`ElectronAutomationAdapter` clipboard methods may return sync or Promise; the two backend handlers become
`async` and uniformly `await`, so the sync SystemSurface on macOS/Linux stays compatible.

Windows native clipboard is enabled only when all of these hold:

```text
platform == win32
AND typeof native.readClipboardTextAsync == "function"
AND typeof native.writeClipboardTextAsync == "function"
```

Capability rules:

- Windows with both exports: `supportsClipboard=true`;
- Windows missing either: keep `WindowsNodeSystemSurface.supportsClipboard=false`;
- macOS/Linux: keep each SystemSurface's existing capability and do not read the Windows ABI.

Error mapping:

- `busy` -> broker `timeout`, noting it failed before mutation;
- `too_large` -> `invalid_request`;
- `unavailable` / `invalid_data` -> broker `internal`, because Windows has no user-granted clipboard
  permission switch and the user must not be misled into changing permissions;
- `write_failed` -> broker `internal`, keeps possibly-sent, no auto-replay.

Logs and errors never contain clipboard content. High-frequency calls add no `info` log.

## Lifecycle and safety

- In Session 0, a non-interactive desktop, or after an addon startup preflight failure, native clipboard is
  not exposed.
- A locked screen is not Session 0. Windows allows clipboard access in the same logon Session, while the
  pointer foreground gate still fails closed independently.
- The clipboard mutex and input state mutex are independent; never hold both.
- The worker holds no UIA COM objects and need not enter the UIA apartment.
- Helper stop first freezes broker admission, then drains accepted workers; on timeout it still fails closed on
  the existing Helper-process-death evidence.
- Read/write tools, tiers, annotations, the 30-tool manifest and broker method names are unchanged.

## Test strategy

TDD: (1) native source/ABI tests lock worker, bounded retry, RAII close, size guard, HGLOBAL ownership and the
two exports; (2) adapter tests cover double-export enablement, single-export rejection, macOS/Linux system
fallback and the broker mapping of every native outcome; (3) capability truthfulness: an old addon stays false,
the new two-export addon is true; (4) broker tests: `read_clipboard` returns a true empty string,
`write_clipboard` awaits native success, busy/too-large/write-failed never fake success; (5) MSVC rebuild and
compiled-addon export checks; (6) a default-off live source Helper smoke that reads the original text, writes a
random non-sensitive marker, reads back and compares exactly, restores the original text in `finally` and
verifies again, printing only booleans and platform; (7) full zcode-cua gates, ZCode CUA focused gates,
typecheck and lint.

If the live smoke fails during restore it exits non-zero and tells the user the clipboard may still hold the
test marker; it never reports a pass when restore is impossible.

## Acceptance

- Windows source Helper `broker_info.capabilities.clipboard === true`.
- `read_clipboard` distinguishes a true empty text from a missing implementation.
- `write_clipboard` writes Unicode text and the same real broker reads it back exactly.
- The live smoke restores the original text exactly, and without opt-in neither reads nor modifies the
  clipboard.
- An old Windows addon missing the additive ABI keeps failing closed.
- macOS/Linux clipboard behavior and the 30-tool surface are unchanged.
- No PowerShell, shell, external command or synchronous main-thread clipboard polling.
- Native build, focused tests, full zcode-cua tests and typecheck/lint in both repos meet their existing
  gates.
