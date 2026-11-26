/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as agenda from "../agenda.js";
import type * as agentCredentials from "../agentCredentials.js";
import type * as agentHistory from "../agentHistory.js";
import type * as agentLifecycle from "../agentLifecycle.js";
import type * as agentPlanningContext from "../agentPlanningContext.js";
import type * as agentPlans from "../agentPlans.js";
import type * as agentReferences from "../agentReferences.js";
import type * as agentReminders from "../agentReminders.js";
import type * as agentTaskActions from "../agentTaskActions.js";
import type * as agentTasks from "../agentTasks.js";
import type * as auth from "../auth.js";
import type * as autonomy from "../autonomy.js";
import type * as backups from "../backups.js";
import type * as calendar from "../calendar.js";
import type * as captures from "../captures.js";
import type * as delivery from "../delivery.js";
import type * as deliveryTransport from "../deliveryTransport.js";
import type * as deliveryWorker from "../deliveryWorker.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as links from "../links.js";
import type * as model_access from "../model/access.js";
import type * as model_agentBindings from "../model/agentBindings.js";
import type * as model_agentCredentials from "../model/agentCredentials.js";
import type * as model_agentEndpoints from "../model/agentEndpoints.js";
import type * as model_agentHistory from "../model/agentHistory.js";
import type * as model_agentHttp from "../model/agentHttp.js";
import type * as model_agentLifecycle from "../model/agentLifecycle.js";
import type * as model_agentMcp from "../model/agentMcp.js";
import type * as model_agentOAuth from "../model/agentOAuth.js";
import type * as model_agentOperations from "../model/agentOperations.js";
import type * as model_agentOrdering from "../model/agentOrdering.js";
import type * as model_agentPagination from "../model/agentPagination.js";
import type * as model_agentPlanLifecycle from "../model/agentPlanLifecycle.js";
import type * as model_agentPlanningContext from "../model/agentPlanningContext.js";
import type * as model_agentPlans from "../model/agentPlans.js";
import type * as model_agentReferences from "../model/agentReferences.js";
import type * as model_agentReminders from "../model/agentReminders.js";
import type * as model_agentScopes from "../model/agentScopes.js";
import type * as model_agentTaskActions from "../model/agentTaskActions.js";
import type * as model_agentTaskPolicy from "../model/agentTaskPolicy.js";
import type * as model_agentTasks from "../model/agentTasks.js";
import type * as model_autonomy from "../model/autonomy.js";
import type * as model_autonomyValues from "../model/autonomyValues.js";
import type * as model_backupFormat from "../model/backupFormat.js";
import type * as model_backupStore from "../model/backupStore.js";
import type * as model_calendarOverlap from "../model/calendarOverlap.js";
import type * as model_calendarStore from "../model/calendarStore.js";
import type * as model_calendarTime from "../model/calendarTime.js";
import type * as model_captureStore from "../model/captureStore.js";
import type * as model_deliverySecrets from "../model/deliverySecrets.js";
import type * as model_deliveryStore from "../model/deliveryStore.js";
import type * as model_deliveryTransport from "../model/deliveryTransport.js";
import type * as model_integrations from "../model/integrations.js";
import type * as model_ledger from "../model/ledger.js";
import type * as model_legacyImportFormat from "../model/legacyImportFormat.js";
import type * as model_legacyImportStore from "../model/legacyImportStore.js";
import type * as model_operations from "../model/operations.js";
import type * as model_pagination from "../model/pagination.js";
import type * as model_planIntentValues from "../model/planIntentValues.js";
import type * as model_planPreview from "../model/planPreview.js";
import type * as model_planning from "../model/planning.js";
import type * as model_reads from "../model/reads.js";
import type * as model_referenceStore from "../model/referenceStore.js";
import type * as model_reminderRecurrence from "../model/reminderRecurrence.js";
import type * as model_reminderStore from "../model/reminderStore.js";
import type * as model_reminderWrites from "../model/reminderWrites.js";
import type * as model_scheduling from "../model/scheduling.js";
import type * as model_taskDomain from "../model/taskDomain.js";
import type * as model_taskDomainCommands from "../model/taskDomainCommands.js";
import type * as model_taskUndo from "../model/taskUndo.js";
import type * as model_values from "../model/values.js";
import type * as model_work from "../model/work.js";
import type * as organization from "../organization.js";
import type * as planning from "../planning.js";
import type * as projects from "../projects.js";
import type * as reminders from "../reminders.js";
import type * as steps from "../steps.js";
import type * as tasks from "../tasks.js";
import type * as users from "../users.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  agenda: typeof agenda;
  agentCredentials: typeof agentCredentials;
  agentHistory: typeof agentHistory;
  agentLifecycle: typeof agentLifecycle;
  agentPlanningContext: typeof agentPlanningContext;
  agentPlans: typeof agentPlans;
  agentReferences: typeof agentReferences;
  agentReminders: typeof agentReminders;
  agentTaskActions: typeof agentTaskActions;
  agentTasks: typeof agentTasks;
  auth: typeof auth;
  autonomy: typeof autonomy;
  backups: typeof backups;
  calendar: typeof calendar;
  captures: typeof captures;
  delivery: typeof delivery;
  deliveryTransport: typeof deliveryTransport;
  deliveryWorker: typeof deliveryWorker;
  health: typeof health;
  http: typeof http;
  imports: typeof imports;
  links: typeof links;
  "model/access": typeof model_access;
  "model/agentBindings": typeof model_agentBindings;
  "model/agentCredentials": typeof model_agentCredentials;
  "model/agentEndpoints": typeof model_agentEndpoints;
  "model/agentHistory": typeof model_agentHistory;
  "model/agentHttp": typeof model_agentHttp;
  "model/agentLifecycle": typeof model_agentLifecycle;
  "model/agentMcp": typeof model_agentMcp;
  "model/agentOAuth": typeof model_agentOAuth;
  "model/agentOperations": typeof model_agentOperations;
  "model/agentOrdering": typeof model_agentOrdering;
  "model/agentPagination": typeof model_agentPagination;
  "model/agentPlanLifecycle": typeof model_agentPlanLifecycle;
  "model/agentPlanningContext": typeof model_agentPlanningContext;
  "model/agentPlans": typeof model_agentPlans;
  "model/agentReferences": typeof model_agentReferences;
  "model/agentReminders": typeof model_agentReminders;
  "model/agentScopes": typeof model_agentScopes;
  "model/agentTaskActions": typeof model_agentTaskActions;
  "model/agentTaskPolicy": typeof model_agentTaskPolicy;
  "model/agentTasks": typeof model_agentTasks;
  "model/autonomy": typeof model_autonomy;
  "model/autonomyValues": typeof model_autonomyValues;
  "model/backupFormat": typeof model_backupFormat;
  "model/backupStore": typeof model_backupStore;
  "model/calendarOverlap": typeof model_calendarOverlap;
  "model/calendarStore": typeof model_calendarStore;
  "model/calendarTime": typeof model_calendarTime;
  "model/captureStore": typeof model_captureStore;
  "model/deliverySecrets": typeof model_deliverySecrets;
  "model/deliveryStore": typeof model_deliveryStore;
  "model/deliveryTransport": typeof model_deliveryTransport;
  "model/integrations": typeof model_integrations;
  "model/ledger": typeof model_ledger;
  "model/legacyImportFormat": typeof model_legacyImportFormat;
  "model/legacyImportStore": typeof model_legacyImportStore;
  "model/operations": typeof model_operations;
  "model/pagination": typeof model_pagination;
  "model/planIntentValues": typeof model_planIntentValues;
  "model/planPreview": typeof model_planPreview;
  "model/planning": typeof model_planning;
  "model/reads": typeof model_reads;
  "model/referenceStore": typeof model_referenceStore;
  "model/reminderRecurrence": typeof model_reminderRecurrence;
  "model/reminderStore": typeof model_reminderStore;
  "model/reminderWrites": typeof model_reminderWrites;
  "model/scheduling": typeof model_scheduling;
  "model/taskDomain": typeof model_taskDomain;
  "model/taskDomainCommands": typeof model_taskDomainCommands;
  "model/taskUndo": typeof model_taskUndo;
  "model/values": typeof model_values;
  "model/work": typeof model_work;
  organization: typeof organization;
  planning: typeof planning;
  projects: typeof projects;
  reminders: typeof reminders;
  steps: typeof steps;
  tasks: typeof tasks;
  users: typeof users;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  auth: import("@convex-dev/auth/_generated/component.js").ComponentApi<"auth">;
  authUsername: import("@convex-dev/auth/components/username/_generated/component.js").ComponentApi<"authUsername">;
  authPassword: import("@convex-dev/auth/components/password/_generated/component.js").ComponentApi<"authPassword">;
};
