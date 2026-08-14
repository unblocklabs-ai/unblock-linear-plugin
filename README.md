# Unblock Linear for OpenClaw

An OpenClaw channel plugin that connects an enrolled OpenClaw agent to the
Unblock Linear relay. Linear AgentSession work is delivered to OpenClaw, and
the agent receives one `linear` tool for common issue workflows, bounded
GraphQL requests, and approved media uploads.

## Requirements

- OpenClaw **2026.7.2-beta.7 or newer**
- Node.js 22 or newer
- An enrolled P-256 agent key and its private JWK stored through an OpenClaw
  `SecretRef`
- An active Unblock Linear private app provisioned through the Worker setup CLI

The production relay is:

```text
https://linear.unblocklabs.ai
```

## Install from this repository

This repository is public. On the OpenClaw host:

```sh
git clone https://github.com/unblocklabs-ai/unblock-linear-plugin.git
cd unblock-linear-plugin
npm install
npm run build
openclaw plugins install --link "$PWD"
openclaw plugins enable unblock-linear
```

Verify discovery:

```sh
openclaw plugins list --enabled
openclaw plugins inspect unblock-linear
openclaw doctor
```

For a published package, install the matching package version instead:

```sh
openclaw plugins install npm:@unblocklabs/unblock-linear
openclaw plugins enable unblock-linear
```

Do not install both forms at the same time. The linked checkout is the
development path; the package install is the release path.

## Configure an enrolled agent

Add the channel configuration to the OpenClaw configuration under
`channels.unblock-linear`:

```json
{
  "channels": {
    "unblock-linear": {
      "enabled": true,
      "accountId": "default",
      "origin": "https://linear.unblocklabs.ai",
      "agentId": "agt_your_agent_id",
      "enrollmentGeneration": 1,
      "devicePrivateKey": {
        "source": "env",
        "provider": "default",
        "id": "UNBLOCK_LINEAR_DEVICE_PRIVATE_JWK"
      }
    }
  }
}
```

The `agentId` is the Worker relay identity. It does **not** select which
OpenClaw agent handles work; use normal OpenClaw channel bindings for agent
routing.

The private JWK must be available to the configured SecretRef provider. For an
environment-backed SecretRef, set the variable in the OpenClaw gateway's
environment—not only in an interactive shell:

```sh
export UNBLOCK_LINEAR_DEVICE_PRIVATE_JWK='{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}'
```

Never put the private JWK directly in committed JSON, send it to the Worker, or
paste it into support messages. The Worker setup CLI sends only the public JWK
to the Worker.

Restart the OpenClaw gateway after changing the plugin configuration. The
plugin opens one authenticated WebSocket connection and resumes persisted work
after reconnects.

### Allow cross-channel session history

Linear AgentSessions are stored as separate OpenClaw sessions. To let the same
agent find and read those sessions from Slack or another channel, configure
session-tool visibility at `agent` scope or broader:

```json
{
  "tools": {
    "sessions": {
      "visibility": "agent"
    }
  }
}
```

OpenClaw's default `tree` scope includes only the current session and sessions
it spawned, so it hides independently created Linear sibling sessions. The
`agent` scope exposes every session owned by the same OpenClaw agent, including
other Slack channels or DMs; enable it only when those conversations share an
appropriate trust boundary. This setting is required for cross-channel history,
not for ordinary Linear delivery or use of the `linear` tool.

## Provision a new Linear app

From the Worker repository, load the deployment's admin token into the
environment and run the interactive setup command:

```sh
read -s ADMIN_API_TOKEN
export ADMIN_API_TOKEN
npm run setup:agent -- create
```

The CLI generates the agent enrollment key locally, creates a pending
reservation, opens Linear's prefilled private-app form, and asks for the app's
client ID, client secret, and webhook signing secret. It sends those credentials
directly to the Worker, which validates the app identity, workspace, scopes, and
Agent Sessions support before activation.

The completed command prints `origin`, `agentId`, `enrollmentGeneration`, and
`privateKeyFile`. Move the private-key file into an OpenClaw-approved
secret store, create the corresponding `SecretRef`, and configure the channel
with those printed values.

