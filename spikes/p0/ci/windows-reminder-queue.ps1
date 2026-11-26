#requires -Version 5.1
#requires -PSEdition Desktop

# Run each mode in a fresh powershell.exe -Mta process during the verified fixture install.
# Keep the same occurrence ID and due time for independent Cleanup and VerifyEmpty.
[CmdletBinding()]
param(
    [ValidateSet('Arm', 'Inspect', 'Cancel', 'Cleanup', 'VerifyEmpty')]
    [string] $Mode,
    [string] $OccurrenceId,
    [string] $DueUtc
)

function Assert-FixtureDueWindow([DateTimeOffset] $Due) {
    $delay = $Due - [DateTimeOffset]::UtcNow
    if ($delay -lt [TimeSpan]::FromHours(48) -or $delay -gt [TimeSpan]::FromDays(7)) {
        throw 'Arm requires a due time 48 hours to 7 days in the future.'
    }
}

function ConvertTo-FixtureDue([string] $Mode, [string] $OccurrenceId, [string] $DueUtc) {
    if ($OccurrenceId -cnotmatch '\A[0-9a-f]{16}\z') {
        throw 'OccurrenceId must be 16 lowercase hex characters.'
    }
    $due = [DateTimeOffset]::MinValue
    if ($DueUtc -cnotmatch '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\z' -or
        -not [DateTimeOffset]::TryParseExact($DueUtc, "yyyy-MM-dd'T'HH:mm:ss'Z'",
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$due)) {
        throw 'DueUtc must be a whole-second UTC timestamp in yyyy-MM-ddTHH:mm:ssZ format.'
    }
    # Cleanup must still work after the original scheduling window has moved.
    if ($Mode -eq 'Arm') { Assert-FixtureDueWindow $due }
    return $due
}

function New-FixtureRequest([string] $Group, [string] $Tag, [DateTimeOffset] $Due) {
    $payload = [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]::new()
    $payload.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Klaxon synthetic fixture</text></binding></visual></toast>')
    $request = [Windows.UI.Notifications.ScheduledToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]::new($payload, $Due)
    $request.Group = $Group
    $request.Tag = $Tag
    return $request
}

function Test-FixtureOccurrence($Item, [string] $Group, [string] $Tag, [DateTimeOffset] $Due) {
    return [string]::Equals($Item.Group, $Group, [StringComparison]::Ordinal) -and
        [string]::Equals($Item.Tag, $Tag, [StringComparison]::Ordinal) -and
        $Item.DeliveryTime.UtcDateTime.Ticks -eq $Due.UtcDateTime.Ticks
}

function Read-FixtureQueue($Notifier, [string] $Group, [string] $Tag, [DateTimeOffset] $Due) {
    $items = $Notifier.GetScheduledToastNotifications()
    if ($items -isnot [Collections.IEnumerable]) { throw 'Windows returned no enumerable schedule.' }
    $count = 0
    $matches = @(
        foreach ($item in $items) {
            $count++
            if (Test-FixtureOccurrence $item $Group $Tag $Due) { $item }
        }
    )
    return [pscustomobject]@{ Count = $count; Matches = $matches }
}

function Invoke-FixtureQueue($Notifier, [string] $Mode, [string] $OccurrenceId, [DateTimeOffset] $Due) {
    $group = 'p0-queue'
    $queue = Read-FixtureQueue $Notifier $group $OccurrenceId $Due
    switch ($Mode) {
        'Arm' {
            if ($queue.Count -ne 0) { throw 'Expected an empty fixture queue at baseline.' }
            $request = New-FixtureRequest $group $OccurrenceId $Due
            if (-not (Test-FixtureOccurrence $request $group $OccurrenceId $Due)) {
                throw 'WinRT did not preserve the fixture request identity and due time.'
            }
            Assert-FixtureDueWindow $Due
            $Notifier.AddToSchedule($request)
            $queue = Read-FixtureQueue $Notifier $group $OccurrenceId $Due
            if ($queue.Count -ne 1 -or $queue.Matches.Count -ne 1) {
                throw 'Arm did not leave one exact occurrence alone in the fixture queue.'
            }
            $result = 'armed'
        }
        'Inspect' {
            if ($queue.Count -ne 1 -or $queue.Matches.Count -ne 1) {
                throw 'Inspect expected one exact occurrence alone in the fixture queue.'
            }
            $result = 'present'
        }
        'Cancel' {
            if ($queue.Count -ne 1 -or $queue.Matches.Count -ne 1) {
                throw 'Cancel expected one exact occurrence alone in the fixture queue.'
            }
            $Notifier.RemoveFromSchedule($queue.Matches[0])
            $queue = Read-FixtureQueue $Notifier $group $OccurrenceId $Due
            if ($queue.Count -ne 0) { throw 'Cancel did not leave the fixture queue empty.' }
            $result = 'cancelled'
        }
        'Cleanup' {
            if ($queue.Matches.Count -gt 1) { throw 'Cleanup found multiple exact matches.' }
            $result = 'absent'
            if ($queue.Matches.Count -eq 1) {
                $Notifier.RemoveFromSchedule($queue.Matches[0])
                $queue = Read-FixtureQueue $Notifier $group $OccurrenceId $Due
                if ($queue.Matches.Count -ne 0) { throw 'The exact occurrence remains after Cleanup.' }
                $result = 'removed'
            }
        }
        'VerifyEmpty' {
            if ($queue.Count -ne 0) { throw 'VerifyEmpty expected an empty fixture queue.' }
            $result = 'empty'
        }
        default { throw 'A queue mode is required.' }
    }
    return [pscustomobject]@{ mode = $Mode; result = $result; count = $queue.Count; matches = $queue.Matches.Count }
}

# Dot sourcing exposes the queue operations for synthetic tests without opening WinRT.
if ($MyInvocation.InvocationName -eq '.') { return }

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $Mode) { throw 'A queue mode is required.' }
$due = ConvertTo-FixtureDue $Mode $OccurrenceId $DueUtc
if (-not [Environment]::Is64BitProcess -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:KLAXON_P0_RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'This probe requires a GitHub-hosted disposable Windows Actions runner.'
}
$installationType = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name InstallationType
if ($installationType -cnotin 'Server', 'Server Core') { throw 'This probe requires Windows Server.' }
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::MTA) {
    throw 'Start Windows PowerShell with -Mta.'
}

$manager = [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
$notifier = $manager::CreateToastNotifier('dev.klaxon.p0reminderfixture')
if ($null -eq $notifier) { throw 'Windows returned no notifier.' }
Invoke-FixtureQueue $notifier $Mode $OccurrenceId $due | ConvertTo-Json -Compress
