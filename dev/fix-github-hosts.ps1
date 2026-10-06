# Point github.com at an IP that actually connects on this machine.
#
# Why: on this machine DNS resolves github.com to 20.205.243.166, whose port 443
# is unreachable, while 140.82.113.3 / 140.82.112.3 / 20.27.177.113 all connect fine.
# So it is a resolution problem, not a blocked network.
#
# What it does (run as administrator):
#   1. backs up the current hosts file;
#   2. removes any GitHub lines this script added before (so it is safe to re-run);
#   3. writes the direct-connect lines below.
#
# GitHub's IPs do change. If it stops working later, replace them with IPs that
# connect from this machine (Test-NetConnection <ip> -Port 443).
# To undo: restore the hosts.bak-* file next to the original.
#
# Note: comments and hostnames are ASCII on purpose - some Windows setups do not
# read a UTF-8 hosts file correctly.

$ErrorActionPreference = 'Stop'
$hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$log = Join-Path $PSScriptRoot 'fix-github-hosts.log'

try {
  $backup = "$hosts.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $hosts $backup -Force
  Write-Host "backed up hosts -> $backup"

  $domains = 'github\.com|www\.github\.com|api\.github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com|codeload\.github\.com|gist\.github\.com'
  $kept = Get-Content $hosts | Where-Object {
    $_ -notmatch "^\s*[\d.:]+\s+($domains)\s*$" -and $_ -notmatch 'dsh-coo-pet'
  }

  $added = @(
    '',
    '# GitHub direct connect (dsh-coo-pet)',
    '140.82.112.3 github.com',
    '140.82.112.3 www.github.com',
    '185.199.108.133 raw.githubusercontent.com',
    '185.199.108.133 objects.githubusercontent.com',
    '140.82.112.3 codeload.github.com',
    '140.82.112.3 gist.github.com'
  )

  Set-Content -Path $hosts -Value ($kept + $added) -Encoding ASCII

  $lines = Get-Content $hosts | Select-String 'github'
  Write-Host ''
  Write-Host 'done. GitHub lines now in hosts:'
  $lines | ForEach-Object { Write-Host "  $_" }
  @("OK $(Get-Date -Format s)", $backup) + ($lines | ForEach-Object { $_.ToString() }) |
    Set-Content -Path $log -Encoding UTF8
} catch {
  Write-Host "FAILED: $($_.Exception.Message)"
  "FAILED $(Get-Date -Format s): $($_.Exception.Message)" | Set-Content -Path $log -Encoding UTF8
}
