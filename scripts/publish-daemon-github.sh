#!/bin/sh
# Publishes the pion-daemon installer as ONE GitHub Release asset:
#
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | sh
#
# Flow: scripts/package-daemon.mjs builds the self-contained install.sh
# (payload + sha256s embedded — nothing else to upload), then `gh` attaches it
# to the release (the GUI app release shares the same v<version> tag, the
# daemon asset just attaches to it).
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

command -v gh >/dev/null 2>&1 || { echo "error: gh CLI required (brew install gh, then gh auth login)" >&2; exit 1; }

echo "==> packaging self-contained install.sh"
node scripts/package-daemon.mjs

DIST="release/daemon-cli"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "==> uploading asset onto existing release $TAG ($REPO)"
  gh release upload "$TAG" --repo "$REPO" --clobber "$DIST/install.sh"
else
  echo "==> creating release $TAG ($REPO) with daemon installer"
  gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes "pion-daemon $TAG" "$DIST/install.sh"
fi

echo ""
echo "published (single daemon asset). remote machines install with:"
echo "  curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | sh"
echo "  (terminal support: PION_WITH_TERMINAL=1 ... | sh; off: PION_WITH_TERMINAL=0 ... | sh)"
