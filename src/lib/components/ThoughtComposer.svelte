<script lang="ts">
  let {
    onCreate,
  }: {
    onCreate: (body: string) => Promise<void> | void;
  } = $props();

  let body = $state("");
  let busy = $state(false);
  let el: HTMLTextAreaElement | null = $state(null);

  // Grow with the content instead of scrolling. A thought is usually one
  // line, but pasting a paragraph shouldn't hide most of it.
  function autoGrow() {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }

  async function submit() {
    const text = body.trim();
    // Whitespace-only is a silent no-op — no error, no flash.
    if (!text || busy) return;
    busy = true;
    try {
      await onCreate(text);
      body = "";
      // Clear, resize, and hold focus so several thoughts can be dumped
      // in a row without touching the mouse.
      queueMicrotask(() => {
        autoGrow();
        el?.focus();
      });
    } finally {
      busy = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }
</script>

<div class="composer">
  <textarea
    bind:this={el}
    bind:value={body}
    rows="1"
    placeholder="What's on your mind?"
    disabled={busy}
    oninput={autoGrow}
    onkeydown={onKeydown}
  ></textarea>
  <div class="hint mono-caps-faint">
    Enter saves · Shift+Enter for a new line · #tag to label
  </div>
</div>

<style>
  .composer {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }
  textarea {
    width: 100%;
    resize: none;
    overflow-y: auto;
    max-height: 220px;
    border: 1px solid var(--border-strong);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    padding: 10px 12px;
    transition: border-color 120ms var(--ease);
  }
  textarea:focus {
    outline: none;
    border-color: var(--klaxon);
  }
  textarea::placeholder {
    color: var(--text-muted);
  }
  .hint {
    margin-top: 6px;
    font-size: 9px;
    letter-spacing: 0.12em;
  }
</style>
