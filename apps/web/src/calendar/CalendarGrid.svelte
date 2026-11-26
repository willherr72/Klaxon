<script lang="ts">
  import { tick } from 'svelte';
  import { taskHref } from '../planner-route';
  import { addDays, height, hourHeight, hourMs, labelDate, overlaps, type CalendarClock } from './calendar-clock';
  import type { Block, CalendarMode, CalendarRange, Event, Interval } from './calendar-contract';

  type Item = { kind: 'block'; value: Block } | { kind: 'event'; value: Event };
  type Positioned = Item & { top: number; size: number; lane: number; laneCount: number };
  let { range, mode, clock, selectedDate, disabled, onSelectDate, onOpenTask, onEdit, onDrag, onEndDrag, onDrop }: {
    range: CalendarRange; mode: CalendarMode; clock: CalendarClock; selectedDate: string; disabled: boolean;
    onSelectDate: (date: string) => void; onOpenTask: (event: MouseEvent, publicId: string) => void;
    onEdit: (block: Block, event: MouseEvent) => void;
    onDrag: (event: DragEvent, block: Block, mode: 'move' | 'resize') => void;
    onEndDrag: () => void;
    onDrop: (event: DragEvent, day: Interval) => void;
  } = $props();

  let scrollBox: HTMLDivElement;
  const firstDate = $derived(range.localDate);
  const days = $derived.by(() => Array.from({ length: mode === 'day' ? 1 : 7 }, (_, index) => {
    const date = addDays(range.localDate, index);
    const startAt = index === 0 ? range.startAt : clock.midnight(date);
    const endAt = index === (mode === 'day' ? 0 : 6) ? range.endAt : clock.midnight(addDays(date, 1));
    if (startAt === undefined || endAt === undefined) return [];
    const interval = { startAt, endAt };
    const allDay = range.events.filter(event => event.allDay && overlaps(event, interval));
    const items: Item[] = [
      ...range.blocks.map(value => ({ kind: 'block' as const, value })),
      ...range.events.filter(event => !event.allDay).map(value => ({ kind: 'event' as const, value })),
    ];
    const hours = Array.from({ length: Math.max(0, Math.ceil((endAt - startAt) / hourMs)) }, (_, i) => startAt + i * hourMs);
    const repeatedHours = new Set(hours.map(hour => clock.hourLabel(hour)).filter((label, i, labels) => labels.indexOf(label) !== i));
    return [{ date, interval, allDay, timed: layout(items, interval), hours, repeatedHours }];
  }).flat());

  $effect(() => {
    const date = firstDate;
    const displayMode = mode;
    let active = true;
    void tick().then(() => {
      if (!active || !scrollBox) return;
      scrollBox.scrollTop = 7 * hourHeight;
      if (displayMode === 'day') scrollBox.scrollLeft = 0;
      else {
        const grid = scrollBox.querySelector<HTMLElement>('[data-calendar-date="' + selectedDate + '"]');
        const first = scrollBox.querySelector<HTMLElement>('[data-calendar-date="' + date + '"]');
        if (grid && first) scrollBox.scrollLeft = grid.offsetLeft - first.offsetLeft;
      }
    });
    return () => { active = false; };
  });

  function layout(items: Item[], day: Interval) {
    const sorted = items.filter(({ value }) => overlaps(value, day))
      .sort((a, b) => a.value.startAt - b.value.startAt || b.value.endAt - a.value.endAt);
    const placed: Positioned[] = [];
    let laneEnds: number[] = [];
    let group: Positioned[] = [];
    let groupEnd = day.startAt;
    for (const item of sorted) {
      const startAt = Math.max(item.value.startAt, day.startAt);
      const endAt = Math.min(item.value.endAt, day.endAt);
      // Leave visual space for the compact controls, including very short blocks.
      const visualEnd = Math.max(endAt, startAt + hourMs);
      if (startAt >= groupEnd) {
        for (const item of group) item.laneCount = laneEnds.length;
        laneEnds = [];
        group = [];
      }
      const free = laneEnds.findIndex(end => end <= startAt);
      const lane = free < 0 ? laneEnds.length : free;
      laneEnds[lane] = visualEnd;
      groupEnd = Math.max(groupEnd, visualEnd);
      const positioned = { ...item, top: height(startAt - day.startAt), size: height(endAt - startAt), lane, laneCount: 1 };
      group.push(positioned);
      placed.push(positioned);
    }
    for (const item of group) item.laneCount = laneEnds.length;
    return placed;
  }

  function blockTitle(block: Block) { return block.title ?? block.taskTitle ?? 'Time block'; }
  function isHistorical(block: Block) { return block.taskStatus === 'done' || block.taskStatus === 'archived'; }
  function eventTitle(event: Event) {
    if (event.title) return event.title;
    if (event.availability === 'free') return 'Free';
    if (event.availability === 'working_elsewhere') return 'Working elsewhere';
    return 'Busy';
  }

  function acceptDrag(event: DragEvent) {
    if (!disabled && event.dataTransfer?.types.includes('application/x-klaxon-calendar')) event.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users can focus the scrollable calendar.) -->
