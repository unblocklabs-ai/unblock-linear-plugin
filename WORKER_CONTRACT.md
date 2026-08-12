# Unblocked Linear Worker contract for the OpenClaw plugin

## Purpose

This is the implementation handoff for a fresh Codex session building the
external OpenClaw plugin. It describes the contract that is implemented and
live-tested by the Cloudflare Worker as of 2026-08-12.

The intended product boundary is:

```text
Linear     owns OAuth scopes, resource access, authorization, and workspace truth
Cloudflare owns Linear credentials, authenticated transport, durability, and replay
OpenClaw   owns agent execution, the model-facing Linear tool, and conversation state
```

The plugin must make Linear feel like a normal agent integration. Relay concepts
such as Durable Objects, delivery IDs, device generations, request correlation,
and retries must not be exposed to the model.

The minimum supported OpenClaw version is `2026.7.2`.

## Current deployment and source of truth

- Staging origin: `https://linear-staging.unblocklabs.ai`
- Staging WebSocket: `wss://linear-staging.unblocklabs.ai/v1/relay/agents/{agentId}/devices/{deviceId}/ws`
- Production origin: `https://linear.unblocklabs.ai`
- Production WebSocket: `wss://linear.unblocklabs.ai/v1/relay/agents/{agentId}/devices/{deviceId}/ws`
- Protocol version: `1`
- Live-tested staging Worker version: `4995bc64-4b47-4b81-b7ce-3ffc341dfacf`
- Production has not yet been updated to this contract.

The authoritative Worker checkout is:

```text
/Users/bek/Desktop/unblocked/unblocked-linear-worker
```

Read these files before implementation and treat them as more authoritative
than prose if the code changes:

```text
scope.md                         product and authority boundary
src/protocol/relay.ts            exact frame runtime schema and byte bounds
src/security/device-auth.ts      exact signed-upgrade authentication
src/agent-relay-do.ts            durable lifecycle, replay, and control behavior
scripts/relay-simulator.mjs      known-good reference client
src/simulator/private-replay.ts  reference crash-safe replay journal
```

Do not invent a second protocol package in v1. Vendor the small protocol-v1
runtime schema into the plugin, record its Worker provenance, and add parity
fixtures. Recheck the Worker schema before release.

## Plugin responsibilities

The plugin owns only:

1. Startup activation and one persistent outbound WebSocket.
2. Resolution of an enrolled P-256 private key through an OpenClaw SecretRef.
3. Signed WebSocket upgrades and bounded reconnect.
4. Runtime validation of every inbound and outbound frame.
5. Durable local ownership of deliveries, activities, and unresolved RPCs.
6. Linear AgentSession to OpenClaw session continuity.
7. Translation of OpenClaw progress/final output into Linear Agent Activities.
8. A model-facing `linear` tool backed by the private `linear.graphql` method.
9. Cancellation/abort handling for control frames.
10. A plugin-owned reconnect CLI for explicit recovery after OAuth revocation.
11. Content-free health and doctor diagnostics.

The plugin does **not** own:

- Linear OAuth, access tokens, refresh tokens, or client secrets;
- Linear webhook verification;
- team, resource, field, or operation authorization;
- a mirrored Linear permissions database;
- Durable Object or D1 access;
- fleet routing;
- a general URL proxy.

Linear decides whether a GraphQL operation is allowed. The Worker authenticates
the device, binds it to exactly one installed Linear app identity, attaches that
identity's current OAuth token, and forwards the operation to the fixed Linear
GraphQL endpoint.

## Required plugin configuration

The runtime needs an already-enrolled device bundle:

```ts
type UnblockedLinearPluginConfig = {
  origin: "https://linear-staging.unblocklabs.ai" | "https://linear.unblocklabs.ai";
  agentId: string;                 // Worker relay identity; 1..128, [A-Za-z0-9_-]
  deviceId: string;                // 1..128, [A-Za-z0-9_-]
  enrollmentGeneration: number;    // positive integer
  devicePrivateKey: SecretRef;      // private P-256 JWK, never plain config/log output
};
```

