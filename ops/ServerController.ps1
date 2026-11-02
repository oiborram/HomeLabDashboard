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
$ManagedServers = @(
    [pscustomobject]@{
        Id = "windrose"
        Name = "Windrose"
        Root = "C:\dev\windrose-server-windows"
        StartScript = "C:\dev\windrose-server-windows\Start-Machurose.ps1"
        Executable = "C:\dev\windrose-server-windows\R5\Binaries\Win64\WindroseServer-Win64-Shipping.exe"
        ProcessName = "WindroseServer-Win64-Shipping"
    },
    [pscustomobject]@{
        Id = "enshrouded"
        Name = "Enshrouded"
        Root = "C:\dev\enshrouded-server"
        StartScript = "C:\dev\enshrouded-server\Start-Enshrouded.ps1"
        UpdateScript = "C:\dev\enshrouded-server\Update-Enshrouded.ps1"
        UpdateOnStop = $true
        Executable = "C:\dev\enshrouded-server\enshrouded_server.exe"
        ProcessName = "enshrouded_server"
    }
)
$ServerById = @{}
foreach ($server in $ManagedServers) {
    $ServerById[$server.Id] = $server
}

New-Item -ItemType Directory -Path $CommandsPath -Force | Out-Null
$otherControllers = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -ieq "powershell.exe" -and
    $_.CommandLine -match '-File\s+"?C:\\ProgramData\\HomeLabDashboard\\ServerController\.ps1"?'
})
if ($otherControllers.Count -gt 0) {
    exit 0
}
$controllerMutex = [System.Threading.Mutex]::new($false, "Global\HomeLabDashboardServerController")
$controllerMutexAcquired = $false
try {
    $controllerMutexAcquired = $controllerMutex.WaitOne(0)
}
catch [System.Threading.AbandonedMutexException] {
    # WaitOne concede la propiedad aunque notifique que la instancia anterior cayó.
    $controllerMutexAcquired = $true
}
if (-not $controllerMutexAcquired) {
    $controllerMutex.Dispose()
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

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 1MB) {
                Move-Item -LiteralPath $LogPath -Destination "$LogPath.old" -Force
            }

            Add-Content -LiteralPath $LogPath -Value ("{0:O} {1}" -f (Get-Date), $Message) -Encoding UTF8
            return
        }
        catch {
            if ($attempt -lt 3) {
                Start-Sleep -Milliseconds 100
            }
        }
    }
}

function Get-ServerProcesses {
    param([Parameter(Mandatory)]$Server)

    @(Get-Process -Name $Server.ProcessName -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $processPath = $_.Path
                [string]::IsNullOrWhiteSpace($processPath) -or
                    [string]::Equals($processPath, $Server.Executable, [System.StringComparison]::OrdinalIgnoreCase)
            }
            catch {
                # Windows oculta Path entre sesiones de inicio de sesión. El nombre del
                # ejecutable sigue siendo suficientemente específico para estos servidores.
                $true
            }
        })
}

function Write-ServerStatus {
    param(
        [string]$ServerId,
        [ValidateSet("running", "stopped", "starting", "stopping", "updating", "error")]
        [string]$Status = "stopped",
        [AllowNull()]
        [string]$Message = $null
    )

    $payload = [ordered]@{
        version = 1
        updatedAt = (Get-Date).ToUniversalTime().ToString("O")
        servers = @($ManagedServers | ForEach-Object {
            $server = $_
            $processes = Get-ServerProcesses -Server $server
            $serverStatus = if ($processes.Count -gt 0) { "running" } else { "stopped" }
            $serverMessage = $null
            if ($server.Id -eq $ServerId -and $Status -in @("starting", "stopping", "updating", "error")) {
                $serverStatus = $Status
                $serverMessage = $Message
            }

            [ordered]@{
                id = $server.Id
                status = $serverStatus
                processIds = @($processes | ForEach-Object { $_.Id })
                message = $serverMessage
            }
        })
    }

    $temporaryPath = "$StatusPath.$PID.tmp"
    $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $StatusPath -Force
}

