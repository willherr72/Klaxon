<script lang="ts">
  import { untrack } from 'svelte';
  import type { Preferences, PreferenceValues, WorkWindow } from './calendar-contract';

  let { base, disabled, cancelDisabled, onSubmit, onCancel }: {
    base: Preferences; disabled: boolean; cancelDisabled: boolean;
    onSubmit: (values: PreferenceValues, revision: number) => void; onCancel: () => void;
  } = $props();

  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const lists = [{ key: 'workHours', plural: 'Work hours', label: 'Work window' }, { key: 'breaks', plural: 'Breaks', label: 'Break' }] as const;
  let nextId = 0;
  type WindowDraft = { id: number; weekday: number; start: string; end: string };
  const initial = untrack(() => base);
  let timezone = $state(initial.timezone);
  let bufferMinutes = $state<number | undefined>(initial.bufferMinutes);
  let discretionaryMinutes = $state<number | undefined>(initial.discretionaryMinutes);
  let lockManuallyMovedBlocks = $state(initial.lockManuallyMovedBlocks);
  let windows = $state({ workHours: initial.workHours.map(windowDraft), breaks: initial.breaks.map(windowDraft) });
  let validation = $state('');

  function asTime(minutes: number) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function windowDraft(window: WorkWindow): WindowDraft {
    return { id: nextId++, weekday: window.weekday, start: asTime(window.startMinute), end: asTime(window.endMinute) };
  }

  function asMinute(time: string) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return time === '24:00' ? 1440 : NaN;
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  }

  function readWindows(rows: WindowDraft[], label: string) {
    const values = rows.map(({ weekday, start, end }) => ({ weekday, startMinute: asMinute(start), endMinute: asMinute(end) }));
    if (values.some(({ startMinute, endMinute }) => !(startMinute < endMinute))) {
      throw new Error(`${label} need an end after their start. Enter times as HH:MM, with 24:00 for midnight at the end of a day.`);
    }
    values.sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
    if (values.some((value, index) => index > 0 && value.weekday === values[index - 1].weekday && value.startMinute < values[index - 1].endMinute)) {
      throw new Error(`${label} on the same day cannot overlap.`);
    }
    return values;
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (disabled) return;
    validation = '';
    const requestedZone = timezone.trim();
    try {
      if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(requestedZone)) throw new RangeError();
      new Intl.DateTimeFormat('en', { timeZone: requestedZone });
    } catch {
      validation = 'Enter an IANA time zone such as America/Chicago or UTC.';
      return;
    }
    if (bufferMinutes === undefined || discretionaryMinutes === undefined) return;
    try {
      onSubmit({ timezone: requestedZone, workHours: readWindows(windows.workHours, 'Work hours'),
        breaks: readWindows(windows.breaks, 'Breaks'), bufferMinutes, discretionaryMinutes, lockManuallyMovedBlocks }, initial.revision);
    } catch (error) {
      if (error instanceof Error) validation = error.message;
    }
  }
</script>

<form class="calendar-editor" aria-label="Scheduling preferences" onsubmit={submit}>
  <h3>Scheduling preferences</h3>
  <fieldset class="calendar-fields" {disabled}>
    <label>Time zone <input type="text" maxlength="100" placeholder="America/Chicago" required bind:value={timezone} /></label>
    <label>Buffer (minutes) <input type="number" min="0" max="1440" step="1" required bind:value={bufferMinutes} /></label>
    <label>Discretionary time (minutes) <input type="number" min="0" max="1440" step="1" required bind:value={discretionaryMinutes} /></label>
    <label class="calendar-check"><input type="checkbox" bind:checked={lockManuallyMovedBlocks} /> Lock manually moved blocks</label>
  </fieldset>
  <p class="calendar-muted">Enter weekly times in 24-hour format. Use 24:00 for the end of a day.</p>
  <div class="calendar-preference-lists">
    {#each lists as list (list.key)}
      <fieldset class="calendar-window-list" {disabled}>
        <legend>{list.plural}</legend>
        {#each windows[list.key] as row, index (row.id)}
          <fieldset class="calendar-fields">
            <legend>{list.label} {index + 1}</legend>
            <label>Day <select bind:value={row.weekday}>
              {#each weekdays as day, value (day)}<option {value}>{day}</option>{/each}
            </select></label>
            <label>Start <input type="text" inputmode="text" placeholder="09:00" maxlength="5" required bind:value={row.start} /></label>
            <label>End <input type="text" inputmode="text" placeholder="17:00" maxlength="5" required bind:value={row.end} /></label>
            <button type="button" aria-label={'Remove ' + list.label.toLowerCase() + ' ' + (index + 1)}
              onclick={() => windows[list.key].splice(index, 1)}>Remove</button>
          </fieldset>
        {/each}
        <button type="button" disabled={windows[list.key].length >= 56}
          onclick={() => windows[list.key].push(windowDraft({ weekday: 0, startMinute: 720, endMinute: 750 }))}>Add {list.label.toLowerCase()}</button>
      </fieldset>
    {/each}
  </div>
  {#if validation}<p role="alert" class="calendar-error">{validation}</p>{/if}
  <div class="calendar-actions">
    <button type="submit" class="calendar-primary" {disabled}>Save preferences</button>
    <button type="button" disabled={cancelDisabled} onclick={onCancel}>Cancel</button>
  </div>
</form>
