// In-process endpoints for the pinned Convex SDK wire protocol. These two
// opaque fixture values have no meaning outside this test.
import { version } from "convex";

export const sdkFixtureUrl = "https://sdk-fixture.invalid";
const accessByOwner = new Map([["A", "p0-inert-access-a"], ["B", "p0-inert-access-b"]]);
const ownerByAccess = new Map(Array.from(accessByOwner, ([owner, access]) => [access, owner]));

export function fixtureAccess(owner) {
  if (!accessByOwner.has(owner)) throw new Error("Unknown fixture owner");
  return accessByOwner.get(owner);
}

export function fixtureRows(owner, revision = 0) {
  const title = revision ? "updated" + (revision > 1 ? " " + revision : "") : "task";
  return [{ id: "task-" + owner.toLowerCase(), title: "Owner " + owner + " " + title }];
}

function taskQuery(path, args) {
  return path === "tasks:list" && JSON.stringify(args) === "[{}]";
}

// StateVersion.ts is a base64-encoded, little-endian uint64 on the wire.
function timestamp(tick) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(tick), true);
  return btoa(String.fromCharCode(...bytes));
}

export function createSdkTransport() {
  const revisions = new Map([["A", 0], ["B", 0]]);
  const sockets = new Set();
  const evidence = {
    httpRequests: 0, httpReads: [], socketsOpened: 0, socketsClosed: 0,
    socketAuth: [], queryAdds: [], queryRemoves: 0,
  };
  const rows = owner => fixtureRows(owner, revisions.get(owner));

  async function fetch(url, init) {
    evidence.httpRequests++;
    if (url !== sdkFixtureUrl + "/api/query" || init?.method !== "POST") {
      return new Response("Unsupported fixture endpoint", { status: 404 });
    }
    const bearer = new Headers(init.headers).get("authorization");
    const owner = bearer?.startsWith("Bearer ") && ownerByAccess.get(bearer.slice(7));
    if (!owner) return new Response("signed-out", { status: 401 });
    const { path, args, format } = JSON.parse(init.body);
    if (format !== "convex_encoded_json" || !taskQuery(path, args)) {
      return new Response("Unsupported fixture query", { status: 400 });
    }
    evidence.httpReads.push(owner);
    return Response.json({ status: "success", value: rows(owner), logLines: [] });
  }

  class FixtureSocket {
    owner = undefined;
    queryIds = new Set();
    tick = 0;
    version = { querySet: 0, identity: 0, ts: timestamp(0) };
    connected = false;

    constructor(url) {
      if (url !== `wss://sdk-fixture.invalid/api/${version}/sync`) throw new Error("Unknown fixture socket");
      sockets.add(this);
      evidence.socketsOpened++;
      queueMicrotask(() => { if (sockets.has(this)) this.onopen?.(); });
    }

    emit(message) {
      const data = JSON.stringify(message);
      queueMicrotask(() => { if (sockets.has(this)) this.onmessage?.({ data }); });
    }

    transition(modifications, changes = {}) {
      const startVersion = this.version;
      this.version = { ...startVersion, ...changes, ts: timestamp(++this.tick) };
      this.emit({ type: "Transition", startVersion, endVersion: this.version, modifications });
    }

    result(queryId) {
      const common = { queryId, logLines: [], journal: null };
      if (!this.owner) return { ...common, type: "QueryFailed", errorMessage: "signed-out", errorData: "signed-out" };
      return { ...common, type: "QueryUpdated", value: rows(this.owner) };
    }

    send(data) {
      const message = JSON.parse(data);
      if (message.type === "Connect" && !this.connected) {
        this.connected = true;
        return;
      }
      if (!this.connected) throw new Error("Expected fixture socket handshake");
      if (message.type === "Event" && message.eventType === "ClientConnect") return;
      if (message.type === "Authenticate" && message.baseVersion === this.version.identity) {
        this.owner = message.tokenType === "User" ? ownerByAccess.get(message.value) : undefined;
        if (!this.owner && message.tokenType !== "None") {
          this.emit({ type: "AuthError", error: "signed-out", baseVersion: message.baseVersion, authUpdateAttempted: true });
          return;
        }
        if (this.owner) evidence.socketAuth.push(this.owner);
        this.transition(Array.from(this.queryIds, id => this.result(id)), { identity: message.baseVersion + 1 });
        return;
      }
      if (message.type === "ModifyQuerySet" && message.baseVersion === this.version.querySet &&
          message.newVersion === message.baseVersion + 1) {
        const modifications = [];
        for (const mod of message.modifications) {
          if (mod.type === "Remove" && this.queryIds.delete(mod.queryId)) {
            evidence.queryRemoves++;
            modifications.push({ type: "QueryRemoved", queryId: mod.queryId });
          } else if (mod.type === "Add" && !this.queryIds.has(mod.queryId) && !mod.componentPath &&
                     taskQuery(mod.udfPath, mod.args)) {
            this.queryIds.add(mod.queryId);
            evidence.queryAdds.push(this.owner ?? null);
            modifications.push(this.result(mod.queryId));
          } else {
            this.emit({ type: "FatalError", error: "Unsupported fixture query modification" });
            return;
          }
        }
        this.transition(modifications, { querySet: message.newVersion });
        return;
      }
      this.emit({ type: "FatalError", error: "Unsupported fixture socket operation" });
    }

    close() {
      if (!sockets.delete(this)) return;
      evidence.socketsClosed++;
      queueMicrotask(() => this.onclose?.({ code: 1000, reason: "" }));
    }
  }

  function update(owner) {
    if (!revisions.has(owner)) throw new Error("Unknown fixture owner");
    revisions.set(owner, revisions.get(owner) + 1);
    let recipients = 0;
    for (const socket of sockets) {
      if (socket.owner === owner && socket.queryIds.size) {
        socket.transition(Array.from(socket.queryIds, id => socket.result(id)));
        recipients += socket.queryIds.size;
      }
    }
    return recipients;
  }

  return { fetch, webSocketConstructor: FixtureSocket, update, evidence };
}
