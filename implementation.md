# Unblock Linear plugin implementation plan

The plugin will be one narrow OpenClaw channel plugin with three coordinated
surfaces:

```text
Linear Worker WebSocket
        │
        ▼
 durable relay service ─────► OpenClaw channel/session
        │                            │
        └──── linear tool ◄──────────┘
              ├─ graphql
              └─ upload
```

The implementation sequence matters because durability and identity must exist
before agent execution.

## 1. Establish the package boundary

Create a minimal TypeScript/npm package targeting:

- Node.js 22+
- OpenClaw `>=2026.7.2-beta.7`
- ESM
- `ws` for authenticated upgrade headers
- Zod for runtime protocol validation
- `@openclaw/plugin-inspector`

It will register:

- the `unblock-linear` channel;
- one long-lived relay service;
- one `linear` tool;
- the `unblock-linear.reconnect` Gateway method;
- `openclaw unblock-linear reconnect`.

Reference Loggie for supported OpenClaw mechanics, but copy none of the failed
sibling implementation.

## 2. Vendor and lock down protocol v1

Before networking, copy the Worker's small Zod protocol schema into
`src/relay/protocol.ts`.

Add parity fixtures proving that:

- both implementations accept the same valid frames;
- both reject malformed frames;
- byte limits match;
- direction-specific routing rejects unexpected frame types;
- identity mismatches close with `1008`;
- oversized frames close with `1009`.

The vendored file will record the Worker source path and revision used. Recheck
it before release rather than creating a shared protocol package.

## 3. Implement signed device authentication

`src/relay/device-auth.ts` will:

1. Resolve the private JWK through OpenClaw's SecretRef API.
2. Verify it is a private P-256 key.
3. Construct the exact canonical message.
4. Generate a fresh 32-byte nonce for every attempt.
5. Produce the raw IEEE-P1363 signature.
6. Return the URL and headers without ever logging the key or signature.

This layer will be a pure function apart from randomness and time, making it
easy to test against fixed vectors.

## 4. Build the durable journal first

The journal is the foundation, not an afterthought.

It will persist:

- Linear-to-OpenClaw session bindings;
- delivery lifecycle state;
- exact unresolved activity frames;
- exact unresolved RPC frames and results;
- revoked/device-replaced state;
- durable insertion order.

Properties:

- schema-versioned;
- mode `0600`;
- atomic replacement and directory sync where supported;
- serialized writes;
- validated before persistence;
- bounded by entries and aggregate bytes;
- fail closed when full;
- never evict unresolved work.

No sensitive journal contents will enter logs or doctor output.

## 5. Implement the relay as a small state machine

The service will have explicit states rather than scattered booleans:

```text
starting
   ├─► connected
   ├─► reconnect_wait
   ├─► revoked
   ├─► device_replaced
   └─► stopped
```

It will own exactly one socket and:

- perform signed upgrades;
- validate every frame before dispatch;
- serialize inbound processing;
- reconnect with bounded exponential backoff and jitter;
- replay unresolved frames in durable order;
- prevent two sockets from operating concurrently;
- await persistence and socket closure during shutdown.

`revoked` and `device_replaced` remain distinct terminal conditions.

## 6. Integrate the OpenClaw channel

For each delivery:

1. Resolve the selected OpenClaw agent through standard channel bindings.
2. Build a stable route/session target from the Linear AgentSession identity.
3. Persist the binding.
4. Send `delivery.accept`.
5. Send `started`.
6. Invoke `runEmbeddedAgent` through the supported inbound pipeline.
7. Pass a delivery-specific abort signal.
8. Preserve the selected agent's normal tools and approval policy.
9. Convert the final result into Linear activity/status frames.

The Worker's `agentId` will never be used to select the OpenClaw agent.

### Run-scoped Linear context

The Linear AgentSession identity must travel through a supported run-scoped
binding, not a global "current session" variable.

That lets the `linear` tool determine:

- **Linear-originated run:** include its Linear `sessionId`.
- **Slack/cron/CLI run:** omit `sessionId`.
- **Every call:** derive a stable opaque OpenClaw `contextId`.

This prevents concurrent or later tool calls from accidentally inheriting
another session's authority.

## 7. Translate agent progress conservatively

Use supported embedded-agent callbacks, but expose only safe user-visible
information:

- execution phase → concise `thought`;
- tool start → bounded `action` with tool name and sanitized metadata;
- genuine user question → `elicitation`;
- final assistant text → `response`;
- safe terminal failure → `error`.

