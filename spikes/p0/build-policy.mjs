export const androidSubscriptionPort = 3212;
export const convexDevelopmentOriginPattern = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud$/;

export function hostedProviderConnections(origin) {
  if (!convexDevelopmentOriginPattern.test(origin)) throw Error("Expected a plain HTTPS Convex deployment origin");
  return "ipc: http://ipc.localhost " + origin + " " + origin.replace(/^https:/, "wss:");
}

// Tauri IPC, the provider route, and the optional subscription-only relay.
export const androidProviderPreflightConnections =
  "ipc: http://ipc.localhost http://127.0.0.1:3210 ws://127.0.0.1:3210 ws://127.0.0.1:" + androidSubscriptionPort;