Interrupted setup is resumable, and its local state can be inspected without an
API call:

```sh
npm run setup:agent -- resume
npm run setup:agent -- status
```

See the Worker repository's
[`quickstart.md`](https://github.com/unblocklabs-ai/unblocked-linear-worker/blob/main/quickstart.md)
for environment selection, scripted non-secret inputs, and concurrent setup
state. Do not put the admin token or Linear app credentials in this plugin
configuration.

## Replace a revoked Linear app

An `installation.revoked` control is terminal for that enrollment. Provision a
replacement from the Worker repository with the existing Worker `agentId`:

```sh
npm run setup:agent -- replace \
  --agent-id agt_your_existing_agent_id
```

Replacement does not disable an otherwise-active old installation and
enrollment until the new private-app credentials and strictly newer generation
are verified; an already-revoked installation remains offline. After setup
succeeds, update the plugin configuration and private-key `SecretRef` from the
new enrollment bundle, then restart OpenClaw. Only the updated enrollment can
clear the plugin's persisted replacement/revocation fence: it must use the same
`agentId`, a strictly newer generation, and successfully authenticate. You may
then delete the old private app in Linear.

## The `linear` tool

The plugin exposes one discriminated tool. Prefer its typed actions for common
workflows:

```ts
type LinearToolInput =
  | {
      action: "issues.list";
      first?: number;
      after?: string;
      teamId?: string;
      stateId?: string;
      assigneeId?: string;
      includeArchived?: boolean;
    }
  | {
      action: "issues.search";
      query: string;
      first?: number;
      after?: string;
      teamId?: string;
      includeArchived?: boolean;
    }
  | { action: "issues.get"; id: string }
  | {
      action: "issues.create";
      teamId: string;
      title: string;
      description?: string;
      stateId?: string;
      assigneeId?: string;
      priority?: number;
    }
  | {
      action: "issues.update";
      id: string;
      title?: string;
      description?: string | null;
      stateId?: string;
      assigneeId?: string | null;
      priority?: number;
    }
  | { action: "comments.create"; issueId: string; body: string }
  | {
      action: "teams.list";
      first?: number;
      after?: string;
      includeArchived?: boolean;
    }
  | {
      action: "states.list";
      teamId: string;
      first?: number;
      after?: string;
    }
  | {
      action: "graphql";
      document: string;
      variables?: Record<string, JsonValue>;
      operationName?: string;
    }
  | {
      action: "upload";
      fileRef: string;
      filename?: string;
      contentType?: string;
    };
```

For example:

```json
{ "action": "issues.list", "first": 10 }
{ "action": "issues.search", "query": "onboarding", "first": 10 }
{ "action": "issues.get", "id": "ENG-123" }
{ "action": "teams.list", "first": 20 }
{ "action": "states.list", "teamId": "10000000-0000-4000-8000-000000000001", "first": 20 }
{ "action": "issues.create", "teamId": "10000000-0000-4000-8000-000000000001", "title": "Document agent onboarding" }
{ "action": "issues.update", "id": "ENG-123", "stateId": "10000000-0000-4000-8000-000000000002" }
{ "action": "comments.create", "issueId": "ENG-123", "body": "The setup is complete." }
```

Replace the illustrative UUIDs with IDs returned by your workspace.
Use Linear UUIDs rather than names for teams, workflow states, and assignees.
Issue reads, updates, and comments also accept a human-readable issue identifier
such as `ENG-123`. List teams and workflow states first when a UUID is unknown,
and follow `pageInfo.endCursor` with `after` only while
`pageInfo.hasNextPage` is true. No action auto-paginates.

`issues.search` uses Linear's ranked full-text/vector search. Its `first` value
is a page-size maximum, not a promised node count, so pages may be sparse.
`totalCount` is the matching count before pagination. Never infer completion
from `nodes.length`; use `hasNextPage` and its `endCursor`. `teamId` filters the
matches to that team rather than changing their ranking. Search accepts at most
20 results per page and has a tighter Linear rate limit than ordinary issue
reads, so prefer a specific query and avoid polling it. Other list actions
accept at most 50 results per page.

When `issues.get` cannot see the requested issue, it returns a safe typed error
with `status: "error"` and `code: "not_found"`. This deliberately covers both a
missing issue and one inaccessible to the installation. Do not infer which case
occurred.

Use `action: "graphql"` only when the typed actions cannot express the needed
operation. Every typed action is compiled to a bounded GraphQL operation,
durably journaled, and sent through the same enrolled Worker relay. Credentials
remain at the Worker; typed actions do not add Linear credentials to the
plugin.

If an issue or comment creation returns `outcome_unknown`, the error message
and structured error result include the safe `entityType` and persisted
`entityId`. Fetch that UUID to reconcile the mutation before deciding whether
another mutation is needed. Never blindly repeat an ambiguous create.

Typed actions return safe failures as structured results rather than failed
tool calls. Treat a typed result with `status: "error"` as a failure, inspect
its `code`, and follow any `entityId`. This keeps typed-action parameters out of
the host adapter's failed-tool parameter-logging path. This behavior applies
only to the typed actions above—not raw `graphql` or `upload`—and is not a claim
that OpenClaw omits parameters from every log surface.

OpenClaw's direct tool runtime returns these values as JSON text in `content`.
The same native value is retained in `details` for Code Mode and Tool Search.
The plugin does not return `structuredContent`.

Uploads accept only OpenClaw-approved inbound media references, request a
Linear upload destination through GraphQL, validate the HTTPS destination, and
stream the bytes directly to Linear. The plugin does not read arbitrary local
paths, proxy general URLs, send file bytes through the WebSocket, or receive a
Linear access token.

The package also includes an `unblock-linear` skill with workflows for recent
issues, issue creation, mutation reconciliation, uploads, and cross-channel
Linear session lookup. Verify that OpenClaw discovered it after installation:

```sh
openclaw skills info unblock-linear
```

## Troubleshooting

```sh
openclaw plugins inspect unblock-linear
openclaw doctor
```

Common configuration failures are reported without secret values:

- `origin`: use the exact production or staging Worker origin.
- `agentId`: use the value from operator provisioning.
- `enrollmentGeneration`: use the current enrolled generation.
- `devicePrivateKey`: use a valid OpenClaw SecretRef whose provider is
  configured on the gateway.

## Development

```sh
npm install
npm run preflight
```

The preflight runs type checks, focused tests, build, static/runtime plugin
inspection, and an npm pack dry run.

## Release

Releases require a clean `main` branch that exactly matches `origin/main`, an
authenticated GitHub CLI, and permission to push to this repository:

```sh
npm run release -- 0.3.0
```

The release command:

1. Confirms the Git tag and npm version do not already exist.
2. Updates `package.json`, `package-lock.json`, and `openclaw.plugin.json` to the
   same version.
3. Runs the full preflight and restores those files if validation fails.
4. Commits `chore: release v0.3.0`, creates the tag, and atomically pushes both.
5. Creates the GitHub Release with generated notes.

Publishing then runs in GitHub Actions through npm trusted publishing. Stable
versions publish to npm's `latest` tag; prerelease versions such as
`0.3.0-beta.1` create a GitHub prerelease and publish to npm's `next` tag. The
workflow rejects a release when its Git tag, package version, and plugin
manifest version do not match.

If GitHub Release creation fails after the atomic push, finish that final step
without changing versions or tags:

```sh
gh release create v0.3.0 --verify-tag --generate-notes --title v0.3.0
```

## Security boundary

- The Worker stores the Linear private-app client and webhook credentials
  encrypted with its control-plane key and mints short-lived access tokens as
  needed.
- OpenClaw stores the private enrollment key through its SecretRef system.
- The plugin never receives a Linear client credential, webhook signing secret,
  or access token.
- The Worker verifies signed WebSocket upgrades and enrollment
  generations.
- Local-file access for uploads remains subject to OpenClaw host approval.
- Do not commit `.prod.secrets`, private JWKs, Linear client secrets, webhook
  secrets, or admin tokens.

## License

MIT
