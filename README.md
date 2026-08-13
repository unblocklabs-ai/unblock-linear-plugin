# Unblock Linear for OpenClaw

An OpenClaw channel plugin that connects an enrolled OpenClaw agent to the
Unblock Linear relay. Linear AgentSession work is delivered to OpenClaw, and
the agent receives one `linear` tool for bounded GraphQL requests and approved
media uploads.

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
openclaw plugins install @unblocklabs/unblock-linear
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

The plugin exposes one discriminated tool:

```ts
type LinearToolInput =
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

GraphQL requests are durably journaled and sent through the enrolled relay.
Uploads accept only OpenClaw-approved inbound media references, request a
Linear upload destination through GraphQL, validate the HTTPS destination, and
stream the bytes directly to Linear. The plugin does not read arbitrary local
paths, proxy general URLs, send file bytes through the WebSocket, or receive a
Linear access token.

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
npm run release -- 0.2.0
```

The release command:

1. Confirms the Git tag and npm version do not already exist.
2. Updates `package.json`, `package-lock.json`, and `openclaw.plugin.json` to the
   same version.
3. Runs the full preflight and restores those files if validation fails.
4. Commits `chore: release v0.2.0`, creates the tag, and atomically pushes both.
5. Creates the GitHub Release with generated notes.

Publishing then runs in GitHub Actions through npm trusted publishing. Stable
versions publish to npm's `latest` tag; prerelease versions such as
`0.2.0-beta.1` create a GitHub prerelease and publish to npm's `next` tag. The
workflow rejects a release when its Git tag, package version, and plugin
manifest version do not match.

If GitHub Release creation fails after the atomic push, finish that final step
without changing versions or tags:

```sh
gh release create v0.2.0 --verify-tag --generate-notes --title v0.2.0
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
