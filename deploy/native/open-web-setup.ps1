[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port=3001)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$installer=Join-Path $root 'backend-node/bin/install.js'
$url="http://localhost:$Port"
try {
    $node=Get-Command node.exe -ErrorAction Stop
    $version=(& $node.Source --version).TrimStart('v')
    if([version]$version -lt [version]'22.13.0'){throw 'Install Node.js 22.13 or newer, then open Install-Native.cmd again.'}
    if(-not(Test-Path -LiteralPath (Join-Path $root 'backend-node/node_modules/express/package.json'))){throw 'Use the built Node installation ZIP, which includes dependencies.'}
    $normalized=$root.Replace('\','/').ToLowerInvariant()
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$installation=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    $probe={
        try{$state=Invoke-RestMethod -Uri "$url/setup-status" -TimeoutSec 2;return $state.application -eq 'vengg4-web-setup' -and $state.installation -eq $installation}catch{return $false}
    }
    if(-not(& $probe)) {
        $logs=Join-Path $root 'backend-node/storage/setup-logs'
        $null=New-Item -ItemType Directory -Path $logs -Force
        $previousPort=$env:SETUP_PORT
        try {
            $env:SETUP_PORT=[string]$Port
            $process=Start-Process -FilePath $node.Source -ArgumentList ('"'+$installer+'"') -WorkingDirectory (Join-Path $root 'backend-node') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'setup.log') -RedirectStandardError (Join-Path $logs 'setup-error.log')
        } finally {$env:SETUP_PORT=$previousPort}
        $ready=$false
        $deadline=[DateTime]::UtcNow.AddSeconds(12)
        while([DateTime]::UtcNow -lt $deadline) {
            if(& $probe){$ready=$true;break}
            if($process.HasExited){break}
            Start-Sleep -Milliseconds 250
        }
        if(-not $ready){throw "Cannot open web setup at $url. Check whether the port is in use. Details: $logs\setup-error.log"}
    }
    Start-Process $url
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    $null=[System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Vengg4 Web Setup','OK','Error')
    exit 1
}
