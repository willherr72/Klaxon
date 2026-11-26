#requires -Version 5.1
#requires -PSEdition Desktop
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-reminder-queue.ps1')

class MemoryQueue {
    [Collections.ArrayList] $Items = [Collections.ArrayList]::new()
    [object[]] GetScheduledToastNotifications() { return $this.Items.ToArray() }
    [void] AddToSchedule($item) { [void]$this.Items.Add($item) }
    [void] RemoveFromSchedule($item) { $this.Items.Remove($item) }
}
function New-FixtureRequest($Group, $Tag, $Due) {
    return [pscustomobject]@{ Group = $Group; Tag = $Tag; DeliveryTime = $Due }
}
function Assert-Rejected([scriptblock] $Operation) {
    try { & $Operation } catch { return }
    throw 'Expected a rejected queue operation.'
}

$queue = [MemoryQueue]::new()
$tag = '0123456789abcdef'
$time = [DateTimeOffset]::UtcNow.AddDays(3).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
$due = ConvertTo-FixtureDue Arm $tag $time
$armed = Invoke-FixtureQueue $queue Arm $tag $due
if ($armed.result -cne 'armed' -or $armed.matches -ne 1) { throw 'Arm failed.' }
Assert-Rejected { Invoke-FixtureQueue $queue Arm $tag $due }
$owned = $queue.Items[0]
$queue.AddToSchedule($owned)
Assert-Rejected { Invoke-FixtureQueue $queue Cleanup $tag $due }
if ($queue.Items.Count -ne 2) { throw 'Ambiguous cleanup modified the queue.' }
$queue.RemoveFromSchedule($owned)

$otherGroup = New-FixtureRequest 'other' $tag $due
$otherTag = New-FixtureRequest 'p0-queue' 'fedcba9876543210' $due
$otherTime = New-FixtureRequest 'p0-queue' $tag ($due.AddSeconds(1))
foreach ($item in $otherGroup, $otherTag, $otherTime) { $queue.AddToSchedule($item) }
Assert-Rejected { Invoke-FixtureQueue $queue Inspect $tag $due }
Assert-Rejected { Invoke-FixtureQueue $queue Cancel $tag $due }
if ($queue.Items.Count -ne 4) { throw 'Failed admission changed the queue.' }
$cleanup = Invoke-FixtureQueue $queue Cleanup $tag $due
if ($cleanup.result -cne 'removed' -or $cleanup.count -ne 3 -or $queue.Items.Contains($owned)) {
    throw 'Cleanup did not remove exactly the owned occurrence.'
}
foreach ($item in $otherGroup, $otherTag, $otherTime) {
    if (-not $queue.Items.Contains($item)) { throw 'Cleanup removed another occurrence.' }
}
if ((Invoke-FixtureQueue $queue Cleanup $tag $due).result -cne 'absent') { throw 'Cleanup was not idempotent.' }
Assert-Rejected { Invoke-FixtureQueue $queue VerifyEmpty $tag $due }
Assert-Rejected { ConvertTo-FixtureDue Arm $tag '2000-01-01T00:00:00Z' }
Assert-Rejected { ConvertTo-FixtureDue Arm $tag '2999-01-01T00:00:00Z' }
Assert-Rejected { ConvertTo-FixtureDue Arm $tag.ToUpperInvariant() $time }
Write-Output 'Synthetic queue identity, ambiguous removal and deadline checks passed.'
