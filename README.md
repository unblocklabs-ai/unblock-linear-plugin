# Unblock Linear for OpenClaw

An OpenClaw channel plugin that connects an enrolled OpenClaw device to the
Unblock Linear relay. Linear AgentSession work is delivered to OpenClaw, and
the agent receives one `linear` tool for bounded GraphQL requests and approved
media uploads.

## Requirements

- OpenClaw **2026.7.2-beta.7 or newer**
- Node.js 22 or newer
- An enrolled P-256 device and its private JWK stored through an OpenClaw
  `SecretRef`
- A completed Unblock Linear installation and OAuth authorization

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

## Configure an enrolled device

Add the channel configuration to the OpenClaw configuration under
`channels.unblock-linear`:

```json
{
  "channels": {
    "unblock-linear": {
      "enabled": true,
      "accountId": "default",
      "origin": "https://linear.unblocklabs.ai",
      "agentId": "bill-01",
      "deviceId": "bill-device-prod-3",
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
paste it into support messages. The Worker needs only the public JWK during
operator provisioning.

Restart the OpenClaw gateway after changing the plugin configuration. The
plugin opens one authenticated WebSocket connection and resumes persisted work
after reconnects.

## Provisioning order for a new Linear app

An operator must provision each app before the device can connect:

1. Call `POST /v1/admin/agents/reservations` on the production Worker.
2. Use the returned unique `webhookUrl` when creating the Linear OAuth app.
3. Use the fixed callback:
   `https://linear.unblocklabs.ai/v1/linear/oauth/callback`.
4. Call the reservation's `/complete` endpoint with the Linear client secret,
   webhook signing secret, and scopes.
5. Open the returned `oauthStartUrl` and complete OAuth.
6. Configure OpenClaw with the enrolled device values above.

See the Worker repository's
[`quickstart.md`](https://github.com/unblocklabs-ai/unblocked-linear-worker/blob/main/quickstart.md)
for the exact reserve/complete curl commands. Do not put the admin token or
Linear secrets in this plugin configuration.

## Reconnect after OAuth revocation

If Linear OAuth is revoked, the plugin stops work and disables automatic
reconnect. After reauthorizing the Linear app, run:

```sh
openclaw unblock-linear reconnect
```

This makes exactly one fresh signed connection attempt. A successful attempt
clears the local revoked state. A failed attempt remains revoked. If the
enrollment generation is stale, reconnect refuses and tells the operator to
update the enrollment configuration first; it never silently adopts a new
device generation.

Restarting OpenClaw also performs one connection attempt.

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
Linear OAuth token.

## Troubleshooting

```sh
openclaw plugins inspect unblock-linear
openclaw doctor
openclaw unblock-linear reconnect
```

Common configuration failures are reported without secret values:

- `origin`: use the exact production or staging Worker origin.
- `agentId` / `deviceId`: use the values from operator provisioning.
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

- The Worker stores Linear secrets encrypted with its control-plane key.
- OpenClaw stores the device private key through its SecretRef system.
- The Worker verifies signed device WebSocket upgrades and enrollment
  generations.
- Local-file access for uploads remains subject to OpenClaw host approval.
- Do not commit `.prod.secrets`, private JWKs, OAuth client secrets, webhook
  secrets, or admin tokens.

## License

MIT