The corresponding public JWK and generation are already stored in the Worker
registry. The private JWK stays on the OpenClaw host.

For staging validation, the existing enrolled staging test device in the
authoritative Worker checkout may be used. Its private key is test input only:
never copy it into plugin source, package contents, fixtures, logs, or commits.

The plugin must not embed or request:

- `CONTROL_API_TOKEN`;
- a Linear access/refresh token;
- the Linear OAuth client secret;
- the Linear webhook signing secret;
- the Cloudflare control-plane key.

The staging-only `/_test/v1/bootstrap` endpoint is an operator provisioning
tool, not a plugin API, and is structurally absent from production. The current
production Worker does not expose a device self-registration endpoint. The
plugin therefore consumes an enrollment bundle supplied by the operator; do not
add registration to the plugin without a separate control-plane contract.

## OpenClaw channel routing and execution

Implement this as an OpenClaw channel plugin named `unblock-linear`, with the
long-lived relay service and model-facing `linear` tool registered by the same
plugin. Use `defineChannelPluginEntry` and the supported channel inbound/session
pipeline rather than inventing a parallel agent runner.

The configured `agentId` above is only the authenticated Worker relay identity.
It is not an OpenClaw agent selector. Do not add an `openclawAgentId` setting and
do not assume the two identities have the same value. Resolve the target
OpenClaw agent through normal channel/account bindings, with OpenClaw's normal
default-agent behavior when no explicit binding exists. This keeps agent
routing, workspace, model, and tool policy in OpenClaw's existing configuration.

For each Linear AgentSession, build one stable OpenClaw route/session target and
reuse it for every delivery in that Linear session. Follow the supported
`sessionTarget` plus `runEmbeddedAgent` pattern used by the working Loggie
channel plugin at:

```text
/Users/bek/Desktop/openclaw-plugins/loggie
```

Use Loggie only as a reference for current OpenClaw channel dispatch, stable
session targeting, abort signals, runtime loading, packaging, and tests. The
sibling `/Users/bek/Desktop/openclaw-plugins/unblock-linear` checkout is a failed
attempt and is not an implementation reference.

Linear-originated runs inherit the selected OpenClaw agent's full effective tool
policy. Do not restrict them to the `linear` tool: a Linear task may legitimately
need to update agent configuration, send a Slack message, or use another
operator-enabled capability. OpenClaw remains authoritative for tool availability
and approvals.

## Signed WebSocket upgrade

Use a WebSocket client that supports custom upgrade headers, such as the Node
`ws` package. A browser-style global `WebSocket` is insufficient because it
cannot set the authentication headers.

For every connection attempt:

1. Set `timestamp = Date.now()` in Unix milliseconds.
2. Generate exactly 32 cryptographically random bytes.
3. Encode those bytes as unpadded base64url; the nonce is exactly 43 characters.
4. Build the exact canonical message below with no trailing newline.
5. Sign it using ECDSA P-256/SHA-256 and IEEE-P1363 raw encoding.
6. Encode the raw 64-byte signature as unpadded base64url; it is exactly 86 characters.
7. Send a fresh nonce, timestamp, and signature on every reconnect.

Canonical bytes:

```text
unblocked-linear-worker:device-auth:v1
method:GET
path:/v1/relay/agents/{URL-encoded-agentId}/devices/{URL-encoded-deviceId}/ws
agent-id:{agentId}
device-id:{deviceId}
enrollment-generation:{positive integer}
timestamp:{Unix milliseconds}
nonce:{43-character base64url nonce}
```

Required headers:

```text
X-Relay-Timestamp: {timestamp}
X-Relay-Nonce: {nonce}
X-Relay-Enrollment-Generation: {generation}
X-Relay-Signature: {86-character base64url signature}
```

Reference Node shape:

