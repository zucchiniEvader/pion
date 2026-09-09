#!/bin/sh
# Pion daemon uninstaller: stops and removes the launchd/systemd service via
# the CLI, then points at what is left behind. Pass --purge to also delete
# ~/.pion (config, token, logs). PION_HOME overrides the install location.
set -eu

PION_HOME="${PION_HOME:-$HOME/.pion}"
BIN="$PION_HOME/bin/pion-daemon"

if [ -x "$BIN" ]; then
    # shellcheck disable=SC2086 — user flags (--purge) pass through
    "$BIN" uninstall --user-data "$PION_HOME" "$@"
else
    printf '%s\n' "pion-daemon binary not found at $BIN — removing service definitions directly is done by the CLI; nothing to do here."
fi

printf '%s\n' ""
printf '%s\n' "Data (config, token, logs) lives in $PION_HOME — rerun with --purge to delete it."
