import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

test("activity supports replay-safe undo, checks the current revision, and scopes its private inverse", async () => {
  const t = convexTest({schema,modules:{
    "../convex/_generated/server.ts":()=>import("../convex/_generated/server"),
    "../convex/tasks.ts":()=>import("../convex/tasks"),
    "../convex/workspaces.ts":()=>import("../convex/workspaces"),
    "../convex/activity.ts":()=>import("../convex/activity"),
  }});
  const [a,b] = await t.run(async ({db}) => [await db.insert("users",{}),await db.insert("users",{})]);
  const alice = t.withIdentity({subject:a});
  const bob = t.withIdentity({subject:b});
  const {_id:workspaceId} = await alice.mutation(anyApi.workspaces.ensurePersonal,{});
  await t.run(({db}) => db.insert("tasks",{...taskRecord(workspaceId,"review"),title:"Private first title",status:"done"}));
  const change = (expectedRevision:number,title:string) => alice.mutation(anyApi.tasks.apply,{workspaceId,operationId:crypto.randomUUID(),
    command:{kind:"task.update",publicId:"review",expectedRevision,patch:{title,status:"ready"}}});
  const first = await change(1,"Review door");
  const options = {workspaceId,paginationOpts:{numItems:10,cursor:null}};
  const {page} = await alice.query(anyApi.activity.list,options);
  expect(page[0]).toMatchObject({action:"task.update",actor:"You",revision:2,undoEligible:true});
  expect(JSON.stringify(page)).not.toContain("Private first title");
  await expect(bob.query(anyApi.activity.list,options)).rejects.toThrow();
  const undo = {workspaceId,eventId:first.activityEventId,expectedRevision:2,operationId:crypto.randomUUID()};
  await expect(bob.mutation(anyApi.activity.undo,undo)).rejects.toThrow();
  const result = await alice.mutation(anyApi.activity.undo,undo);
  expect(await alice.mutation(anyApi.activity.undo,undo)).toEqual(result);
  const restored = await alice.query(anyApi.tasks.get,{workspaceId,publicId:"review"});
  expect(restored).toMatchObject({title:"Private first title",status:"done",revision:3});
  expect(restored.completedAt).toBeUndefined();
  const second = await change(3,"Later change");
  await change(4,"Keep this update");
  await expect(alice.mutation(anyApi.activity.undo,{...undo,eventId:second.activityEventId,expectedRevision:4,
    operationId:crypto.randomUUID()})).rejects.toThrow(/REVISION_CONFLICT/);
  expect((await alice.query(anyApi.tasks.get,{workspaceId,publicId:"review"})).title).toBe("Keep this update");
});
