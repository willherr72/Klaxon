import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

export function windowsFixtureProcesses(hostPid, profile, execute = execFileSync) {
  // Inspect only the host and its WebView2 children. Emit process identities and
  // profile matches without exposing the child command lines.
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $fixtureProfile = [IO.Path]::GetFullPath($env:KLAXON_P0_WEBVIEW_PROFILE)
    $browserProfile = Join-Path $fixtureProfile 'EBWebView'
    Get-CimInstance Win32_Process -Filter "ProcessId = ${hostPid} OR (ParentProcessId = ${hostPid} AND Name = 'msedgewebview2.exe')" | ForEach-Object {
      $matchesProfile = 0
      if ($_.ProcessId -ne ${hostPid} -and $_.CommandLine -match '(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^"\s]+))(?=\s|$)') {
        $path = [IO.Path]::GetFullPath($Matches[1] + $Matches[2] + $Matches[3])
        if ($path -eq $fixtureProfile -or $path -eq $browserProfile) { $matchesProfile = 1 }
      }
      "{0} {1} {2}" -f $_.ProcessId, $_.CreationDate.ToUniversalTime().Ticks, $matchesProfile
    }
  `;
  const query = () => execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
    env: { ...process.env, KLAXON_P0_WEBVIEW_PROFILE: profile },
  });
  let output;
  try {
    output = query();
  } catch (error) {
    if (error.code !== "ETIMEDOUT") throw error;
    // An incomplete CIM snapshot cannot establish ownership or retirement.
    output = query();
  }
  const rows = output.trim();
  if (!rows) return new Map();
  return new Map(rows.split(/\r?\n/).map(row => {
    const match = /^([1-9]\d*) ([1-9]\d*) ([01])$/.exec(row);
    assert.ok(match && Number.isSafeInteger(Number(match[1])), "invalid Windows fixture process identity");
    return [Number(match[1]), { created: match[2], matchesProfile: match[3] === "1" }];
  }));
}

export function windowsProcessIdentity(pid, creationTicks) {
  return pid + ":" + creationTicks;
}

export function observeWindowsBrowsers(processes, host, ownedBrowsers, retiring = false) {
  const observedHost = processes.get(host.pid)?.created;
  const hostReused = observedHost && host.created && observedHost !== host.created;
  const browsers = new Map();
  for (const [pid, { created, matchesProfile }] of processes) {
    if (pid === host.pid) continue;
    const inHostLifetime = (!host.created || BigInt(created) >= BigInt(host.created)) &&
      (!hostReused || BigInt(created) < BigInt(observedHost));
    const verified = matchesProfile && inHostLifetime;
    if (verified) ownedBrowsers.set(pid, created);
    if (verified || (retiring && ownedBrowsers.get(pid) === created)) {
      browsers.set(pid, created);
    }
  }
  return browsers;
}
