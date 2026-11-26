<script lang="ts">
  import { onMount } from 'svelte';
  import type { ConvexClient } from 'convex/browser';
  import { errorCode } from '../contracts';
  import { addDays, localDate, queries, sectionKeys, sections, type Schedule, type Today, type Upcoming, type View, type Waiting } from './queries';

  let { client, workspaceId, view, onOpenTask, onUnauthenticated }: {
    client: ConvexClient; workspaceId: string; view: View; onOpenTask: (id: string) => void; onUnauthenticated?: () => void;
  } = $props();
  const titles = { today: 'Today', upcoming: 'Upcoming', waiting: 'Waiting' };
  let timezone = $state('');
  const openedAt = Date.now();
  let now = $state(openedAt);
  let asOf = $state(openedAt);
  let weekOffset = $state(0);
  let cursors = $state<(string | null)[]>([null]);
  let tab = $state<'Tasks' | 'Schedule'>('Tasks');
  let today = $state<Today>();
  let schedule = $state<Schedule>();
  let upcoming = $state<Upcoming>();
  let waiting = $state<Waiting>();
  let errors = $state<Record<string, string>>({});
  const day = $derived(timezone ? localDate(now, timezone) : '');
  const from = $derived(day ? addDays(day, weekOffset) : '');
  const clock = $derived(new Intl.DateTimeFormat(undefined, {timeZone: timezone || 'UTC', hour: 'numeric', minute: '2-digit'}));
  const dateFormat = new Intl.DateTimeFormat(undefined, {timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'});
  const formatDay = (date: string) => dateFormat.format(new Date(date + 'T12:00:00Z'));
  const timeline = $derived(schedule ? [
    ...schedule.blocks.map(b => ({...b, label: b.title || b.taskTitle || 'Reserved time', allDay: false, key: 'block-' + b.publicId})),
    ...schedule.events.map(e => ({...e, label: e.title || 'Busy', taskPublicId: undefined, key: 'event-' + e.publicId})),
  ].sort((a,b) => a.startAt - b.startAt || a.key.localeCompare(b.key)) : []);

  onMount(() => {
    function tick() {
      const at = Date.now();
      const expiredDeadline = today?.dueToday.items.some(t => t.deadline?.kind === 'instant' && t.deadline.at < at);
      if (!timezone || localDate(asOf, timezone) !== localDate(at, timezone) || expiredDeadline) asOf = at;
      now = at;
    }
    const timer = window.setInterval(tick, 30_000);
    window.addEventListener('focus', tick);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick); };
  });

  function fail(section: string, error: unknown) {
    if (errorCode(error) === 'UNAUTHENTICATED') onUnauthenticated?.();
    errors[section] = 'Could not load ' + section + '.';
  }
  $effect(() => {
    timezone = '';
    delete errors.preferences;
    return client.onUpdate(queries.preferences, {workspaceId}, value => {
      timezone = value.timezone;
      delete errors.preferences;
    }, error => fail('preferences', error));
  });
  $effect(() => {
    today = undefined;
    delete errors.tasks;
    if (view !== 'today' || !day || localDate(asOf, timezone) !== day) return;
    return client.onUpdate(queries.today, {workspaceId, localDate: day, timezone, asOf}, value => {
      today = value; delete errors.tasks;
    }, error => fail('tasks', error));
  });
  $effect(() => {
    schedule = undefined;
    delete errors.schedule;
    if (view !== 'today' || !day) return;
    return client.onUpdate(queries.schedule, {workspaceId, localDate: day, timezone, view:'day'}, value => {
      schedule = value; delete errors.schedule;
    }, error => fail('schedule', error));
  });
  $effect(() => {
    upcoming = undefined;
    delete errors.upcoming;
    if (view !== 'upcoming' || !from) return;
    return client.onUpdate(queries.upcoming, {workspaceId, from, timezone}, value => {
      upcoming = value; delete errors.upcoming;
    }, error => fail('upcoming', error));
  });
  $effect(() => {
    waiting = undefined;
    delete errors.waiting;
    if (view !== 'waiting') return;
    return client.onUpdate(queries.waiting, {workspaceId, filter:{kind:'status',status:'waiting'},
      paginationOpts:{cursor:cursors[cursors.length - 1],numItems:25}}, value => {
      waiting = value; delete errors.waiting;
    }, error => fail('waiting', error));
  });
  function useTab(event: KeyboardEvent) {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    tab = event.key === 'Home' ? 'Tasks' : event.key === 'End' ? 'Schedule' : tab === 'Tasks' ? 'Schedule' : 'Tasks';
    document.getElementById('overview-tab-' + tab)?.focus();
  }
</script>

