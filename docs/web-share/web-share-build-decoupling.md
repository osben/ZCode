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

## Acceptance

- The Share image build command contains no CUA secret and does not access any Git repository.
- `/cn/share`, `/share`, callback, mock fixtures and asset paths stay available.
- Build dependency boundaries of the full Web and Remote v4 are unchanged.
- The Share page creates no Host, Agent, service or remote session.
