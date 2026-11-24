param([Parameter(Mandatory)][string]$UserData, [Parameter(Mandatory)][string]$Url)
$ErrorActionPreference = 'Stop'
$sdk = Join-Path $UserData 'sdk'
$core = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'
New-Item -ItemType Directory -Path $sdk | Out-Null
$archive = Join-Path $sdk 'sdk.zip'
Invoke-WebRequest -UseBasicParsing 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.2903.40/microsoft.web.webview2.1.0.2903.40.nupkg' -TimeoutSec 30 -OutFile $archive
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $hash = [BitConverter]::ToString($sha256.ComputeHash([IO.File]::ReadAllBytes($archive))).Replace('-', '')
} finally {
    $sha256.Dispose()
}
if ($hash -ne 'EF128016DD1E51C59178C827ED5B8AA3322C57AFA8675D930F8109505542AD74') {
    throw 'WebView2 SDK package hash mismatch'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $sdk)
$env:PATH = (Join-Path $sdk 'runtimes\win-x64\native') + ';' + $env:PATH
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=0"
$env:WEBVIEW2_USER_DATA_FOLDER = $UserData
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path $core
Add-Type -Path (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll')
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Klaxon P0 synthetic probe'
$form.ShowInTaskbar = $false
$form.Opacity = 0
$view = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$view.Dock = 'Fill'
$form.Controls.Add($view)
$view.Source = [Uri]$Url
[System.Windows.Forms.Application]::Run($form)
