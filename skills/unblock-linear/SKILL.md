---
name: unblock-linear
description: Work with Linear through the Unblock Linear OpenClaw plugin. Use when listing, searching, creating, or updating Linear issues; adding comments; uploading attachments; handling Linear AgentSession work; or finding a Linear-originated OpenClaw session from Slack or another channel.
---

# Unblock Linear

Use the `linear` tool for Linear workspace data. Use OpenClaw's `sessions_*`
tools for OpenClaw conversation history; Linear GraphQL does not expose the
local OpenClaw transcript.

## Linear workflow

1. Read before writing. Resolve team, project, issue, and user IDs instead of
   guessing them.
2. Prefer a typed action. Use `action: "graphql"` only when no typed action can
   express the request, and then keep the request to one bounded operation.
3. For lists, set a small `first` value. Follow `pageInfo.endCursor` with
   `after` only while `pageInfo.hasNextPage` is true. No action auto-paginates;
   never infer completion from `nodes.length`.
4. Use explicit Linear IDs or issue identifiers where the action accepts them;
   never pass a team, state, assignee, or issue name as an ID.
5. Treat a typed result with `status: "error"` as a failure and inspect its
   `code`. On `outcome_unknown`, fetch its top-level `entityId` to reconcile the
   `entityType` before deciding whether another mutation is needed. Never
   blindly repeat an ambiguous create.
6. Treat Linear authorization errors as permission or installation scope
   failures; do not attempt to bypass them.

### Recent issues

```json
{ "action": "issues.list", "first": 10 }
```

Add `teamId`, `stateId`, or `assigneeId` only when the user supplies or approves
the constraint. Use `includeArchived: true` only when archived issues matter.

For text search:

```json
{ "action": "issues.search", "query": "onboarding", "first": 10 }
```

Search uses Linear's ranked full-text/vector retrieval. `first` is a maximum,
not a promised node count, so a page may be sparse. `totalCount` counts matches
before pagination. Continue with `after: pageInfo.endCursor` only when
`pageInfo.hasNextPage` is true. Search does not auto-paginate and is more tightly
rate-limited than ordinary issue reads, so use a specific query and do not poll
or repeatedly broaden searches. An optional `teamId` filters matches to that
team; it is not a ranking hint.

Fetch a known issue with:

```json
{ "action": "issues.get", "id": "ENG-123" }
```

A missing or inaccessible issue returns `status: "error"` with
`code: "not_found"`. Treat those cases identically; do not claim the issue does
not exist or that the installation lacks access.

### Resolve IDs

```json
{ "action": "teams.list", "first": 20 }
{ "action": "states.list", "teamId": "10000000-0000-4000-8000-000000000001", "first": 20 }
```

Replace illustrative UUIDs in examples with IDs returned by the workspace. Use
the returned `pageInfo` for bounded pagination. Ordinary list pages accept at
most 50 results; search pages accept at most 20. Resolve other required IDs with
an appropriate typed read or a narrow GraphQL query before mutating.

### Create an issue

Resolve the target team first, then use its Linear ID:

```json
{
  "action": "issues.create",
  "teamId": "10000000-0000-4000-8000-000000000001",
  "title": "Document agent onboarding",
  "description": "Add the operator quickstart."
}
```

Do not invent missing content or IDs. A create uses a stable entity UUID so an
ambiguous result can be reconciled safely. On `outcome_unknown`, call
`issues.get` with the error result's `entityId` before considering another
create.

### Update an issue or add a comment

```json
{ "action": "issues.update", "id": "ENG-123", "stateId": "10000000-0000-4000-8000-000000000002" }
{ "action": "comments.create", "issueId": "ENG-123", "body": "The setup is complete." }
```

Include at least one changed field in `issues.update`. Read the issue first when
the requested change depends on its current state. A comment create also uses a
stable UUID; on `outcome_unknown`, query the error result's `entityId` with a
narrow GraphQL read before considering another comment.

Typed actions return safe failures as structured results. Raw `graphql` and
`upload` do not share this result contract, so do not expect `status`, `code`,
`entityType`, or `entityId` from those escape hatches.

For direct OpenClaw tool calls, read the result as JSON text from `content`.
Code Mode and Tool Search can use the same native value from `details`. Do not
expect `structuredContent`.

## Advanced GraphQL

Use `action: "graphql"` only for a Linear operation not covered by typed
actions. Keep it bounded, use variables rather than interpolating user text,
and request only the fields needed for the task. Typed and raw operations both
go through the Worker relay; the plugin never receives Linear credentials.

## Cross-channel Linear session history

Each Linear AgentSession is stored as its own OpenClaw session. A Slack session
does not automatically share its transcript.

1. Use `sessions_list` to find recent sessions for the current agent.
2. Select only session keys containing `:unblock-linear:`.
3. Use `sessions_history` with that exact key to read the sanitized transcript.
4. Do not read unrelated Slack, DM, or channel sessions merely because they are
   visible.

Cross-channel lookup requires:

```json
{
  "tools": {
    "sessions": {
      "visibility": "agent"
    }
  }
}
```

OpenClaw defaults to `tree`, which hides independently created Linear sibling
sessions. If lookup fails under `tree`, explain the requirement to the operator;
never change OpenClaw configuration without permission. `agent` visibility also
exposes other sessions owned by the same agent, so use it only where those
conversations share an appropriate trust boundary.

## Uploads

Use `action: "upload"` only with an OpenClaw-managed
`media://inbound/<opaque-id>` reference. Never pass arbitrary filesystem paths
or URLs. Use the returned Linear asset URL in the appropriate GraphQL mutation.
