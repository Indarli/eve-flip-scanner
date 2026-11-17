param([switch]$Once)

$ErrorActionPreference = "SilentlyContinue"
$base = "http://127.0.0.1:8787"

if ($Once) {
  try {
    $r = Invoke-RestMethod -Uri "$base/api/notifier/alerts" -TimeoutSec 15
    $items = @($r.items)
    Write-Output ("items: " + $items.Count)
    $items | Select-Object -First 5 | ForEach-Object { Write-Output ("[" + $_.type + "] " + $_.title + " — " + $_.text) }
  } catch {
    Write-Output ("ERROR: " + $_.Exception.Message)
  }
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# один экземпляр нотификатора
$createdNew = $false
$script:mutex = New-Object System.Threading.Mutex($true, "Local\EveFlipNotifier", [ref]$createdNew)
if (-not $createdNew) { exit 0 }

$script:seen = @{}
$script:firstPoll = $true
$script:startTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(13, 20, 30)
$form.Size = New-Object System.Drawing.Size(390, 170)
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($wa.Right - 406), ($wa.Bottom - 186))

$accent = New-Object System.Windows.Forms.Panel
$accent.SetBounds(0, 0, 4, 170)
$accent.BackColor = [System.Drawing.Color]::FromArgb(255, 140, 60)
$form.Controls.Add($accent)

$script:title = New-Object System.Windows.Forms.Label
$script:title.Text = "EVE FLIP"
$script:title.ForeColor = [System.Drawing.Color]::FromArgb(255, 178, 122)
$script:title.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$script:title.SetBounds(16, 10, 320, 22)
$script:title.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($script:title)

$script:body = New-Object System.Windows.Forms.Label
$script:body.Text = ""
$script:body.ForeColor = [System.Drawing.Color]::FromArgb(221, 231, 246)
$script:body.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$script:body.SetBounds(16, 36, 356, 118)
$script:body.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($script:body)

$close = New-Object System.Windows.Forms.Label
$close.Text = "×"
$close.ForeColor = [System.Drawing.Color]::FromArgb(127, 144, 171)
$close.Font = New-Object System.Drawing.Font("Segoe UI", 12)
$close.SetBounds(362, 4, 24, 24)
$close.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($close)

$openIntel = {
  Start-Process "http://127.0.0.1:8787/#intel"
  $form.Hide()
}

$form.Add_Click($openIntel)
$script:title.Add_Click($openIntel)
$script:body.Add_Click($openIntel)

$close.Add_Click({
  $script:pollTimer.Stop()
  $script:hideTimer.Stop()
  $form.Close()
  [System.Windows.Forms.Application]::Exit()
})

function Play-Sound {
  try {
    $resp = Invoke-WebRequest -Uri "$base/api/intel/sound" -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -eq 200 -and $resp.Content.Length -gt 0) {
      $tmp = Join-Path $env:TEMP "eveflip_alert.wav"
      [System.IO.File]::WriteAllBytes($tmp, $resp.Content)
      $player = New-Object System.Media.SoundPlayer $tmp
      $player.Play()
      return
    }
  } catch { }
  [System.Media.SystemSounds]::Exclamation.Play()
}

function Show-Alert($items) {
  $top = @($items | Sort-Object ts -Descending | Select-Object -First 3)
  $types = @($top | ForEach-Object { $_.type } | Select-Object -Unique)
  if ($types -contains "zkb") { $head = "ZKB" }
  elseif ($types -contains "pi") { $head = "ПЛАНЕТАРКА" }
  else { $head = "ИНТЕЛ" }

  $script:title.Text = "EVE FLIP · " + $head
  $lines = @()
  foreach ($it in $top) { $lines += ($it.title + "`r`n" + $it.text) }
  $script:body.Text = ($lines -join "`r`n`r`n")

  $form.Show()
  $form.BringToFront()
  $script:hideTimer.Stop()
  $script:hideTimer.Start()
  Play-Sound
}

function Poll {
  try {
    $r = Invoke-RestMethod -Uri "$base/api/notifier/alerts" -TimeoutSec 8
  } catch {
    return
  }
  $items = @($r.items)
  $wasFirst = $script:firstPoll
  $script:firstPoll = $false
  if (-not $items.Count) { return }

  $new = @()
  foreach ($it in $items) {
    if ($script:seen.ContainsKey($it.id)) { continue }
    $script:seen[$it.id] = $true
    if (-not $wasFirst -and [double]$it.ts -gt ($script:startTime - 120000)) { $new += $it }
  }
  if ($new.Count -gt 0) { Show-Alert $new }
}

$script:pollTimer = New-Object System.Windows.Forms.Timer
$script:pollTimer.Interval = 2000
$script:pollTimer.Add_Tick({ Poll })
$script:pollTimer.Start()

$script:hideTimer = New-Object System.Windows.Forms.Timer
$script:hideTimer.Interval = 10000
$script:hideTimer.Add_Tick({
  $form.Hide()
  $script:hideTimer.Stop()
})

[System.Windows.Forms.Application]::Run()
