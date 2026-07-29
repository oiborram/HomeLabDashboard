[CmdletBinding()]
param(
    [string]$ControlPath = "C:\dev\homelab-server-control"
)

$ErrorActionPreference = "Stop"

$TaskName = "HomeLab Dashboard Server Controller"
$InstallRoot = "C:\ProgramData\HomeLabDashboard"
$SourceController = Join-Path $PSScriptRoot "ServerController.ps1"
$InstalledController = Join-Path $InstallRoot "ServerController.ps1"

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $ControlPath "commands") -Force | Out-Null
Copy-Item -LiteralPath $SourceController -Destination $InstalledController -Force

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
    $startupMethod = "tarea programada"
}
catch [Microsoft.Management.Infrastructure.CimException] {
    $startupPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    $shortcutPath = Join-Path $startupPath "HomeLab Dashboard Server Controller.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstalledController`" -ControlPath `"$ControlPath`""
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.WindowStyle = 7
    $shortcut.Save()

    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$InstalledController`"", "-ControlPath", "`"$ControlPath`"") `
        -WorkingDirectory $InstallRoot `
        -WindowStyle Hidden
    $startupMethod = "inicio de sesión de Windows"
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
