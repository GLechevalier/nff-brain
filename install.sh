#!/bin/sh
# nff-brain installer (macOS / Linux)
#   curl -fsSL https://raw.githubusercontent.com/GLechevalier/nff-brain/main/install.sh | sh
set -e

if ! command -v node >/dev/null 2>&1; then
  echo "nff-brain needs Node.js >= 18 — install it from https://nodejs.org and re-run." >&2
  exit 1
fi

MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$MAJOR" -lt 18 ]; then
  echo "nff-brain needs Node.js >= 18 (found $(node --version))." >&2
  exit 1
fi

echo "Installing nff-brain via npm…"
npm install -g nff-brain

echo
nff-brain doctor || true
echo
echo "Done. Next steps:"
echo "  cd <your project> && nff-brain init --hooks"
echo "  (VS Code UI: install the 'nff-brain' extension from the Marketplace)"
