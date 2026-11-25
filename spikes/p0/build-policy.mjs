export const androidSubscriptionPort = 3212;

// Tauri IPC, the provider route, and the optional subscription-only relay.
export const androidProviderPreflightConnections =
  "ipc: http://ipc.localhost http://127.0.0.1:3210 ws://127.0.0.1:3210 ws://127.0.0.1:" + androidSubscriptionPort;
