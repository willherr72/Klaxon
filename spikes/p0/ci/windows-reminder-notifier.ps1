#requires -Version 5.1
#requires -PSEdition Desktop
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function Format-ProbeError([string] $Stage, $Failure) {
    $cause = $Failure.Exception.GetBaseException()
    return '{0}: {1} (HRESULT 0x{2:X8})' -f $Stage, $cause.Message, $cause.HResult
}

function Read-FixtureSchedule($Notifier, [version] $OsVersion) {
    $failures = @()
    $setting = $null
    $settingRead = $false
    try {
        $setting = $Notifier.get_Setting()
        $settingRead = $true
    } catch {
        $detail = Format-ProbeError 'Setting' $_
        if ($OsVersion -eq [version]'10.0.20348.0' -and $_.Exception.GetBaseException().HResult -eq 0x80070490) {
            [Console]::WriteLine($detail)
        } else {
            $failures += $detail
        }
    }
    if ($settingRead) {
        if ([string]$setting -cin 'Enabled','DisabledForApplication','DisabledForUser','DisabledByGroupPolicy','DisabledByManifest') {
            [Console]::WriteLine("Notification setting: $setting")
        } else {
            $failures += 'Unknown notification setting.'
        }
    }
    try {
        $items = $Notifier.GetScheduledToastNotifications()
        if ($items -isnot [System.Collections.IEnumerable]) { throw 'Windows returned no enumerable schedule.' }
        $count = 0
        foreach ($item in $items) { $count++ }
        [Console]::WriteLine("Scheduled notification count: $count")
        if ($count -ne 0) { throw 'Expected an empty schedule for the fresh fixture identity.' }
    } catch {
        $failures += Format-ProbeError 'GetScheduledToastNotifications' $_
    }
    if ($failures.Count) { throw ($failures -join [Environment]::NewLine) }
    if ($settingRead) { return 'read' }
    return 'setting-unavailable'
}

# Dot sourcing exposes the classifier for tests with an in-memory notifier.
if ($MyInvocation.InvocationName -eq '.') { return }
if (-not [Environment]::Is64BitProcess -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:KLAXON_P0_RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'This probe requires a GitHub-hosted disposable Windows Actions runner.'
}

$appId = 'dev.klaxon.p0reminderfixture'
[Console]::WriteLine("Reading $appId on Windows $([Environment]::OSVersion.Version), PowerShell $($PSVersionTable.PSVersion), session $([Diagnostics.Process]::GetCurrentProcess().SessionId)")
$manager = [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
try {
    $notifier = $manager::CreateToastNotifier($appId)
    if ($null -eq $notifier) { throw 'Windows returned no notifier.' }
} catch {
    throw (Format-ProbeError 'CreateToastNotifier' $_)
}
$result = Read-FixtureSchedule $notifier ([Environment]::OSVersion.Version)
if ($result -ceq 'setting-unavailable') { exit 42 }
if ($result -cne 'read') { throw 'Unrecognized notifier result.' }