```ts
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import WebSocket from "ws";

const url = new URL(
  `/v1/relay/agents/${encodeURIComponent(agentId)}/devices/${encodeURIComponent(deviceId)}/ws`,
  origin.replace(/^http/, "ws"),
);
const timestamp = Date.now();
const nonce = randomBytes(32).toString("base64url");
const canonical = Buffer.from([
  "unblocked-linear-worker:device-auth:v1",
  "method:GET",
  `path:${url.pathname}`,
  `agent-id:${agentId}`,
  `device-id:${deviceId}`,
  `enrollment-generation:${enrollmentGeneration}`,
  `timestamp:${timestamp}`,
  `nonce:${nonce}`,
].join("\n"));
const signature = sign("sha256", canonical, {
  key: createPrivateKey({ key: privateJwk, format: "jwk" }),
  dsaEncoding: "ieee-p1363",
}).toString("base64url");

const socket = new WebSocket(url, {
  headers: {
    "X-Relay-Timestamp": String(timestamp),
    "X-Relay-Nonce": nonce,
    "X-Relay-Enrollment-Generation": String(enrollmentGeneration),
    "X-Relay-Signature": signature,
  },
});
```

The Worker accepts at most 60 seconds of clock skew and atomically consumes each
nonce. Reusing a nonce returns HTTP 409. Invalid/stale signatures return 401.
Disabled agents, inactive devices, or revoked installations return 403.

Only one active device connection exists per logical agent. A newer connection
or enrolled generation closes the old connection with code `4001`. Installation
revocation sends a control and closes with `4003`.

## Frame envelope

All messages are UTF-8 JSON. Every frame is at most 64 KiB and has:

```ts
type BaseFrame = {
  v: 1;
  id: string;             // UUID, unique frame identity
  type: string;
  agentId: string;
  deviceId: string;
  timestamp: string;      // ISO 8601 with timezone/offset
  sessionId?: string;     // Linear AgentSession ID, not an OpenClaw session ID
  correlationId?: string; // UUID, RPC only
  idempotencyKey?: string;
  payload: unknown;
};
```

Validate every frame before acting. Also verify that inbound `agentId` and
`deviceId` match the configured connection identity. A malformed or
identity-mismatched device frame closes the connection with code `1008`; an
oversized frame closes with `1009`.

Frame directions:

```text
Worker -> plugin: delivery, control, rpc.result, delivery.ack
plugin -> Worker: delivery.accept, delivery.status, activity, rpc.request
```

The plugin must be prepared to receive restored controls, pending RPC results,
an accepted/started delivery replay, and the next queued delivery immediately
after connection. Do not depend on an application-level handshake frame.

## Delivery and OpenClaw session binding

Inbound delivery:

```ts
type DeliveryFrame = BaseFrame & {
  type: "delivery";
  sessionId: string;
  idempotencyKey: string;
  payload: {
    deliveryId: string; // UUID
    action: "created" | "prompted";
    sequence: number;   // positive integer within the Linear session
    issueId?: string;
    teamId: string;
    openclawSessionId?: string;
    prompt: string;     // max 48,000 characters; sensitive
  };
};
```

Required behavior:

1. Durably record the delivery before accepting it.
2. For `created`, create or choose one stable OpenClaw session ID and durably
   bind it to `sessionId`. Send it in `delivery.accept`; the Worker rejects a
   created delivery that omits it.
3. For `prompted`, reuse the existing binding. The Worker normally supplies
   `payload.openclawSessionId`; never create a new conversation for a follow-up.
4. Treat an exact repeated `deliveryId` as resume/replay, not new user intent.
5. Execute only one active delivery at a time for this plugin/device version.
6. Resolve the selected OpenClaw agent through normal channel routing and run the
   delivery through a stable `sessionTarget` using the supported embedded-agent
   runtime.
7. Preserve the selected agent's full effective tool policy and normal approval
   behavior.

Acceptance:

```json
{
  "v": 1,
  "id": "10000000-0000-4000-8000-000000000001",
  "type": "delivery.accept",
  "agentId": "test-agent",
  "deviceId": "test-device",
  "sessionId": "linear-agent-session-id",
  "idempotencyKey": "20000000-0000-4000-8000-000000000002",
  "timestamp": "2026-08-12T12:00:00.000Z",
  "payload": {
    "deliveryId": "20000000-0000-4000-8000-000000000002",
    "openclawSessionId": "stable-openclaw-session-id"
  }
}
```

