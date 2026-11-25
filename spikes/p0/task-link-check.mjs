import assert from "node:assert/strict";

// Probe addressability before choosing a P1 router. The fixture still renders its task list.
export async function openTaskLink(page, entry, task) {
  const link = new URL(entry);
  link.hash = "/tasks/" + encodeURIComponent(task.id);
  await page.goto("about:blank");
  await page.goto(link.href);
  async function checkAddressedTask() {
    assert.equal(page.url(), link.href);
    const id = await page.evaluate(() => decodeURIComponent(location.hash.slice("#/tasks/".length)));
    assert.equal(id, task.id);
    assert.match(id, /^[0-9a-f-]{36}$/);
    const row = page.locator('[data-task-id="' + id + '"]');
    await row.waitFor();
    assert.equal(await row.locator("strong").textContent(), task.title);
  }
  await checkAddressedTask();
  await page.reload();
  await checkAddressedTask();
}
