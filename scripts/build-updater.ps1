$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'updater\Program.cs'
$manifest = Join-Path $projectRoot 'updater\app.manifest'
$outputDir = Join-Path $projectRoot 'build\updater'
$output = Join-Path $outputDir 'PartyP2P.Updater.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Compilador C# do .NET Framework não encontrado.' }

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
& $compiler /nologo /target:winexe /optimize+ /platform:anycpu `
  /out:$output /win32manifest:$manifest `
  /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll `
  $source
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar o updater (código $LASTEXITCODE)." }
Write-Host "Updater nativo: $output"
