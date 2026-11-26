import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import { withLoopbackRelay } from "./relay.mjs";

const host = "127.0.0.1";
const timeout = 10_000;
const fixture = Buffer.from([0x00, 0x80, 0xff, 0x0a]);

function track(socket) {
  const closed = new Promise(resolve => socket.once("close", resolve));
  socket.on("error", () => {});
  return { socket, closed };
}

function connect(t, port) {
  const peer = track(createConnection({ host, port }));
  t.after(() => peer.socket.destroy());
  return peer;
}

async function echoServer(t) {
  const peers = [];
  const server = createServer(socket => {
    peers.push(track(socket));
    socket.pipe(socket);
  });
  t.after(async () => {
    for (const { socket } of peers) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen({ host, port: 0 });
  await once(server, "listening");
  return { port: server.address().port, peers };
}

async function roundTrip({ socket }) {
  socket.write(fixture);
  const chunks = [];
  let length = 0;
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    chunks.push(chunk);
    length += chunk.length;
    if (length >= fixture.length) break;
  }
  assert.deepEqual(Buffer.concat(chunks), fixture);
}

test("cuts established pairs, refuses new peers while cut, and reconnects after restore", { timeout }, async t => {
  const upstream = await echoServer(t);
  const result = await withLoopbackRelay(upstream.port, async ({ port, disconnect, restore, evidence }) => {
    const before = [connect(t, port), connect(t, port)];
    await Promise.all(before.map(roundTrip));
    assert.equal(upstream.peers.length, 2);

    disconnect();
    await Promise.all([...before, ...upstream.peers].map(peer => peer.closed));

    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = connect(t, port);
      await refused.closed;
      assert.equal(refused.socket.bytesRead, 0);
    }
    assert.equal(upstream.peers.length, 2);
    assert.equal(evidence().cut, true);

    restore();
    const after = connect(t, port);
    await roundTrip(after);
    assert.equal(upstream.peers.length, 3);
    assert.deepEqual(evidence(), {
      connectionsBeforeCut: 2,
      connectionsCut: 2,
      refusedWhileCut: 2,
      connectionsAfterRestore: 1,
      cut: false,
    });
    return after;
  });
  await Promise.all([result.closed, upstream.peers[2].closed]);
});

test("a previously closed connection cannot prove the cut", { timeout }, async t => {
  const upstream = await echoServer(t);
  await withLoopbackRelay(upstream.port, async ({ port, disconnect, restore, evidence }) => {
    const { socket, closed } = connect(t, port);
    const received = buffer(socket);
    socket.end(fixture);
    assert.deepEqual(await received, fixture);
    await Promise.all([closed, upstream.peers[0].closed]);

    assert.throws(disconnect, /no established connection/i);
    const refused = connect(t, port);
    await refused.closed;
    assert.equal(upstream.peers.length, 1);
    assert.equal(evidence().connectionsCut, 0);

    restore();
    await roundTrip(connect(t, port));
    assert.equal(upstream.peers.length, 2);
  });
});

test("closes both sockets and the listener when the action fails", { timeout }, async t => {
  const upstream = await echoServer(t);
  const failure = new Error("fixture action failed");
  let client;
  let relayPort;

  await assert.rejects(withLoopbackRelay(upstream.port, async ({ port }) => {
    relayPort = port;
    client = connect(t, port);
    await roundTrip(client);
    throw failure;
  }), error => error === failure);

  await Promise.all([client.closed, upstream.peers[0].closed]);
  const probe = connect(t, relayPort);
  await assert.rejects(once(probe.socket, "connect"), { code: "ECONNREFUSED" });
});
