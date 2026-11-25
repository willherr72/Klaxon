export function observeOutcome(evidence) {
  if (!evidence.uninterrupted || !evidence.sameBearer || !evidence.bearerUnexpired ||
      evidence.forcedRefreshes || evidence.queryErrors || evidence.httpRows === null) {
    return "inconclusive";
  }
  return evidence.emptyCallback && evidence.subscriptionRows === 0 && evidence.renderedRows === 0 &&
    evidence.httpAuthenticated === false && evidence.httpRows === 0 ? "passed" : "failed";
}
