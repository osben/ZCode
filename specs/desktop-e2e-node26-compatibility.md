# Desktop E2E Node.js 26 compatibility

## Requirement

The desktop WebDriverIO runner must be able to create a WebDriver session under the repository-pinned Node.js `26.11.1` runtime. Session creation must work with the local HTTP WebDriver endpoint used by a minimal smoke reproduction, before Electron or application code starts.

## Acceptance scenarios

- Under Node.js `26.11.1`, WebDriverIO sends a session-creation request to a local HTTP endpoint and accepts a valid WebDriver session response.
- The same smoke reproduction continues to work under Node.js `24` for the supported local workaround.
- The WebDriverIO package family resolves to compatible v9 releases, including the upstream Node.js 26 request-header fix.
- Helpers that gate on `waitForClickable` scroll targets into view before waiting (for example the
  occupation-onboarding Skip button, which can sit below the fold on the 1200x800 e2e window).
  This is a repository-level workaround: WDIO's `isClickable` — in v8 and v9 alike — already
  requires the element to be inside the viewport and unobscured and attempts its own scroll, not a
  v8→v9 semantic change.
