# Pion daemon one-line installer for Windows (docs/remote-install.md).
#
#   irm https://<server>/install.ps1 | iex
#   $env:PION_DL_BASE = 'https://<server>'; ./install.ps1   # explicit base
#
# <server> = the URL of the directory this script is served from (docroot
# points straight at the publish dir; add a path prefix only if yours has one).
#
# Installs to %USERPROFILE%\.pion (override with PION_HOME), verifies sha256
# against manifest.json, registers the logon scheduled task via
# `pion-daemon install` and prints the Host/Port/Token block to paste into
# Pion's settings. PION_NO_SERVICE=1 skips service registration; PION_LISTEN /
# PION_LISTEN_WS override the listen addresses (<host:port>). node-pty is
# installed by default for the integrated terminal; PION_WITH_TERMINAL=0
# skips it. A C/C++ build toolchain may be required when no prebuild exists.
# Uninstall afterwards:  .pion\bin\pion-daemon.cmd uninstall [--purge]
$ErrorActionPreference = 'Stop'

function Die($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }
function Say($msg) { Write-Host $msg }

# __DL_BASE__ below is baked by scripts/package-daemon.mjs (--dl-base). The
# sentinel compares a SPLIT literal so the bake cannot turn the check into a
# self-match — an unbaked installer still detects itself.
$DlBase = if ($env:PION_DL_BASE) { $env:PION_DL_BASE } else { '__DL_BASE__' }
if (-not $DlBase -or $DlBase -eq ('__DL_BASE' + '__')) {
  Die "download base unknown. This installer is served from a static mirror —
       set PION_DL_BASE=https://<server> (this script's own directory URL; see
       docs/remote-install.md)."
}
$DlBase = $DlBase.TrimEnd('/')

$PionHome = if ($env:PION_HOME) { $env:PION_HOME } else { Join-Path $env:USERPROFILE '.pion' }
$BinDir = Join-Path $PionHome 'bin'
$ShareDir = Join-Path $PionHome 'share'
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pion-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null

function Fetch($url, $out) {
  # curl.exe ships with Windows 10 1803+; Invoke-WebRequest as the fallback.
  & curl.exe -fsSL -o $out $url 2>$null
  if ($LASTEXITCODE -ne 0) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out }
}

function FetchAny($out, $layoutUrl, $flatUrl) {
  # GitHub Releases assets are FLAT (no resources/ prefix); a static docroot
  # serves the directory layout. Try the layout form first, then the flat one.
  try { Fetch $layoutUrl $out } catch { Fetch $flatUrl $out }
}