Do not forward:

- reasoning streams;
- raw tool arguments or results;
- prompts;
- credentials;
- workspace content merely because it appeared in an internal event.

Every activity frame is persisted before transmission.

## 8. Implement the `linear` GraphQL action

The tool will validate the discriminated input and create a durable RPC request.

For each call:

1. Select the owning OpenClaw context.
2. Add the Linear session only when appropriate.
3. Generate correlation and idempotency identities.
4. Persist the exact validated request.
5. Send it or wait for reconnection.
6. Correlate `rpc.result`.
7. Durably record result consumption.
8. Resolve the original tool invocation.
9. Compact only when safe.

Partial GraphQL `data` plus `errors` will be returned unchanged.

Retries will obey the Worker result:

- `invalid_request`: return immediately;
- `unauthorized`: wait for state change;
- `retryable: true`: retry under the same durable identity;
- `outcome_unknown`: never invent a new mutation identity; tell the agent to
  reconcile.

## 9. Add managed uploads

For `action: "upload"`:

1. Require `media://inbound/<opaque-id>`.
2. Resolve it through OpenClaw's guarded media store.
3. Reject everything else, including filesystem paths and URLs.
4. Verify the file is at most 25 MiB.
5. Request `fileUpload` through the durable GraphQL path.
6. Validate the returned destination as HTTPS.
7. Disable redirect following.
8. Stream the managed file with Linear's returned headers plus the approved
   `Content-Type` and exact `Content-Length` required by Linear's signed upload
   destination; reject any conflicting returned value.
9. Return the Linear asset URL.

The WebSocket never carries file bytes.

## 10. Implement controls and cancellation

Each active delivery gets its own abort controller.

- `session.stop` aborts only that session and its scoped RPCs.
- `team.access_removed` cancels known affected Linear sessions.
- `installation.revoked` aborts everything, persists revoked state, closes the
  socket, and disables automatic reconnect.
- `device.replaced` additionally fences the enrolled generation.

The plugin will not pretend that aborting OpenClaw can roll back an external
side effect already completed.

## 11. Implement explicit reconnect

The CLI calls the running Gateway:

```text
openclaw unblock-linear reconnect
        │
        ▼
unblock-linear.reconnect
        │
        ▼
one fresh signed connection attempt
```

- Success clears revoked state and restarts normal reconnect behavior.
- Failure preserves revoked state.
- A device-replacement fence returns instructions to update enrollment.
- OpenClaw startup performs the same single probe.
- There is no OAuth polling.

## 12. Handle process-crash recovery

When an accepted/started delivery returns:

1. Load its stable session binding.
2. Inspect the persisted OpenClaw transcript.
3. If a completed response exists, recover it without rerunning.
4. If no tool began, resume the incomplete turn.
5. If a tool may have executed, inject explicit reconciliation guidance before
   continuing.
6. Reuse exact persisted Linear RPC identities.
7. Never create a second conversation.

This gives strong Linear RPC replay while being honest that Slack, shell,
configuration, and other arbitrary tools are not transactionally exactly-once.

## 13. Validate in progressively more realistic layers

### Deterministic tests

- protocol/schema parity;
- authentication vectors;
- journal crash/reload behavior;
- state-machine transitions;
- delivery/session continuity;
- RPC replay and conflict handling;
- control isolation;
- upload source and size rejection;
- log redaction.

### OpenClaw integration

- channel binding and default routing;
- stable `sessionTarget`;
- full tool-policy preservation;
- cancellation;
- CLI-to-Gateway reconnect;
- cold and mock-runtime inspection.

### Packaging

- typecheck and build;
- focused tests;
- Inspector;
- `npm pack --dry-run`;
- install the packed artifact into a local OpenClaw `2026.7.2-beta.7` Gateway;
- prove the package uses built JavaScript and no private Worker key is included.

### Staging

Using the enrolled test device:

1. Connect with the enrolled test device; the simulator is disabled.
2. Exercise authenticated queries and a reversible mutation.
3. Test disconnect/replay and controls.
4. Test a managed upload.
5. Audit logs for sensitive content.
6. Keep production separate until all required staging evidence is complete.

Production remains untouched until its Worker supports the validated contract
and staging evidence is complete.

The normative protocol and acceptance requirements remain in
[`WORKER_CONTRACT.md`](./WORKER_CONTRACT.md).
