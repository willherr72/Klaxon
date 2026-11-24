# Offline test worker. Only fixed fixture owners, generations and simulated
# provider outcomes are accepted. Invoke through session.test.mjs.
param(
    [Parameter(Mandatory)][ValidatePattern('^klaxon-p0-session-[A-Za-z0-9]{6}$')][string]$RunDirectory,
    [Parameter(Mandatory)][ValidateSet('sign-in', 'resume', 'logout')][string]$Action,
    [Parameter(Mandatory)][ValidateSet('alpha', 'beta')][string]$Owner,
    [ValidateSet('grant', 'unavailable', 'expired')][string]$Response = 'grant',
    [ValidateRange(1, 999)][int]$Generation = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$directory = Join-Path ([IO.Path]::GetTempPath()) $RunDirectory
$slot = Join-Path $directory "$Owner.bin"
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
# Public context binds the ciphertext to this app and its selected fixture owner.
$context = [Text.Encoding]::UTF8.GetBytes("dev.klaxon.p0native/session-v1/$Owner")

function Get-FixtureMarker([int]$Version) {
    "KLAXON-P0-INERT/$Owner/$Version"
}

function Save-FixtureMarker([int]$Version) {
    $bytes = [Text.Encoding]::UTF8.GetBytes((Get-FixtureMarker $Version))
    $ciphertext = [Security.Cryptography.ProtectedData]::Protect($bytes, $context, $scope)
    $staged = Join-Path $directory ([Guid]::NewGuid().ToString() + '.tmp')
    try {
        [IO.File]::WriteAllBytes($staged, $ciphertext)
        if ([IO.File]::Exists($slot)) {
            [IO.File]::Replace($staged, $slot, [NullString]::Value)
        } else {
            [IO.File]::Move($staged, $slot)
        }
    } finally {
        [IO.File]::Delete($staged)
    }
}

if ($Action -eq 'sign-in') {
    Save-FixtureMarker 1
    return 'stored'
}
if ($Action -eq 'logout') {
    [IO.File]::Delete($slot)
    return 'signed-out'
}
if (-not [IO.File]::Exists($slot)) {
    return 'sign-in-required'
}

$ciphertext = [IO.File]::ReadAllBytes($slot)
try {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect($ciphertext, $context, $scope)
} catch [Security.Cryptography.CryptographicException] {
    # Failure to unlock the record is not an authoritative expiry response.
    return 'storage-unavailable'
}

# Simulated refresh authority. Decrypting a record alone never grants access.
if ($Response -eq 'unavailable') {
    return 'retry-required'
}
if ($Response -eq 'expired' -or [Text.Encoding]::UTF8.GetString($bytes) -cne (Get-FixtureMarker $Generation)) {
    [IO.File]::Delete($slot)
    return 'sign-in-required'
}
Save-FixtureMarker ($Generation + 1)
return 'authenticated'
