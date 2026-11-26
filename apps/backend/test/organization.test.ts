import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { recordVersion, taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

test("planner search spans planning text and linked IDs within the signed-in workspace", async () => {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
    "../convex/organization.ts": () => import("../convex/organization"),
  } });
  const owner = await t.run(({db}) => db.insert("users", {}));
  const other = await t.run(({db}) => db.insert("users", {}));
  const client = t.withIdentity({subject:owner});
  const { _id: workspaceId } = await client.mutation(anyApi.workspaces.ensurePersonal, {});
  const { _id: elsewhere } = await t.withIdentity({subject:other}).mutation(anyApi.workspaces.ensurePersonal, {});
  await t.run(async ({db}) => {
    const taskId = await db.insert("tasks", {...taskRecord(workspaceId,"quote"), title:"Paint quote", description:"Primer schedule"});
    await db.insert("dayNotes",{workspaceId,publicId:"note",localDate:"2026-12-01",body:"Primer arrives today",...recordVersion});
    await db.insert("externalLinks",{workspaceId,taskId,publicId:"issue",provider:"linear",relationship:"reference",
      externalObjectId:"DEV-217",...recordVersion});
    await db.insert("tasks",{...taskRecord(elsewhere,"secret"),title:"Primer private"});
  });
  const search = (text: string) => client.query(anyApi.organization.search,{workspaceId,text});
  expect((await search("paint")).tasks).toMatchObject([{publicId:"quote"}]);
  expect(await search("primer")).toMatchObject({ tasks:[{publicId:"quote"}], notes:[{localDate:"2026-12-01"}] });
  expect((await search("DEV-217")).tasks).toMatchObject([{publicId:"quote"}]);
  await expect(client.query(anyApi.organization.search,{workspaceId:elsewhere,text:"primer"})).rejects.toThrow();
  await expect(search(" ")).rejects.toThrow(/INVALID_ARGUMENT/);

  const [projectId, unrelated] = await t.run(async ({db}) => [
    await db.insert("projects",{workspaceId,publicId:"work",name:"Work",rank:1,...recordVersion}),
    await db.insert("projects",{workspaceId:elsewhere,publicId:"work",name:"Elsewhere",rank:1,...recordVersion}),
  ]);
  const args = {workspaceId,projectId,operationId:crypto.randomUUID(),publicId:"sizing",name:"Sizing"};
  const saved = await client.mutation(anyApi.organization.createLane,args);
  expect(await client.mutation(anyApi.organization.createLane,args)).toEqual(saved);
  expect(await client.query(anyApi.organization.lanes,{workspaceId,projectId})).toMatchObject({lanes:[{publicId:"sizing",rank:0}],partial:false});
  await expect(client.mutation(anyApi.organization.createLane,{...args,projectId:unrelated})).rejects.toThrow(/NOT_FOUND/);
});
