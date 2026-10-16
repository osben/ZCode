# Intranet Probe Capability (External Service Version)

## Goal

Provide an independent, reusable capability for probing intranet connectivity. Each product feature decides for itself whether to use the probe result.

## Design

- Start a lightweight HTTP service on the intranet machine (default `10.0.0.100:3850`, overridable through `INTRANET_MACHINE_HOST`).
- The client probes this service by calling `systemService.probeIntranet(...)`.
- The service returns fixed JSON: `{ ok: true, marker: "xxx" }`.
- The client validates:
  - HTTP status `2xx`
  - `ok === true`
  - If `expectedMarker` is configured, `marker` must match.

## Server (Maintained Outside This Repository)

The intranet probe service is not maintained with this project's code; deploy it independently on the intranet machine.

Default probe paths:

- `GET /api/intranet/probe`
- `POST /api/intranet/probe` (compatible endpoint with identical behavior)

Optional environment variables:

- `PORT` (default `3850`)
- `ZCODE_INTRANET_PROBE_PATH` (default `/api/intranet/probe`)
- `ZCODE_INTRANET_PROBE_MARKER` (default `zcode-intranet`)
- `ZCODE_INTRANET_PROBE_TOKEN` (optional; when configured, the client must send `x-zcode-intranet-token`)

## Client

Example call:

```ts
const result = await services.systemService.probeIntranet({
  targets: [
    {
      kind: "service",
      url: "http://10.0.0.100:3850/api/intranet/probe",
      expectedMarker: "zcode-intranet",
      // token: "optional",
    },
  ],
});

if (result.isIntranet) {
  // The current network can reach the target intranet service.
}
```

### SSH Entry Visibility

The remote connection (SSH) entry is always shown in the UI. SSH availability depends on the target machine, network path, and credentials; intranet probe results are not used as a product visibility gate.

## Compatibility

`probeIntranet` still retains the legacy TCP target probe (`host + port`) for backward compatibility or a transitional dual-path setup.
