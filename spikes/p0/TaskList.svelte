<script>
  let { tasks } = $props();
</script>

<ul aria-label="Synthetic tasks">
  {#each $tasks as task (task._id)}
    <li data-task-id={task._id}>{task.title}</li>
  {/each}
</ul>
