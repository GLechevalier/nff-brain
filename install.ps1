# nff-brain installer (Windows)
#   irm https://raw.githubusercontent.com/GLechevalier/nff-brain/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "nff-brain needs Node.js >= 18 - install it from https://nodejs.org and re-run."
}

$major = [int](node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if ($major -lt 18) {
  Write-Error "nff-brain needs Node.js >= 18 (found $(node --version))."
}

Write-Host "Installing nff-brain via npm..."
npm install -g nff-brain

Write-Host ""
try { nff-brain doctor } catch {}
Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  cd <your project>; nff-brain init --hooks"
Write-Host "  (VS Code UI: install the 'nff-brain' extension from the Marketplace)"
