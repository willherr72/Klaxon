<script lang="ts">
  import type { ConvexClient } from 'convex/browser';
  import { makeFunctionReference } from 'convex/server';
  import { onDestroy } from 'svelte';
  import { unscheduledReasons, type PlanPreview } from '../calendar/calendar-contract';
  import { errorCode } from '../contracts';

  type NamedTask = { taskPublicId: string; taskTitle: string };
  type Placement = PlanPreview['placements'][number] & NamedTask & {
    previousStartAt?: number; previousEndAt?: number;
  };
  type Proposal = Omit<PlanPreview, 'placements' | 'unscheduled'> & {
    agentLabel: string;
    reason: string;
    placements: Placement[];
    unscheduled: (PlanPreview['unscheduled'][number] & NamedTask)[];
    focusTasks: NamedTask[];
    briefing?: string;
    previousBriefing?: string;
    carryForwards?: (NamedTask & { expectedRevision: number; fromDate: string; toDate: string })[];
  };
  type Decision = 'approve' | 'reject';
  type Revision = { publicId: string; expectedRevision: number };
  type Selection = Revision & { decision: Decision };
  type Write = Revision & { workspaceId: string; operationId: string };
  type Attempt = { decision: Decision; args: Write };

  const list = makeFunctionReference<'query', { workspaceId: string }, Proposal[]>('agentPlans:pending');
  const decisions = {
    approve: makeFunctionReference<'mutation', Write>('agentPlans:approve'),
    reject: makeFunctionReference<'mutation', Write>('agentPlans:reject'),
  };

  let { client, workspaceId, disabled = false, onUnauthenticated, onDirtyChange }: {
    client: ConvexClient;
    workspaceId: string;
    disabled?: boolean;
    onUnauthenticated: () => void;
    onDirtyChange?: (dirty: boolean) => void;
  } = $props();

  let proposals = $state.raw<Proposal[]>();
  let unavailable = $state.raw<Revision[]>([]);
  let stale = $state.raw<Revision[]>([]);
  let selection = $state.raw<Selection>();
  let attempt = $state.raw<Attempt>();
  let writing = $state(false);
  let signedOut = $state(false);
  let loadError = $state(false);
  let refresh = $state(0);
  let now = $state(Date.now());
  let error = $state('');
  let notice = $state('');
  let alive = true;

  function matches(row: Proposal, revision: Revision) {
    return row.publicId === revision.publicId && row.revision === revision.expectedRevision;
  }

  const visible = $derived(proposals?.filter(row => !unavailable.some(revision => matches(row, revision))));
  const current = $derived(visible?.find(row => selection && matches(row, selection) && row.expiresAt > now));
  const nextExpiry = $derived(visible?.reduce((nearest, row) => row.expiresAt > now
    ? Math.min(nearest, row.expiresAt) : nearest, Infinity));

  onDestroy(() => { alive = false; });
  $effect(() => onDirtyChange?.(writing || Boolean(attempt)));
  $effect(() => {
    if (nextExpiry === undefined || !Number.isFinite(nextExpiry)) return;
    const timeout = setTimeout(() => { now = Date.now(); }, Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timeout);
  });
  $effect(() => {
    if (signedOut) return;
    const refreshId = refresh;
    let subscribed = true;
    proposals = undefined;
    loadError = false;
    const stop = client.onUpdate(list, { workspaceId }, rows => {
      if (!alive || !subscribed || signedOut || refresh !== refreshId) return;
      now = Date.now();
      proposals = rows;
      loadError = false;
      if (selection && !rows.some(row => selection && matches(row, selection) && row.expiresAt > now)) {
        selection = undefined;
        error = 'The proposal changed. Review the current proposal before deciding.';
      }
    }, reason => {
      if (!alive || !subscribed || signedOut || refresh !== refreshId) return;
      if (errorCode(reason) === 'UNAUTHENTICATED') expire();
      else {
        proposals = undefined;
        selection = undefined;
        loadError = true;
      }
    });
    return () => {
      subscribed = false;
      stop();
    };
  });

  function expire() {
    signedOut = true;
    proposals = selection = attempt = undefined;
    notice = error = '';
    onUnauthenticated();
  }

  function select(row: Proposal, decision: Decision) {
    if (disabled || attempt || row.expiresAt <= Date.now() ||
      (decision === 'approve' && stale.some(revision => matches(row, revision)))) return;
    selection = { decision, publicId: row.publicId, expectedRevision: row.revision };
    notice = error = '';
  }

  function confirm() {
    if (disabled || attempt || !selection || !current || current.expiresAt <= Date.now()) return;
    const { decision, publicId, expectedRevision } = selection;
    selection = undefined;
    attempt = { decision, args: { workspaceId, publicId, expectedRevision, operationId: crypto.randomUUID() } };
    void submit();
  }

  async function submit() {
    if (disabled || writing || !attempt || signedOut) return;
    const { decision, args } = attempt;
    writing = true;
    error = '';
    try {
      await client.mutation(decisions[decision], args);
      if (!alive || signedOut) return;
      unavailable = [...unavailable, { publicId: args.publicId, expectedRevision: args.expectedRevision }];
      attempt = undefined;
      notice = decision === 'approve' ? 'Proposal approved.' : 'Proposal rejected.';
    } catch (reason) {
      if (!alive || signedOut) return;
      const code = errorCode(reason);
      if (code === 'UNAUTHENTICATED') expire();
      else if (decision === 'approve' && (code === 'PLAN_CONTEXT_CHANGED' || code === 'PLAN_EXPIRED')) {
        stale = [...stale, { publicId: args.publicId, expectedRevision: args.expectedRevision }];
        attempt = undefined;
        error = code === 'PLAN_EXPIRED'
          ? 'The proposal expired or a block in it has already started.'
          : 'The schedule changed after the agent generated this proposal.';
      } else if (code === 'PLAN_EXPIRED' || code === 'PLAN_UNAVAILABLE' || code === 'PLAN_NOT_PENDING' ||
        code === 'REVISION_CONFLICT' || code === 'AUTONOMY_REVIEW_DISABLED') {
        unavailable = [...unavailable, { publicId: args.publicId, expectedRevision: args.expectedRevision }];
        attempt = undefined;
        error = code === 'PLAN_EXPIRED' ? 'The proposal expired.' : 'The proposal changed or is no longer available.';
      } else if (code) {
        attempt = undefined;
        error = 'The workspace could not accept this decision.';
      } else {
        error = 'The decision could not be confirmed. Retry the same decision.';
      }
    } finally {
      if (alive) writing = false;
    }
  }

  function formatRange(startAt: number, endAt: number, timezone: string) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: timezone })
      .formatRange(startAt, endAt);
  }
