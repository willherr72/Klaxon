import { once } from "node:events";
import { createConnection, createServer } from "node:net";

const host = "127.0.0.1";

export function withSubscriptionRelay(action) {
  return withLoopbackRelay(3210, action);
}

// An explicit upstream port lets the relay tests use an isolated loopback server.
export async function withLoopbackRelay(upstreamPort, action) {
  const pairs = new Set();
  let cut = false;
  let restored = false;
  let connectionsBeforeCut = 0;
  let connectionsAfterRestore = 0;
  let connectionsCut = 0;
  let refusedWhileCut = 0;

  const server = createServer({ allowHalfOpen: true }, downstream => {
    if (cut) {
      refusedWhileCut++;
      downstream.destroy();
      return;
    }

    const upstream = createConnection({ host, port: upstreamPort, allowHalfOpen: true });
    const pair = {
      established: false,
      isLive: () => pair.established && !downstream.destroyed && !upstream.destroyed,
      destroy() {
        downstream.destroy();
        upstream.destroy();
      },
    };
    pairs.add(pair);
    pair.closed = Promise.all([downstream, upstream].map(socket => new Promise(resolve => {
      socket.on("error", pair.destroy);
      socket.once("close", () => {
        if (!socket.readableEnded || !socket.writableFinished) pair.destroy();
        resolve();
      });
    }))).then(() => pairs.delete(pair));

    upstream.once("connect", () => {
      if (downstream.destroyed || upstream.destroyed) return;
      pair.established = true;
      if (restored) connectionsAfterRestore++;
      else connectionsBeforeCut++;
    });
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });

  function disconnect() {
    if (cut) return;
    cut = true;
    let live = 0;
    for (const pair of pairs) {
      if (pair.isLive()) live++;
      pair.destroy();
    }
    connectionsCut += live;
    if (live === 0) throw new Error("Relay cut had no established connection");
  }

  function restore() {
    if (!cut) return;
    restored = true;
    cut = false;
  }

  function evidence() {
    return { connectionsBeforeCut, connectionsCut, refusedWhileCut, connectionsAfterRestore, cut };
  }

  server.listen({ host, port: 0, exclusive: true });
  await once(server, "listening");
  try {
    return await action({ port: server.address().port, disconnect, restore, evidence });
  } finally {
    const serverClosed = new Promise(resolve => server.close(resolve));
    for (const pair of pairs) pair.destroy();
    await Promise.all([serverClosed, ...Array.from(pairs, pair => pair.closed)]);
  }
}
