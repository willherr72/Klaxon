<script lang="ts">
  import type { ConvexClient } from 'convex/browser';
  import AgentCredentials from './AgentCredentials.svelte';
  import AgentPlanReview from './AgentPlanReview.svelte';
  import AutonomyPolicy from './AutonomyPolicy.svelte';

  let { client, workspaceId, workspacePublicId, disabled, onDirtyChange, onUnauthenticated }: {
    client: ConvexClient;
    workspaceId: string;
    workspacePublicId: string;
    disabled: boolean;
    onDirtyChange: (dirty: boolean) => void;
    onUnauthenticated: () => void;
  } = $props();
  let credentialDirty = $state(false);
  let reviewDirty = $state(false);
  let policyDirty = $state(false);
  $effect(() => onDirtyChange(credentialDirty || reviewDirty || policyDirty));
</script>

<AgentCredentials {client} {workspaceId} {workspacePublicId} {disabled} {onUnauthenticated}
  onDirtyChange={dirty => credentialDirty = dirty} />
<AgentPlanReview {client} {workspaceId} {disabled} {onUnauthenticated} onDirtyChange={dirty => reviewDirty = dirty} />
<AutonomyPolicy {client} {workspaceId} {disabled} {onUnauthenticated} onDirtyChange={dirty => policyDirty = dirty} />
