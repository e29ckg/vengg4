[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
    $names=@($zip.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
    foreach($required in @('Install-Native.cmd','Start-Native.cmd','README.md','SECURITY_REVIEW_NODE.md','deploy/node-apache.conf','deploy/native/open-web-setup.ps1',
        'backend-node/src/server.js','backend-node/bin/install.js','backend-node/migrations/001-node-security.sql','backend-node/migrations/002-mfa-reset.sql',
        'backend-node/resources/schema.sql','backend-node/resources/templates/shift_change_form.docx',
        'backend-node/node_modules/express/package.json','backend-node/node_modules/otpauth/package.json','frontend/dist/index.html')) {
        if("vengg4-native/$required" -notin $names){throw "Missing Node installation file: $required"}
    }
    $private=@($names | Where-Object {$_ -notmatch '/node_modules/' -and ($_ -match '/(?:\.env$|storage/|database\.local\.php$|credentials\.json$)' -or $_ -match '\.php$')})
    if($private.Count){throw ('Private or legacy PHP files packaged: '+($private -join ', '))}
    $reader=New-Object IO.StreamReader($zip.GetEntry('vengg4-native/frontend/dist/index.html').Open())
    try {$html=$reader.ReadToEnd()}finally{$reader.Dispose()}
    if($html -notmatch '/vengg4/assets/'){throw 'Wrong frontend base path'}
    Write-Host "PASS: Node runtime, MFA dependencies, web installer, frontend, schema, templates and privacy checks ($($names.Count) files)"
} finally {$zip.Dispose()}
