# Klaxon agent API

Send UTF-8 JSON to the deployment's HTTPS Convex HTTP Actions origin using
`POST`, `Content-Type: application/json`, and
`Authorization: Bearer <agent-token>`. Keep the token in the authorization header
and use the JSON body for parameters. Task routes reject query parameters. The
request body limit is 32 KiB, including JSON encoding and field names.

Every body includes `workspacePublicId`. The credential binds the caller to one
workspace and its current membership. Reads require `tasks:read` and writes require
`tasks:write`. Authorized credentials have 60 requests per minute. A request
accepted for an operation counts toward its quota even if the operation returns a
conflict.

| Route | Additional request fields | Successful response |
| --- | --- | --- |
| `/api/v1/tasks/list` | `filter`, optional `limit` and `cursor` | `{ "items": [...], "nextCursor": string or null }` |
| `/api/v1/tasks/get` | `publicId` | A task object |
| `/api/v1/tasks/create` | `publicId`, `operationId`, `reason`, `task` | A write receipt |
| `/api/v1/tasks/update` | `publicId`, `operationId`, `reason`, `expectedRevision`, `patch` | A write receipt |

Success returns HTTP 200. A write receipt has `workspacePublicId`, `publicId`,
`revision`, and `activityEventPublicId`. Read responses include task fields,
current revision and timestamps, with public IDs for project and lane references.

## List and pagination

Supply one filter object.

| `kind` | Additional filter fields |
| --- | --- |
| `status` | `status` |
| `planned` or `deadlineDate` | `from` and `until` as `YYYY-MM-DD` dates |
| `deadlineInstant` | `from` and `until` as UTC epoch milliseconds |
| `project` | `projectPublicId` |

Date and time windows include `from` and exclude `until`. Status filters accept
`inbox`, `ready`, `in_progress`, `waiting`, `done`, and `archived`. The page
size defaults to 25 and accepts integers from 1 through 50. Omit `cursor` on the
first page. Pass the returned `nextCursor` unchanged with the same workspace and
filter until it is `null`.

## Create, update and retry

Choose a task public ID for create and a UUID as `operationId` for each distinct
write. Include a reason of up to 512 characters. For an update, use the current
task revision as `expectedRevision`. A revision conflict returns the current
revision. Repeating an identical write with the same operation ID returns its
recorded receipt while the actor still has access. A changed request with that
operation ID returns `OPERATION_ID_CONFLICT`.

Create requires `task.title`. Create and update accept `title`, `description`,
`status`, `priority`, `plannedDate`, `deadline`, `estimateMinutes`, `tags`,
`waitingReason`, `waitingPerson`, `followUpDate`, `projectPublicId` and
`lanePublicId`. Updates change only fields present in `patch`. Use `null` to
clear a value other than `title`, `status`, or `priority`.

Write statuses are `inbox`, `ready`, `in_progress`, `waiting`, and `done`.
Priorities are `none`, `low`, `normal`, `high` and `urgent`. A deadline is
`{ "kind": "date", "date": "2026-12-01" }` or an object with
`"kind": "instant"`, an `at` value in UTC epoch milliseconds and an optional
IANA `timezone`. `tags` is an array of strings.

## Errors

Versioned JSON handlers return `{ "error": { "code": "..." } }`. Only a revision conflict
includes `error.currentRevision`. Versioned JSON responses use `Cache-Control: no-store`.

| HTTP status | Error code |
| --- | --- |
| 400 | `INVALID_ARGUMENT` |
| 401 | `AGENT_UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `ALREADY_EXISTS`, `INVALID_STATE`, `OPERATION_ID_CONFLICT`, `REVISION_CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `AGENT_RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

## Planning context

`POST /api/v1/planning/context` requires `planning:read` and a body containing
`workspacePublicId`, a `date` in `YYYY-MM-DD` format and an IANA `timezone`.
The result includes local-day bounds, task and step candidates, schedule blocks
and their lock state, visible meetings, due reminders, preferences and the day
plan. A section's `partial` flag indicates that its bounded result omitted
records.

The result gives the inclusive `startAt` and exclusive `endAt` in UTC
milliseconds and the read time as `asOf`. The `tasks`, `blocks`, `meetings`
and `reminders` sections each have `items` and `partial`. Tasks include up to
20 distinct candidates from four indexed groups in order of priority for the
snapshot: due or overdue deadlines, tasks planned for the day, due waiting
follow-ups, then unplanned active work. Each task includes up to eight ordered
steps and its own step `partial` flag. Schedule sections show at most 40 records
each. Reminders include pending and snoozed triggers inside the requested day.

`dayPlan` is `null` when the day has no saved plan. An existing plan includes
its revision, up to 20 focus task public IDs, and `focusPartial`. A block's
`planOwned` field indicates it belongs to this day plan. The plan's
`needsReplan` is `null` if the calendar read reached its internal scan bound
before meeting conflicts could be checked. Meetings follow the credential
owner's calendar access and busy-only settings. They include `lastSeenAt`
and `connectionState` to help callers assess freshness.

MCP exposes the same snapshot as `get_planning_context` with `date` and
`timezone`. The service resolves the workspace from the bearer.

## MCP and optional OAuth

The stateless MCP endpoint is `/mcp`. Use the agent bearer credential in the
Authorization header. Available tools reflect the caller's current scopes.

Operators configure the OAuth resource and map the external identity to an
owner-issued credential using these Convex deployment settings.

| Variable | Value |
| --- | --- |
| `KLAXON_OAUTH_ISSUER` | Exact HTTPS issuer identifier, including any path or trailing slash in the token's `iss` |
| `KLAXON_OAUTH_JWKS_URL` | Pinned HTTPS URL for that issuer's signing keys |
| `KLAXON_OAUTH_RESOURCE` | Canonical HTTPS MCP endpoint URL ending in `/mcp`, used as the token audience |
| `KLAXON_OAUTH_BINDINGS` | JSON array mapping external principals to workspace credentials (up to 64 unique pairs) |

In Settings, the workspace owner creates a credential with the required scopes
and expiry, then opens **OAuth setup identifiers**. The operator uses the two
public IDs to configure a mapping of this form.

```json
[{"workspacePublicId":"<workspace-public-id>","credentialPublicId":"<credential-public-id>","issuer":"https://issuer.example","subject":"<issuer-subject>","clientId":"<registered-client-id>"}]
```

The owner reviews the exact issuer, subject and client ID in Settings and
confirms the binding. A changed identity requires fresh confirmation. Revoking
the grant or removing the mapping denies the next OAuth call. The external
authorization server handles login, client registration, PKCE and token renewal.
Each authenticated MCP request consumes one unit of the same credential quota,
including discovery and calls rejected by tool validation.

With valid settings, unauthenticated MCP responses advertise
`/.well-known/oauth-protected-resource/mcp` in the bearer challenge. OAuth access
tokens must use RS256 with a matching key ID and `at+jwt` or
`application/at+jwt` type. Their issuer, audience, validity period, subject and
client ID are checked before the workspace binding is resolved. Token scopes
further restrict the binding's current permissions. REST routes continue to use
the opaque agent credential. [OAuth resource metadata](https://www.rfc-editor.org/rfc/rfc9728.html) · [JWT access-token profile](https://www.rfc-editor.org/rfc/rfc9068.html)
