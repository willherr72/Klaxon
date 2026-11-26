<script lang="ts">
  import ReminderPanel from './ReminderPanel.svelte';
  import type { ReminderProps } from './reminder-contract';
  import './reminders.css';

  let props: ReminderProps = $props();
</script>

{#key props.client}
  {#key props.userId}
    {#key props.workspaceId}
      {#key props.workspacePublicId}
        <ReminderPanel {...props} />
      {/key}
    {/key}
  {/key}
{/key}
