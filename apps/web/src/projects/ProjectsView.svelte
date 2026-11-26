<script lang="ts">
  import type { ProjectsProps } from './contracts';
  import ProjectsPanel from './ProjectsPanel.svelte';

  let { client, workspaceId, ...props }: ProjectsProps = $props();
</script>

{#key [client, workspaceId]}
  <ProjectsPanel {client} {workspaceId} {...props} />
{/key}
