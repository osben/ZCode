# Share Landing Page: Jenkins Static Release

## Goal

The Share landing page is built and released as a separate nginx static image, not sharing an image or
Deployment with the phone remote control `/remote` image. A Jenkins Job selects the build-time injected ZCode
API/OAuth endpoint through `ZCODE_ENV=test|production`; the page entries are `/cn/share` (Chinese) and
`/share` (English).

## Release chain

```text
Jenkins checkout z-code
  -> pnpm / Dockerfile.web-share
  -> Vite build:web-share (base=/cn/share/)
  -> nginx static image
  -> Docker registry push
  -> kubectl set image share Deployment
  -> rollout status
```

Jenkins keeps API tokens and Docker passwords out of Docker ARGs, image tags, the build context and logs. The
Share build installs only the lightweight dependencies of `@zcode/web-share` and uses the repo lockfile for
reproducible rendering dependencies; a filtered install does not bring in the CUA dependencies of the full
Web/Remote closure and needs no CUA Git token. The runtime image contains only nginx and static artifacts;
material-icons are copied from `packages/web/public`.

## Jenkins configuration

`Jenkinsfile.web-share` uses the Kubernetes Pod template `default` like the existing remote Job, which must
contain the `buildkit` and `kubectl` containers. Pipeline defaults target staging:

- registry: `openwebui-hk-registry-vpc.cn-hongkong.cr.aliyuncs.com/glm-chat`
- image: `staging-zcode-conversation-share`
- Deployment and container: `staging-zcode-conversation-share`
- namespace/context: `zcode` / `openwebui`
- `ZCODE_ENV=test`, build endpoint `https://zcode.z.ai`

Pipeline parameters can switch to `production` and override the image name, Deployment name and container
name. The Git repo credential follows the remote Pipeline's value; Share needs no CUA credential. Share-specific
image and Deployment names must be confirmed by the infrastructure maintainer.

Jenkins must enable Pipeline script from SCM with script path `Jenkinsfile.web-share`. The Pipeline shallow
clones `BRANCH_TO_BUILD`, generates an immutable tag `<clean-branch>-<first 8 of commit sha>`, builds and
pushes `Dockerfile.web-share` with BuildKit, then runs:

```text
kubectl set image deployment/<DEPLOYMENT_NAME>
  <CONTAINER_NAME>=<REGISTRY>/<IMAGE_NAME>:<tag> -n zcode --context openwebui
kubectl rollout status deployment/<DEPLOYMENT_NAME> -n zcode --context openwebui --timeout=4m
```

## Acceptance paths

After the image starts:

- `/cn/share`, `/cn/share/callback`, `/share`, `/share/callback` return 200;
- `/cn/share/` redirects to `/cn/share`, `/share/` redirects to `/share`;
- both entries can reach the SPA, mock fixtures and assets; build artifacts use the `/cn/share/assets/` prefix by default;
- `/remote/v4` is not served by the share image.

The full smoke test of local build and nginx routing can still use `scripts/test-web-share-build.sh`; it needs
only Docker, not CUA Git credentials.
