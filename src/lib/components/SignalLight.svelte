<script lang="ts">
  import type { Priority } from "../types";

  let {
    priority = "normal",
    size = 10,
    pulse = false,
  }: { priority?: Priority; size?: number; pulse?: boolean } = $props();

  const colors: Record<Priority, { core: string; glow: string }> = {
    low: { core: "var(--signal-low)", glow: "var(--signal-low-glow)" },
    normal: { core: "var(--signal-normal)", glow: "var(--signal-normal-glow)" },
    high: { core: "var(--signal-high)", glow: "var(--signal-high-glow)" },
  };
</script>

<span
  class="light"
  class:pulse={pulse || priority === "high"}
  style:--core={colors[priority].core}
  style:--glow={colors[priority].glow}
  style:width="{size}px"
  style:height="{size}px"
></span>

<style>
  .light {
    display: inline-block;
    border-radius: 50%;
    background: var(--core);
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.4),
      0 0 8px 1px var(--glow),
      inset 0 0 3px rgba(255, 255, 255, 0.45);
    flex-shrink: 0;
  }
  .pulse {
    animation: lightPulse 1.6s var(--ease) infinite;
  }
  @keyframes lightPulse {
    0%, 100% { box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.4),
      0 0 8px 1px var(--glow),
      inset 0 0 3px rgba(255, 255, 255, 0.45); }
    50% { box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.4),
      0 0 14px 3px var(--glow),
      inset 0 0 4px rgba(255, 255, 255, 0.6); }
  }
</style>
