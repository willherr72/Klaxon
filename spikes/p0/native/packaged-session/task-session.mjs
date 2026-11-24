// Only the packaged fixture uses this adapter. Native owns provider access.
export function createTaskSession(core, render) {
  let generation = 0;
  let status = "unchecked";
  render({ status, rows: [] });

  // Capture authorization when the request starts. An IPC result or channel
  // message already in the WebView's queue can outlive its native session.
  function receiveRows() {
    const authorizedGeneration = status === "authenticated" ? generation : undefined;
    return rows => {
      if (authorizedGeneration === generation) render({ status, rows });
    };
  }

  return {
    async change(operation) {
      const changing = ++generation;
      status = "unchecked";
      render({ status, rows: [] });
      let reply;
      try {
        reply = await core.invoke("fixture_session", { operation });
      } catch {
        reply = "unavailable";
      }
      if (generation === changing) {
        status = reply;
        render({ status, rows: [] });
      }
      return status;
    },
    async read() {
      const receive = receiveRows();
      const rows = await core.invoke("fixture_task_list");
      receive(rows);
    },
    async subscribe() {
      const onRows = new core.Channel();
      onRows.onmessage = receiveRows();
      await core.invoke("fixture_task_subscribe", { onRows });
    },
    publish() {
      return core.invoke("fixture_task_publish");
    },
  };
}
