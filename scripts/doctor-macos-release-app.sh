#!/usr/bin/env bash

set -euo pipefail

APP_PATH="${1:-${ZCODE_MACOS_RELEASE_APP_PATH:-/Applications/ZCode.app}}"
ZCODE_HOME_DIR="${ZCODE_HOME:-${HOME:+$HOME/.zcode}}"
CUA_HELPER_INSTALL_VARIANT="${ZCODE_CUA_HELPER_INSTALL_VARIANT:-}"
# Installer identity is independent of backend environment: ZCODE_PREVIEW_IDENTITY=1 keeps a production-backend build branded as ZCode Preview.
# Accept only "1", matching the exact comparison used by CI workflows and release gates (resolve_zcode_env rejects other spellings).
is_preview_identity_requested() {
  [[ "${ZCODE_PREVIEW_IDENTITY:-}" = "1" ]]
}
if [ -z "$CUA_HELPER_INSTALL_VARIANT" ] && { [ "${ZCODE_ENV:-production}" = "test" ] || is_preview_identity_requested; }; then
  CUA_HELPER_INSTALL_VARIANT="preview"
fi
if [ -n "$CUA_HELPER_INSTALL_VARIANT" ] && [[ ! "$CUA_HELPER_INSTALL_VARIANT" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "[macos-release-doctor] invalid ZCODE_CUA_HELPER_INSTALL_VARIANT: $CUA_HELPER_INSTALL_VARIANT" >&2
  exit 1
fi
CUA_HELPER_INSTALL_SUBDIR="${CUA_HELPER_INSTALL_VARIANT:+$CUA_HELPER_INSTALL_VARIANT/}"
# Shell cannot import producer TS constants. macosReleaseAppDoctor.test.ts locks these literals to
# @zcode/zcode-cua/broker/helperConstants so a future producer rename fails loudly.
ZCODE_HOME_HELPER_APP_PATH="${ZCODE_HOME_DIR:+$ZCODE_HOME_DIR/computer-use/${CUA_HELPER_INSTALL_SUBDIR}ZCode Computer Use.app}"
HELPER_APP_PATH="${ZCODE_CUA_HELPER_APP_PATH:-$ZCODE_HOME_HELPER_APP_PATH}"
APP_BUNDLE_NAME="$(basename "$APP_PATH")"
APP_DISPLAY_NAME="${APP_BUNDLE_NAME%.app}"
APP_EXECUTABLE_NAME="${ZCODE_APP_EXECUTABLE_NAME:-$APP_DISPLAY_NAME}"
HELPER_EXECUTABLE_NAME="${ZCODE_CUA_HELPER_EXECUTABLE_NAME:-ZCode Computer Use}"
REQUIRE_CUA_HELPER="${ZCODE_CUA_REQUIRE_HELPER:-0}"
REQUIRE_CUA_HELPER_STAPLE=0
if [[ "$REQUIRE_CUA_HELPER" =~ ^(1|true|on)$ ]]; then
  REQUIRE_CUA_HELPER_STAPLE=1
fi

if [ "${APP_PATH:-}" = "--help" ] || [ "${APP_PATH:-}" = "-h" ]; then
  cat <<'USAGE'
Usage:
  bash scripts/doctor-macos-release-app.sh /Applications/ZCode.app
  ZCODE_CUA_REQUIRE_HELPER=1 bash scripts/doctor-macos-release-app.sh /Applications/ZCode.app
  ZCODE_CUA_HELPER_APP_PATH=/path/to/ZCode\ Computer\ Use.app ZCODE_CUA_REQUIRE_HELPER=1 bash scripts/doctor-macos-release-app.sh /Applications/ZCode.app
  ZCODE_MACOS_RELEASE_APP_PATH=/Applications/ZCode.app pnpm run doctor:macos-release

Always validates the installed macOS release app with:
  codesign --verify --deep --strict <app>
  spctl -a -vv -t exec <app>

Set ZCODE_CUA_REQUIRE_HELPER=1 for CUA/Helper release gates. In that mode this
also validates the independently signed Helper bundle selected below with the
same codesign/spctl checks and a local notarization staple check.

Helper lookup order:
  1. ZCODE_CUA_HELPER_APP_PATH (CI passes the Helper bundled inside ZCode.app)
  2. ${ZCODE_HOME:-$HOME/.zcode}/computer-use/<optional variant>/ZCode Computer Use.app

CI release acceptance validates the copy actually shipped at
ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app. Post-install checks
may omit the override to validate the user-level installed copy. A missing selected
Helper.app fails closed.
USAGE
  exit 0
fi

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[macos-release-doctor] missing required command: $command_name" >&2
    exit 1
  fi
}

assert_bundle_dir() {
  local label="$1"
  local bundle_path="$2"
  if [ -z "$bundle_path" ]; then
    echo "[macos-release-doctor] ${label} missing: <no product helper path; set ZCODE_HOME or HOME>" >&2
    exit 1
  fi
  if [ ! -d "$bundle_path" ]; then
    echo "[macos-release-doctor] ${label} missing: $bundle_path" >&2
    exit 1
  fi
}

assert_executable() {
  local label="$1"
  local executable_path="$2"
  if [ ! -x "$executable_path" ]; then
    echo "[macos-release-doctor] ${label} executable missing or not executable: $executable_path" >&2
    exit 1
  fi
}

assert_macho_executable() {
  local label="$1"
  local executable_path="$2"
  local magic
  magic="$(od -An -N4 -tx1 -v "$executable_path" | tr -d ' \n')"
  case "$magic" in
    feedface|feedfacf|cafebabe|cafebabf|cffaedfe|cefaedfe|bebafeca|bfbafeca) ;;
    *)
      echo "[macos-release-doctor] ${label} is not a Mach-O executable: $executable_path" >&2
      exit 1
      ;;
  esac
}

