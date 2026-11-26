<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { routeLabels, type PlannerDestination, type PlannerRoute } from './routes';
  import './planner-shell.css';

  type Theme = 'system' | 'light' | 'dark';

  interface Props {
    destinations: readonly PlannerDestination[];
    active?: PlannerRoute;
    /** Identify a route change within the same primary destination, such as a new task detail. */
    routeKey?: string;
    /** The parent commits navigation by updating active or routeKey after its guards pass. */
    onNavigate?: (destination: PlannerDestination) => void;
    children: Snippet;
    status?: Snippet;
    actions?: Snippet;
    detail?: Snippet;
    detailLabel?: string;
  }

  const desktopRoutes = ['today', 'inbox', 'upcoming', 'calendar', 'projects', 'waiting'] as const;
  const desktopUtilities = ['capture', 'activity', 'settings'] as const;
  const mobileRoutes = ['today', 'inbox', 'calendar', 'capture', 'projects'] as const;
  const mobileUtilities = ['upcoming', 'waiting', 'activity', 'settings'] as const;
  const themeKey = 'klaxon.planner.theme';

  let {
    destinations, active, routeKey, onNavigate, children, status, actions, detail, detailLabel = 'Task details',
  }: Props = $props();

  const id = $props.id();
  const contentId = `${id}-planner-content`;
  let main: HTMLElement | undefined = $state();
  let detailPanel: HTMLElement | undefined = $state();
  let more: HTMLDetailsElement | undefined = $state();
  let moreSummary: HTMLElement | undefined = $state();
  let theme = $state<Theme>(readTheme());
  let previousRoute: { active?: PlannerRoute; key?: string; hasDetail: boolean } | undefined;

  const routes = $derived(new Map(destinations.map(destination => [destination.id, destination])));
  const primary = $derived(orderedRoutes(desktopRoutes, routes));
  const utilities = $derived(orderedRoutes(desktopUtilities, routes));
  const bottom = $derived(orderedRoutes(mobileRoutes, routes));
  const moreRoutes = $derived(orderedRoutes(mobileUtilities, routes));

  $effect(() => {
    const current = { active, key: routeKey, hasDetail: Boolean(detail) };
    const previous = previousRoute;
    previousRoute = current;
    if (previous && (current.active !== previous.active || current.key !== previous.key ||
      current.hasDetail !== previous.hasDetail)) {
      void tick().then(() => {
        if (more) more.open = false;
        (detailPanel ?? main)?.focus();
      });
    }
  });

  function orderedRoutes(ids: readonly PlannerRoute[], available: ReadonlyMap<PlannerRoute, PlannerDestination>) {
    return ids.flatMap(id => {
      const destination = available.get(id);
      return destination ? [destination] : [];
    });
  }

  function readTheme(): Theme {
    try {
      const saved = typeof window === 'undefined' ? null : window.localStorage.getItem(themeKey);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
      return 'system';
    }
  }

  function changeTheme(event: Event & { currentTarget: HTMLSelectElement }) {
    const selected = event.currentTarget.value;
    theme = selected === 'light' || selected === 'dark' ? selected : 'system';
    try {
      window.localStorage.setItem(themeKey, theme);
    } catch {
      // The current page can still use the selected theme when storage is unavailable.
    }
  }

  function navigate(event: MouseEvent, destination: PlannerDestination) {
    if (!onNavigate || event.defaultPrevented || event.button !== 0 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(destination);
  }

  function skip(event: MouseEvent) {
    event.preventDefault();
    (detailPanel ?? main)?.focus();
  }

  function closeMore(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !more?.open) return;
    event.preventDefault();
    event.stopPropagation();
    more.open = false;
    moreSummary?.focus();
  }
</script>

{#snippet links(items: PlannerDestination[], inDisclosure = false)}
  <ul class="planner-links">
    {#each items as destination (destination.id)}
      <li>
        <a href={destination.href} aria-current={destination.id === active ? 'page' : undefined}
          onclick={(event) => navigate(event, destination)}
          onkeydown={inDisclosure ? closeMore : undefined}>{routeLabels[destination.id]}</a>
      </li>
    {/each}
  </ul>
{/snippet}

<div class="planner-shell" class:planner-has-rail={destinations.length > 0}
  class:planner-has-bottom={bottom.length > 0} data-planner-theme={theme}>
  <a class="planner-skip" href={`#${contentId}`} onclick={skip}>Skip to content</a>

  {#if destinations.length > 0}
    <aside class="planner-rail" aria-label="Klaxon">
      <span class="planner-brand">Klaxon</span>
      {#if primary.length}
        <nav aria-label="Planner">{@render links(primary)}</nav>
      {/if}
      {#if utilities.length}
        <nav aria-label="Workspace">{@render links(utilities)}</nav>
      {/if}
    </aside>
  {/if}

  <div class="planner-workspace">
    <header class="planner-header">
      <span class="planner-brand planner-header-brand">Klaxon</span>
      {#if status}
        <div class="planner-status">{@render status()}</div>
      {/if}
      <div class="planner-header-controls">
        {@render actions?.()}
        <label class="planner-theme">
          Theme
          <select value={theme} onchange={changeTheme}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        {#if moreRoutes.length}
          <details class="planner-more" bind:this={more}>
            <summary bind:this={moreSummary} onkeydown={closeMore}>More</summary>
            <nav aria-label="More planner destinations">{@render links(moreRoutes, true)}</nav>
          </details>
        {/if}
      </div>
    </header>

    <main class="planner-main" class:planner-has-detail={detail} id={contentId} tabindex="-1" bind:this={main}>
      <div class="planner-view">{@render children()}</div>
      {#if detail}
        <section class="planner-detail" aria-label={detailLabel} tabindex="-1" bind:this={detailPanel}>
          {@render detail()}
        </section>
      {/if}
    </main>
  </div>

  {#if bottom.length}
    <nav class="planner-bottom" aria-label="Planner">{@render links(bottom)}</nav>
  {/if}
</div>
