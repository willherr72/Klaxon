# Proposed HTTP and MCP boundary

P0 contract sketch. Implement and version in P3 after P1 mutation tests. A reader may list its own tasks with bounded cursor pagination. A planner may submit an operation ID, reason and expected revision to update an authorized task. The server derives workspace and actor. Return a conflict with the current revision on a stale change. A matching replay returns the original result. A planner moving a locked block is denied.

HTTP and MCP adapters delegate to the same domain operations. Keep planner previews bounded, expiring and tied to calendar and lock revisions. Check atomic application and rollback when a later item fails. Validate hosted MCP authorization discovery and refresh on the actual client before promising Dot interoperability.
