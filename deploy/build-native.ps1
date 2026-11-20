[CmdletBinding()]
param([string]$OutputDirectory = '', [switch]$Force)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist' }
$arguments = @('--prefix', (Join-Path $projectRoot 'backend-node'), 'run', 'package', '--', '--output', [IO.Path]::GetFullPath($OutputDirectory))
if ($Force) { $arguments += '--force' }
& npm.cmd @arguments
if ($LASTEXITCODE -ne 0) { throw 'Node installer ZIP build failed.' }
