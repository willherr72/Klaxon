import { invoke } from "@tauri-apps/api/core";
import type {
  Reminder,
  ReminderCreate,
  ReminderUpdate,
} from "./types";

export const api = {
  listReminders: () => invoke<Reminder[]>("list_reminders"),
  getReminder: (id: string) =>
    invoke<Reminder>("get_reminder", { id }),
  createReminder: (input: ReminderCreate) =>
    invoke<Reminder>("create_reminder", { input }),
  updateReminder: (id: string, patch: ReminderUpdate) =>
    invoke<Reminder>("update_reminder", { id, patch }),
  deleteReminder: (id: string) =>
    invoke<void>("delete_reminder", { id }),
  snoozeReminder: (id: string, snoozeUntilMs: number) =>
    invoke<Reminder>("snooze_reminder", { id, snoozeUntilMs }),
  dismissReminder: (id: string) =>
    invoke<Reminder>("dismiss_reminder", { id }),
  completeReminder: (id: string) =>
    invoke<Reminder>("complete_reminder", { id }),
  nextReminder: () => invoke<Reminder | null>("next_reminder"),
  getSetting: (key: string) =>
    invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  listSettings: () =>
    invoke<Record<string, string>>("list_settings"),
  dataDir: () => invoke<string>("data_dir"),
  setGlobalHotkey: (combo: string) =>
    invoke<void>("set_global_hotkey", { combo }),
  previewTone: (tone: string) =>
    invoke<void>("preview_tone", { tone }),
  nlParse: (input: string) =>
    invoke<NlParsed>("nl_parse", { input }),
  // Sync
  deviceIdentity: () => invoke<DeviceInfo>("device_identity"),
  generateSecret: () => invoke<string>("generate_secret"),
  setSyncEnabled: (enabled: boolean) =>
    invoke<void>("set_sync_enabled", { enabled }),
  listPeers: () => invoke<PeerView[]>("list_peers"),
  addPeer: (input: AddPeerInput) =>
    invoke<PeerView>("add_peer", { input }),
  removePeer: (id: string) => invoke<void>("remove_peer", { id }),
  pingPeer: (id: string) => invoke<PingResponse>("ping_peer", { id }),
  listDiscoveredPeers: () =>
    invoke<DiscoveredPeer[]>("list_discovered_peers"),
  startPairWith: (
    peerUrl: string,
    peerId: string,
    peerName: string,
    peerCertFingerprint: string,
  ) =>
    invoke<PairOutcome>("start_pair_with", {
      peerUrl,
      peerId,
      peerName,
      peerCertFingerprint,
    }),
  approvePairRequest: (requestId: string) =>
    invoke<void>("approve_pair_request", { requestId }),
  declinePairRequest: (requestId: string) =>
    invoke<void>("decline_pair_request", { requestId }),
};

export interface PairOutcome {
  peer_id: string;
  peer_name: string;
  confirmation_code: string;
}

export interface PairProgress {
  request_id: string;
  peer_id: string;
  peer_name: string;
  confirmation_code: string;
}

export interface PendingPairEvent {
  request_id: string;
  initiator_id: string;
  initiator_name: string;
  initiator_url: string;
  confirmation_code: string;
}

export interface NlParsed {
  due_at_ms: number;
  title: string;
  matched_date: string | null;
  matched_time: string | null;
  tags: string[];
}

export interface DiscoveredPeer {
  device_id: string;
  device_name: string;
  url: string;
  last_seen_ms: number;
  cert_fingerprint: string | null;
  // v0.3: iroh EndpointId, present on peers running a build with the
  // iroh transport. `null` on v0.2 peers — those will need re-pairing
  // once both sides are upgraded.
  node_id: string | null;
}

export interface DeviceInfo {
  device_id: string;
  device_name: string;
  sync_enabled: boolean;
  sync_port: number;
  sync_url_hint: string;
}

export interface PeerView {
  id: string;
  name: string;
  url: string;
  last_pull_at: number;
  last_push_at: number;
  last_seen_at: number | null;
}

export interface AddPeerInput {
  id: string;
  name: string;
  url: string;
  shared_secret: string;
}

export interface PingResponse {
  device_id: string;
  device_name: string;
  version: string;
  server_time_ms: number;
}
