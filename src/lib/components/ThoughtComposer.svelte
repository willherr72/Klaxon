<script lang="ts">
  let {
    onCreate,
    autofocus = false,
  }: {
    onCreate: (body: string) => Promise<void> | void;
    /** Take keyboard focus as soon as the textarea exists. Used by the
     * hotkey capture window, where the whole point is to type
     * immediately without reaching for the mouse. */
    autofocus?: boolean;
  } = $props();

  let body = $state("");
  let busy = $state(false);
  let el: HTMLTextAreaElement | null = $state(null);
  let mirror: HTMLDivElement | null = $state(null);

  // Mirrors models::tag_from_token: a '#' followed by a run of letters,
  // digits, '-' or '_'. Unicode-aware so it agrees with Rust's
  // char::is_alphanumeric rather than JS's ASCII-only \w. Anything after
  // that run (say the '!' in "#done!") is ordinary text, because the
  // backend wouldn't include it in the tag either.
  const TAG_RE = /#[\p{L}\p{N}_-]+/gu;

  function escapeHtml(s: string): string {
    return s.replace(
      /[&<>]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string,
    );
  }

  /** Render the body as HTML with `#tag` spans wrapped for colouring.
   * Everything is escaped first — this string goes through {@html}. */
  function highlight(text: string): string {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(TAG_RE)) {
      const i = m.index ?? 0;
      // The backend splits on whitespace before testing for '#', so
      // "a#b" is not a tag. Require a token boundary here to match.
      const prev = i > 0 ? text[i - 1] : " ";
      if (!/\s/.test(prev)) continue;
      out += escapeHtml(text.slice(last, i));
      out += `<span class="tag">${escapeHtml(m[0])}</span>`;
      last = i + m[0].length;
    }
    out += escapeHtml(text.slice(last));
    // A trailing newline collapses in the mirror but not in the textarea,
    // so the two would disagree on height by one line.
    return out.endsWith("\n") ? `${out} ` : out;
  }

  let highlighted = $derived(highlight(body));

  // Runs once `el` is bound, which is what we actually want to wait for.
  $effect(() => {
    if (autofocus && el) el.focus();
  });

  // Grow with the content instead of scrolling. A thought is usually one
  // line, but pasting a paragraph shouldn't hide most of it.
  function autoGrow() {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }

  // Past the max height the textarea scrolls; the mirror has to follow or
  // the colouring drifts away from the text.
  function syncScroll() {
    if (el && mirror) mirror.scrollTop = el.scrollTop;
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
  <!-- The mirror sits behind a transparent-text textarea: a textarea can't
       style its own content, so the visible text is actually the mirror's
       and the textarea contributes only the caret and interaction. Their
       box metrics must stay identical or the two drift apart. -->
  <div class="input-wrap">
    <div class="mirror" bind:this={mirror} aria-hidden="true">
      {@html highlighted}
    </div>
    <textarea
      bind:this={el}
      bind:value={body}
      rows="1"
      placeholder="What's on your mind?"
      disabled={busy}
      oninput={() => {
        autoGrow();
        syncScroll();
      }}
      onscroll={syncScroll}
      onkeydown={onKeydown}
    ></textarea>
  </div>
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

  /* Border and background live on the wrapper so the textarea and mirror
     can share identical geometry with no border of their own. */
  .input-wrap {
    position: relative;
    border: 1px solid var(--border-strong);
    background: var(--bg);
    transition: border-color 120ms var(--ease);
  }
  .input-wrap:focus-within {
    border-color: var(--klaxon);
  }

  /* These declarations must stay in lockstep between the two layers. */
  .mirror,
  .input-wrap textarea {
    padding: 10px 12px;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    letter-spacing: normal;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    box-sizing: border-box;
  }

  .mirror {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    color: var(--text);
  }
  .mirror :global(.tag) {
    color: var(--klaxon);
  }

  .input-wrap textarea {
    position: relative;
    display: block;
    width: 100%;
    resize: none;
    overflow-y: auto;
    max-height: 220px;
    border: none;
    background: transparent;
    /* The mirror supplies the visible glyphs; this layer supplies only
       the caret and hit area. */
    color: transparent;
    caret-color: var(--text);
  }
  .input-wrap textarea:focus {
    outline: none;
  }
  .input-wrap textarea::placeholder {
    color: var(--text-muted);
  }
  /* Semi-transparent so the mirror's text stays readable through a
     selection — an opaque highlight would paint over it. */
  .input-wrap textarea::selection {
    background: rgba(255, 157, 0, 0.28);
  }

  .hint {
    margin-top: 6px;
    font-size: 9px;
    letter-spacing: 0.12em;
  }
</style>
