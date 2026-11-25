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