After acceptance, send `started`, then exactly one terminal status:

```ts
type DeliveryStatus = BaseFrame & {
  type: "delivery.status";
  sessionId: string;
  idempotencyKey: string;
  payload: {
    deliveryId: string;
    status: "started" | "completed" | "failed" | "canceled";
    summary?: string; // max 4,000; never raw chain-of-thought
  };
};
```

Allowed Worker transitions are:

```text
offered -> accepted -> started -> completed|failed|canceled
offered -> accepted -> completed|failed|canceled
```

Repeated accept/status frames for the same already-applied state are
idempotent. On reconnect the Worker re-sends an accepted or started delivery
with the same `deliveryId` and `idempotencyKey`; recover the same OpenClaw
conversation under the process-crash policy below and replay the exact locally
unresolved frames.

The Worker acknowledges each applied device status, including an identical
terminal status replay, with:

```ts
type DeliveryAcknowledgement = BaseFrame & {
  type: "delivery.ack";
  sessionId: string;
  idempotencyKey: string; // deliveryId
  payload: {
    deliveryId: string;
    status: "started" | "completed" | "failed" | "canceled";
  };
};
```

The Worker re-emits acknowledgements for applied statuses on reconnect. Keep a
status frame locally unresolved until its matching acknowledgement is durably
consumed. Only then may terminal delivery state and its enclosed activity replay
entries be compacted.

### Process-crash recovery

OpenClaw conversation continuity does not imply exactly-once execution of an
arbitrary tool. A Slack message, configuration write, shell command, or other
side effect may have completed immediately before a process crash without a
transactional acknowledgement available to this plugin.

On restart or an accepted/started delivery replay:

1. Reuse the exact persisted OpenClaw session target and delivery binding.
2. Inspect the persisted OpenClaw transcript before starting more work.
3. If the turn already has a completed assistant result, recover that result and
   finish the delivery without rerunning the prompt.
4. If no tool execution began, resume the incomplete turn in the same session.
5. If tool execution began and its completion is ambiguous, resume in the same
   session with an explicit instruction to inspect and reconcile existing state
   before repeating any side effect.
6. Reuse every persisted `linear` RPC identity exactly. Linear relay requests
   retain their protocol-specific replay guarantees even when other OpenClaw
   tools do not.
7. Never claim exactly-once recovery for arbitrary OpenClaw tools, and never
   create a second OpenClaw conversation for the replayed delivery.

## Agent Activities

Use an `activity` frame for native Linear AgentSession progress:

```ts
type AgentActivity =
  | { type: "thought"; body: string; ephemeral?: boolean }            // body <= 4,000
  | { type: "action"; action: string; parameter: string; result?: string; ephemeral?: boolean }
  | { type: "elicitation"; body: string }                             // body <= 8,000
  | { type: "response"; body: string }                                // body <= 32,000
  | { type: "error"; body: string };                                  // body <= 8,000

type ActivityFrame = BaseFrame & {
  type: "activity";
  sessionId: string;
  idempotencyKey: string;
  payload: {
    commandId: string; // UUID; durable activity identity
    activity: AgentActivity;
  };
};
```

Persist the exact frame before sending. Reuse the same `commandId` and payload
on replay; never reuse a command ID for different content. There is no separate
activity acknowledgement frame, so keep unresolved activity frames through
reconnect and compact them only after the enclosing delivery has reached its
terminal status.

Never emit private chain-of-thought, credentials, tool secrets, or unredacted
internal prompts as Agent Activity content. `thought` is concise user-visible
progress, not hidden reasoning.

## The model-facing Linear tool

Expose one normal OpenClaw tool named `linear` for v1. Keep the model-facing
shape about Linear, not the relay:

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
      fileRef: string;       // OpenClaw-managed media://inbound/<opaque-id>
      filename?: string;
      contentType?: string;
    };
