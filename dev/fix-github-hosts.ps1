# Point github.com at an address that actually connects on this machine.
#
# Why: this machine's DNS resolves github.com to 20.205.243.166, whose port 443 is
# unreachable, while several other GitHub addresses connect fine. So it is a
# resolution problem, not a blocked network.
#
# The script PICKS A WORKING ADDRESS ITSELF, on purpose: GitHub's addresses rotate,
# and a hardcoded one goes stale within hours (seen twice in one day).
#
# Run it as administrator:
#   powershell -ExecutionPolicy Bypass -File <this file>
#
# It backs up hosts, removes the GitHub lines it added before (so re-running is
# safe), and writes fresh ones. To undo: restore the hosts.bak-* file it leaves.
#
# Every step is appended to fix-github-hosts.log next to this script, because the
# elevated window closes before its output can be read.
#
# NOTE: this file is deliberately PURE ASCII. Windows PowerShell 5.1 reads .ps1 as
# ANSI unless there is a BOM, so non-ASCII comments turn into garbage, the quotes
# get mangled, and the whole script fails to parse. Keep it English-only.

$ErrorActionPreference = 'Stop'
$hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$log = Join-Path $PSScriptRoot 'fix-github-hosts.log'

function Note([string]$line) {
  try { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format HH:mm:ss), $line) -Encoding UTF8 } catch { }
  Write-Host $line
}

Set-Content -Path $log -Value "=== run $(Get-Date -Format s) ===" -Encoding UTF8

# GitHub's own ranges; the first address that answers on 443 wins.
$candidates = '140.82.113.3', '140.82.112.3', '140.82.114.3', '140.82.121.3', '140.82.116.3',
              '20.27.177.113', '4.208.26.197', '20.200.245.247', '20.205.243.166'
# raw.githubusercontent.com lives on Fastly, a different range.
$rawCandidates = '185.199.110.133', '185.199.111.133', '185.199.108.133', '185.199.109.133'

function Test-Host443([string]$ip) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { return $c.ConnectAsync($ip, 443).Wait(900) -and $c.Connected }
  catch { return $false }
  finally { try { $c.Close() } catch { } }
}

function Pick-Ip([string[]]$list) {
  foreach ($ip in $list) {
    if (Test-Host443 $ip) { Note ("  reachable: {0}" -f $ip); return $ip }
  }
  return $null
}

try {
  Note 'step 1: probing addresses'
  $web = Pick-Ip $candidates
  if (-not $web) { throw 'no candidate address answered on port 443 (try later, or another network)' }
  $raw = Pick-Ip $rawCandidates
  if (-not $raw) { $raw = $web }
  Note ("step 2: picked web={0} raw={1}" -f $web, $raw)

  Note 'step 3: reading hosts'
  $bytes = [System.IO.File]::ReadAllBytes($hosts)
  # Self-heal: a crashed run of this script once truncated hosts, and a later run
  # then wrote ONLY our GitHub block into it -- the original Microsoft header was
  # gone. Size alone cannot tell (our block is a few hundred bytes too), so look
  # for the header itself. If it is missing, rebuild on the newest backup.
  $probe = [System.Text.Encoding]::ASCII.GetString($bytes)
  if ($probe -notmatch 'Microsoft Corp') {
    # Pick the newest backup that still HAS the original header - not merely the
    # newest non-empty one, because the truncated runs left their own backups.
    $newest = $null
    foreach ($cand in (Get-ChildItem (Split-Path $hosts) -Filter 'hosts.bak-*' -ErrorAction SilentlyContinue |
                        Sort-Object LastWriteTime -Descending)) {
      if ($cand.Length -lt 64) { continue }
      $body = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($cand.FullName))
      if ($body -match 'Microsoft Corp') { $newest = $cand; break }
    }
    if ($newest) {
      $bytes = [System.IO.File]::ReadAllBytes($newest.FullName)
      Note ("  original header missing - rebuilt from {0} ({1} bytes)" -f $newest.Name, $bytes.Length)
    } else {
      Note '  original header missing and no usable backup - writing a fresh file'
    }
  }
  $text = [System.Text.Encoding]::ASCII.GetString($bytes)
  Note ("  hosts is {0} bytes" -f $bytes.Length)

  Note 'step 4: backing up'
  $backup = "$hosts.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  [System.IO.File]::WriteAllBytes($backup, $bytes)
  Note ("  backup -> {0}" -f $backup)

  Note 'step 5: rewriting'
  $domains = 'github\.com|www\.github\.com|api\.github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com|codeload\.github\.com|gist\.github\.com'
  $kept = @()
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -match "^\s*[\d.:]+\s+($domains)\s*$") { continue }
    if ($line -match 'dsh-coo-pet') { continue }
    $kept += $line
  }
  $added = @(
    '',
    '# GitHub direct connect (dsh-coo-pet)',
    "$web github.com",
    "$web www.github.com",
    "$raw raw.githubusercontent.com",
    "$raw objects.githubusercontent.com",
    "$web codeload.github.com",
    "$web gist.github.com"
  )
  $out = (($kept + $added) -join "`r`n") + "`r`n"
  # keep a lock-friendly retry: the file is briefly held by the DNS client cache
  $done = $false
  for ($i = 1; $i -le 5 -and -not $done; $i++) {
    try {
      [System.IO.File]::WriteAllBytes($hosts, [System.Text.Encoding]::ASCII.GetBytes($out))
      $done = $true
    } catch {
      Note ("  write attempt {0} failed: {1}" -f $i, $_.Exception.Message)
      Start-Sleep -Milliseconds 400
    }
  }
  if (-not $done) { throw 'could not write hosts after 5 attempts' }

  Note 'step 6: verifying'
  $now = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($hosts))
  foreach ($line in ($now -split "`r?`n")) {
    if ($line -match 'github') { Note ("  {0}" -f $line) }
  }
  Note 'DONE - close and reopen your browser'
} catch {
  Note ("FAILED: {0}" -f $_.Exception.Message)
}
