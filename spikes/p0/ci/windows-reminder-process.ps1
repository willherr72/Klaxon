#requires -Version 7.2

function Confirm-ReminderChildExit($Child) {
    try {
        if ($Child.HasExited) { return }
        try { $Child.Kill($true) }
        catch { Write-Host "Could not terminate reminder child $($Child.Id): $($_.Exception.Message)" }
        if (-not $Child.WaitForExit(5000)) {
            [Console]::Error.WriteLine("Child $($Child.Id) is still alive. Queue cleanup is unverified. Waiting for exit before continuing.")
            # The disposable job's hard deadline bounds this last resort. A live
            # writer can publish after a cleanup read, even if that read returns zero.
            $Child.WaitForExit()
        }
    } catch {
        $failure = [InvalidOperationException]::new('Child exit and queue cleanup are unverified.', $_.Exception)
        $failure.Data['UnconfirmedReminderChild'] = $Child
        throw $failure
    }
}

function Invoke-ReminderChild([string] $ScriptName, [string[]] $Parameters) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('-Mta','-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot $ScriptName)) + $Parameters) {
        $start.ArgumentList.Add($argument)
    }
    $child = [Diagnostics.Process]::Start($start)
    try {
        Write-Host "Started $ScriptName process $($child.Id) with $Parameters"
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(30000)) {
            throw "$ScriptName exceeded 30 seconds."
        }
        $output = $stdout.GetAwaiter().GetResult()
        $errors = $stderr.GetAwaiter().GetResult()
        Write-Host $output
        if ($errors) { Write-Host $errors }
        return [pscustomobject]@{ ExitCode = $child.ExitCode; Output = $output }
    } finally {
        Confirm-ReminderChildExit $child
        $child.Dispose()
    }
}

function Test-ReminderQueue([scriptblock] $RunStage) {
    # This occurrence is due long after the 25-minute disposable CI job ends.
    $occurrence = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(8)).ToLowerInvariant()
    $due = [DateTimeOffset]::UtcNow.AddDays(3).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
    function Invoke-Stage([string] $Mode, [string[]] $ExpectedResult, [int] $Count, [int] $Matches) {
        $child = & $RunStage $Mode $occurrence $due
        if ($child.ExitCode -ne 0) { throw "Queue stage $Mode exited with $($child.ExitCode)." }
        $receipt = ConvertFrom-Json -InputObject $child.Output -NoEnumerate -ErrorAction Stop
        if ($null -eq $receipt -or $receipt -is [array] -or $receipt.mode -cne $Mode -or $receipt.result -cnotin $ExpectedResult -or
            $receipt.count -isnot [long] -or $receipt.count -ne $Count -or
            $receipt.matches -isnot [long] -or $receipt.matches -ne $Matches) {
            throw "Queue stage $Mode returned an unexpected receipt."
        }
    }

    # Leave any pre-existing schedule untouched. A later Arm failure may have
    # reached Windows, so reconcile the occurrence even if the writer has died.
    Invoke-Stage VerifyEmpty empty 0 0
    $failures = [Collections.Generic.List[string]]::new()
    try {
        Invoke-Stage Arm armed 1 1
        Invoke-Stage Inspect present 1 1
        Invoke-Stage Cancel cancelled 0 0
        Invoke-Stage VerifyEmpty empty 0 0
        return
    } catch {
        if ($_.Exception.Data.Contains('UnconfirmedReminderChild')) { throw }
        $failures.Add($_.Exception.Message)
    }
    try { Invoke-Stage Cleanup @('removed','absent') 0 0 }
    catch {
        $failures.Add($_.Exception.Message)
        if ($_.Exception.Data.Contains('UnconfirmedReminderChild')) {
            throw ($failures -join [Environment]::NewLine)
        }
    }
    try { Invoke-Stage VerifyEmpty empty 0 0 }
    catch { $failures.Add($_.Exception.Message) }
    throw ($failures -join [Environment]::NewLine)
}
