[CmdletBinding()]
param(
    [string]$ControlPath = "C:\dev\homelab-server-control"
)

$ErrorActionPreference = "Stop"
$InstallRoot = "C:\ProgramData\HomeLabDashboard"
$ControllerPath = Join-Path $InstallRoot "ServerController.ps1"
$LogPath = Join-Path $InstallRoot "bootstrap.log"
$StatusPath = Join-Path $ControlPath "status.json"
$HeartbeatMaxAgeSeconds = 90

function Write-BootstrapLog {
    param([string]$Message)

    try {
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
        if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 65536) {
            Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force
        }
        Add-Content -LiteralPath $LogPath -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $Message) -Encoding ASCII
    }
    catch {
        # This helper must never prevent the Docker watchdog from running.
    }
}

function Test-ControllerHeartbeat {
    if (-not (Test-Path -LiteralPath $StatusPath)) {
        return $false
    }

    try {
        $state = Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
        $updatedAt = [DateTimeOffset]::Parse([string]$state.updatedAt).ToUniversalTime()
        $ageSeconds = ([DateTimeOffset]::UtcNow - $updatedAt).TotalSeconds
        return $ageSeconds -ge -5 -and $ageSeconds -le $HeartbeatMaxAgeSeconds
    }
    catch {
        return $false
    }
}

try {
    # El watchdog se ejecuta tanto en la sesión de servicios como en la sesión
    # interactiva. El latido compartido funciona en ambas; inspeccionar CommandLine no.
    if (Test-ControllerHeartbeat) {
        exit 0
    }

    if (-not (Test-Path -LiteralPath $ControllerPath)) {
        Write-BootstrapLog "Server controller script is missing: $ControllerPath"
        exit 0
    }

    if (-not ("DetachedProcess" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class DetachedProcess
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Start(string application, string arguments, string workingDirectory, out uint processId)
    {
        const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
        const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
        const uint CREATE_NO_WINDOW = 0x08000000;

        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(startup);
        var commandLine = new StringBuilder("\"" + application + "\" " + arguments);
        PROCESS_INFORMATION process;
        bool created = CreateProcess(
            application,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
            IntPtr.Zero,
            workingDirectory,
            ref startup,
            out process);

        if (!created)
        {
            processId = 0;
            return Marshal.GetLastWin32Error();
        }

        processId = process.dwProcessId;
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return 0;
    }
}
"@
    }

    $powershellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ControllerPath`" -ControlPath `"$ControlPath`""
    [uint32]$createdPid = 0
    $errorCode = [DetachedProcess]::Start($powershellPath, $arguments, $InstallRoot, [ref]$createdPid)
    if ($errorCode -eq 5) {
        $fallback = Start-Process -FilePath $powershellPath `
            -ArgumentList $arguments `
            -WorkingDirectory $InstallRoot `
            -WindowStyle Hidden `
            -PassThru
        $createdPid = $fallback.Id
        $errorCode = 0
    }
    if ($errorCode -ne 0 -or -not $createdPid) {
        Write-BootstrapLog "Detached Windows process creation failed with code $errorCode."
        exit 0
    }

    $deadline = (Get-Date).AddSeconds(5)
    do {
        Start-Sleep -Milliseconds 250
    } while (-not (Test-ControllerHeartbeat) -and (Get-Date) -lt $deadline)

    if (-not (Test-ControllerHeartbeat)) {
        Write-BootstrapLog "Server controller PID $createdPid did not publish a fresh heartbeat."
        exit 0
    }

    Write-BootstrapLog "Server controller started by Docker watchdog."
}
catch {
    Write-BootstrapLog "Server controller startup failed: $($_.Exception.Message)"
}

exit 0
