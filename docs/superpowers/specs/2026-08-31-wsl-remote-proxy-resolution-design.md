# WSL Remote Workspace Proxy Auto-Resolution

## Background

The desktop's network proxy configuration belongs to the Windows Host; the Agent in a WSL remote workspace is
a separate Linux process. In WSL NAT networking mode the Agent cannot treat `localhost:port` as the Windows
Host's proxy address, so model, MCP or tool network requests fail after the workspace connects. Staging already
routes remote resource downloads through the Host proxy; this design only completes the runtime proxy boundary
for the Agent inside WSL.

## Goals

- Reuse the existing explicit `httpProxy` / `httpProxyNoProxy` settings.
- In WSL NAT mode, automatically convert a loopback proxy address into a host gateway address reachable from
  WSL.
- Keep the value unchanged in WSL mirrored mode or when the proxy is already a non-loopback address.
- When automatic conversion fails, do not scan the LAN or guess ports; keep the original configuration as a
  diagnosable fallback.
- SSH, Docker, server remote, desktop `desktop-continuous` and mobile `web-remote-replayable` keep their
  behavior.

## Non-goals

- No global proxy discovery or LAN port scanning.
- Do not pass Windows credentials, shell-environment proxies or full proxy URL logs to the remote.
- No change to remote workspace owner, lease, queue, snapshot or delivery semantics.
- Windows certificate path to WSL path conversion is not handled here; a custom CA needs a separate later
  design.

## Chain and boundary

```text
AppSettings.httpProxy (Windows Host)
              |
              v
      WSL remote connect
              |
              +-- Host/CDN fetch: uses the original Windows proxy localhost:port
              |
              +-- WSL Agent env:
                    loopback + NAT -> resolve WSL host gateway -> gateway:port
                    loopback + mirrored -> keep localhost:port
                    non-loopback -> keep the user configuration
```

Connection setup passes the proxy to the WSL server command only as an explicit remote runtime network option;
`pickRemoteRuntimeEnv(process.env)` is not extended, so the user's shell `HTTP_PROXY` is not inherited past the
existing runtime environment sanitization boundary. The remote server then uses this explicit network
configuration for the next Agent spawn.

## Resolution rules

1. No explicit proxy: inject no proxy environment variable.
2. Proxy host is not `localhost`, `127.0.0.1` or `::1`: keep the original proxy URL.
3. Proxy host is loopback:
   - First probe the original loopback TCP port inside WSL; on success treat it as mirrored/directly reachable
     and keep the value.
   - If the original address is unreachable, prefer the next hop of `ip route show default` as the host
     gateway; fall back to `/etc/resolv.conf` only when `ip` is unavailable or there is no default route.
   - A route candidate rejects loopback; a resolv.conf candidate must also be a private or link-local address,
     so public/corporate DNS is never taken as the host gateway. After a valid gateway is found, replace the
     URL hostname and keep scheme, port, credentials and path.
4. Gateway resolution or probing fails: keep the original proxy value and state in the connection log that
   automatic resolution was not confirmed; do not block the WSL server handshake, so a wrong network
   diagnosis never blocks opening a local workspace.

The auto-resolved address lives only in the environment of this remote server process and its Agent child
processes and is not written back to the settings file, because the WSL gateway address may change when the
distribution restarts.

## Safety and compatibility

- Only the host/port the user already configured is probed; no network scanning.
- Logs record only the scheme, host, port and resolution kind of the proxy result, hiding username, password
  and path.
- Only `target.kind === "wsl"` uses this capability; SSH/Docker/server keep the original runtime environment.
- The remote Agent stays a shared-host attachment; the desktop chain stays `desktop-continuous` and the mobile
  chain stays `web-remote-replayable`.

## Test plan

- Pure functions: loopback, IPv4, IPv6, non-loopback, replacement and redaction of URLs with credentials.
- WSL backend: keep the value when loopback is reachable; replace when unreachable and the gateway resolves;
  keep the original when resolution fails.
- connect: only WSL injects the explicit proxy environment; `HTTP_PROXY` from the calling process environment
  allowlist is not passed through to SSH/Docker.
- Regression: existing remote asset, remote connect and WSL lifecycle unit tests; run `pnpm typecheck` and
  `pnpm lint`.