<div class="calendar-grid" role="region" aria-label={mode === 'day' ? 'Day calendar' : 'Week calendar'} tabindex="0" bind:this={scrollBox}>
  <div class="calendar-columns" class:calendar-week={mode === 'week'}>
    {#each days as day (day.date)}
      <section class="calendar-day" aria-label={labelDate(day.date)} data-calendar-date={day.date}>
        <header class="calendar-day-header">
          <h3>{labelDate(day.date)}</h3>
          {#if mode === 'week'}
            <button type="button" aria-pressed={day.date === selectedDate} disabled={disabled}
              aria-label={'Plan ' + labelDate(day.date)} onclick={() => onSelectDate(day.date)}>{day.date === selectedDate ? 'Selected' : 'Select day'}</button>
          {/if}
          {#each day.allDay as event (event.publicId)}
            <div class="calendar-all-day" class:calendar-event-muted={event.availability === 'free' || event.availability === 'working_elsewhere'}>
              <strong>{eventTitle(event)}</strong> <small>All day · {event.provider === 'outlook' ? 'Outlook' : event.provider}</small>
            </div>
          {/each}
        </header>
        <div class="calendar-timeline" role="group" aria-label={'Timeline for ' + labelDate(day.date)}
          style:--timeline-height={`${height(day.interval.endAt - day.interval.startAt)}px`}
          ondragover={acceptDrag} ondrop={event => onDrop(event, day.interval)}>
          {#each day.hours as hour (hour)}
            {@const hourText = clock.hourLabel(hour)}
            <div class="calendar-hour" style:--hour-top={`${height(hour - day.interval.startAt)}px`} aria-hidden="true">
              {day.repeatedHours.has(hourText) ? clock.label(hour) : hourText}
            </div>
          {/each}
          {#each day.timed as item (`${item.kind}:${item.value.publicId}`)}
            <div class="calendar-timed" class:calendar-external={item.kind === 'event'}
              class:calendar-event-muted={item.kind === 'event' && (item.value.availability === 'free' || item.value.availability === 'working_elsewhere')}
              style:--item-top={`${item.top}px`} style:--item-height={`${item.size}px`}
              style:--item-left={`${item.lane / item.laneCount * 100}%`} style:--item-width={`${100 / item.laneCount}%`}>
              {#if item.kind === 'block'}
                {@const block = item.value}
                {@const title = blockTitle(block)}
                {@const draggable = !disabled && !block.locked && !isHistorical(block) && block.startAt >= day.interval.startAt}
                <div class="calendar-item-content" role="group" aria-label={title} class:calendar-draggable={draggable} {draggable}
                  ondragstart={event => draggable ? onDrag(event, block, 'move') : event.preventDefault()} ondragend={onEndDrag}>
                  <div class="calendar-item-title">
                    {#if block.taskPublicId}
                      {@const id = block.taskPublicId}
                      <a href={taskHref(id)} draggable="false" onclick={event => onOpenTask(event, id)}>{title}</a>
                    {:else}
                      <strong>{title}</strong>
                    {/if}
                    {#if block.locked}<small>Locked</small>{/if}
                    {#if block.origin !== 'manual'}<small>Planned</small>{/if}
                  </div>
                  <small>{clock.label(block.startAt)}–{clock.label(block.endAt)}</small>
                </div>
                {#if !isHistorical(block)}
                  <button class="calendar-edit" type="button" disabled={disabled} aria-label={'Edit block: ' + title}
                    onclick={event => onEdit(block, event)}>Edit</button>
                  {#if draggable}
                    <span class="calendar-resize" role="img" aria-label={'Drag to resize ' + title} draggable="true"
                      ondragstart={event => onDrag(event, block, 'resize')} ondragend={onEndDrag}></span>
                  {/if}
                {/if}
              {:else}
                <div class="calendar-item-content">
                  <strong>{eventTitle(item.value)}</strong>
                  <small>{clock.label(item.value.startAt)}–{clock.label(item.value.endAt)} · {item.value.provider === 'outlook' ? 'Outlook' : item.value.provider}</small>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</div>
