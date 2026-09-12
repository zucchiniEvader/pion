#!/bin/sh
# Pion daemon one-line installer (④ remote runtime, docs/remote-install.md).
#
#   curl -fsSL https://<server>/install.sh | sh
#   PION_DL_BASE=https://<server> sh install.sh      # explicit base
#
# <server> = the URL of the directory this script is served from (docroot
# points straight at the publish dir; add a path prefix only if yours has one).
#
# Installs to ~/.pion (override with PION_HOME), verifies sha256 against
# manifest.json, registers the auto-start service via `pion-daemon install`
# and prints the Host/Port/Token block to paste into Pion's settings.
# PION_NO_SERVICE=1 skips service registration; PION_LISTEN / PION_LISTEN_WS
# override the listen addresses (<host:port>); PION_WITH_TERMINAL=1 also
# npm-installs node-pty (native build toolchain required) to enable the
# integrated terminal.
set -eu

DL_BASE="${PION_DL_BASE:-__DL_BASE__}"
PION_HOME="${PION_HOME:-$HOME/.pion}"
BIN_DIR="$PION_HOME/bin"
SHARE_DIR="$PION_HOME/share"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# __DL_BASE__ below is baked by scripts/package-daemon.mjs (--dl-base). The
# sentinel compares a SPLIT literal ("__DL_BASE""__") so the bake cannot turn
# the check into a self-match — an unbaked installer still detects itself.
DL_BASE="${PION_DL_BASE:-__DL_BASE__}"
if [ "$DL_BASE" = "__DL_BASE""__" ] || [ -z "$DL_BASE" ]; then
    die "download base unknown. This installer is served from a static mirror —
       set PION_DL_BASE=https://<server> (this script's own directory URL; see
       docs/remote-install.md)."
fi
DL_BASE="${DL_BASE%/}"

# ── node >= 18 (the daemon is a pure-JS node program) ──────────────────────
command -v node >/dev/null 2>&1 || die "node not found in PATH. Install Node.js >= 18 first
  (Debian/Ubuntu: apt install nodejs npm · RHEL: dnf install nodejs · macOS: brew install node · any: https://nodejs.org)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required, found $(node --version)"

fetch() { # fetch <url> <outfile>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "need curl or wget to download from $DL_BASE"
  fi
}

hash_of() { # sha256 of <file> — GNU and BSD spellings
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "==> fetching manifest from $DL_BASE"
fetch "$DL_BASE/manifest.json" "$TMP/manifest.json"
# manifest.json is data we control, parsed with the node we just required.
MANIFEST_VARS=$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log("PION_VERSION=" + JSON.stringify(String(m.version)));
for (const [name, f] of Object.entries(m.files)) {
  const key = "PION_SHA_" + name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  console.log(key + "=" + JSON.stringify(String(f.sha256)));
}
' "$TMP/manifest.json") || die "manifest.json is not valid JSON"
eval "$MANIFEST_VARS"
[ -n "${PION_VERSION:-}" ] || die "manifest has no version"

fetch_any() { # fetch_any <outfile> <url-preferred> <url-fallback>
  # GitHub Releases assets are FLAT (no resources/ prefix); a static docroot
  # serves the directory layout. Try the layout form first, then the flat one.
  fetch "$2" "$1" || fetch "$3" "$1"
}

say "==> downloading pion-daemon $PION_VERSION"
fetch "$DL_BASE/pion-daemon" "$TMP/pion-daemon"
fetch_any "$TMP/kanban-bridge.ts" "$DL_BASE/resources/kanban-bridge.ts" "$DL_BASE/kanban-bridge.ts"
fetch_any "$TMP/pion-commands.ts" "$DL_BASE/resources/pion-commands.ts" "$DL_BASE/pion-commands.ts"
[ "$(hash_of "$TMP/pion-daemon")" = "${PION_SHA_PION_DAEMON:-}" ] || die "checksum mismatch: pion-daemon (delete and re-download manifest.json?)"
[ "$(hash_of "$TMP/kanban-bridge.ts")" = "${PION_SHA_RESOURCES_KANBAN_BRIDGE_TS:-}" ] || die "checksum mismatch: kanban-bridge.ts"
[ "$(hash_of "$TMP/pion-commands.ts")" = "${PION_SHA_RESOURCES_PION_COMMANDS_TS:-}" ] || die "checksum mismatch: pion-commands.ts"

mkdir -p "$BIN_DIR" "$SHARE_DIR/resources"
cp "$TMP/pion-daemon" "$BIN_DIR/pion-daemon"
chmod 0755 "$BIN_DIR/pion-daemon"
cp "$TMP/kanban-bridge.ts" "$SHARE_DIR/resources/kanban-bridge.ts"
cp "$TMP/pion-commands.ts" "$SHARE_DIR/resources/pion-commands.ts"
say "==> installed $BIN_DIR/pion-daemon"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "    note: $BIN_DIR is not in PATH — add 'export PATH=\"$BIN_DIR:\$PATH\"' to your shell rc" ;;
esac

command -v pi >/dev/null 2>&1 || say "    warn: 'pi' CLI not found in PATH — the daemon serves, but agent runtimes need pi installed on this machine"

# Integrated terminal opt-in (daemon/terminal.ts lazily imports node-pty).
# node-pty is native: needs a build toolchain on the remote, hence opt-in.
# Installed into $PION_HOME/node_modules — node resolution from
# $BIN_DIR/pion-daemon walks up to it.
if [ "${PION_WITH_TERMINAL:-0}" = "1" ]; then
  say "==> installing node-pty (integrated terminal; requires node-gyp toolchain)"
  if command -v npm >/dev/null 2>&1; then
    if (cd "$PION_HOME" && { [ -f package.json ] || npm init -y >/dev/null 2>&1; } && npm install --no-fund --no-audit node-pty); then
      say "    node-pty installed — terminal enabled"
    else
      say "    warn: node-pty install failed — terminal will report err.terminal.unavailable"
    fi
  else
    say "    warn: npm not found — skipping node-pty (terminal disabled)"
  fi
fi

INSTALL_ARGS="--user-data $PION_HOME --resources $SHARE_DIR/resources"
if [ -n "${PION_LISTEN:-}" ]; then INSTALL_ARGS="$INSTALL_ARGS --listen $PION_LISTEN"; fi
if [ -n "${PION_LISTEN_WS:-}" ]; then INSTALL_ARGS="$INSTALL_ARGS --listen-ws $PION_LISTEN_WS"; fi

if [ "${PION_NO_SERVICE:-0}" = "1" ]; then
  say "==> PION_NO_SERVICE=1 — skipping service registration; run manually:"
  say "    $BIN_DIR/pion-daemon serve $INSTALL_ARGS"
  "$BIN_DIR/pion-daemon" token show $INSTALL_ARGS
else
  say "==> registering the auto-start service"
  # shellcheck disable=SC2086 — INSTALL_ARGS is word-split on purpose
  "$BIN_DIR/pion-daemon" install $INSTALL_ARGS
fi
