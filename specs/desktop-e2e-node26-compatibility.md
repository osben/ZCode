# Desktop E2E Node.js 26 compatibility

## Requirement

The desktop WebDriverIO runner must be able to create a WebDriver session under the repository-pinned Node.js `26.11.1` runtime. Session creation must work with the local HTTP WebDriver endpoint used by a minimal smoke reproduction, before Electron or application code starts.

## Acceptance scenarios

- Under Node.js `26.11.1`, WebDriverIO sends a session-creation request to a local HTTP endpoint and accepts a valid WebDriver session response.
- The same smoke reproduction continues to work under Node.js `24` for the supported local workaround.
- The WebDriverIO package family resolves to compatible v9 releases, including the upstream Node.js 26 request-header fix.