function Sha256Of($path) { (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant() }

try {
  # ── node >= 18 (the daemon is a pure-JS node program) ────────────────────
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Die "node not found in PATH. Install Node.js >= 18 first (winget install OpenJS.NodeJS.LTS, or https://nodejs.org)" }
  $nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
  if ($nodeMajor -lt 18) { Die "node >= 18 required, found $(node --version)" }

  Say "==> fetching manifest from $DlBase"
  $manifestPath = Join-Path $Tmp 'manifest.json'
  Fetch "$DlBase/manifest.json" $manifestPath
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $version = $manifest.version
  if (-not $version) { Die "manifest has no version" }
  $sha = @{}
  foreach ($prop in $manifest.files.PSObject.Properties) { $sha[$prop.Name] = $prop.Value.sha256 }

  Say "==> downloading pion-daemon $version"
  $daemonPath = Join-Path $Tmp 'pion-daemon'
  $kanbanPath = Join-Path $Tmp 'kanban-bridge.ts'
  $commandsPath = Join-Path $Tmp 'pion-commands.ts'
  Fetch "$DlBase/pion-daemon" $daemonPath
  FetchAny $kanbanPath "$DlBase/resources/kanban-bridge.ts" "$DlBase/kanban-bridge.ts"
  FetchAny $commandsPath "$DlBase/resources/pion-commands.ts" "$DlBase/pion-commands.ts"
  if ((Sha256Of $daemonPath) -ne $sha['pion-daemon']) { Die "checksum mismatch: pion-daemon (delete and re-download manifest.json?)" }
  if ((Sha256Of $kanbanPath) -ne $sha['resources/kanban-bridge.ts']) { Die "checksum mismatch: kanban-bridge.ts" }
  if ((Sha256Of $commandsPath) -ne $sha['resources/pion-commands.ts']) { Die "checksum mismatch: pion-commands.ts" }

  New-Item -ItemType Directory -Force -Path $BinDir, (Join-Path $ShareDir 'resources') | Out-Null
  Copy-Item $daemonPath (Join-Path $BinDir 'pion-daemon') -Force
  # The bundle carries a POSIX shebang that node ignores; this shim makes it
  # double-clickable-from-a-shell so `pion-daemon …` works anywhere on PATH.
  Set-Content -Path (Join-Path $BinDir 'pion-daemon.cmd') -Value "@echo off`r`nnode `"%~dp0pion-daemon`" %*" -Encoding ascii
  Copy-Item $kanbanPath (Join-Path $ShareDir 'resources/kanban-bridge.ts') -Force
  Copy-Item $commandsPath (Join-Path $ShareDir 'resources/pion-commands.ts') -Force
  Say "==> installed $(Join-Path $BinDir 'pion-daemon')"

  $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
  if ($userPath -notlike "*$BinDir*") { Say "    note: $BinDir is not in PATH — add it via System Properties → Environment Variables" }

  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) { Say "    warn: 'pi' CLI not found in PATH — the daemon serves, but agent runtimes need pi installed on this machine" }

  # Install against the remote Node runtime, independently of Electron's ABI.
  # Resolution from bin\pion-daemon walks up to $PionHome\node_modules.
  if ($env:PION_WITH_TERMINAL -ne '0') {
    Say "==> installing node-pty (integrated terminal)"
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($npm) {
      & npm install --prefix $PionHome --no-save --package-lock=false --no-fund --no-audit node-pty@1.1.0
      if ($LASTEXITCODE -eq 0) {
        node -e "
          const { createRequire } = require('node:module');
          const pty = createRequire(process.argv[1])('node-pty');
          const child = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'exit 0'], { env: process.env });
          const timer = setTimeout(() => { child.kill(); process.exit(1); }, 10000);
          child.onExit(({ exitCode }) => { clearTimeout(timer); process.exit(exitCode === 0 ? 0 : 1); });
        " (Join-Path $BinDir 'pion-daemon')
        if ($LASTEXITCODE -eq 0) { Say "    node-pty verified — terminal enabled" }
        else { Say "    warn: node-pty installed but cannot start a terminal with this Node runtime"; Say "    repair: npm rebuild --prefix `"$PionHome`" node-pty, then restart the daemon" }
      } else {
        Say "    warn: node-pty install failed — integrated terminal unavailable"
        Say "    install the VS Build Tools (C++ workload) and Python, then rerun this installer"
      }
    } else {
      Say "    warn: npm not found — install npm and rerun this installer to enable the terminal"
    }
  } else {
    Say "==> skipping integrated terminal (PION_WITH_TERMINAL=0)"
  }

  $installArgs = @('--user-data', $PionHome, '--resources', (Join-Path $ShareDir 'resources'))
  if ($env:PION_LISTEN) { $installArgs += @('--listen', $env:PION_LISTEN) }
  if ($env:PION_LISTEN_WS) { $installArgs += @('--listen-ws', $env:PION_LISTEN_WS) }

  if ($env:PION_NO_SERVICE -eq '1') {
    Say "==> PION_NO_SERVICE=1 — skipping service registration; run manually:"
    Say "    $(Join-Path $BinDir 'pion-daemon.cmd') serve $($installArgs -join ' ')"
    & (Join-Path $BinDir 'pion-daemon.cmd') token show @installArgs
  } else {
    Say "==> registering the logon scheduled task"
    & (Join-Path $BinDir 'pion-daemon.cmd') install @installArgs
  }
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
