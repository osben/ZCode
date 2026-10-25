#!/bin/bash
set -euo pipefail

# Bugfix: the shell version of prepare-prebuilds has drifted from the mjs implementation several times,
# so a remote resource-boundary fix can leave the old directories and comments in the other implementation.
# Delegate to a single implementation here to prevent the two paths from diverging again, where both scripts run but directory ownership differs.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT_DIR/scripts/prepare-prebuilds.mjs" "$@"
