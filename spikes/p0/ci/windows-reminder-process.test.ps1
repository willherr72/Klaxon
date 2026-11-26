#requires -Version 7.2
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-reminder-process.ps1')

function Test-Scenario($Fault, $ExpectedStages) {
    $stages = [Collections.Generic.List[string]]::new()
    $fixture = @{ Occupied = $false; Id = $null; Due = $null }
    $failed = $false
    try {
        Test-ReminderQueue {
            param($mode, $id, $due)
            $stages.Add($mode)
            if ($stages.Count -eq 1) {
                $fixture.Id = $id
                $fixture.Due = $due
                if ($id -cnotmatch '^[0-9a-f]{16}$' -or
                    [DateTimeOffset]::Parse($due) -lt [DateTimeOffset]::UtcNow.AddDays(2)) {
                    throw 'Invalid fixture identity or due time.'
                }
            } elseif ($id -cne $fixture.Id -or $due -cne $fixture.Due) {
                throw 'Fixture identity or due time changed between processes.'
            }
            $result = switch ($mode) {
                VerifyEmpty {
                    if ($Fault -eq 'occupied-baseline' -or $fixture.Occupied) { throw 'Nonempty schedule.' }
                    'empty'
                }
                Arm {
                    $fixture.Occupied = $true
                    if ($Fault -in 'lost-add-reply','failed-cleanup') { throw 'Lost acknowledgment.' }
                    'armed'
                }
                Inspect {
                    if ($Fault -eq 'malformed-inventory') { return @{ ExitCode = 0; Output = '{}' } }
                    'present'
                }
                Cancel {
                    if ($Fault -ne 'lost-removal') { $fixture.Occupied = $false }
                    'cancelled'
                }
                Cleanup {
                    if ($Fault -eq 'failed-cleanup') { return @{ ExitCode = 1; Output = '' } }
                    $fixture.Occupied = $false
                    'removed'
                }
            }
            # For lost-removal the API claims cancellation. Only the independent final read detects it.
            $count = if ($mode -eq 'Cancel') { 0 } else { [int]$fixture.Occupied }
            $receipt = @{ mode = $mode; result = $result; count = $count; matches = $count }
            return @{ ExitCode = 0; Output = ConvertTo-Json -Compress $receipt }
        }
    } catch { $failed = $true }
    if ($failed -ne ($Fault -ne 'none') -or ($stages -join ',') -cne $ExpectedStages -or
        $fixture.Occupied -ne ($Fault -eq 'failed-cleanup')) {
        throw "Unexpected outcome for ${Fault}: failed=$failed stages=$stages occupied=$($fixture.Occupied)"
    }
}

Test-Scenario none 'VerifyEmpty,Arm,Inspect,Cancel,VerifyEmpty'
Test-Scenario occupied-baseline 'VerifyEmpty'
Test-Scenario lost-add-reply 'VerifyEmpty,Arm,Cleanup,VerifyEmpty'
Test-Scenario malformed-inventory 'VerifyEmpty,Arm,Inspect,Cleanup,VerifyEmpty'
Test-Scenario lost-removal 'VerifyEmpty,Arm,Inspect,Cancel,VerifyEmpty,Cleanup,VerifyEmpty'
Test-Scenario failed-cleanup 'VerifyEmpty,Arm,Cleanup,VerifyEmpty'
Write-Output 'Passed six synthetic Windows queue process scenarios.'
