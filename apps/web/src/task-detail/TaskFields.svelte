<script lang="ts">
  import { editableStatuses, taskStatuses, titleLimit } from '../contracts';
  import { priorities, type Project, type TaskDetail } from './detail-contract';
  import { estimateLimit, rankLimit, type TaskDraft } from './draft';

  let {
    task, draft = $bindable(), projects, projectError, projectsLoading, moreProjects, loadProjects,
    locked, discardDisabled, dirty, onSave, onReset,
  }: {
    task: TaskDetail;
    draft: TaskDraft;
    projects: Project[];
    projectError: string;
    projectsLoading: boolean;
    moreProjects: boolean;
    loadProjects: () => void;
    locked: boolean;
    discardDisabled: boolean;
    dirty: boolean;
    onSave: (event: SubmitEvent) => void;
    onReset: () => void;
  } = $props();
  const projectId = $props.id();
  const projectMissing = $derived(Boolean(draft.projectId && !projects.some(project => project._id === draft.projectId)));
  const usesExtendedYear = $derived(/^[-+]|^0000-/.test(draft.deadlineTime));
</script>

<form onsubmit={onSave}>
  <fieldset disabled={locked} aria-label="Task fields">
    <label>Title <input bind:value={draft.title} maxlength={titleLimit} required /></label>
    <label>Description / notes <textarea bind:value={draft.description} maxlength="32768" rows="4"></textarea></label>
    <div class="task-detail-grid">
      <label>Status
        <select bind:value={draft.status}>
          {#if task.status === 'archived'}
            <option value={task.status}>{taskStatuses[task.status]}</option>
          {:else}
            {#each editableStatuses as status (status)}
              <option value={status}>{taskStatuses[status]}</option>
            {/each}
          {/if}
        </select>
      </label>
      <label>Priority
        <select bind:value={draft.priority}>
          {#each Object.entries(priorities) as [priority, label] (priority)}
            <option value={priority}>{label}</option>
          {/each}
        </select>
      </label>
      <label>Rank
        <input type="number" step="any" min={-rankLimit} max={rankLimit} required
          value={draft.rank} oninput={event => { draft.rank = event.currentTarget.value; }} />
      </label>
      <label>Estimate (minutes)
        <input type="number" min="0" max={estimateLimit} step="1"
          value={draft.estimateMinutes} oninput={event => { draft.estimateMinutes = event.currentTarget.value; }} />
      </label>
      <label>Planned date <input type="date" bind:value={draft.plannedDate} /></label>
      <label>Deadline type
        <select bind:value={draft.deadlineType}>
          <option value="none">No deadline</option>
          <option value="date">Date only</option>
          <option value="instant">Specific date and time</option>
        </select>
      </label>
      {#if draft.deadlineType === 'date'}
        <label>Deadline date <input type="date" bind:value={draft.deadlineDate} required /></label>
      {:else if draft.deadlineType === 'instant'}
        <label>Deadline time (UTC)
          {#if usesExtendedYear}
            <input value={draft.deadlineTime} onchange={event => { draft.deadlineTime = event.currentTarget.value; }} required />
          {:else}
            <input type="datetime-local" step="0.001" bind:value={draft.deadlineTime} required />
          {/if}
        </label>
        <label>Deadline time zone (optional)
          <input bind:value={draft.deadlineTimezone} maxlength="128" placeholder="America/Chicago" />
        </label>
      {/if}
    </div>

    <div class="task-detail-project">
      <div class="task-detail-project-field">
        <label for={projectId}>Project</label>
        <select id={projectId} bind:value={draft.projectId} disabled={Boolean(projectError) || projectsLoading}>
          <option value="">No project</option>
          {#if projectMissing}<option value={draft.projectId}>Current project</option>{/if}
          {#each projects as project (project._id)}
            {#if project.archivedAt === undefined || project._id === draft.projectId || project._id === task.projectId}
              <option value={project._id} disabled={project.archivedAt !== undefined && project._id !== task.projectId}>
                {project.name}{project.archivedAt !== undefined ? ' (archived)' : ''}
              </option>
            {/if}
          {/each}
        </select>
      </div>
      {#if projectsLoading}<p role="status">Loading projects…</p>{/if}
      {#if projectError}<p role="alert">{projectError}</p>{/if}
      {#if projectError || moreProjects}
        <button type="button" onclick={loadProjects} disabled={projectsLoading}>
          {projectError ? 'Retry loading projects' : 'Load more projects'}
        </button>
      {/if}
      {#if task.laneId && draft.projectId !== (task.projectId ?? '')}
        <p>Changing the project clears this task’s current lane.</p>
      {/if}
    </div>

    <details open={draft.status === 'waiting'}>
      <summary>Waiting details</summary>
      <div class="task-detail-grid">
        <label>Waiting for <input bind:value={draft.waitingPerson} maxlength="512" /></label>
        <label>Follow-up date <input type="date" bind:value={draft.followUpDate} /></label>
      </div>
      <label>Waiting reason <textarea bind:value={draft.waitingReason} maxlength="2048" rows="2"></textarea></label>
    </details>
  </fieldset>
  <div class="task-detail-actions">
    <button class="task-detail-primary" disabled={locked || !dirty}>Save task</button>
    {#if dirty}<button type="button" onclick={onReset} disabled={discardDisabled}>Discard task edits</button>{/if}
  </div>
</form>
