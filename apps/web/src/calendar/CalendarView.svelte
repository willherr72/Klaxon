<script lang="ts">
  import CalendarPanel from './CalendarPanel.svelte';
  import type { CalendarProps } from './calendar-contract';
  import './calendar.css';

  let { client, workspaceId, ...rest }: CalendarProps = $props();
</script>

{#key [client, workspaceId]}
  <CalendarPanel {client} {workspaceId} {...rest} />
{/key}
