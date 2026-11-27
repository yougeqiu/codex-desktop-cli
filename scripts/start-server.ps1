# start-server.ps1 — start the bundled codex app-server on a loopback WebSocket and record state.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File start-server.ps1 [-Port 8798]
param(
  [ValidateRange(1024,65535)][int]$Port = 8798
)
$ErrorActionPreference = 'Stop'

$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
if (-not $pkg) { throw 'OpenAI.Codex is not installed for the current user.' }
$exe = Join-Path $pkg.InstallLocation 'app\resources\codex.exe'
if (-not (Test-Path $exe)) { throw "bundled codex.exe not found: $exe" }

# already running on this port with the matching executable?
$stateDir = Join-Path $env:USERPROFILE '.codex-desktop'
$statePath = Join-Path $stateDir 'state.json'
if (Test-Path $statePath) {
  try {
    $old = Get-Content $statePath -Raw | ConvertFrom-Json
    if ($old.port -eq $Port -and $old.serverExecutable -eq $exe -and
        $old.serverProcessId -and (Get-Process -Id $old.serverProcessId -ErrorAction SilentlyContinue)) {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($old.port)/readyz" -TimeoutSec 3 -ErrorAction SilentlyContinue
      if ($r -and $r.StatusCode -eq 200) { Write-Output "already running pid=$($old.serverProcessId) port=$($old.port)"; exit 0 }
    }
  } catch {}
}

# Reclaim a healthy matching listener or stop an outdated codex.exe owning this port
$listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($ln in $listeners) {
  $ownerPid = [int]$ln.OwningProcess
  if ($ownerPid -le 0) { continue }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
  if ($cim -and $cim.Name -ieq 'codex.exe' -and $cim.ExecutablePath -ieq $exe) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 3 -ErrorAction SilentlyContinue
      if ($r -and $r.StatusCode -eq 200) {
        @{
          websocketUrl = "ws://127.0.0.1:$Port"
          readyUrl = "http://127.0.0.1:$Port/readyz"
          port = $Port
          serverProcessId = $ownerPid
          serverExecutable = $exe
          packageVersion = $pkg.Version.ToString()
          startedAt = (Get-Date).ToString('o')
        } | ConvertTo-Json | Set-Content -Path $statePath -Encoding UTF8
        Write-Output "adopted running pid=$ownerPid port=$Port pkg=$($pkg.Version)"
        exit 0
      }
    } catch {}
  }
  if ($cim -and $cim.Name -ieq 'codex.exe') {
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $ownerPid -Timeout 5 -ErrorAction SilentlyContinue
  } else {
    throw "port $Port is already occupied by pid=$ownerPid ($($cim.Name))"
  }
}

$logDir = Join-Path $stateDir 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $logDir "$stamp-server.out.log"
$errLog = Join-Path $logDir "$stamp-server.err.log"

# Launch detached via WMI Win32_Process.Create so the server survives parent shell / job-object teardown
$cmdLine = 'cmd.exe /d /c ""' + $exe + '" app-server --listen ws://127.0.0.1:' + $Port + ' > "' + $outLog + '" 2> "' + $errLog + '""'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$createRes = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $cmdLine
  ProcessStartupInformation = $startup
}
if ($createRes.ReturnValue -ne 0 -or -not $createRes.ProcessId) {
  throw "Win32_Process.Create failed for codex app-server (rc=$($createRes.ReturnValue))"
}
$wrapperPid = [int]$createRes.ProcessId

$deadline = (Get-Date).AddSeconds(60)
$ok = $false
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $wrapperPid -ErrorAction SilentlyContinue)) {
    throw "app-server exited early; see $errLog"
  }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 500
}
if (-not $ok) { throw "app-server not ready within 60s on port $Port" }

$listenOwner = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$serverPid = if ($listenOwner -and $listenOwner.OwningProcess) { [int]$listenOwner.OwningProcess } else { $wrapperPid }

@{
  websocketUrl = "ws://127.0.0.1:$Port"
  readyUrl = "http://127.0.0.1:$Port/readyz"
  port = $Port
  serverProcessId = $serverPid
  serverExecutable = $exe
  packageVersion = $pkg.Version.ToString()
  startedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Path $statePath -Encoding UTF8

Write-Output "server ready pid=$serverPid port=$Port pkg=$($pkg.Version)"
