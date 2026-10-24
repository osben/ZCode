# Development environment troubleshooting

## Vite memory allocation failure

```
[vite] memory allocation of 668992 bytes failed
```

### Fix 1: raise the Node.js memory limit (recommended)

PowerShell:

```powershell
$env:NODE_OPTIONS="--max-old-space-size=4096"
pnpm run dev:desktop
```

CMD:

```cmd
set NODE_OPTIONS=--max-old-space-size=4096
pnpm run dev:desktop
```

### Fix 2: clear caches

```bash
# Vite cache
cd packages/desktop
rm -rf node_modules/.vite
rm -rf .vite

# project-level cache
cd ../..
rm -rf node_modules/.cache

pnpm run dev:desktop
```

### Fix 3: restart the terminal

Closing the terminal window and opening a new one sometimes resolves it.

## Type errors

Rebuild the dependent packages first:

```bash
pnpm run build

# or only the shared package
cd packages/shared
pnpm run build
```
