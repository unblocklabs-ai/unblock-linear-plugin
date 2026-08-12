export const LINEAR_RUN_BINDING_KEY = "unblock-linear.run";

export type LinearRunBinding = Readonly<{
  linearSessionId: string;
  contextId: string;
  deliveryId: string;
  teamId: string;
}>;

export type LinearRunIdentity = Readonly<{
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
}>;

export type LinearRunBindingContext = LinearRunIdentity & Readonly<{
  toolBindings?: Readonly<Record<string, unknown>>;
}>;

const activeFallbackBindings = new Map<string, LinearRunBinding>();

/** Strictly reads the four-field plugin-owned binding passed to one embedded run. */
export function parseLinearRunBinding(value: unknown): LinearRunBinding | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 4) return undefined;
  const { linearSessionId, contextId, deliveryId, teamId } = value;
  return isNonEmptyString(linearSessionId) && isNonEmptyString(contextId) &&
    isNonEmptyString(deliveryId) && isNonEmptyString(teamId)
    ? { linearSessionId, contextId, deliveryId, teamId }
    : undefined;
}

export function readLinearRunBinding(
  toolBindings: Readonly<Record<string, unknown>> | undefined,
): LinearRunBinding | undefined {
  return parseLinearRunBinding(toolBindings?.[LINEAR_RUN_BINDING_KEY]);
}

/**
 * Beta.7 compatibility seam for the Codex bridge, which can drop toolBindings.
 * The host binding remains authoritative; an exact-identity disagreement fails.
 */
export function resolveLinearRunBinding(
  context: LinearRunBindingContext,
): LinearRunBinding | undefined {
  const hostValue = context.toolBindings?.[LINEAR_RUN_BINDING_KEY];
  const hostBinding = parseLinearRunBinding(hostValue);
  if (hostValue !== undefined && hostBinding === undefined) {
    throw new LinearRunBindingError("invalid_host_binding");
  }
  const fallbackBinding = readFallbackBinding(context);
  if (hostBinding !== undefined && fallbackBinding !== undefined &&
    !sameBinding(hostBinding, fallbackBinding)) {
    throw new LinearRunBindingError("binding_conflict");
  }
  return hostBinding ?? fallbackBinding;
}

export async function withLinearRunBindingFallback<T>(
  identity: LinearRunIdentity,
  binding: LinearRunBinding,
  run: () => Promise<T>,
): Promise<T> {
  const key = identityKey(identity);
  if (key === undefined || parseLinearRunBinding(binding) === undefined) {
    throw new LinearRunBindingError("invalid_fallback_binding");
  }
  if (activeFallbackBindings.has(key)) {
    throw new LinearRunBindingError("binding_conflict");
  }
  activeFallbackBindings.set(key, binding);
  try {
    return await run();
  } finally {
    activeFallbackBindings.delete(key);
  }
}

export class LinearRunBindingError extends Error {
  constructor(readonly code: "invalid_host_binding" | "invalid_fallback_binding" | "binding_conflict") {
    super("Linear run binding is unavailable");
    this.name = "LinearRunBindingError";
  }
}

function readFallbackBinding(identity: LinearRunIdentity): LinearRunBinding | undefined {
  const key = identityKey(identity);
  return key === undefined ? undefined : activeFallbackBindings.get(key);
}

function identityKey(identity: LinearRunIdentity): string | undefined {
  const { agentId, sessionId, sessionKey } = identity;
  return isNonEmptyString(agentId) && isNonEmptyString(sessionId) && isNonEmptyString(sessionKey)
    ? JSON.stringify([agentId, sessionId, sessionKey])
    : undefined;
}

function sameBinding(left: LinearRunBinding, right: LinearRunBinding): boolean {
  return left.linearSessionId === right.linearSessionId && left.contextId === right.contextId &&
    left.deliveryId === right.deliveryId && left.teamId === right.teamId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
