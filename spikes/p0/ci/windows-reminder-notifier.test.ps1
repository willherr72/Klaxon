#requires -Version 5.1
#requires -PSEdition Desktop
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-reminder-notifier.ps1')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public sealed class FixtureNotifier {
    public int SettingError;
    public int ScheduleError;
    public int Count;
    public int Reads;
    public string SettingValue = "Enabled";
    public string get_Setting() {
        if (SettingError != 0) throw new COMException("synthetic getter", SettingError);
        return SettingValue;
    }
    public object[] GetScheduledToastNotifications() {
        Reads++;
        if (ScheduleError != 0) throw new COMException("synthetic schedule", ScheduleError);
        return Count < 0 ? null : new object[Count];
    }
}
'@

function Test-Read($Version, $SettingError, $ScheduleError, $Count, $Expected, $Setting = 'Enabled') {
    $notifier = New-Object FixtureNotifier
    $notifier.SettingError = $SettingError
    $notifier.ScheduleError = $ScheduleError
    $notifier.Count = $Count
    $notifier.SettingValue = $Setting
    $result = $null
    try { $result = Read-FixtureSchedule $notifier $Version }
    catch {
        if ($Expected -ne 'error') { throw }
        $result = 'error'
    }
    if ($result -cne $Expected -or $notifier.Reads -ne 1) {
        throw "Expected $Expected and one schedule read. Got '$result' and $($notifier.Reads)."
    }
}

$server = [version]'10.0.20348.0'
$missing = 0x80070490
Test-Read $server 0 0 0 'read'
Test-Read $server 0 0 0 'read' 'DisabledForUser'
Test-Read $server $missing 0 0 'setting-unavailable'
Test-Read ([version]'10.0.26100.0') $missing 0 0 'error'
Test-Read $server 0x80070005 0 0 'error'
Test-Read $server 0 $missing 0 'error'
Test-Read $server $missing $missing 0 'error'
Test-Read $server $missing 0 1 'error'
Test-Read $server $missing 0 -1 'error'
Test-Read $server 0 0 0 'error' 'Unknown'
Write-Output 'Passed 10 synthetic notifier classification cases.'