```

The plugin fills in the private transport identities. The model must not supply
`agentId`, `deviceId`, `contextId`, `sessionId`, `correlationId`, or
`idempotencyKey`.

Use the private `linear.graphql` request:

```ts
type LinearGraphqlRpc = BaseFrame & {
  type: "rpc.request";
  sessionId?: string;        // include only when running inside a Linear AgentSession
  correlationId: string;     // UUID for matching this response
  idempotencyKey: string;    // stable logical request ID, 1..128
  payload: {
    method: "linear.graphql";
    params: {
      contextId: string;     // stable opaque OpenClaw run/context ID, 1..128
      operationName?: string;
      document: string;
      variables: Record<string, JsonValue>;
    };
  };
};
```

Constraints:

- The GraphQL document must be nonempty and at most 48,000 UTF-8 bytes.
- The complete persisted request is at most 60 KiB.
- Variables must be a JSON object, not an array or scalar.
- One request selects exactly one query or mutation.
- Fragments are allowed.
- Multiple named operations are allowed only when `operationName` selects one.
- Subscriptions and schema-definition documents are rejected.
- The bounded GraphQL result is at most 48,000 bytes.
- The upstream is fixed to Linear; the plugin cannot supply a URL or headers.

Context rules:

- Inside a Linear-created OpenClaw run: include the Linear `sessionId`.
- From Slack, cron, CLI, or another OpenClaw context: omit `sessionId`.
- Always use an opaque stable `contextId` for the owning OpenClaw context.
- A stopped Linear session cancels only requests carrying that session ID.
- Installation revocation cancels or rejects all requests.

The `graphql` action maps directly to the private `linear.graphql` request below.
The `upload` action uses that same RPC internally for Linear's `fileUpload`
mutation, then follows the attachment flow specified later in this contract.

Example context-only query:

```json
{
  "v": 1,
  "id": "30000000-0000-4000-8000-000000000003",
  "type": "rpc.request",
  "agentId": "test-agent",
  "deviceId": "test-device",
  "timestamp": "2026-08-12T12:00:01.000Z",
  "correlationId": "40000000-0000-4000-8000-000000000004",
  "idempotencyKey": "50000000-0000-4000-8000-000000000005",
  "payload": {
    "method": "linear.graphql",
    "params": {
      "contextId": "openclaw-run-123",
      "operationName": "Viewer",
      "document": "query Viewer { viewer { id name } }",
      "variables": {}
    }
  }
}
```

For a session-bound request, add the Linear AgentSession ID as the envelope's
`sessionId`. Do not duplicate it inside `params`.

## RPC results and GraphQL semantics

The Worker returns:

```ts
type RpcResult = BaseFrame & {
  type: "rpc.result";
  sessionId?: string;
  correlationId: string;
  payload:
    | { ok: true; result: { data?: unknown; errors?: unknown[]; extensions?: unknown } }
    | {
        ok: false;
        error: {
          code:
            | "invalid_request"
            | "unauthorized"
            | "not_found"
            | "conflict"
            | "retryable"
            | "outcome_unknown"
            | "internal";
          message: string;
          retryable: boolean;
        };
      };
};
```

Important distinction:

- `payload.ok` reports whether the relay request produced a definitive bounded
  Linear GraphQL envelope.
- A valid GraphQL response containing partial `data` and `errors` is still
  `ok: true`. Preserve and return both to the model/tool caller.
- `ok: false` is a relay/transport/lifecycle failure, not a rewritten Linear
  permission response.

Error handling:

- `invalid_request`: fix the document, selection, variables, or size; do not reconnect.
- `conflict`: the same idempotency key was reused for different semantic input;
  treat this as a plugin bug and mint a new key only for genuinely new intent.
- `unauthorized`: installation/session control is active; do not retry until state changes.
- `outcome_unknown`: a mutation may have reached Linear. Never resend it under a
  new identity. Reconcile with a follow-up query.
- Other failures: obey the explicit `retryable` boolean.

The Worker retries safe queries on rate limits, temporary transport failures,
and server failures. It does not blindly replay a mutation after a
post-dispatch timeout, transport failure, malformed response, or server failure.

## RPC durability and exact replay

Before sending a request, durably persist:

```text
owner OpenClaw context
optional Linear session ID
correlation ID
idempotency key
operation name
exact document
exact variables
full validated frame
```

Do not put those contents in ordinary logs or operator transcripts.

The Worker's durable request identity is the `idempotencyKey`. Its semantic hash
includes `contextId`, optional Linear `sessionId`, optional `operationName`, the
document, and canonical variables; it excludes `correlationId`.

There is no separate `rpc.result` acknowledgement frame. A WebSocket send is not
proof the plugin received the result. Therefore:

1. Keep the request locally unresolved until the plugin has durably consumed its
   correlated result.
2. After reconnect, resend the exact unresolved request with the same
   idempotency key. Keeping the same full frame and correlation ID is simplest.
3. The Worker recognizes an exact duplicate, resets its result-send marker, and
   replays the persisted result.
4. A changed document, variables, context, session, or operation name with the
   same key receives `conflict`.
5. Delete/compact the local replay entry only after the result is durably handed
   to its owning OpenClaw tool invocation, or after a control terminally cancels it.

Use one small private replay journal with restrictive permissions and a fixed
entry bound. The simulator's implementation uses atomic temp-file replacement,
mode `0600`, validates before persistence, and never places documents,
variables, prompts, activity bodies, or results in its operator transcript.
Journal exhaustion must fail closed: reject new work with a content-free error
rather than evicting or overwriting any unresolved delivery, activity, or RPC.

## Control frames

```ts
type ControlPayload =
  | { kind: "session.stop"; reason?: string }
  | { kind: "team.access_removed"; teamId: string }
  | { kind: "installation.revoked" }
  | { kind: "device.replaced"; generation: number };
