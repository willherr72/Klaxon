export function subscriptionOrigin(directOrigin, reconnectPort) {
  if (reconnectPort === undefined) return directOrigin;
  if (!Number.isInteger(reconnectPort) || reconnectPort < 1 || reconnectPort > 65_535 ||
      reconnectPort === Number(new URL(directOrigin).port)) {
    throw new RangeError("Expected a distinct loopback relay port");
  }
  return `http://127.0.0.1:${reconnectPort}`;
}

// The hosted fixture cuts only this SDK client's WSS transport. Native HTTPS
// and the independent control stay online.
export function createSubscriptionGate(Socket) {
  const sockets = new Set();
  let cut = false;
  return {
    WebSocket: class extends Socket {
      constructor(...args) {
        super(...args);
        if (cut) {
          this.close();
          return;
        }
        sockets.add(this);
        this.addEventListener("close", () => sockets.delete(this), { once: true });
      }
    },
    disconnect() {
      if (![...sockets].some(socket => socket.readyState === Socket.OPEN)) throw Error("No open hosted subscription");
      cut = true;
      for (const socket of sockets) socket.close();
    },
    restore() { cut = false; },
  };
}

export function isCachedBearerRenameDenied(status, envelopeStatus, error) {
  // The local backend can deliver a function error in HTTP 200. The SDK
  // also accepts 560 for this error envelope.
  return (status === 200 || status === 560) && envelopeStatus === "error" && typeof error?.message === "string" &&
    /(?:^|\n)(?:Uncaught )?Error: Task unavailable(?:\r?\n|$)/.test(error.message);
}

function observeReconnectOutcome(evidence) {
  if (evidence.staleBearerRenameOutcome === "succeeded" || evidence.postRestoreNonemptyCallbacks > 0 ||
      evidence.postClearNonemptyCallbacks > 0) {
    return "failed";
  }
  if (evidence.disconnectedBeforeRevoke !== true || evidence.disconnectedAfterRevoke !== true ||
      evidence.nativeRevoked !== true || evidence.reconnected !== true || evidence.sameBearer !== true ||
      !Number.isInteger(evidence.emptyCallbackConnection) || evidence.emptyCallbackConnection !== evidence.connectionCount ||
      evidence.bearerUnexpired !== true || evidence.forcedRefreshes !== 0 || evidence.queryErrors !== 0 ||
      evidence.postRestoreNonemptyCallbacks !== 0 || evidence.postClearNonemptyCallbacks !== 0 ||
      evidence.httpAuthenticated == null || evidence.httpRows == null || !evidence.staleBearerRenameDenied) {
    return "inconclusive";
  }
  return evidence.emptyAfterRestore === true && evidence.emptyCallback === true &&
    evidence.subscriptionRows === 0 && evidence.renderedRows === 0 &&
    evidence.httpAuthenticated === false && evidence.httpRows === 0 ? "passed" : "failed";
}

export function observeOutcome(evidence, mode) {
  if (mode === "reconnect") return observeReconnectOutcome(evidence);
  if (!evidence.uninterrupted || !evidence.sameBearer || !evidence.bearerUnexpired ||
      evidence.forcedRefreshes || evidence.queryErrors || evidence.httpRows === null) {
    return "inconclusive";
  }
  return evidence.emptyCallback && evidence.subscriptionRows === 0 && evidence.renderedRows === 0 &&
    evidence.httpAuthenticated === false && evidence.httpRows === 0 ? "passed" : "failed";
}
