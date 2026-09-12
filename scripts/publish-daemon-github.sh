#!/bin/sh
# Publishes the pion-daemon CLI package as GitHub Release assets, so remote
# machines install with:
#
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | sh
#
# Flow: scripts/package-daemon.mjs builds release/daemon-cli with the
# releases/latest/download base baked into install.sh, then `gh` creates the
# release (or re-uploads onto an existing tag — the GUI app release shares
# the same v<version> tag, daemon assets just attach to it).
#
# Env overrides: PION_GH_REPO (default from package.json repository),
# PION_GH_TAG (default v<package.json version>). Needs: gh CLI authenticated.
set -eu

REPO="${PION_GH_REPO:-}"
TAG="${PION_GH_TAG:-}"
if [ -z "$REPO" ]; then
  # package.json repository: "git+https://github.com/<owner>/<repo>.git"
  REPO=$(node -p 'require("./package.json").repository.url.replace(/.*github\.com[/:]/, "").replace(/\.git$/, "")')
fi
if [ -z "$TAG" ]; then
  TAG="v$(node -p 'require("./package.json").version')"
fi
DL_BASE="https://github.com/$REPO/releases/latest/download"

command -v gh >/dev/null 2>&1 || { echo "error: gh CLI required (brew install gh, then gh auth login)" >&2; exit 1; }

echo "==> packaging daemon-cli (dl-base $DL_BASE)"
node scripts/package-daemon.mjs --dl-base "$DL_BASE"

# GitHub assets are FLAT: resources/*.ts upload under their basenames, and
# install.sh falls back to the flat URL when resources/ 404s (see fetch_any).
DIST="release/daemon-cli"
ASSETS="$DIST/install.sh $DIST/uninstall.sh $DIST/manifest.json $DIST/pion-daemon $DIST/resources/kanban-bridge.ts $DIST/resources/pion-commands.ts"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "==> uploading assets onto existing release $TAG ($REPO)"
  # shellcheck disable=SC2086 — ASSETS is word-split on purpose
  gh release upload "$TAG" --repo "$REPO" --clobber $ASSETS
else
  echo "==> creating release $TAG ($REPO) with daemon assets"
  # shellcheck disable=SC2086
  gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes "pion-daemon $TAG" $ASSETS
fi

echo ""
echo "published. remote machines install with:"
echo "  curl -fsSL $DL_BASE/install.sh | sh"
echo "  (terminal support: PION_WITH_TERMINAL=1 curl -fsSL $DL_BASE/install.sh | sh)"
