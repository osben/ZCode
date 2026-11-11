# Share Standalone Build and CUA Dependency Boundary

## Status

- Status: implemented.
- Scope: build dependencies of the Share static landing page.
- Unchanged: Share API, OAuth protocol, Desktop import, phone `/remote`, the full Web entry.

## Background

Historically `build:web-share` built the full Web app through `packages/web/src/main.tsx`. It now uses a
standalone `@zcode/web-share` entry; Share reuses only `@zcode/share-ui`, protocol types, the auth/Share API
clients and read-only presentation, and no longer enters the CUA dependency closure of the full Web.

```text
history: @zcode/web -> @zcode/client / @zcode/ui -> @zcode/services -> @zcode/zcode-cua
now:     @zcode/web-share -> @zcode/share-ui / @zcode/shared
         @zcode/web       -> @zcode/client / @zcode/ui -> @zcode/services -> @zcode/zcode-cua
```

## Boundary

- `@zcode/web-share` contains only the Share route, Preview API, OAuth callback and the read-only timeline.
- The Share build does not declare, resolve or download `@zcode/services` and `@zcode/zcode-cua`.
- `@zcode/share-ui` provides the read-only presentation entry Share needs; Desktop/Remote keep using the full `@zcode/ui`.
- Share and the full Web share protocol types and confirmed read-only presentation implementations, not runtime services.
- The Remote v4 build builds CUA from `packages/zcode-cua` inside the workspace, with no private Git or credentials.
- `message.tsx`, reused by the read-only timeline, statically references the file-link menu, which pulls `@zcode/rpc` into the closure. Share points a vite alias straight at `packages/rpc/src` (the Dockerfile copies only that source; rpc has no third-party dependency). Without services the menu is not rendered, so no RPC channel is created at runtime.
- `packages/shared/src/app-control` value-imports `@zcode/session-control/contracts`. Share aliases it to `packages/session-control/src/contract.ts`, and the Dockerfile copies that package's `src` and `package.json` (its `imports` field resolves the `#session-control/*` subpaths); its only third-party dependency, zod, is already installed by shared.
- A new `@zcode/*` value import entering the Share closure must register both a vite alias and a Dockerfile `COPY`, and be verified with `docker build -f Dockerfile.web-share .`; a local full-workspace build hides a missing one. If the base image cannot be pulled, rebuild the file layout in an empty directory from the Dockerfile's COPY list and run the same install and build, which is equivalent.

## Build chain

```text
Dockerfile.web-share
  -> pnpm install --frozen-lockfile --filter @zcode/web-share...
  -> pnpm --filter @zcode/web-share build
  -> nginx static image
```

`.npmrc` is `node-linker=hoisted`, so `--filter` does not trim the lockfile layout; since CUA joined the
monorepo the lockfile has no Git sources, so the Share image needs no git, BuildKit secret or Jenkins
credential, and no `packages/zcode-cua`.

The Dockerfile has three stages: `sources` (`FROM scratch`, gathering all source COPYs) -> `builder` (installs dependencies from package.json only, then merges source once with `COPY --from=sources /app ./` and builds) -> `runtime` (nginx). Source COPYs must stay in the `sources` stage: BuildKit in the Jenkins Pod falls back to the native snapshotter, so every layer after install copies the whole node_modules (about 80 seconds per layer measured), and 13 scattered COPYs added up to about 17 minutes and once exceeded the 20-minute release timeout. Add new Share source inputs to the `sources` stage, not after the install.

## Acceptance

- The Share image build command contains no CUA secret and does not access any Git repository.
- `/cn/share`, `/share`, callback, mock fixtures and asset paths stay available.
- Build dependency boundaries of the full Web and Remote v4 are unchanged.
- The Share page creates no Host, Agent, service or remote session.
