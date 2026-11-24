<script>
  let status = $state("unchecked");
  let busy = $state(false);

  async function check(operation) {
    if (busy) return;
    busy = true;
    try {
      status = await window.__TAURI__.core.invoke("fixture_session", { operation });
    } catch {
      status = "unavailable";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="Native session fixture">
  <h2>Native session fixture</h2>
  <div class="actions">
    <button disabled={busy} onclick={() => check("seed")}>Start synthetic session</button>
    <button disabled={busy} onclick={() => check("resume")}>Resume session</button>
    <button disabled={busy} onclick={() => check("sign-out")}>Sign out</button>
  </div>
  <output aria-label="Native session status">{status}</output>
</section>
