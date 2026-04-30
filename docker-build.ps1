<#
九州修仙录 - Windows Docker 构建发布脚本

作用：
1. 在 Windows / PowerShell 环境下复用 Linux 版 docker-build.sh 的镜像构建与推送流程。
2. 不负责 Docker 登录、环境变量配置或 compose 部署，这些仍由调用方在执行前完成。

输入/输出：
- 输入：可选版本号、--server-only / -s 参数，以及环境变量 VITE_CDN_BASE、VITE_API_BASE。
- 输出：构建并推送 client/server 镜像；指定非 latest 版本时额外同步 latest 标签。

数据流/状态流：
命令行参数 -> 目标镜像列表 -> docker build -> docker push -> 可选 latest tag/push。

复用设计说明：
1. 镜像仓库、镜像命名、参数语义与 docker-build.sh 保持一致，避免 Windows 与 Linux 发布口径分裂。
2. client 构建参数只在对应环境变量存在时追加，避免空字符串覆盖前端构建配置。

关键边界条件与坑点：
1. PowerShell 参数数组必须逐项传给 docker，不能拼成单个字符串，否则 build-arg 会被错误解析。
2. 非 latest 版本才同步 latest 标签，避免重复 tag/push 浪费构建发布时间。
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
& chcp.com 65001 > $null

$Registry = 'ccr.ccs.tencentyun.com/tcb-100001011660-qtgo'
$Version = 'latest'
$Mode = 'all'
$VersionSet = $false

function Write-Info {
  param([string]$Message)
  Write-Host "[INFO] $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-ErrorMessage {
  param([string]$Message)
  Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function ConvertFrom-Utf8Hex {
  param([string]$Hex)

  $Bytes = New-Object byte[] ($Hex.Length / 2)
  for ($Index = 0; $Index -lt $Bytes.Length; $Index += 1) {
    $Bytes[$Index] = [Convert]::ToByte($Hex.Substring($Index * 2, 2), 16)
  }
  return [System.Text.Encoding]::UTF8.GetString($Bytes)
}

function Show-Usage {
  Write-Host (ConvertFrom-Utf8Hex 'E794A8E6B3953A')
  Write-Host (ConvertFrom-Utf8Hex '20202E5C646F636B65722D6275696C642E707331205BE78988E69CACE58FB75D205B2D2D7365727665722D6F6E6C797C2D735D')
  Write-Host (ConvertFrom-Utf8Hex '20202E5C646F636B65722D6275696C642E626174205BE78988E69CACE58FB75D205B2D2D7365727665722D6F6E6C797C2D735D')
  Write-Host ''
  Write-Host (ConvertFrom-Utf8Hex 'E58F82E695B03A')
  Write-Host (ConvertFrom-Utf8Hex '2020E78988E69CACE58FB720202020202020202020202020E9959CE5838FE6A087E7ADBE2C20E9BB98E8AEA4206C6174657374')
  Write-Host (ConvertFrom-Utf8Hex '20202D2D7365727665722D6F6E6C792C202D73202020E58FAAE69E84E5BBBAE5B9B6E68EA8E98081E69C8DE58AA1E7ABAFE9959CE5838F')
}

foreach ($Arg in $args) {
  switch ($Arg) {
    { $_ -eq '--server-only' -or $_ -eq '-s' } {
      $Mode = 'server-only'
      continue
    }
    { $_ -eq '-h' -or $_ -eq '--help' } {
      Show-Usage
      exit 0
    }
    default {
      if (-not $VersionSet) {
        $Version = $Arg
        $VersionSet = $true
        continue
      }

      Write-ErrorMessage "$(ConvertFrom-Utf8Hex 'E697A0E6B395E8AF86E588ABE58F82E695B0'): $Arg"
      Show-Usage
      exit 1
    }
  }
}

$Targets = @('client', 'server')
if ($Mode -eq 'server-only') {
  $Targets = @('server')
}

function Get-ImageName {
  param([string]$Target)
  return "$Registry/jiuzhou-$Target`:$Version"
}

function Invoke-Docker {
  param([string[]]$Arguments)

  & docker @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($Arguments -join ' ') $(ConvertFrom-Utf8Hex 'E689A7E8A18CE5A4B1E8B4A5EFBC8CE98080E587BAE7A081'): $LASTEXITCODE"
  }
}

function Build-Image {
  param([string]$Target)

  if ($Target -eq 'client') {
    Write-Info 'Building client...'
    $BuildArgs = @(
      'build',
      '-t',
      (Get-ImageName 'client')
    )

    if ($env:VITE_CDN_BASE) {
      $BuildArgs += @('--build-arg', "VITE_CDN_BASE=$env:VITE_CDN_BASE")
    }

    if ($env:VITE_API_BASE) {
      $BuildArgs += @('--build-arg', "VITE_API_BASE=$env:VITE_API_BASE")
    }

    $BuildArgs += @('-f', 'client/Dockerfile', '.')
    Invoke-Docker $BuildArgs
    return
  }

  Write-Info 'Building server...'
  Invoke-Docker @('build', '-t', (Get-ImageName 'server'), '-f', 'server/Dockerfile', '.')
}

function Push-Image {
  param([string]$Target)

  Write-Info "Pushing $Target..."
  Invoke-Docker @('push', (Get-ImageName $Target))
}

function Tag-LatestImage {
  param([string]$Target)

  $VersionImage = "$Registry/jiuzhou-$Target`:$Version"
  $LatestImage = "$Registry/jiuzhou-$Target`:latest"

  Invoke-Docker @('tag', $VersionImage, $LatestImage)
  Invoke-Docker @('push', $LatestImage)
}

Write-Info "Building and pushing to $Registry..."

foreach ($Target in $Targets) {
  Build-Image $Target
}

foreach ($Target in $Targets) {
  Push-Image $Target
}

if ($Version -ne 'latest') {
  Write-Info 'Tagging as latest...'
  foreach ($Target in $Targets) {
    Tag-LatestImage $Target
  }
}

Write-Host ''
Write-Info "Done! Images pushed to $Registry"
foreach ($Target in $Targets) {
  Write-Host "   - $(Get-ImageName $Target)"
}
