# restart-desktop.ps1 — attach Codex Desktop to the shared app-server without disrupting an already-attached window.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1 [-Port 8798] [-Force]
param(
  [ValidateRange(1024,65535)][int]$Port = 8798,
  [int]$VerifyTimeoutSeconds = 120,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$wsUrl = "ws://127.0.0.1:$Port"

# ensure shared server is running and matches the current package version
& (Join-Path $PSScriptRoot 'start-server.ps1') -Port $Port
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 3
  if ($r.StatusCode -ne 200) { throw }
} catch { throw "shared app-server not ready on port $Port" }

function Get-ChatGptUiPids {
  $pids = @()
  try {
    $lines = & tasklist /FI "IMAGENAME eq ChatGPT.exe" /V /FO CSV /NH 2>$null
    $rows = @($lines | Where-Object { $_ -and $_ -match '^"ChatGPT\.exe"' } |
      ConvertFrom-Csv -Header ImageName,PID,SessionName,SessionNum,MemUsage,Status,UserName,CPUTime,WindowTitle)
    foreach ($row in $rows) {
      $title = [string]$row.WindowTitle
      if (-not [string]::IsNullOrWhiteSpace($title) -and $title -ne 'N/A' -and $title -ne 'OleMainThreadWndName') {
        $pids += [int]$row.PID
      }
    }
  } catch {}
  if ($pids.Count -eq 0) {
    $pids = @(Get-Process ChatGPT -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
      ForEach-Object { [int]$_.Id })
  }
  return @($pids | Select-Object -Unique)
}

# skip restart if Desktop already has a visible window AND is connected to our shared server
if (-not $Force) {
  $chatProcs = @(Get-Process ChatGPT -ErrorAction SilentlyContinue)
  $chatPids = @($chatProcs | ForEach-Object { [int]$_.Id })
  $uiPids = @(Get-ChatGptUiPids)
  if ($uiPids.Count -gt 0 -and $chatPids.Count -gt 0) {
    $attached = @(Get-NetTCPConnection -RemoteAddress '127.0.0.1' -RemotePort $Port -State Established -ErrorAction SilentlyContinue |
      Where-Object { $chatPids -contains [int]$_.OwningProcess })
    if ($attached.Count -gt 0) {
      Write-Output "ALREADY_ATTACHED: Desktop uiPid=$($uiPids[0]) already connected to $wsUrl (use -Force to restart)"
      exit 0
    }
  }
}

$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
$desktopExe = Join-Path $pkg.InstallLocation 'app\ChatGPT.exe'

# protect our shared app-server PID recorded in state.json
$sharedServerPid = $null
$statePath = Join-Path $env:USERPROFILE '.codex-desktop\state.json'
if (Test-Path $statePath) {
  try {
    $st = Get-Content $statePath -Raw | ConvertFrom-Json
    if ($st.port -eq $Port -and $st.serverProcessId) { $sharedServerPid = [int]$st.serverProcessId }
  } catch {}
}

# graceful close on visible windows only (CloseMainWindow can leave Electron resident in background), then drain full tree
Get-Process ChatGPT -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
  ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }

$deadline = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process ChatGPT -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 250
}

# kill any lingering headless ChatGPT processes and Desktop-owned embedded helpers (never kill our shared app-server)
Get-Process ChatGPT -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name='codex.exe' or Name='codex-code-mode-host.exe' or Name='codex-computer-use.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ProcessId -ne $sharedServerPid -and
    ($_.CommandLine -notlike "*app-server*--listen*127.0.0.1:$Port*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# wait until all ChatGPT processes have actually exited before starting a new instance (prevents Electron SingletonLock collision)
$drainDeadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $drainDeadline) {
  if (-not (Get-Process ChatGPT -ErrorAction SilentlyContinue)) { break }
  Get-Process ChatGPT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 250
}
if (Get-Process ChatGPT -ErrorAction SilentlyContinue) {
  throw 'Existing ChatGPT processes did not exit cleanly; aborting relaunch to avoid headless duplicate instance'
}
Start-Sleep -Milliseconds 500

