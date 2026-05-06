<script lang="ts">
  import SignalLight from "./SignalLight.svelte";
</script>

<div class="empty">
  <div class="halo">
    <SignalLight priority="low" size={14} pulse />
  </div>
  <div class="primary mono-caps">No Reminders</div>
  <div class="secondary mono-caps-faint">All Clear · System Idle</div>
  <div class="rule"></div>
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 400px;
    gap: 10px;
    color: var(--text-muted);
  }
  .halo {
    margin-bottom: 14px;
    padding: 22px;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.6);
  }
  .primary {
    font-size: 12px;
    color: var(--text-2);
    letter-spacing: 0.22em;
  }
  .secondary {
    font-size: 9px;
    letter-spacing: 0.22em;
  }
  .rule {
    margin-top: 14px;
    width: 60px;
    height: 1px;
    background: var(--border-strong);
  }
</style>