```

Behavior:

- `session.stop`: abort the matching OpenClaw run and cancel its unresolved
  session-scoped RPCs. The Worker permits at most one best-effort final
  `response` or `error` activity after stop; then send `delivery.status` as
  `canceled`.
- `team.access_removed`: promptly cancel known affected active Linear sessions.
  This is an operational signal, not a Cloudflare authorization rule for future
  generic GraphQL; Linear remains authoritative.
- `installation.revoked`: abort all work, reject new `linear` tool calls, clear
  reconnect timers, persist a local revoked state, and remain offline until OAuth
  is reauthorized and an operator explicitly requests a reconnect or OpenClaw
  restarts.
- `device.replaced`: stop using the old generation and require a newly supplied
  enrollment bundle. Persist the replacement fence and do not reconnect with the
  stale key/generation.

When an enrolled generation rotates while connected, the Worker sends
`control.device.replaced` before closing the old socket with code `4001`. A stale
generation presented during a new signed upgrade receives content-free HTTP
`409 {"error":"device_replaced"}`; other authentication failures remain generic.

Controls can arrive immediately on reconnect. Apply them before resuming work.

## Reconnect and shutdown

- Use bounded exponential backoff with jitter for abnormal network closes.
- Generate new signed-upgrade authentication for every attempt.
- Do not automatically reconnect after an intentional plugin shutdown,
  installation revocation, or device replacement with a newer generation. The
  only revocation exceptions are the explicit CLI attempt and the single startup
  attempt defined below; neither may bypass a device-replacement fence.
- A new successful connection replaces the old socket; never operate both.
- On reconnect, replay exact unresolved local activity and RPC frames in durable
  insertion order.
- If the Worker reoffers an accepted/started delivery, attach to the same local
  OpenClaw session and apply the process-crash recovery policy above; do not
  create a second conversation.
- Make plugin shutdown await journal persistence and socket closure.

Register a plugin CLI command:

```text
openclaw unblock-linear reconnect
```

Implement it through a plugin-owned Gateway method such as
`unblock-linear.reconnect`, using the supported plugin CLI and Gateway client
APIs. Its behavior is:

1. It tells the running plugin service to make exactly one fresh signed
   connection attempt.
2. Success clears the persisted revoked state and resumes normal bounded
   automatic reconnect behavior.
3. Failure preserves the revoked state and returns a useful content-free error.
4. It refuses to bypass a `device.replaced` fence or use a stale enrollment
   generation, and instructs the operator to update the enrollment configuration.
5. It does not poll for OAuth reauthorization.

On OpenClaw startup, perform one fresh signed connection attempt even when the
persisted state is `installation.revoked`. Success clears the revoked state;
failure leaves the service revoked and requires the explicit reconnect command.
Startup must still refuse a stale device generation after `device.replaced`.

## Files and attachments

Do not send file bytes through the WebSocket.

The `upload` action accepts only an opaque OpenClaw-managed reference of the
exact form `media://inbound/<opaque-id>`. Resolve it through OpenClaw's supported
guarded media-store API. Reject absolute paths, relative paths, `file://` URLs,
HTTP(S) source URLs, data URLs, and malformed media references. The initial
maximum upload size is 25 MiB.

