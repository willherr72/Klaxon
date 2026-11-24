$ErrorActionPreference = 'Stop'

function Find-WebView2Runtime {
    # Evergreen registers a machine or user install. Edge browser versions use different keys.
    $product = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $locations = @{
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$product" = ${env:ProgramFiles(x86)}
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$product" = $env:LOCALAPPDATA
    }
    foreach ($key in $locations.Keys) {
        $entry = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
        if (-not $entry.pv -or [version]$entry.pv -le [version]'0.0.0.0') { continue }
        $directory = $entry.location
        if (-not $directory) { $directory = Join-Path $locations[$key] 'Microsoft/EdgeWebView/Application' }
        $binary = Join-Path $directory "$($entry.pv)/msedgewebview2.exe"
        if (Test-Path -LiteralPath $binary -PathType Leaf) { return Get-Item -LiteralPath $binary }
    }
}

$runtime = Find-WebView2Runtime
if (-not $runtime) {
    $bootstrapper = Join-Path $env:RUNNER_TEMP 'MicrosoftEdgeWebview2Setup.exe'
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrapper
    $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapper
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo('SimpleName', $false) -ne 'Microsoft Corporation') {
        throw 'WebView2 bootstrapper requires a valid Microsoft Corporation signature.'
    }
    $setup = Start-Process -FilePath $bootstrapper -ArgumentList '/silent', '/install' -WindowStyle Hidden -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "WebView2 installation exited with $($setup.ExitCode)." }
    $runtime = Find-WebView2Runtime
    if (-not $runtime) { throw 'WebView2 installer completed without a registered runtime executable.' }
}

Write-Host "WebView2 $($runtime.VersionInfo.FileVersion) at $($runtime.FullName) on $env:PROCESSOR_ARCHITECTURE"
