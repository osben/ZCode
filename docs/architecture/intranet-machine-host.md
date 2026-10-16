# Intranet Machine Host

## Background

Intranet dependency downloads, intranet probes, SEA SMB upload notices, and release notifications all need to refer to the same intranet machine. Previously, each script had its own default IP, which was easy to miss when the machine moved.

## Rules

- Shared environment variable: `INTRANET_MACHINE_HOST`
- Default value: `10.0.0.100`
- `host` means only the machine address; it does not include a protocol, port, or path.
- Call sites that need a full URL continue to compose it using their own protocol, port, and path.
- The complete deps mirror address can still be overridden with `ZCODE_DEPS_BASE_URL`; this variable overrides the full deps base URL and does not replace `INTRANET_MACHINE_HOST`.

## Coverage

- `packages/shared/src/intranetDefaults.ts`: default host and probe URL for intranet checks
- `scripts/intranetDefaults.mjs`: default host for the scripts' deps base URL
- `scripts/download-glm.sh`: default host for the Shell download script
- `apps/zcode-cli/packages/cli/scripts/upload-sea-smb.mjs`: default host shown in the SMB URL prompt
- Release-notification scripts: use the same host to compose an intranet artifact URL or remote-send address

## Example

```bash
INTRANET_MACHINE_HOST=192.0.2.10 pnpm bundle:desktop
```