# relaunch detached via WMI Win32_Process.Create (escapes caller Job Object & pipes) with ShowWindow=Normal and shared WS env
$launchFloor = (Get-Date).AddSeconds(-2)
$envMap = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
  $k = [string]$entry.Key
  if ($k -ieq 'CODEX_APP_SERVER_FORCE_CLI' -or $k -ieq 'CODEX_APP_SERVER_USE_LOCAL_DAEMON') { continue }
  $envMap[$k] = [string]$entry.Value
}
$envMap['CODEX_APP_SERVER_WS_URL'] = $wsUrl
$envArray = [string[]]@($envMap.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })

$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow = [uint16]1
  EnvironmentVariables = $envArray
}
$createRes = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = ('"' + $desktopExe + '"')
  CurrentDirectory = (Split-Path -Parent $desktopExe)
  ProcessStartupInformation = $startup
}
if ($createRes.ReturnValue -ne 0 -or -not $createRes.ProcessId) {
  throw "Win32_Process.Create failed for ChatGPT.exe (rc=$($createRes.ReturnValue))"
}
$launchedPid = [int]$createRes.ProcessId
Write-Output "desktop relaunched pid=$launchedPid; verifying handshake..."

# verify via Desktop's UTC/local logs (AppServerConnection may log from utility child PID)
$logRoots = @(
  (Join-Path $env:LOCALAPPDATA 'Codex\Logs'),
  (Join-Path $env:LOCALAPPDATA ('Packages\' + $pkg.PackageFamilyName + '\LocalCache\Local\Codex\Logs'))
)
$dateSubdirs = @(
  (Get-Date).ToUniversalTime().ToString('yyyy\/MM\/dd'),
  (Get-Date -Format 'yyyy\/MM\/dd')
) | Select-Object -Unique

$deadline = (Get-Date).AddSeconds($VerifyTimeoutSeconds)
$verified = $false
$matchedUiPid = $null
while ((Get-Date) -lt $deadline -and -not $verified) {
  $aliveChatGpt = @(Get-Process ChatGPT -ErrorAction SilentlyContinue)
  if ($aliveChatGpt.Count -eq 0 -and ((Get-Date) -gt $launchFloor.AddSeconds(8))) {
    throw "Desktop exited shortly after launch (pid=$launchedPid)"
  }
  foreach ($root in $logRoots) {
    foreach ($sub in $dateSubdirs) {
      $day = Join-Path $root $sub
      if (-not (Test-Path $day)) { continue }
      Get-ChildItem $day -Filter 'codex-desktop-*-t0-*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $launchFloor } |
        ForEach-Object {
          $tail = Get-Content $_.FullName -Tail 400 -ErrorAction SilentlyContinue | Out-String
          if ($tail -match 'initialize_handshake_result [^\n]*outcome=success [^\n]*transportKind=websocket' -and
              $tail -match 'state_changed [^\n]*initialized=true [^\n]*next=connected') {
            $verified = $true
          }
        }
    }
  }
  if (-not $verified) { Start-Sleep -Seconds 1 }
}
if (-not $verified) {
  Write-Output "VERIFY_FAILED: Desktop did not confirm websocket connection within ${VerifyTimeoutSeconds}s (check logs under $env:LOCALAPPDATA\Codex\Logs)"
  exit 2
}

# verify a real UI window exists so it isn't stuck headless in background
$uiDeadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $uiDeadline) {
  $uiPids = @(Get-ChatGptUiPids)
  if ($uiPids.Count -gt 0) { $matchedUiPid = $uiPids[0]; break }
  Start-Sleep -Milliseconds 500
}
if (-not $matchedUiPid) {
  Write-Output "WARN: WebSocket connected, but no visible ChatGPT window detected within 15s (process may be minimized/headless)"
} else {
  Write-Output "VERIFIED: Desktop pid=$launchedPid uiPid=$matchedUiPid connected to $wsUrl"
}