run_quiet_validation() {
  local label="$1"
  shift
  local output_file
  output_file="$(mktemp "${TMPDIR:-/tmp}/zcode-macos-release-doctor.XXXXXX")"
  if "$@" >"$output_file" 2>&1; then
    rm -f "$output_file"
    return 0
  fi

  echo "[macos-release-doctor] ${label} failed" >&2
  cat "$output_file" >&2
  rm -f "$output_file"
  return 1
}

validate_release_bundle() {
  local label="$1"
  local bundle_path="$2"
  local require_notarization_staple="${3:-0}"

  echo "[macos-release-doctor] validating ${label}: $bundle_path"
  run_quiet_validation "${label} codesign verify" codesign --verify --deep --strict "$bundle_path"
  run_quiet_validation "${label} Gatekeeper exec assessment" spctl -a -vv -t exec "$bundle_path"
  if [ "$require_notarization_staple" = "1" ]; then
    # Fix rationale: xcrun is a macOS-only tool for staple verification, so check for it only after the Helper exists and basic signature validation passes,
    # or Linux unit tests and real failures are masked by “xcrun is missing,” hiding a missing Helper or signature error.
    require_command xcrun
    # Checking only with spctl can be masked by online ticket lookup or cache; verify the final Helper’s local staple.
    run_quiet_validation "${label} notarization staple" xcrun stapler validate "$bundle_path"
  fi
}

require_command codesign
require_command spctl

# Bugfix: a successful release/notarization previously proved only that the DMG passed the gate, not that the installed main app
# and Computer Use Helper.app would pass Gatekeeper’s exec assessment. First fail closed on the bundle
# structure, then run codesign/spctl for each app to avoid reporting success when the Helper is missing or lacks its own signature.
# CI passes the Helper inside the final ZCode.app explicitly; post-install verification checks the user-level copy by default.
assert_bundle_dir "$APP_BUNDLE_NAME" "$APP_PATH"
assert_executable "$APP_BUNDLE_NAME" "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE_NAME"
validate_release_bundle "$APP_BUNDLE_NAME" "$APP_PATH"

if [ "$REQUIRE_CUA_HELPER" != "1" ] && [ "$REQUIRE_CUA_HELPER" != "true" ] && [ "$REQUIRE_CUA_HELPER" != "on" ]; then
  if [ -d "$HELPER_APP_PATH" ]; then
    echo "[macos-release-doctor] standalone Computer Use Helper.app present; validating optional helper: $HELPER_APP_PATH"
  else
    echo "[macos-release-doctor] standalone Computer Use Helper.app not required; set ZCODE_CUA_REQUIRE_HELPER=1 for CUA release gates"
    echo "[macos-release-doctor] done"
    exit 0
  fi
fi

assert_bundle_dir "Computer Use Helper.app" "$HELPER_APP_PATH"
assert_executable \
  "Computer Use Helper.app" \
  "$HELPER_APP_PATH/Contents/MacOS/$HELPER_EXECUTABLE_NAME"
assert_macho_executable \
  "Computer Use Helper.app executable" \
  "$HELPER_APP_PATH/Contents/MacOS/$HELPER_EXECUTABLE_NAME"

validate_release_bundle "Computer Use Helper.app" "$HELPER_APP_PATH" "$REQUIRE_CUA_HELPER_STAPLE"

echo "[macos-release-doctor] done"
