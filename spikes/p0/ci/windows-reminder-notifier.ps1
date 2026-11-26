#requires -Version 5.1
#requires -PSEdition Desktop
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

if (-not [Environment]::Is64BitProcess -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:KLAXON_P0_RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'This probe requires a GitHub-hosted disposable Windows Actions runner.'
}

function Format-ProbeError([string] $Stage, $Failure) {
    $cause = $Failure.Exception.GetBaseException()
    return '{0}: {1} (HRESULT 0x{2:X8})' -f $Stage, $cause.Message, $cause.HResult
}

function Read-FixtureSchedule($Notifier) {
    $failures = @()
    try {
        $setting = [string] $Notifier.get_Setting()
        if ($setting -cnotin 'Enabled','DisabledForApplication','DisabledForUser','DisabledByGroupPolicy','DisabledByManifest') {
            throw 'Unknown notification setting.'
        }
        [Console]::WriteLine("Notification setting: $setting")
    } catch {
        $failures += Format-ProbeError 'Setting' $_
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
Read-FixtureSchedule $notifier
