param(
    [string]$OutputPath = "C:\dev\.homelab-dashboard.env"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-RandomHex {
    param([int]$Bytes = 32)

    $buffer = New-Object byte[] $Bytes
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($buffer)
    }
    finally {
        $generator.Dispose()
    }

    return -join ($buffer | ForEach-Object { $_.ToString("x2") })
}

function Get-UpdateChat {
    param($Update)

    foreach ($property in @("message", "edited_message", "channel_post", "my_chat_member", "chat_member")) {
        $container = $Update.$property
        if ($null -ne $container -and $null -ne $container.chat) {
            return $container.chat
        }
    }

    return $null
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Configurar acceso Telegram · HomeLab"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(610, 310)
$form.MinimumSize = $form.Size
$form.MaximumSize = $form.Size
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Conectar HomeLabAuthBot"
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 16)
$title.Location = New-Object System.Drawing.Point(24, 20)
$title.AutoSize = $true
$form.Controls.Add($title)

$instructions = New-Object System.Windows.Forms.Label
$instructions.Text = "Pega el token que te dio BotFather. El campo está oculto y el token se guardará sólo en este PC. El bot debe estar dentro del grupo y debes haber enviado /activar@HomeLabAuthBot."
$instructions.Location = New-Object System.Drawing.Point(27, 62)
$instructions.Size = New-Object System.Drawing.Size(540, 58)
$form.Controls.Add($instructions)

$tokenLabel = New-Object System.Windows.Forms.Label
$tokenLabel.Text = "Token de BotFather"
$tokenLabel.Location = New-Object System.Drawing.Point(27, 130)
$tokenLabel.AutoSize = $true
$form.Controls.Add($tokenLabel)

$tokenBox = New-Object System.Windows.Forms.TextBox
$tokenBox.Location = New-Object System.Drawing.Point(30, 155)
$tokenBox.Size = New-Object System.Drawing.Size(535, 30)
$tokenBox.UseSystemPasswordChar = $true
$form.Controls.Add($tokenBox)

$status = New-Object System.Windows.Forms.Label
$status.Text = ""
$status.ForeColor = [System.Drawing.Color]::FromArgb(180, 55, 55)
$status.Location = New-Object System.Drawing.Point(27, 195)
$status.Size = New-Object System.Drawing.Size(410, 45)
$form.Controls.Add($status)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancelar"
$cancelButton.Location = New-Object System.Drawing.Point(365, 224)
$cancelButton.Size = New-Object System.Drawing.Size(95, 34)
$cancelButton.Add_Click({ $form.Close() })
$form.Controls.Add($cancelButton)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = "Validar y guardar"
$saveButton.Location = New-Object System.Drawing.Point(467, 224)
$saveButton.Size = New-Object System.Drawing.Size(100, 34)
$form.Controls.Add($saveButton)
$form.AcceptButton = $saveButton
$form.CancelButton = $cancelButton

$saveButton.Add_Click({
    $token = $tokenBox.Text.Trim()
    if ($token -notmatch "^\d+:[A-Za-z0-9_-]{20,}$") {
        $status.Text = "El token no tiene el formato esperado."
        return
    }

    $saveButton.Enabled = $false
    $cancelButton.Enabled = $false
    $status.ForeColor = [System.Drawing.Color]::FromArgb(40, 95, 160)
    $status.Text = "Validando el bot y buscando el grupo…"
    $form.Refresh()

    try {
        $botInfo = Invoke-RestMethod `
            -Method Get `
            -Uri "https://api.telegram.org/bot$token/getMe" `
            -TimeoutSec 15

        if (-not $botInfo.ok) {
            throw "BotFather rechazó el token."
        }

        $updates = Invoke-RestMethod `
            -Method Get `
            -Uri "https://api.telegram.org/bot$token/getUpdates?limit=100&timeout=0" `
            -TimeoutSec 15

        $groupChat = $updates.result |
            Sort-Object update_id -Descending |
            ForEach-Object { Get-UpdateChat $_ } |
            Where-Object { $_.type -in @("group", "supergroup") } |
            Select-Object -First 1

        if ($null -eq $groupChat) {
            [System.Windows.Forms.MessageBox]::Show(
                "No he encontrado ningún grupo. Comprueba que el bot está añadido y envía de nuevo /activar@$($botInfo.result.username). Después vuelve a pulsar Validar y guardar.",
                "Grupo no detectado",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            ) | Out-Null
            $status.Text = "Grupo no detectado. Envía el comando y vuelve a intentarlo."
            return
        }

        $confirmation = [System.Windows.Forms.MessageBox]::Show(
            "Bot: @$($botInfo.result.username)`nGrupo detectado: $($groupChat.title)`n`n¿Quieres usar este grupo para los códigos de acceso?",
            "Confirmar grupo privado",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question
        )

        if ($confirmation -ne [System.Windows.Forms.DialogResult]::Yes) {
            $status.Text = "Configuración cancelada. No se ha guardado el token."
            return
        }

        $lines = @(
            "AUTH_ENABLED=true",
            "AUTH_CODE_SECRET=$(New-RandomHex)",
            "AUTH_SESSION_SECRET=$(New-RandomHex)",
            "TELEGRAM_BOT_TOKEN=$token",
            "TELEGRAM_CHAT_ID=$($groupChat.id)",
            "AUTH_COOKIE_SECURE=true",
            "AUTH_CODE_DIGITS=8",
            "AUTH_CODE_PERIOD_SECONDS=30",
            "AUTH_CODE_GRACE_SECONDS=5",
            "AUTH_SESSION_HOURS=12",
            "AUTH_ATTEMPTS_LIMIT=6",
            "AUTH_ATTEMPTS_WINDOW_SECONDS=600",
            "AUTH_LOCK_SECONDS=600",
            "AUTH_TIME_ZONE=Europe/Madrid",
            "AUTH_TRUST_PROXY=loopback, linklocal, uniquelocal"
        )

        $parent = Split-Path -Parent $OutputPath
        if (-not (Test-Path $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }

        [System.IO.File]::WriteAllLines(
            $OutputPath,
            $lines,
            (New-Object System.Text.UTF8Encoding($false))
        )

        [System.Windows.Forms.MessageBox]::Show(
            "Configuración guardada correctamente para el grupo '$($groupChat.title)'. Puedes volver a Codex.",
            "Telegram conectado",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null

        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
    }
    catch {
        $status.Text = "No se pudo validar. Revisa el token y la conexión."
    }
    finally {
        $saveButton.Enabled = $true
        $cancelButton.Enabled = $true
    }
})

$form.Add_Shown({
    $form.Activate()
    $tokenBox.Focus()
})

[void]$form.ShowDialog()
