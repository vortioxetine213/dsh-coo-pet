# 把 DSH profile 里那份插件的**复制品**换回指向 D 盘的软链接。
#
# 为什么要它:插件是以 `file:D:/deepseek/dsh-desktop-pet` 声明的依赖,
# 而 pnpm 跨盘(C → D)没法做硬链接,只能整份复制——25 MB 的插件本体,
# 外加它在 C 盘建起来的 Chromium 缓存,一次能吃掉 20~30 MB。
#
# 什么时候跑:`pnpm install`、或者 DSH 插件管理器重装 / 换包名之后
# (每次换包名重新安装都会再复制一份,所以这里按 `dsh-desktop-pet*` 通配处理)。
#
# ⚠️ 桌宠正在跑的时候先 `pet_window close`(或者直接从托盘退出桌宠),
#    否则它正在用的 Chromium 缓存文件(如 journal.baj)会被占用,删不掉。

$ErrorActionPreference = 'Stop'

# 插件本体就是这个脚本的上一级目录(dev/ 的父目录)
$Real = Split-Path -Parent $PSScriptRoot
$nm = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules'

if (-not (Test-Path $Real)) { Write-Error "找不到插件本体:$Real"; exit 1 }

$fixed = 0
foreach ($dir in Get-ChildItem $nm -Filter 'dsh-coo-pet*' -Force -ErrorAction SilentlyContinue) {
  if ($dir.LinkType) {
    Write-Host ("已是软链接:{0} -> {1}" -f $dir.Name, $dir.Target) -ForegroundColor Green
    continue
  }
  $size = (Get-ChildItem -Recurse -File $dir.FullName -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  Write-Host ("换掉 C 盘那份复制品 {0}({1:N1} MB)…" -f $dir.Name, ($size / 1MB))
  try {
    Remove-Item -Recurse -Force $dir.FullName -ErrorAction Stop
  } catch {
    Write-Error "删不掉 $($dir.Name):$($_.Exception.Message)`n桌宠可能还在跑,先 pet_window close 再试。"
    exit 1
  }
  New-Item -ItemType Junction -Path $dir.FullName -Target $Real | Out-Null
  $fixed++
}

if ($fixed -eq 0) {
  Write-Host '没有需要处理的,收工。'
} else {
  Write-Host "处理了 $fixed 个。插件本体与数据现在都在 D 盘。" -ForegroundColor Green
}