For upload parity:

1. Resolve `fileRef` through the OpenClaw host's guarded media API and verify the
   managed file is within the 25 MiB bound.
2. Call Linear's `fileUpload` mutation through `linear.graphql`.
3. Require an HTTPS upload destination and validate that it is the exact
   pre-signed destination returned by Linear. Do not accept a caller-supplied URL.
4. Stream the managed file directly to that destination using exactly the
   headers Linear returned. Do not load the whole file into memory.
5. Return the resulting Linear asset URL from the tool.
6. Let the agent use that URL in a normal `graphql` action mutation.

For downloads, GraphQL responses contain short-lived Linear-signed file URLs.
The Worker fixes `public-file-urls-expire-in` to 300 seconds. Do not add a
caller-selected fetch URL or general file proxy. Downloads remain ordinary
signed URLs handled through OpenClaw's normal approved download mechanism.

## Logging and diagnostics

Allowed diagnostic metadata:

- agent ID, device ID, and enrollment generation;
- connection/reconnect status and close code;
- frame type and frame ID;
- delivery/request state counts and oldest age;
- GraphQL operation kind and optional operation name;
- attempt count, timing, bounded HTTP/GraphQL error codes;
- mutation `outcome_unknown` classification.

Never log:

- the private JWK or any secret;
- GraphQL documents or variables;
- GraphQL response data or error messages containing workspace content;
- delivery prompts;
- issue descriptions, comments, customer data, or file contents;
- managed media references and pre-signed upload/download URLs;
- Agent Activity bodies;
- raw OpenClaw prompts or hidden reasoning.

The doctor command should prove only configuration presence, key parseability,
clock sanity, endpoint reachability, signed connection status, generation, and
bounded state counts.

## Minimal OpenClaw implementation shape

Use the current supported focused `openclaw/plugin-sdk` entry points; do not
patch OpenClaw core or import private internals.

The smallest useful plugin has:

```text
package.json               declares OpenClaw >=2026.7.2 and channel metadata
openclaw.plugin.json       declares the channel, linear tool, and startup activation
index.ts                   defineChannelPluginEntry and thin registrations only
setup-entry.ts             setup-safe channel/CLI metadata when required by the SDK
src/channel.ts             channel account, status, routing, and inbound surface
src/config.ts              config parsing plus SecretRef resolution boundary
src/relay/protocol.ts      vendored exact protocol-v1 Zod schema
src/relay/device-auth.ts   canonical signing
src/relay/client.ts        one socket, reconnect, routing, controls
src/relay/journal.ts       bounded private exact replay state
src/service.ts             OpenClaw startup/shutdown lifecycle
src/cli.ts                 reconnect command -> plugin-owned Gateway method
src/tool.ts                graphql/upload actions -> linear.graphql RPC and guarded media upload
src/sessions.ts            channel routing, stable session target, recovery, and abort mapping
test/                      protocol, replay, control, tool, and runtime tests
```

Use the supported channel entrypoint and inbound pipeline, `registerService` for
the long-lived relay connection, `registerTool` for the `linear` tool,
`registerGatewayMethod` for the reconnect operation, and `registerCli` for the
operator command, subject to the exact OpenClaw 2026.7.2 SDK. Keep entrypoint
registration thin. Do not add a provider-neutral transport layer, configurable
scheduler, multiple-device manager, generic job framework, or mirrored Linear
SDK/schema.

