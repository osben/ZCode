# Self-hosted remote relay

This executable pairs the existing Desktop and Web remote-control transports.
It exposes `/ws`, `/healthz` and `/readyz`; it does not serve the Web frontend or
run an Agent. Desktop must remain running to execute commands.

The server supports separate registration SIDs and authenticated browser
replacement. Desktop still uses application-wide credentials: independent
window registration and public URL defaults in Desktop releases remain pending.
See [the design and acceptance catalog](../../specs/self-hosted-remote-relay.md).

## Railway

1. Create a service from the repository, with Root Directory `/`. Set
   `RAILWAY_DOCKERFILE_PATH=packages/remote-relay/Dockerfile`. Leave build/start
   overrides empty so Railway uses the Dockerfile.
2. Attach a persistent Volume at `/data`. Use one replica: live socket pairs are
   process-local, and SQLite registrations belong to this volume.
3. Set the following service variables, replacing the key and Web origin:

   ```dotenv
   RAILWAY_DOCKERFILE_PATH=packages/remote-relay/Dockerfile
   RAILWAY_RUN_UID=0
   PORT=3031
   ZCODE_RELAY_HOST=0.0.0.0
   ZCODE_RELAY_PORT=3031
   ZCODE_RELAY_DB_PATH=/data/relay.sqlite
   ZCODE_RELAY_STORAGE_KEY=<base64-encoded-32-byte-key>
   ZCODE_RELAY_ALLOWED_ORIGINS=https://<web-domain>
   ```

4. Generate a public domain with target port `3031`. Set the healthcheck path
   to `/readyz`. After deployment, `https://<relay-domain>/readyz` should return
   HTTP 200; connect clients to `wss://<relay-domain>/ws`.

The Dockerfile builds from a restricted context containing only the relay's
dependency closure and root build inputs. It defaults to the `node` user;
Railway's root-owned volume requires `RAILWAY_RUN_UID=0` with this image.
`PORT=3031` selects Railway's healthcheck port; the executable itself reads
`ZCODE_RELAY_PORT`.

Generate the storage key locally with `openssl rand -base64 32`, store it in
Railway Variables, and retain it with your backups. It must remain unchanged
when reopening the existing database. Never put it in a `VITE_` variable, client
build, source file or PR.

Origins are exact HTTP(S) origins without paths or trailing slashes. Multiple
origins are comma-separated. Connections without an Origin header are permitted
for Desktop, but still require authentication. Leave trusted proxies unset until
the actual proxy peer addresses are verified; forwarding headers are not trusted
by default, so registration quotas behind a proxy may be shared across users.

Railway references: [Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[Volumes](https://docs.railway.com/volumes),
[Domains](https://docs.railway.com/networking/domains/working-with-domains),
[Healthchecks](https://docs.railway.com/deployments/healthchecks).

## Client configuration

Build Web with the relay's public address in its build environment:

```dotenv
VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://<relay-domain>/ws
```

From the repository root, run `pnpm build:web-remote-control:v4`. Serve
`packages/web/dist` under `https://<web-domain>/remote/v4/` on a separate static
host. A Web Railway container is not included in this package.

Set these variables in the environment of the Desktop process:

```dotenv
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://<relay-domain>/ws
ZCODE_WEB_REMOTE_CONTROL_URL=https://<web-domain>/remote/v4/
```

Variables set on the Railway relay service do not configure local Desktop.
Public endpoint defaults for releases launched from Finder/Explorer are not
implemented yet. Do not change `ZCODE_BASE_URL` to select the relay.

## Limits and verification

| Relay variable                         | Default                        |
| -------------------------------------- | ------------------------------ |
| `ZCODE_RELAY_MAX_CONNECTIONS`          | `2000`                         |
| `ZCODE_RELAY_REGISTRATIONS_PER_MINUTE` | `20` per source IP             |
| `ZCODE_RELAY_MAX_REGISTRATIONS`        | `100000`                       |
| `ZCODE_RELAY_MAX_BUFFERED_BYTES`       | `2097152`                      |
| `ZCODE_RELAY_MAX_TOTAL_BUFFERED_BYTES` | `67108864`                     |
| `ZCODE_RELAY_TRUSTED_PROXIES`          | Empty, exact IP addresses only |

These are admission limits, not measured capacity. Registrations persist;
connections and pairs do not. The relay can read forwarded payloads: WSS is
transport encryption, not end-to-end encryption.

Use the repository-pinned Node/pnpm versions. From the repository root:

```bash
pnpm test:relay
pnpm build:relay
pnpm --filter @zcode/remote-relay test:bundle
docker build -f packages/remote-relay/Dockerfile -t zcode-remote-relay:local .
```
