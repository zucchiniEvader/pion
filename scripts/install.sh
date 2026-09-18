#!/bin/sh
# Pion daemon one-line installer (④ remote runtime, docs/remote-install.md).
#
#   curl -fsSL https://<host>/install.sh | sh
#
# SELF-CONTAINED: the payload (pion-daemon bundle, the two bundled PI
# extensions, uninstall.sh) is embedded below as quoted heredocs and the
# sha256s are baked into this script by scripts/package-daemon.mjs — nothing
# is fetched at install time, so the piped-via-curl form works with no
# download base and no second asset. (The heredoc trick is what makes
# `curl | sh` viable: stdin has no $0 to re-read.)
#
# Installs to ~/.pion (override with PION_HOME), verifies the embedded
# sha256s, registers the auto-start service via `pion-daemon install`
# and prints the Host/Port/Token block to paste into Pion's settings.
# PION_NO_SERVICE=1 skips service registration; PION_LISTEN / PION_LISTEN_WS
# override the listen addresses (<host:port>). node-pty is installed by
# default for the integrated terminal; PION_WITH_TERMINAL=0 skips it.
# A native build toolchain may be required when no prebuild is available.
set -eu

PION_HOME="${PION_HOME:-$HOME/.pion}"
BIN_DIR="$PION_HOME/bin"
SHARE_DIR="$PION_HOME/share"

# Baked by scripts/package-daemon.mjs (kept as plain assignments so the
# heredoc quoting below never touches them).
PION_PKG_VERSION=__PION_PKG_VERSION__
SHA_PION_DAEMON=__SHA_PION_DAEMON__
SHA_KANBAN_BRIDGE=__SHA_KANBAN_BRIDGE__
SHA_PION_COMMANDS=__SHA_PION_COMMANDS__

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ── node >= 18 (the daemon is a pure-JS node program) ──────────────────────
command -v node >/dev/null 2>&1 || die "node not found in PATH. Install Node.js >= 18 first
  (Debian/Ubuntu: apt install nodejs npm · RHEL: dnf install nodejs · macOS: brew install node · any: https://nodejs.org)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required, found $(node --version)"

hash_of() { # sha256 of <file> — GNU and BSD spellings
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Unbaked-sentinel: this source template lives in the repo; only the packaged
# copy (release/daemon-cli/install.sh) carries the payload. Compare SPLIT
# literals so baking can never turn the check into a self-match.
[ "$PION_PKG_VERSION" = "__PION_PKG_""VERSION__" ] && die "installer not packaged — run scripts/package-daemon.mjs first"

say "==> extracting pion-daemon $PION_PKG_VERSION (self-contained payload)"
cat > "$TMP/pion-daemon" <<'__PION_DAEMON__'
__PION_DAEMON__
chmod 0755 "$TMP/pion-daemon"
mkdir -p "$TMP/resources"
cat > "$TMP/resources/kanban-bridge.ts" <<'__KANBAN_BRIDGE__'
__KANBAN_BRIDGE__
cat > "$TMP/resources/pion-commands.ts" <<'__PION_COMMANDS__'
__PION_COMMANDS__
cat > "$TMP/uninstall.sh" <<'__UNINSTALL__'
__UNINSTALL__

[ "$(hash_of "$TMP/pion-daemon")" = "$SHA_PION_DAEMON" ] || die "checksum mismatch: pion-daemon (download truncated?)"
[ "$(hash_of "$TMP/resources/kanban-bridge.ts")" = "$SHA_KANBAN_BRIDGE" ] || die "checksum mismatch: kanban-bridge.ts"
[ "$(hash_of "$TMP/resources/pion-commands.ts")" = "$SHA_PION_COMMANDS" ] || die "checksum mismatch: pion-commands.ts"

mkdir -p "$BIN_DIR" "$SHARE_DIR/resources"
cp "$TMP/pion-daemon" "$BIN_DIR/pion-daemon"
chmod 0755 "$BIN_DIR/pion-daemon"
cp "$TMP/resources/kanban-bridge.ts" "$SHARE_DIR/resources/kanban-bridge.ts"
cp "$TMP/resources/pion-commands.ts" "$SHARE_DIR/resources/pion-commands.ts"
cp "$TMP/uninstall.sh" "$BIN_DIR/uninstall.sh"
chmod 0755 "$BIN_DIR/uninstall.sh"
say "==> installed $BIN_DIR/pion-daemon"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "    note: $BIN_DIR is not in PATH — add 'export PATH=\"$BIN_DIR:\$PATH\"' to your shell rc" ;;
esac

command -v pi >/dev/null 2>&1 || say "    warn: 'pi' CLI not found in PATH — the daemon serves, but agent runtimes need pi installed on this machine"

# Install against the remote Node runtime, independently of Electron's ABI.
# Resolution from $BIN_DIR/pion-daemon walks up to $PION_HOME/node_modules.
# Do not npm init: the default directory name (.pion) is not a package name.
if [ "${PION_WITH_TERMINAL:-1}" != "0" ]; then
  say "==> installing node-pty (integrated terminal)"
  if command -v npm >/dev/null 2>&1; then
    if npm install --prefix "$PION_HOME" --no-save --package-lock=false --no-fund --no-audit node-pty@1.1.0; then
      if node -e '
        const { createRequire } = require("node:module");
        const pty = createRequire(process.argv[1])("node-pty");
        const child = pty.spawn("/bin/sh", ["-c", "exit 0"], { env: process.env });
        const timer = setTimeout(() => { child.kill(); process.exit(1); }, 5000);
        child.onExit(({ exitCode }) => { clearTimeout(timer); process.exit(exitCode === 0 ? 0 : 1); });
      ' "$BIN_DIR/pion-daemon"; then
        say "    node-pty verified — terminal enabled"
      else
        say "    warn: node-pty installed but cannot start a terminal with this Node runtime"
        say "    repair: npm rebuild --prefix \"$PION_HOME\" node-pty, then restart the daemon"
      fi
    else
      say "    warn: node-pty install failed — integrated terminal unavailable"
      say "    install a C/C++ build toolchain and Python, then rerun this installer"
    fi
  else
    say "    warn: npm not found — install npm and rerun this installer to enable the terminal"
  fi
else
  say "==> skipping integrated terminal (PION_WITH_TERMINAL=0)"
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

say ""
say "uninstall: $BIN_DIR/uninstall.sh  (or: pion-daemon uninstall; --purge also deletes $PION_HOME)"
