const prefix = "klaxon.p0.fixture.v1.";

// One key per synthetic task. A failed write leaves the previous row intact.
export function readFixture() {
  const tasks = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const task = JSON.parse(localStorage.getItem(key));
    if (task?._id !== key.slice(prefix.length) || typeof task.title !== "string" ||
        typeof task.savedAt !== "string") throw new Error("Invalid fixture row");
    tasks.push(task);
  }
  return tasks.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a._id.localeCompare(b._id));
}

export function saveFixture(id, title) {
  const key = prefix + id;
  localStorage.setItem(key, JSON.stringify({ _id: id, title, savedAt: new Date().toISOString() }));
}
