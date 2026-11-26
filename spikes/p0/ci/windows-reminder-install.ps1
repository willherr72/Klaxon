#requires -Version 7.2
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows -or -not [Environment]::Is64BitProcess -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:KLAXON_P0_RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'This probe requires a GitHub-hosted disposable Windows Actions runner.'
}

function Assert-Absent([string[]] $Paths) {
    foreach ($path in $Paths) {
        if (Test-Path -LiteralPath $path) { throw "Expected no fixture state at $path" }
    }
}

function Assert-NoReparsePoints([string] $Path) {
    for ($part = $Path; $part; $part = Split-Path -LiteralPath $part) {
        if ((Test-Path -LiteralPath $part) -and
            ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Fixture path contains a reparse point at $part"
        }
    }
}

function Get-LocalFolder([Environment+SpecialFolder] $Folder) {
    $path = [Environment]::GetFolderPath($Folder, 'DoNotVerify')
    if ($path -notmatch '^[A-Za-z]:\\') { throw "Expected a local Windows folder for $Folder" }
    return $path
}

function Assert-FixtureStopped {
    if (Get-Process -Name 'klaxon-p0-reminder-fixture' -ErrorAction SilentlyContinue) {
        throw 'The reminder fixture process is running.'
    }
}

$product = 'Klaxon P0 Reminder Fixture'
$appId = 'dev.klaxon.p0reminderfixture'
$binary = 'klaxon-p0-reminder-fixture.exe'
$native = Join-Path $PSScriptRoot '../native'
$installer = Join-Path $native "src-tauri/target/debug/bundle/nsis/${product}_0.1.0_x64-setup.exe"

$userProfile = Get-LocalFolder UserProfile
$localAppData = Get-LocalFolder LocalApplicationData
$roamingAppData = Get-LocalFolder ApplicationData
$programs = Get-LocalFolder Programs
$desktop = Get-LocalFolder DesktopDirectory
foreach ($folder in $localAppData, $roamingAppData, $programs, $desktop) {
    if (-not $folder.StartsWith("$userProfile\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Fixture folder is outside the current profile at $folder"
    }
    Assert-NoReparsePoints $folder
}

$installDir = Join-Path $localAppData $product
$executable = Join-Path $installDir $binary
$uninstaller = Join-Path $installDir 'uninstall.exe'
$shortcutName = "$product.lnk"
$shortcuts = [ordered]@{
    'Start menu' = Join-Path $programs $shortcutName
    'Desktop' = Join-Path $desktop $shortcutName
}
$uninstallRelative = "Microsoft\Windows\CurrentVersion\Uninstall\$product"
$settingsRelative = "klaxon\$product"
$uninstallKey = "HKCU:\Software\$uninstallRelative"
$settingsKey = "HKCU:\Software\$settingsRelative"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$unexpectedPaths = @(
    (Join-Path $programs "$product\$shortcutName")
    (Join-Path (Get-LocalFolder CommonPrograms) $shortcutName)
    (Join-Path (Get-LocalFolder CommonPrograms) "$product\$shortcutName")
    (Join-Path (Get-LocalFolder CommonDesktopDirectory) $shortcutName)
    (Join-Path $localAppData "Programs\$product")
    (Join-Path (Get-LocalFolder ProgramFiles) $product)
    (Join-Path (Get-LocalFolder ProgramFilesX86) $product)
    (Join-Path $localAppData $appId)
    (Join-Path $roamingAppData $appId)
    "HKLM:\Software\$uninstallRelative"
    "HKLM:\Software\WOW6432Node\$uninstallRelative"
    "HKLM:\Software\$settingsRelative"
    "HKLM:\Software\WOW6432Node\$settingsRelative"
)
$fixturePaths = @($installDir; $shortcuts.Values; $uninstallKey) + $unexpectedPaths
Assert-Absent ($fixturePaths + $settingsKey)
function Assert-NoFixtureStartup {
    if ((Test-Path -LiteralPath $runKey) -and
        (Get-Item -LiteralPath $runKey).GetValueNames() -contains $product) {
        throw 'A fixture startup entry exists.'
    }
}
Assert-NoFixtureStartup
Assert-FixtureStopped

Assert-NoReparsePoints $installer
$verificationJson = python (Join-Path $native 'verify-windows-reminder-installer.py') --json
if ($LASTEXITCODE -ne 0) { throw 'Static verification of the reminder installer failed.' }
$verification = $verificationJson | ConvertFrom-Json
if ($verification.installerSha256 -notmatch '^[a-f0-9]{64}$' -or
    $verification.executableSha256 -notmatch '^[a-f0-9]{64}$') {
    throw 'Static verification did not return both fixture hashes.'
}

# Read the actual file through Shell Link COM without opening the shortcut or invoking Explorer.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class KlaxonP0ShellLink
{
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path,
            int capacity, IntPtr findData, uint flags);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid Format; public uint Id; }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    public static string[] Read(string path)
    {
        var shellLinkClass = Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"), true);
        var link = Activator.CreateInstance(shellLinkClass);
        try
        {
            ((IPersistFile)link).Load(path, 0); // STGM_READ
            var target = new StringBuilder(32768);
            Marshal.ThrowExceptionForHR(((IShellLinkW)link).GetPath(target, target.Capacity, IntPtr.Zero, 4)); // SLGP_RAWPATH
            // PKEY_AppUserModel_ID (System.AppUserModel.ID)
            var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
            Marshal.ThrowExceptionForHR(((IPropertyStore)link).GetValue(ref key, out var value));
            try
            {
                string appId = value.Type == 8 ? Marshal.PtrToStringBSTR(value.Pointer)
                    : value.Type == 31 ? Marshal.PtrToStringUni(value.Pointer) : null;
                return new[] { target.ToString(), appId };
            }
            finally { PropVariantClear(ref value); }
        }
        finally { Marshal.ReleaseComObject(link); }
    }
}
'@

$installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
if ($installerHash -ine $verification.installerSha256) { throw 'The inspected installer changed before launch.' }
try {
    $setup = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "The fixture installer exited with $($setup.ExitCode)." }
    Assert-Absent $unexpectedPaths
    Assert-NoFixtureStartup
    Assert-FixtureStopped

    Assert-NoReparsePoints $executable
    $installedHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
    if ($installedHash -ine $verification.executableSha256) {
        throw 'The installed executable differs from the verified NSIS payload.'
    }

    foreach ($entry in $shortcuts.GetEnumerator()) {
        Assert-NoReparsePoints $entry.Value
        $target, $shortcutAppId = [KlaxonP0ShellLink]::Read($entry.Value)
        if ($target -ine $executable -or $shortcutAppId -cne $appId) {
            throw "Unexpected $($entry.Key) shortcut target or AppUserModelID. Target '$target', ID '$shortcutAppId'."
        }
        Write-Host "$($entry.Key) shortcut targets $target with AppUserModelID $shortcutAppId"
    }

    $expected = @{
        DisplayName = $product
        DisplayVersion = '0.1.0'
        Publisher = 'klaxon'
        InstallLocation = '"' + $installDir + '"'
        MainBinaryName = $binary
        DisplayIcon = '"' + $executable + '"'
        UninstallString = '"' + $uninstaller + '"'
    }
    $record = Get-Item -LiteralPath $uninstallKey
    try {
        foreach ($name in $expected.Keys) {
            if ($record.GetValue($name) -ine $expected[$name]) { throw "Unexpected HKCU uninstall value $name" }
        }
    } finally { $record.Dispose() }
    Write-Host "Verified HKCU uninstall identity for $product and installed executable SHA-256 $installedHash"
    Write-Host "Installer SHA-256 $installerHash"

    # Query WinRT while the verified shortcut exists. Score the child independently after teardown.
    $probeExit = 1
    $child = $null
    try {
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        foreach ($argument in '-Mta','-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'windows-reminder-notifier.ps1')) {
            $start.ArgumentList.Add($argument)
        }
        $child = [Diagnostics.Process]::Start($start)
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        $exited = $child.WaitForExit(30000)
        if (-not $exited) {
            $child.Kill($true)
            if (-not $child.WaitForExit(5000)) { throw 'Notifier probe did not exit after termination.' }
            Write-Host 'The read-only notifier probe exceeded 30 seconds.'
        }
        Write-Host ($stdout.GetAwaiter().GetResult())
        Write-Host ($stderr.GetAwaiter().GetResult())
        if ($exited) { $probeExit = $child.ExitCode }
    } catch {
        Write-Host "Notifier probe process failed: $($_.Exception.Message)"
    } finally {
        if ($child) { $child.Dispose() }
    }
    try { "notifier_exit=$probeExit" >> $env:GITHUB_OUTPUT }
    catch { Write-Host "Could not publish notifier result: $($_.Exception.Message)" }
} catch {
    Write-Host "Installation verification failed. $($_.Exception.Message)"
    throw
} finally {
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        # This exact path was absent at admission. Wait for the NSIS temporary child as well.
        Assert-NoReparsePoints $uninstaller
        $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WorkingDirectory $localAppData -WindowStyle Hidden -Wait -PassThru
        if ($remove.ExitCode -ne 0) { throw "The fixture uninstaller exited with $($remove.ExitCode)." }
    }
    Assert-Absent $fixturePaths
    Assert-NoFixtureStartup
    Assert-FixtureStopped

    if (Test-Path -LiteralPath $settingsKey) {
        # Silent uninstall preserves the install location. Remove only that verified, newly created key.
        $settings = Get-Item -LiteralPath $settingsKey
        try {
            $names = $settings.GetValueNames()
            if ($settings.SubKeyCount -ne 0 -or $names.Count -ne 1 -or $names[0] -cne '' -or
                $settings.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String -or
                $settings.GetValue('') -ine $installDir) {
                throw 'Unexpected residual fixture settings after silent uninstall.'
            }
        } finally { $settings.Dispose() }
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey("Software\$settingsRelative")
        Assert-Absent $settingsKey
        Write-Host 'Removed the fixture install-location setting retained by silent uninstall.'
    }
    Write-Host 'Confirmed removal of the fixture directory, shortcuts, and HKCU uninstall entry.'
}
