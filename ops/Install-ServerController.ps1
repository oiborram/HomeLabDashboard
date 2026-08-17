[CmdletBinding()]
param(
    [string]$ControlPath = "C:\dev\homelab-server-control"
)

$ErrorActionPreference = "Stop"

$TaskName = "HomeLab Dashboard Server Controller"
$InstallRoot = "C:\ProgramData\HomeLabDashboard"
$SourceController = Join-Path $PSScriptRoot "ServerController.ps1"
$SourceEnsureController = Join-Path $PSScriptRoot "Ensure-ServerController.ps1"
$InstalledController = Join-Path $InstallRoot "ServerController.ps1"
$InstalledEnsureController = Join-Path $InstallRoot "Ensure-ServerController.ps1"
$StartupShortcut = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) "HomeLab Dashboard Server Controller.lnk"
$DockerWatchdogScript = "C:\dev\watchdog-anti-caidas\watchdog-compose.sh"

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $ControlPath "commands") -Force | Out-Null
Copy-Item -LiteralPath $SourceController -Destination $InstalledController -Force
Copy-Item -LiteralPath $SourceEnsureController -Destination $InstalledEnsureController -Force

function Install-DockerWatchdogBootHook {
    if (-not (Test-Path -LiteralPath $DockerWatchdogScript)) {
        return $false
    }

    $content = Get-Content -LiteralPath $DockerWatchdogScript -Raw
    $hook = @"
# <homelab-server-controller>
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File '$InstalledEnsureController' -ControlPath '$ControlPath' >/dev/null 2>&1 || true
# </homelab-server-controller>
"@
    if ($content.Contains("# <homelab-server-controller>")) {
        $updated = [regex]::Replace(
            $content,
            '(?ms)^# <homelab-server-controller>.*?^# </homelab-server-controller>',
            $hook.TrimEnd()
        )
    }
    else {
        $anchor = 'mkdir -p "$log_dir"'
        if (-not $content.Contains($anchor)) {
            return $false
        }
        $updated = $content.Replace($anchor, "$anchor`n`n$hook")
    }

    if ($updated -eq $content) {
        return $true
    }
    [System.IO.File]::WriteAllText(
        $DockerWatchdogScript,
        $updated,
        [System.Text.UTF8Encoding]::new($false)
    )
    return $true
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstalledController`" -ControlPath `"$ControlPath`""
$triggers = @(
    New-ScheduledTaskTrigger -AtStartup
    New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

try {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $triggers `
        -Principal $principal `
        -Settings $settings `
        -Description "Controla únicamente los servidores permitidos desde HomeLabDashboard." `
        -Force `
        -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Remove-Item -LiteralPath $StartupShortcut -Force -ErrorAction SilentlyContinue
    $startupMethod = "tarea programada al arrancar Windows"
}
catch [Microsoft.Management.Infrastructure.CimException] {
    if (Install-DockerWatchdogBootHook) {
        Remove-Item -LiteralPath $StartupShortcut -Force -ErrorAction SilentlyContinue
        & schtasks.exe /Run /TN "Dev Docker Compose Watchdog" | Out-Null
        $startupMethod = "watchdog Docker antes del inicio de sesión"
    }
    else {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($StartupShortcut)
        $shortcut.TargetPath = "powershell.exe"
        $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstalledController`" -ControlPath `"$ControlPath`""
        $shortcut.WorkingDirectory = $InstallRoot
        $shortcut.WindowStyle = 7
        $shortcut.Save()

        & $InstalledEnsureController -ControlPath $ControlPath
        $startupMethod = "inicio de sesión de Windows (respaldo)"
    }
}

$deadline = (Get-Date).AddSeconds(10)
$statusPath = Join-Path $ControlPath "status.json"
do {
    Start-Sleep -Milliseconds 250
} while (-not (Test-Path -LiteralPath $statusPath) -and (Get-Date) -lt $deadline)

if (-not (Test-Path -LiteralPath $statusPath)) {
    throw "El controlador se instaló, pero no llegó a publicar su estado."
}

Write-Output "Controlador instalado y activo mediante $startupMethod."
