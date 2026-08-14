import type { RelayServiceState } from "./relay/service.js";

export type IntegrationState = Readonly<{
  accountId?: string;
  running: boolean;
  connected: boolean;
  statusState: RelayServiceState;
}>;

type IntegrationStateListener = (state: IntegrationState) => void;

let publishedState: IntegrationState = {
  running: false,
  connected: false,
  statusState: "stopped",
};
const stateListeners = new Set<IntegrationStateListener>();

export function publishIntegrationState(state: IntegrationState): void {
  publishedState = { ...state };
  for (const listener of stateListeners) {
    try {
      listener({ ...publishedState });
    } catch {
      // Status reporting must not interrupt relay state transitions.
    }
  }
}

export function subscribeIntegrationState(listener: IntegrationStateListener): () => void {
  stateListeners.add(listener);
  listener({ ...publishedState });
  return () => stateListeners.delete(listener);
}
