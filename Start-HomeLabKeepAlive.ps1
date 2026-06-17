$ErrorActionPreference = "SilentlyContinue"

$stdoutPath = "C:\dev\HomeLabDashboard\homelab-keepalive.out.log"
$stderrPath = "C:\dev\HomeLabDashboard\homelab-keepalive.err.log"
$command = @'
set -eu
while ! docker info >/dev/null 2>&1; do
  sleep 2
done
cd /mnt/c/dev
docker compose up -d
while true; do
  sleep 3600
done
'@

Start-Process `
  -FilePath "wsl.exe" `
  -ArgumentList @("-d", "Ubuntu", "--", "bash", "-lc", $command) `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden
