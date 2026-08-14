# Unblocked Linear Worker contract for the OpenClaw plugin

## Purpose

This document records the current contract between the OpenClaw plugin and the
Cloudflare Worker working trees as of 2026-08-13. It is an implementation and
operations reference, not proof that either configured origin is currently
running these exact working trees. Verify deployed versions and live acceptance
separately before release.

The intended product boundary is:

```text
Linear     owns app scopes, resource access, authorization, and workspace truth
Cloudflare owns Linear credentials, access-token minting, relay transport, durability, and replay
OpenClaw   owns agent execution, conversation state, and the plugin's local replay journal
```

The plugin must make Linear feel like a normal agent integration. Relay concepts
such as Durable Objects, delivery IDs, enrollment generations, request
correlation, and retries must not be exposed to the model.

The minimum supported OpenClaw version is `2026.7.2-beta.7`.

## Configured origins and source of truth

- Staging origin: `https://linear-staging.unblocklabs.ai`
- Staging WebSocket: `wss://linear-staging.unblocklabs.ai/v1/relay/agents/{agentId}/ws`
- Production origin: `https://linear.unblocklabs.ai`
- Production WebSocket: `wss://linear.unblocklabs.ai/v1/relay/agents/{agentId}/ws`
- Protocol version: `1`

The Worker Wrangler configurations target these origins. The repositories do
not establish which Worker version is currently deployed at either origin, so
this contract makes no deployment-parity or live-test claim.

The authoritative Worker checkout is:

```text
/Users/bek/Desktop/unblocked/unblocked-linear-worker
```

Read these files before implementation and treat them as more authoritative
than prose if the code changes:

```text
scope.md                         product boundary only; implementation/test details may be stale
src/protocol/relay.ts            exact frame runtime schema and byte bounds
src/security/enrollment-auth.ts  exact signed-upgrade authentication
src/agent-relay-do.ts            durable lifecycle, replay, and control behavior
src/http/router.ts               public routes, webhooks, and relay upgrade
src/http/provisioning-admin.ts   current operator provisioning API
src/registry/                    provisioning and enrollment persistence
scripts/bootstrap-production.mjs interactive create/resume/status/replace client

# In this plugin checkout:
src/relay/journal.ts             crash-safe local replay and lifecycle journal
src/relay/service.ts             authenticated WebSocket lifecycle and replay
src/delivery/                    OpenClaw session binding, execution, and recovery
src/linear/                      GraphQL RPC, tool, and guarded upload behavior
src/integration.ts               OpenClaw service, journal, and executor wiring
```

The plugin vendors the small protocol-v1 runtime schema with its Worker
provenance and parity fixtures. Do not introduce a second protocol package in
v1; compare the vendored body with the Worker schema before release.

## Plugin responsibilities

The plugin owns only:

1. Startup activation and one persistent outbound WebSocket.
2. Resolution of an enrolled P-256 private key through an OpenClaw SecretRef.
3. Signed WebSocket upgrades and bounded reconnect.
4. Runtime validation of every inbound and outbound frame.
5. Durable local ownership of deliveries, activities, unresolved RPCs, and
   managed upload workflows.
6. Linear AgentSession to OpenClaw session continuity.
7. Translation of OpenClaw progress/final output into Linear Agent Activities.
8. A model-facing `linear` tool backed by the private `linear.graphql` method.
9. Cancellation/abort handling for control frames.
10. Content-free channel status and configuration-only doctor warnings.

The plugin does **not** own:

- Linear private-app credentials or access tokens;
- Linear webhook verification;
- team, resource, field, or operation authorization;
- a mirrored Linear permissions database;
- Durable Object or D1 access;
- fleet routing;
- a general URL proxy.

Linear decides whether a GraphQL operation is allowed. The Worker authenticates
the agent enrollment, binds it to exactly one installed Linear app identity,
mints a short-lived access token through the client-credentials grant, and
forwards the operation to the fixed Linear GraphQL endpoint.

## Required plugin configuration

The runtime configuration lives under `channels.unblock-linear` and needs one
already-enrolled agent bundle:

```ts
type UnblockedLinearPluginConfig = {
  origin: "https://linear-staging.unblocklabs.ai" | "https://linear.unblocklabs.ai";
  agentId: string;                 // Worker relay identity; 1..128, [A-Za-z0-9_-]
  enrollmentGeneration: number;    // positive integer
  devicePrivateKey: SecretRef;      // private P-256 JWK, never plain config/log output
};
```

The corresponding public JWK and generation are already stored in the Worker
registry. The private JWK stays on the OpenClaw host.

For staging validation, provision a dedicated enrolled agent through the
operator API. Keep its private key outside both repositories and never copy it
into plugin source, package contents, fixtures, logs, or commits.

The plugin must not embed, receive, or request:

- `ADMIN_API_TOKEN`;
- a Linear access token;
- the Linear private-app client ID or client secret;
- the Linear webhook signing secret;
- the Cloudflare control-plane key.

Provisioning is operator-only and driven from the Worker repository. The admin
token is accepted only through the environment:

```sh
npm run setup:agent -- create
npm run setup:agent -- resume
npm run setup:agent -- status
npm run setup:agent -- replace --agent-id <existing-agent-id>
```

`create` generates a private P-256 enrollment key locally and sends only its
public JWK to `POST /v1/admin/agents/reservations`, authenticated with
`Authorization: Bearer <ADMIN_API_TOKEN>`. The Worker creates server-generated
agent, installation, and webhook identities. The CLI opens Linear's
prefilled private-app form with the unique webhook and required scopes, then
collects the app's client ID, client secret, and webhook signing secret without
echoing them.

The CLI sends those app credentials directly to the reservation's completion
endpoint. Before atomic activation, the Worker obtains a short-lived token
through `client_credentials` and verifies the app user, expected organization,
required scopes, and Agent Sessions support. The Worker encrypts the long-lived
client and webhook credentials; it does not persist the access token. Although
Linear currently requires `authorization_code` in every app manifest, the
Worker never starts that grant, exposes a callback, or asks for user consent.

The CLI persists only resumable non-credential setup state and the private JWK
in separate mode-`0600` files. `status` is local-only; `resume` continues a
pending reservation. Successful completion prints the safe enrollment bundle:
`origin`, `agentId`, `enrollmentGeneration`, and
`privateKeyFile`. The operator moves the key into an OpenClaw-approved
secret store and supplies the printed values to the plugin.

`replace` uses the same flow for an existing `agentId`. An otherwise-active
current installation and enrollment remain active until the replacement
credentials are verified and the new generation is atomically activated; an
already-revoked installation remains offline. Worker-side replacement does not
delete the old private app in Linear.

These admin endpoints are not plugin APIs. The staging and production Worker
entrypoints wire the same routes behind each deployment's respective
`ADMIN_API_TOKEN` binding; source alone does not prove live reachability. There
is no agent self-registration endpoint. The plugin therefore consumes an
enrollment bundle supplied by the operator; do not add registration to the
plugin without a separate control-plane contract.

## OpenClaw channel routing and execution

This is implemented as an OpenClaw channel plugin named `unblock-linear`, with the
long-lived relay service and model-facing `linear` tool registered by the same
plugin. It uses `defineChannelPluginEntry` and the supported channel
inbound/session pipeline rather than a parallel agent runner.

The configured `agentId` above is only the authenticated Worker relay identity.
It is not an OpenClaw agent selector. Do not add an `openclawAgentId` setting and
do not assume the two identities have the same value. Resolve the target
OpenClaw agent through normal channel/account bindings, with OpenClaw's normal
default-agent behavior when no explicit binding exists. This keeps agent
routing, workspace, model, and tool policy in OpenClaw's existing configuration.

For each Linear AgentSession, `src/delivery/executor.ts` persists one stable
OpenClaw route/session target and reuses it for every delivery in that Linear
session. Execution uses the supported `sessionTarget` plus `runEmbeddedAgent`
path with an abort signal and the selected agent's normal runtime policy.

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
unblocked-linear-worker:enrollment-auth:v1
method:GET
path:/v1/relay/agents/{URL-encoded-agentId}/ws
agent-id:{agentId}
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
  `/v1/relay/agents/${encodeURIComponent(agentId)}/ws`,
  origin.replace(/^http/, "ws"),
);
const timestamp = Date.now();
const nonce = randomBytes(32).toString("base64url");
const canonical = Buffer.from([
  "unblocked-linear-worker:enrollment-auth:v1",
  "method:GET",
  `path:${url.pathname}`,
  `agent-id:${agentId}`,
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
Disabled agents, inactive enrollments, or revoked installations return 403.

Only one active connection exists per logical agent. A newer connection or
enrollment generation closes the old connection with code `4001`. Installation
revocation sends a control and closes with `4003`.

## Frame envelope

All messages are UTF-8 JSON. Every frame is at most 64 KiB and has:

```ts
type BaseFrame = {
  v: 1;
  id: string;             // UUID, unique frame identity
  type: string;
  agentId: string;
  timestamp: string;      // ISO 8601 with timezone/offset
  sessionId?: string;     // Linear AgentSession ID, not an OpenClaw session ID
  correlationId?: string; // UUID, RPC only
  idempotencyKey?: string;
  payload: unknown;
};
```

Validate every frame before acting and verify that inbound `agentId` matches the
configured relay identity. Any malformed or identity-mismatched frame closes
the connection with code `1008`; an oversized frame closes with `1009`.

Frame directions:

```text
Worker -> plugin: delivery, control, rpc.result, delivery.ack
plugin -> Worker: delivery.accept, delivery.status, activity, rpc.request
```

The plugin must be prepared to receive restored controls, pending RPC results,
an accepted/started delivery replay, delivery-status acknowledgements, and the
next eligible queued delivery immediately after connection. Do not depend on an
application-level handshake frame.

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
5. Execute only one active delivery at a time in the plugin service; the Worker
   also serializes delivery per Agent Durable Object.
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

The Worker acknowledges each applied delivery status, including an identical
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
      // action <= 256; parameter <= 2,000; optional result <= 4,000
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
`agentId`, `contextId`, `sessionId`, `correlationId`, or
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
- The canonical semantic request payload accepted for persistence is at most
  60 KiB, covering `contextId`, optional `sessionId` and `operationName`, the
  document, and canonical variables.
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
- `unauthorized`: an installation, team, or session control is active; do not
  retry until state changes.
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

Do not put those contents in plugin logs, channel status, doctor output, or
reconnect errors.

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

The plugin implements this with
`plugins/unblock-linear/relay-journal.json` under the OpenClaw state directory
and a sibling single-writer lease owned by `RelayService`. The journal validates
its complete state before persistence, writes through a mode-`0600` temporary
file, syncs it, and atomically renames it into place. `RelayService` persists
replayable work before sending and replays unresolved activity, delivery-status,
and RPC frames in journal sequence after reconnect.

The ordinary journal capacity is 256 entries and 4 MiB. Durable stopped-session
markers are a separate control overlay so a stop can still persist at ordinary
capacity; every marker must correspond to a retained delivery, which bounds the
overlay by the delivery count. Journal exhaustion must fail closed rather than
evicting or overwriting unresolved work. An incompatible or corrupt journal is
rejected; there is intentionally no schema migration or backward compatibility.
The host-private relay journal and OpenClaw conversation transcript intentionally
persist content required for replay and recovery.

## Control frames

```ts
type ControlPayload =
  | { kind: "session.stop"; reason?: string }
  | { kind: "team.access_removed"; teamId: string }
  | { kind: "installation.revoked" }
  | { kind: "enrollment.replaced"; generation: number }; // nonnegative in protocol; enrolled generations are positive
```

Behavior:

- `session.stop`: abort the matching OpenClaw run and cancel its unresolved
  session-scoped RPCs. The Worker permits at most one best-effort final
  `response` or `error` activity after stop; then send `delivery.status` as
  `canceled`. If the session has retained delivery state, the plugin persists
  its bounded stopped marker before cleanup; otherwise it compacts retained
  binding and RPC state without keeping a marker. It always attempts the local
  abort even if journal persistence fails; a persistence failure still closes
  the socket fail-closed.
- `team.access_removed`: promptly cancel known affected active Linear sessions.
  This is an operational signal, not a Cloudflare authorization rule for future
  generic GraphQL; Linear remains authoritative.
- `installation.revoked`: abort all work, reject new `linear` tool calls, clear
  reconnect timers, persist a local revoked state, and remain offline while the
  same enrollment is configured. Recovery requires Worker-side replacement,
  updated plugin configuration and SecretRef, and an OpenClaw restart.
- `enrollment.replaced`: stop using the old generation and require a newly
  supplied enrollment bundle. Persist the replacement fence and do not reconnect
  with the stale key/generation. Require the control payload generation to be
  strictly newer than the connected generation. The fence records the stale
  enrolled agent identity and the expected replacement generation from the
  control; an exact stale-upgrade `409` records the attempted generation as both.
  Only the same agent with a strictly newer generation can probe, and it must
  meet or exceed an expected replacement generation supplied by a control.

When an enrollment generation rotates while connected, the Worker attempts to
send `enrollment.replaced` before closing the old socket with code `4001`. The
plugin drains already-queued inbound frames before finalizing the close so a
successfully queued control cannot be lost to the immediate close. A stale
generation presented during a new signed upgrade receives content-free HTTP
`409 {"error":"enrollment_replaced"}`; other signed-authentication failures
remain generic.

Controls can arrive immediately on reconnect. Apply them before resuming work.

## Reconnect and shutdown

- Use bounded exponential backoff with jitter for abnormal network closes.
- Generate new signed-upgrade authentication for every attempt.
- Do not automatically reconnect after an intentional plugin shutdown,
  installation revocation, or enrollment replacement while the same enrollment
  is configured. Both require a same-agent, strictly newer enrollment supplied
  through configuration.
- A new successful connection replaces the old socket; never operate both.
- On reconnect, replay exact unresolved local activity, delivery-status, and RPC
  frames in durable insertion order.
- If the Worker reoffers an accepted/started delivery, attach to the same local
  OpenClaw session and apply the process-crash recovery policy above; do not
  create a second conversation.
- Make plugin shutdown await journal persistence and socket closure.

There is no plugin-owned operator reconnect command. For
`installation.revoked`, run `npm run setup:agent -- replace --agent-id
<existing-agent-id>` from the Worker repository, update the plugin enrollment
and private-key SecretRef, then restart OpenClaw. Startup must not use the old
enrollment to bypass the persisted revoked state.

For a persisted revocation or `enrollment.replaced` fence, startup refuses
unchanged, rollback, and cross-agent configuration without opening a socket. If
configuration has changed to the same agent with a generation strictly newer
than the fenced enrollment—and at least the expected replacement generation
when one was supplied—startup makes one authenticated probe. A WebSocket `open`
atomically validates the persisted frame agent IDs and clears the fence before
replay begins; replay requires no identity rewriting. A failed probe keeps the
fence and does not retry automatically.

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
4. Stream the managed file directly to that destination using the bounded
   headers Linear returned plus the approved `Content-Type` and exact
   `Content-Length`. Reject conflicting returned values, block redirects, and
   verify the stream emits exactly the approved size. Do not load the whole file
   into memory.
5. Return the resulting Linear asset URL from the tool.
6. Let the agent use that URL in a normal `graphql` action mutation.

Once an upload PUT begins, a transport error, size mismatch, redirect, or
non-2xx response is persisted as `ambiguous` and is not retried automatically.

For downloads, GraphQL responses contain short-lived Linear-signed file URLs.
The Worker fixes `public-file-urls-expire-in` to 300 seconds. Do not add a
caller-selected fetch URL or general file proxy. Downloads remain ordinary
signed URLs handled through OpenClaw's normal approved download mechanism.

## Logging and diagnostics

Allowed diagnostic metadata:

- agent ID and enrollment generation;
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

The status adapter emits content-free configured state and maps the relay
service's live `IntegrationState` into OpenClaw's channel runtime snapshot,
including running, connected, lifecycle, and start/stop timestamps. Doctor
preview warnings report only disabled accounts and missing or invalid
configuration field names. Doctor does not resolve the secret, open a socket,
inspect journal content, or claim endpoint/authentication health.

## Minimal OpenClaw implementation shape

Use the current supported focused `openclaw/plugin-sdk` entry points; do not
patch OpenClaw core or import private internals.

The current focused implementation has:

```text
package.json               declares OpenClaw >=2026.7.2-beta.7 and channel metadata
openclaw.plugin.json       declares the channel, linear tool, and startup activation
index.ts                   defineChannelPluginEntry and thin registrations only
setup-entry.ts             setup-safe channel metadata
src/channel.ts             channel account, status, doctor, and secret metadata
src/config.ts              channel-root config parsing and SecretRef boundary
src/integration.ts         service/tool wiring, media resolution, and relay state
src/relay/protocol.ts      vendored exact protocol-v1 Zod schema
src/relay/device-auth.ts   plugin-side canonical signing implementation
src/relay/service.ts       one socket, reconnect, replay, and controls
src/relay/journal.ts       bounded private exact replay state
src/relay/lease.ts         single-writer journal ownership
src/delivery/              session routing, execution, recovery, and abort mapping
src/linear/                graphql/upload tool, RPC bridge, and guarded media upload
test/                      protocol, replay, control, tool, and runtime tests
```

Use the supported channel entrypoint and inbound pipeline, `registerService` for
the long-lived relay connection, and `registerTool` for the `linear` tool,
subject to the exact OpenClaw 2026.7.2-beta.7 SDK. Keep entrypoint registration
thin. Do not add a provider-neutral transport layer, configurable scheduler,
multiple-enrollment manager, generic job framework, or mirrored Linear
SDK/schema.

The package and manifest align, and `npm run preflight` covers:

```text
typecheck/build
unit tests
cold manifest inspection
runtime inspection with the mock SDK
npm pack --dry-run
```

An installed local Gateway smoke test and authenticated staging acceptance are
separate release checks; the mock-runtime inspector and repository tests do not
prove either one.

## Required validation before release

1. Exact P-256 canonical bytes, raw signature encoding, skew, nonce, and headers.
2. Authenticated staging connection using an enrolled test agent.
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
    leaking persisted content, while a `session.stop` at the ordinary entry or
    byte limit still persists its bounded marker and aborts active work.
17. A completed transcript result is recovered after restart without rerunning
    the prompt.
18. An incomplete delivery with no tool execution resumes in the same session.
19. An incomplete delivery with ambiguous tool execution receives explicit
    inspect-and-reconcile guidance before any repeated side effect.
20. Accepted/started delivery replay never creates a second OpenClaw conversation.
21. Stop aborts only the matching session; context-only GraphQL stays usable.
22. App revocation aborts work, persists revoked state, and disables automatic
    reconnect for the same enrollment.
23. Replacement does not disable an otherwise-active old installation/enrollment
    until verification, then atomically activates a new same-agent enrollment
    generation.
24. Restart with unchanged, rolled-back, or cross-agent enrollment cannot clear
    a revocation or replacement fence.
25. Enrollment replacement fences the old generation and drains
    control-before-close. Only a strictly newer same-agent generation may clear
    a revocation or replacement fence after authenticated open; replay needs no
    identity rewriting.
26. A managed `media://inbound/<opaque-id>` file uploads through Linear's
    `fileUpload` flow and returns the asset URL.
27. Paths, arbitrary URLs, malformed references, and files over 25 MiB are
    rejected without making an upload request.
28. Upload bytes stream directly to the validated Linear HTTPS destination using
    the returned headers plus the approved `Content-Type` and exact
    `Content-Length` required by Linear's signed upload destination; reject
    conflicts. File bytes never enter the WebSocket protocol.
29. Mutation `outcome_unknown` is not automatically replayed and triggers query reconciliation.
30. Plugin logs, channel status, doctor output, and connection errors contain none
    of the sensitive fields listed above.
31. Cold and mock-runtime OpenClaw plugin inspection match the manifest.

Staging validation requires an operator-provisioned enrolled agent with the
plugin's `RelayService` and `RelayJournal`. No authenticated live staging result
is established by the current repositories; production provisioning and release
remain separate, explicitly authorized steps.

## Known current limits

- One active enrollment generation per logical agent.
- Serial delivery execution per Agent Durable Object.
- Each authorized delivery receives a deadline 10 minutes after ingress. If it
  remains authorized when that deadline is processed and no agent socket is
  connected, the Worker marks it failed and queues a user-visible Linear error
  activity instead of offering stale work later.
- 64 KiB maximum WebSocket frame.
- 48,000-byte GraphQL document and result bounds.
- 60 KiB maximum canonical GraphQL request payload accepted for persistence,
  covering `contextId`, optional `sessionId` and `operationName`, the document,
  and canonical variables.
- 256 ordinary plugin journal entries and 4 MiB ordinary serialized journal
  state, plus the delivery-bounded stopped-session control overlay.
- A Linear session binding remains durable until an explicit `session.stop`;
  many distinct sessions that never receive that control can exhaust journal
  capacity and fail closed.
- No GraphQL subscriptions.
- No reusable Linear credential or access token on the OpenClaw host.
- Managed uploads are limited to 25 MiB and `media://inbound/<opaque-id>` sources.
- Completed delivery-owned uploads compact with their acknowledged terminal
  delivery. Generic completed uploads outside a delivery have no trustworthy
  lifecycle endpoint and can eventually exhaust journal capacity; they are
  retained fail-closed. Pending, uploading, failed, and ambiguous upload state is
  also retained rather than guessed or evicted.
- No agent self-registration API; enrollment is operator-only through the
  authenticated Worker `setup:agent` flow.
- No journal backward compatibility or migration; incompatible prior state is
  rejected intentionally.
- No exactly-once guarantee for arbitrary Linear mutations; ambiguous outcomes
  are terminal `outcome_unknown` and require reconciliation.
- No exactly-once guarantee for arbitrary non-Linear OpenClaw tool side effects;
  crash recovery inspects and reconciles before repeating ambiguous work.

These limits are intentional. Do not broaden the architecture while operating
the first plugin unless a real acceptance test requires it.