The package and manifest must align. Add `@openclaw/plugin-inspector` and prove:

```text
typecheck/build
unit tests
cold manifest inspection
runtime inspection with the mock SDK
npm pack --dry-run
installed local Gateway smoke test
```

## Required validation before release

1. Exact P-256 canonical bytes, raw signature encoding, skew, nonce, and headers.
2. Authenticated staging connection using an enrolled test device.
3. Created delivery persists a binding before acceptance.
4. Standard channel binding selects the OpenClaw agent independently from the
   Worker relay `agentId`, and default-agent routing works without a binding.
5. Prompted delivery reuses the same OpenClaw session target.
6. Linear-created runs retain the selected agent's full effective tool and
   approval policy.
7. Started/progress/response/completed lifecycle.
8. Session-bound GraphQL query.
9. Context-only GraphQL query with no `sessionId`.
10. Reversible GraphQL mutation.
11. Partial GraphQL `data` plus `errors` preserved to the tool caller.
12. Invalid GraphQL request gets a correlated error without closing the socket.
13. Exact request replay returns the same persisted result.
14. Conflicting idempotency-key reuse returns `conflict`.
15. Disconnect after request send but before result consumption; restart replays
    the exact frame and resolves the original invocation.
16. Journal capacity exhaustion fails closed without evicting unresolved work or
    leaking persisted content.
17. A completed transcript result is recovered after restart without rerunning
    the prompt.
18. An incomplete delivery with no tool execution resumes in the same session.
19. An incomplete delivery with ambiguous tool execution receives explicit
    inspect-and-reconcile guidance before any repeated side effect.
20. Accepted/started delivery replay never creates a second OpenClaw conversation.
21. Stop aborts only the matching session; context-only GraphQL stays usable.
22. OAuth revocation aborts work, persists revoked state, and disables automatic
    reconnect.
23. `openclaw unblock-linear reconnect` makes one attempt, clears revocation only
    on success, and returns a content-free failure otherwise.
24. OpenClaw restart makes one connection attempt from revoked state.
25. Device replacement fences the old generation and the reconnect command
    refuses it until enrollment configuration changes.
26. A managed `media://inbound/<opaque-id>` file uploads through Linear's
    `fileUpload` flow and returns the asset URL.
27. Paths, arbitrary URLs, malformed references, and files over 25 MiB are
    rejected without making an upload request.
28. Upload bytes stream directly to the validated Linear HTTPS destination using
    the returned headers plus the approved `Content-Type` and exact
    `Content-Length` required by Linear's signed upload destination; reject
    conflicts. File bytes never enter the WebSocket protocol.
29. Mutation `outcome_unknown` is not automatically replayed and triggers query reconciliation.
30. Operator logs/transcripts contain none of the sensitive fields listed above.
31. Cold and live OpenClaw plugin inspection match the manifest.

The simulator is disabled. Staging validation uses the enrolled test device;
production remains a separate, explicitly authorized release step.

## Known current limits

- One active device generation per logical agent.
- Serial delivery execution per Agent Durable Object.
- 64 KiB maximum WebSocket frame.
- 48,000-byte GraphQL document and result bounds.
- No GraphQL subscriptions.
- No reusable Linear OAuth credential on the OpenClaw host.
- Managed uploads are limited to 25 MiB and `media://inbound/<opaque-id>` sources.
- No production self-enrollment API yet.
- No exactly-once guarantee for arbitrary Linear mutations; ambiguous outcomes
  are terminal `outcome_unknown` and require reconciliation.
- No exactly-once guarantee for arbitrary non-Linear OpenClaw tool side effects;
  crash recovery inspects and reconciles before repeating ambiguous work.
- Production has not yet received the staging-validated generic GraphQL build.

These limits are intentional. Do not broaden the architecture while building
the first plugin unless a real acceptance test requires it.
