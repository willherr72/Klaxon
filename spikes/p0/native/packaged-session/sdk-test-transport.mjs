// In-process endpoints for the pinned Convex SDK wire protocol.
import { version } from "convex";

export const sdkFixtureUrl = "https://sdk-fixture.invalid";

// The packaged verifier knows only digests and status labels. Native supplies the bearer.
const grantByDigest = new Map([
  ["a206ba414bf056a11a8f04667db4f62d498147df76757b9a7f406749fd481c57", { owner: "A", generation: "a1" }],
  ["9afeac65acb4f5a64c6a917f42c22eefe2766c3054b0e89ba7b5f8a6f0e4c9c8", { owner: "A", generation: "a2" }],
  ["38ff407969b06bfad555042c30b725d4fa6c1875ca801960ae1743c507a58817", { owner: "B", generation: "b1" }],
]);

async function identify(access) {
  if (typeof access !== "string") return undefined;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(access));
  const digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  return grantByDigest.get(digest);
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
    httpRequests: 0, httpReads: [], httpReadGenerations: [], socketsOpened: 0, socketsClosed: 0,
    socketAuth: [], socketAuthGenerations: [], queryAdds: [], queryAddGenerations: [], queryRemoves: 0,
  };
  let ownerAGeneration = "a1";
  const rows = owner => fixtureRows(owner, revisions.get(owner));
  const accepts = grant => grant && (grant.owner === "B" || grant.generation === ownerAGeneration);

  async function fetch(url, init) {
    evidence.httpRequests++;
    if (url !== sdkFixtureUrl + "/api/query" || init?.method !== "POST") {
      return new Response("Unsupported fixture endpoint", { status: 404 });
    }
    const bearer = new Headers(init.headers).get("authorization");
    const grant = bearer?.startsWith("Bearer ") && await identify(bearer.slice(7));
    if (!accepts(grant)) return new Response("signed-out", { status: 401 });
    const { path, args, format } = JSON.parse(init.body);
    if (format !== "convex_encoded_json" || !taskQuery(path, args)) {
      return new Response("Unsupported fixture query", { status: 400 });
    }
    evidence.httpReads.push(grant.owner);
    evidence.httpReadGenerations.push(grant.generation);
    return Response.json({ status: "success", value: rows(grant.owner), logLines: [] });
  }

  class FixtureSocket {
    grant = undefined;
    queryIds = new Set();
    tick = 0;
    version = { querySet: 0, identity: 0, ts: timestamp(0) };
    connected = false;
    incoming = Promise.resolve();

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
      if (!accepts(this.grant)) return { ...common, type: "QueryFailed", errorMessage: "signed-out", errorData: "signed-out" };
      return { ...common, type: "QueryUpdated", value: rows(this.grant.owner) };
    }

    send(data) {
      const message = JSON.parse(data);
      // Preserve ordering while the verifier checks the Authenticate message.
      this.incoming = this.incoming.then(() => {
        if (sockets.has(this)) return this.receive(message);
      });
    }

    async receive(message) {
      if (message.type === "Connect" && !this.connected) {
        this.connected = true;
        return;
      }
      if (!this.connected) throw new Error("Expected fixture socket handshake");
      if (message.type === "Event" && message.eventType === "ClientConnect") return;
      if (message.type === "Authenticate" && message.baseVersion === this.version.identity) {
        const grant = message.tokenType === "User" ? await identify(message.value) : undefined;
        if (!sockets.has(this)) return;
        this.grant = accepts(grant) ? grant : undefined;
        if (!this.grant && message.tokenType !== "None") {
          this.emit({ type: "AuthError", error: "signed-out", baseVersion: message.baseVersion, authUpdateAttempted: true });
          return;
        }
        if (this.grant) {
          evidence.socketAuth.push(this.grant.owner);
          evidence.socketAuthGenerations.push(this.grant.generation);
        }
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
            evidence.queryAdds.push(this.grant?.owner ?? null);
            evidence.queryAddGenerations.push(this.grant?.generation ?? null);
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
      if (socket.grant?.owner === owner && accepts(socket.grant) && socket.queryIds.size) {
        socket.transition(Array.from(socket.queryIds, id => socket.result(id)));
        recipients += socket.queryIds.size;
      }
    }
    return recipients;
  }

  function expire(owner) {
    let expired = 0;
    for (const socket of sockets) {
      if (!socket.grant || (owner && socket.grant.owner !== owner)) continue;
      socket.grant = undefined;
      socket.emit({ type: "AuthError", error: "expired", baseVersion: socket.version.identity, authUpdateAttempted: false });
      expired++;
    }
    return expired;
  }

  function rotate() {
    if (ownerAGeneration === "a2") return 0;
    ownerAGeneration = "a2";
    return expire("A");
  }

  return { fetch, webSocketConstructor: FixtureSocket, update, expire: () => expire(), rotate, evidence };
}