</script>

<section aria-labelledby="agent-plan-review">
  <h2 id="agent-plan-review">Agent plan proposals</h2>
  {#if signedOut}
    <p role="alert">Sign in again to review proposals.</p>
  {:else}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if writing}
      <p role="status">Submitting decision…</p>
    {:else if attempt}
      <button type="button" disabled={disabled} onclick={submit}>Retry decision</button>
    {/if}
    {#if loadError}
      <p role="alert">Proposals could not be loaded.</p>
      <button type="button" disabled={disabled} onclick={() => refresh++}>Reload proposals</button>
    {:else if !visible}
      <p role="status">Loading proposals…</p>
    {:else if !visible.length}
      <p>No pending proposals.</p>
    {:else}
      {#each visible as row (row.publicId)}
        {@const approvalStale = stale.some(revision => matches(row, revision))}
        <article>
          <h3><time datetime={row.localDate}>{row.localDate}</time> · {row.timezone}</h3>
          <p>{row.agentLabel}</p>
          <p>{row.reason}</p>
          {#if row.briefing !== undefined}
            <h4>Daily briefing</h4>
            {#if row.previousBriefing}<p>Current briefing</p><blockquote>{row.previousBriefing}</blockquote>{/if}
            <p>Proposed briefing</p><blockquote>{row.briefing}</blockquote>
          {/if}
          {#if row.carryForwards?.length}
            <h4>Carry-forward changes</h4>
            <ol>
              {#each row.carryForwards as carry (carry.taskPublicId)}
                <li>{carry.taskTitle} · <time datetime={carry.fromDate}>{carry.fromDate}</time> → <time datetime={carry.toDate}>{carry.toDate}</time></li>
              {/each}
            </ol>
          {/if}
          <h4>Calendar changes</h4>
          {#if row.placements.length}
            <ul>
              {#each row.placements as placement (placement.taskPublicId)}
                {@const destination = formatRange(placement.startAt, placement.endAt, row.timezone)}
                {#if placement.action === 'move' && placement.previousStartAt !== undefined && placement.previousEndAt !== undefined}
                  <li>Move {placement.taskTitle} from {formatRange(placement.previousStartAt, placement.previousEndAt, row.timezone)} to {destination}</li>
                {:else}
                  <li>{placement.action === 'move' ? 'Move' : 'Schedule'} {placement.taskTitle} at {destination}</li>
                {/if}
              {/each}
            </ul>
          {:else}
            <p>No calendar changes.</p>
          {/if}
          {#if row.unscheduled.length}
            <h4>Unscheduled work</h4>
            <ul>
              {#each row.unscheduled as item (item.taskPublicId)}
                <li>{item.taskTitle} · {unscheduledReasons[item.reason]}{item.remainingMinutes === undefined ? '' : ` · ${item.remainingMinutes} min remaining`}</li>
              {/each}
            </ul>
          {/if}
          {#if row.focusTasks.length}
            <p>Add {row.focusTasks.map(task => task.taskTitle).join(', ')} to day focus.</p>
          {/if}
          {#if row.expiresAt <= now}
            <p>Proposal expired.</p>
          {:else if current === row && selection}
            <div class="actions">
              <button type="button" disabled={disabled} onclick={confirm}>
                {selection.decision === 'approve' ? 'Confirm approval' : 'Confirm rejection'}
              </button>
              <button type="button" onclick={() => selection = undefined}>Cancel</button>
            </div>
          {:else}
            {#if approvalStale}<p>This revision can no longer be applied.</p>{/if}
            <div class="actions">
              <button type="button" disabled={disabled || Boolean(attempt) || approvalStale} onclick={() => select(row, 'approve')}>Approve</button>
              <button type="button" disabled={disabled || Boolean(attempt)} onclick={() => select(row, 'reject')}>Reject</button>
            </div>
          {/if}
        </article>
      {/each}
    {/if}
  {/if}
</section>

<style>
  article {
    border-block-start: 1px solid var(--planner-border, #526171);
    margin-block-start: 1rem;
    padding-block-start: 1rem;
    overflow-wrap: anywhere;
  }

  article h3 {
    margin-block-start: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
