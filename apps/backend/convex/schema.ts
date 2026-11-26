import { defineSchema } from "convex/server";
import { integrationTables } from "./model/integrations";
import { ledgerTables } from "./model/ledger";
import { planningTables } from "./model/planning";
import { workTables } from "./model/work";

// Public ID uniqueness and same-workspace references are enforced by domain
// transactions. Convex indexes provide lookup paths without enforcing uniqueness.
export default defineSchema({
  ...workTables,
  ...planningTables,
  ...integrationTables,
  ...ledgerTables,
});
