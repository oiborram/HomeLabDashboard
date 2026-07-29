[CmdletBinding()]
param(
    [string]$ControlPath = "C:\dev\homelab-server-control",
    [int]$RefreshSeconds = 30
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$CommandsPath = Join-Path $ControlPath "commands"
$StatusPath = Join-Path $ControlPath "status.json"
$LogPath = Join-Path $ControlPath "controller.log"
$WindroseRoot = "C:\dev\windrose-server-windows"
$WindroseStartScript = Join-Path $WindroseRoot "Start-Machurose.ps1"
$WindroseExecutable = Join-Path $WindroseRoot "R5\Binaries\Win64\WindroseServer-Win64-Shipping.exe"

New-Item -ItemType Directory -Path $CommandsPath -Force | Out-Null
$controllerMutex = [System.Threading.Mutex]::new($false, "Local\HomeLabDashboardServerController")
if (-not $controllerMutex.WaitOne(0)) {
    exit 0
}

if (-not ("ConsoleSignal" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class ConsoleSignal
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);

    public static bool TrySendCtrlC(uint processId)
    {
        FreeConsole();
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        try
        {
            if (!AttachConsole(processId))
            {
                return false;
            }

            bool sent = GenerateConsoleCtrlEvent(0, 0);
            Thread.Sleep(250);
            return sent;
        }
        finally
        {
            FreeConsole();
            SetConsoleCtrlHandler(IntPtr.Zero, false);
        }
    }
}
"@
}

function Write-ControllerLog {
    param([string]$Message)

    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 1MB) {
        Move-Item -LiteralPath $LogPath -Destination "$LogPath.old" -Force
    }

    Add-Content -LiteralPath $LogPath -Value ("{0:O} {1}" -f (Get-Date), $Message) -Encoding UTF8
}

function Get-WindroseProcesses {
    @(Get-Process -Name "WindroseServer-Win64-Shipping" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                [string]::Equals($_.Path, $WindroseExecutable, [System.StringComparison]::OrdinalIgnoreCase)
            }
            catch {
                $false
            }
        })
}

function Write-ServerStatus {
    param(
        [ValidateSet("running", "stopped", "starting", "stopping", "error")]
        [string]$Status,
        [AllowNull()]
        [string]$Message = $null
    )

    $processes = Get-WindroseProcesses
    if ($Status -notin @("starting", "stopping", "error")) {
        $Status = if ($processes.Count -gt 0) { "running" } else { "stopped" }
    }

    $payload = [ordered]@{
        version = 1
        updatedAt = (Get-Date).ToUniversalTime().ToString("O")
        servers = @(
            [ordered]@{
                id = "windrose"
                status = $Status
                processIds = @($processes | ForEach-Object { $_.Id })
                message = $Message
            }
        )
    }

    $temporaryPath = "$StatusPath.$PID.tmp"
    $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $StatusPath -Force
}

function Wait-ForWindroseState {
    param(
        [bool]$Running,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ((((Get-WindroseProcesses).Count -gt 0)) -eq $Running) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Start-Windrose {
    if ((Get-WindroseProcesses).Count -gt 0) {
        Write-ServerStatus -Status "running"
        return
    }

    if (-not (Test-Path -LiteralPath $WindroseStartScript) -or -not (Test-Path -LiteralPath $WindroseExecutable)) {
        throw "No se ha encontrado la instalación de Windrose."
    }

    Write-ServerStatus -Status "starting" -Message "Iniciando servidor"
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$WindroseStartScript`"") `
        -WorkingDirectory $WindroseRoot `
        -WindowStyle Hidden

    if (-not (Wait-ForWindroseState -Running $true -TimeoutSeconds 30)) {
        throw "Windrose no inició dentro del tiempo esperado."
    }

    Write-ControllerLog "Windrose iniciado desde el dashboard."
    Write-ServerStatus -Status "running"
}

function Stop-Windrose {
    $processes = Get-WindroseProcesses
    if ($processes.Count -eq 0) {
        Write-ServerStatus -Status "stopped"
        return
    }

    Write-ServerStatus -Status "stopping" -Message "Deteniendo servidor y guardando la partida"

    $closeRequested = $false
    foreach ($process in $processes) {
        try {
            if ($process.CloseMainWindow()) {
                $closeRequested = $true
            }
        }
        catch {
            Write-ControllerLog "No se pudo solicitar el cierre de la ventana PID $($process.Id): $($_.Exception.Message)"
        }
    }

    if ($closeRequested -and (Wait-ForWindroseState -Running $false -TimeoutSeconds 30)) {
        Write-ControllerLog "Windrose detenido correctamente desde el dashboard."
        Write-ServerStatus -Status "stopped"
        return
    }

    foreach ($process in (Get-WindroseProcesses)) {
        [void][ConsoleSignal]::TrySendCtrlC([uint32]$process.Id)
    }

    if (-not (Wait-ForWindroseState -Running $false -TimeoutSeconds 10)) {
        foreach ($process in (Get-WindroseProcesses)) {
            Stop-Process -Id $process.Id -Force
        }
        Write-ControllerLog "Windrose requirió cierre forzado tras agotar el cierre normal."
    }
    else {
        Write-ControllerLog "Windrose detenido correctamente desde el dashboard."
    }

    Write-ServerStatus -Status "stopped"
}

function Invoke-ServerCommand {
    param([System.IO.FileInfo]$CommandFile)

    try {
        $command = Get-Content -LiteralPath $CommandFile.FullName -Raw | ConvertFrom-Json
        if ($command.version -ne 1 -or $command.serverId -ne "windrose" -or $command.enabled -isnot [bool]) {
            throw "Orden no válida o servidor no permitido."
        }

        if ($command.enabled) {
            Start-Windrose
        }
        else {
            Stop-Windrose
        }
    }
    catch {
        Write-ControllerLog "Error procesando $($CommandFile.Name): $($_.Exception.Message)"
        Write-ServerStatus -Status "error" -Message $_.Exception.Message
    }
    finally {
        Remove-Item -LiteralPath $CommandFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

Write-ControllerLog "Controlador iniciado."
Write-ServerStatus -Status "stopped"

$watcher = [System.IO.FileSystemWatcher]::new($CommandsPath)
$watcher.NotifyFilter =
    [System.IO.NotifyFilters]::FileName -bor
    [System.IO.NotifyFilters]::LastWrite

try {
    while ($true) {
        $commandFiles = @(Get-ChildItem -LiteralPath $CommandsPath -Filter "*.json" -File |
            Sort-Object CreationTimeUtc)
        if ($commandFiles.Count -gt 0) {
            $commandFiles | ForEach-Object { Invoke-ServerCommand -CommandFile $_ }
        }
        else {
            Write-ServerStatus -Status "stopped"
        }
        [void]$watcher.WaitForChanged(
            [System.IO.WatcherChangeTypes]::Created -bor
            [System.IO.WatcherChangeTypes]::Changed -bor
            [System.IO.WatcherChangeTypes]::Renamed,
            $RefreshSeconds * 1000
        )
    }
}
finally {
    $watcher.Dispose()
    Write-ControllerLog "Controlador detenido."
    $controllerMutex.ReleaseMutex()
    $controllerMutex.Dispose()
}
