<script lang="ts">
  import TaskDetailPanel from './TaskDetailPanel.svelte';
  import type { DetailProps } from './detail-contract';

  let { client, workspaceId, publicId, ...rest }: DetailProps = $props();
</script>

{#key [client, workspaceId, publicId]}
  <TaskDetailPanel {client} {workspaceId} {publicId} {...rest} />
{/key}
