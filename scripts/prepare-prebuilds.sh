#!/bin/bash
set -euo pipefail

# The shell implementation of prepare-prebuilds has drifted from the mjs implementation multiple times,
# leaving old directories and comments in the repository even after remote resource boundaries were fixed elsewhere.
# Delegate to the single implementation to avoid a split where scripts run but directory responsibilities disagree.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT_DIR/scripts/prepare-prebuilds.mjs" "$@"