<section class="overview" aria-label={titles[view]}>
  <header><h1>{titles[view]}</h1>
    {#if day && view === 'today'}<p>{formatDay(day)} · {timezone}</p>{/if}
  </header>
  {#if errors.preferences}<p role="alert">{errors.preferences}</p>{/if}
  {#if view === 'today'}
    {#if today?.briefing}<p>{today.briefing}</p>{/if}
    {#if today?.needsReplan}<p role="status">Your schedule needs review.</p>{/if}
    <div class="tabs" role="tablist" aria-label="Today view">
      {#each ['Tasks','Schedule'] as name (name)}
        <button role="tab" id={'overview-tab-' + name} aria-selected={name === tab} aria-controls={'overview-' + name}
          tabindex={name === tab ? 0 : -1} onclick={() => tab = name === 'Tasks' ? 'Tasks' : 'Schedule'} onkeydown={useTab}>{name}</button>
      {/each}
    </div>
    <div class="columns">
      <section id="overview-Tasks" class:inactive={tab !== 'Tasks'} aria-label="Tasks">
        <h2>Tasks</h2>
        {#if errors.tasks}<p role="alert">{errors.tasks}</p>
        {:else if !today}<p role="status">Loading tasks…</p>
        {:else if !sectionKeys.some(k => today?.[k].items.length)}<p>No tasks for today.</p>
        {:else}
          {#each sectionKeys as key (key)}
            {#if today[key].items.length}
              <h3>{sections[key]}</h3>
              <ul>{#each today[key].items as task (task.publicId)}
                <li><button class="open" onclick={() => onOpenTask(task.publicId)}>{task.title}</button>
                  {#if task.estimateMinutes}<small>{task.estimateMinutes} min</small>{/if}</li>
              {/each}</ul>
              {#if today[key].partial}<small>Showing {today[key].items.length} tasks</small>{/if}
            {/if}
          {/each}
        {/if}
      </section>
      <section id="overview-Schedule" class:inactive={tab !== 'Schedule'} aria-label="Schedule">
        <h2>Schedule</h2>
        {#if errors.schedule}<p role="alert">{errors.schedule}</p>
        {:else if !schedule}<p role="status">Loading schedule…</p>
        {:else if !timeline.length}<p>No scheduled blocks or events.</p>
        {:else}<ul>{#each timeline as item (item.key)}
          <li><small>{item.allDay ? 'All day' : clock.format(item.startAt) + ' – ' + clock.format(item.endAt)}</small>
            {#if item.taskPublicId}<button class="open" onclick={() => item.taskPublicId && onOpenTask(item.taskPublicId)}>{item.label}</button>
            {:else}<span>{item.label}</span>{/if}</li>
        {/each}</ul>{/if}
      </section>
    </div>
  {:else if view === 'upcoming'}
    {#if from}<p>{formatDay(from)} – {formatDay(addDays(from,6))} · {timezone}</p>{/if}
    <nav aria-label="Upcoming weeks"><button onclick={() => weekOffset -= 7}>Previous week</button>
      <button onclick={() => weekOffset = 0} disabled={!weekOffset}>This week</button><button onclick={() => weekOffset += 7}>Next week</button></nav>
    {#if errors.upcoming}<p role="alert">{errors.upcoming}</p>
    {:else if !upcoming}<p role="status">Loading upcoming items…</p>
    {:else if !upcoming.items.length}<p>Nothing planned or due this week.</p>
    {:else}<ul>{#each upcoming.items as item (item.kind + ':' + item.publicId)}
      <li><small>{formatDay(item.date)}{item.at === undefined ? '' : ' · ' + clock.format(item.at)} · {item.kind}</small>
        {#if item.kind === 'reminder'}<span>{item.title}</span>{:else}<button class="open" onclick={() => onOpenTask(item.publicId)}>{item.title}</button>{/if}</li>
    {/each}</ul>{#if upcoming.partial}<p>Showing {upcoming.items.length} upcoming items.</p>{/if}{/if}
  {:else}
    {#if errors.waiting}<p role="alert">{errors.waiting}</p>
    {:else if !waiting}<p role="status">Loading waiting tasks…</p>
    {:else}
      {#if !waiting.page.length}<p>No waiting tasks on this page.</p>{/if}
      <ul>{#each waiting.page as task (task.publicId)}
        <li><button class="open" onclick={() => onOpenTask(task.publicId)}>{task.title}</button>
          {#if task.waitingPerson || task.waitingReason}<small>{[task.waitingPerson, task.waitingReason].filter(Boolean).join(' · ')}</small>{/if}
          {#if task.followUpDate}<small>Follow up {formatDay(task.followUpDate)}</small>{/if}</li>
      {/each}</ul>
      {#if cursors.length > 1 || !waiting.isDone}
        <nav aria-label="Waiting task pages"><button disabled={cursors.length === 1} onclick={() => cursors = cursors.slice(0,-1)}>Previous page</button>
          <button disabled={waiting.isDone} onclick={() => waiting && (cursors = [...cursors,waiting.continueCursor])}>Next page</button></nav>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .overview {padding: var(--planner-gutter); color:var(--planner-text)}
  header p, small {color:var(--planner-text-muted)}
  h1, h2, h3 {line-height:1.15}
  h1 {margin:0; font-size:clamp(2rem, 5vw, 3rem)}
  h3 {margin:1.6rem 0 .4rem}
  .columns {display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:var(--planner-gutter)}
  ul {padding:0;margin:0;list-style:none}
  li {padding:.5rem 0;border-bottom:1px solid var(--planner-border);display:grid;overflow-wrap:anywhere}
  button {color:inherit;min-height:var(--planner-target);cursor:pointer}
  button:disabled {cursor:default}
  button.open {text-align:start;background:none;border:0;padding:.25rem 0;font:inherit}
  button.open:hover {text-decoration:underline}
  nav, .tabs {display:flex;gap:.5rem;flex-wrap:wrap}
  .tabs {display:none}
  @media (max-width: 48rem) {
    .columns {display:block}
    .tabs {display:flex}
    .tabs button[aria-selected="true"] {border-bottom:3px solid var(--planner-accent)}
    .inactive {display:none}
  }
</style>
