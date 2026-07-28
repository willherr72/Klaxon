<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { api } from "./lib/api";
  import ThoughtComposer from "./lib/components/ThoughtComposer.svelte";

  async function save(body: string) {
    try {
      await api.createThought({ body, tags: [] });
    } catch (e) {
      console.error("capture failed", e);
      return; // Leave the window open so the text isn't lost.
    }
    await getCurrentWindow().close();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      void getCurrentWindow().close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="capture">
  <div class="bar mono-caps-faint">Capture a thought</div>
  <ThoughtComposer onCreate={save} autofocus />
</div>

<style>
  .capture {
    background: var(--bg);
    border: 1px solid var(--klaxon-dim);
    height: 100vh;
    box-sizing: border-box;
    overflow: hidden;
  }
  .bar {
    padding: 8px 16px 0;
    font-size: 9px;
    letter-spacing: 0.22em;
  }
</style>