function Wait-ForServerState {
    param(
        [Parameter(Mandatory)]$Server,
        [bool]$Running,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ((((Get-ServerProcesses -Server $Server).Count -gt 0)) -eq $Running) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Start-ManagedServer {
    param([Parameter(Mandatory)]$Server)

    if ((Get-ServerProcesses -Server $Server).Count -gt 0) {
        Write-ServerStatus
        return
    }

    if (-not (Test-Path -LiteralPath $Server.StartScript) -or -not (Test-Path -LiteralPath $Server.Executable)) {
        throw "No se ha encontrado la instalación de $($Server.Name)."
    }

    Write-ServerStatus -ServerId $Server.Id -Status "starting" -Message "Iniciando servidor"
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($Server.StartScript)`"") `
        -WorkingDirectory $Server.Root `
        -WindowStyle Hidden

    if (-not (Wait-ForServerState -Server $Server -Running $true -TimeoutSeconds 30)) {
        throw "$($Server.Name) no inició dentro del tiempo esperado."
    }

    Write-ControllerLog "$($Server.Name) iniciado desde el dashboard."
    Write-ServerStatus
}

function Update-ManagedServer {
    param([Parameter(Mandatory)]$Server)

    if (-not $Server.UpdateOnStop) {
        return
    }
    if (-not (Test-Path -LiteralPath $Server.UpdateScript)) {
        throw "No se ha encontrado el actualizador de $($Server.Name)."
    }

    Write-ServerStatus -ServerId $Server.Id -Status "updating" -Message "Actualizando servidor con SteamCMD"
    Write-ControllerLog "$($Server.Name) está comprobando actualizaciones."
    $updater = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($Server.UpdateScript)`"") `
        -WorkingDirectory $Server.Root `
        -WindowStyle Hidden `
        -PassThru

    while (-not $updater.WaitForExit(5000)) {
        Write-ServerStatus -ServerId $Server.Id -Status "updating" -Message "Actualizando servidor con SteamCMD"
    }
    $updater.Refresh()
    if ($updater.ExitCode -ne 0) {
        throw "SteamCMD no pudo actualizar $($Server.Name) (código $($updater.ExitCode))."
    }
    Write-ControllerLog "$($Server.Name) actualizado y listo para iniciar."
}

function Stop-ManagedServer {
    param([Parameter(Mandatory)]$Server)

    $processes = Get-ServerProcesses -Server $Server
    if ($processes.Count -eq 0) {
        Write-ServerStatus
        return
    }

    Write-ServerStatus -ServerId $Server.Id -Status "stopping" -Message "Deteniendo servidor y guardando la partida"

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

    if ($closeRequested -and (Wait-ForServerState -Server $Server -Running $false -TimeoutSeconds 30)) {
        Write-ControllerLog "$($Server.Name) detenido correctamente desde el dashboard."
        Update-ManagedServer -Server $Server
        Write-ServerStatus
        return
    }

    foreach ($process in (Get-ServerProcesses -Server $Server)) {
        [void][ConsoleSignal]::TrySendCtrlC([uint32]$process.Id)
    }

    if (-not (Wait-ForServerState -Server $Server -Running $false -TimeoutSeconds 10)) {
        foreach ($process in (Get-ServerProcesses -Server $Server)) {
            Stop-Process -Id $process.Id -Force
        }
        Write-ControllerLog "$($Server.Name) requirió cierre forzado tras agotar el cierre normal."
    }
    else {
        Write-ControllerLog "$($Server.Name) detenido correctamente desde el dashboard."
    }

    Update-ManagedServer -Server $Server
    Write-ServerStatus
}

function Invoke-ServerCommand {
    param([System.IO.FileInfo]$CommandFile)

    try {
        $command = Get-Content -LiteralPath $CommandFile.FullName -Raw | ConvertFrom-Json
        if ($command.version -ne 1 -or -not $ServerById.ContainsKey([string]$command.serverId) -or $command.enabled -isnot [bool]) {
            throw "Orden no válida o servidor no permitido."
        }

        $server = $ServerById[[string]$command.serverId]
        if ($command.enabled) {
            Start-ManagedServer -Server $server
        }
        else {
            Stop-ManagedServer -Server $server
        }
    }
    catch {
        Write-ControllerLog "Error procesando $($CommandFile.Name): $($_.Exception.Message)"
        Write-ServerStatus -ServerId ([string]$command.serverId) -Status "error" -Message $_.Exception.Message
    }
    finally {
        Remove-Item -LiteralPath $CommandFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

Write-ControllerLog "Controlador iniciado."
Write-ServerStatus

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
            Write-ServerStatus
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
