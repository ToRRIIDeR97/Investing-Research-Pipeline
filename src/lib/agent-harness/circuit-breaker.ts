import { ProviderError, type HarnessErrorCategory } from "./errors";

export type ProviderCircuitState = "closed" | "open";

type Circuit = {
  consecutiveFailures: number;
  openedAt?: string;
};

const circuits = new Map<string, Circuit>();

function circuitKey(scopeId: string, endpoint: string, model: string) {
  return `${scopeId}\u0000${endpoint}\u0000${model}`;
}

export function providerCircuitSnapshot(scopeId: string, endpoint: string, model: string) {
  const circuit = circuits.get(circuitKey(scopeId, endpoint, model));
  return {
    state: circuit?.openedAt ? "open" as const : "closed" as const,
    consecutiveFailures: circuit?.consecutiveFailures || 0,
    openedAt: circuit?.openedAt,
  };
}

export function assertProviderCircuitAvailable(scopeId: string, endpoint: string, model: string) {
  const snapshot = providerCircuitSnapshot(scopeId, endpoint, model);
  if (snapshot.state === "open") {
    throw new ProviderError("Provider circuit is open for this research run", "provider_unavailable", {
      circuitState: snapshot.state,
      consecutiveFailures: snapshot.consecutiveFailures,
      openedAt: snapshot.openedAt,
    });
  }
  return snapshot;
}

export function recordProviderSuccess(scopeId: string, endpoint: string, model: string) {
  circuits.delete(circuitKey(scopeId, endpoint, model));
  return providerCircuitSnapshot(scopeId, endpoint, model);
}

export function recordProviderFailure(scopeId: string, endpoint: string, model: string) {
  const key = circuitKey(scopeId, endpoint, model);
  const current = circuits.get(key) || { consecutiveFailures: 0 };
  current.consecutiveFailures += 1;
  if (current.consecutiveFailures >= 2 && !current.openedAt) current.openedAt = new Date().toISOString();
  circuits.set(key, current);
  return providerCircuitSnapshot(scopeId, endpoint, model);
}

export function qualifiesForProviderCircuit(category: HarnessErrorCategory, timeoutReason?: string | null) {
  if (timeoutReason === 'total' || timeoutReason === 'caller' || category === 'budget_exhausted') return false;
  return timeoutReason === "inactivity" ||
    category === "provider_timeout" || category === "connection" || category === "malformed_stream";
}

export function resetProviderCircuitsForTests() {
  circuits.clear();
}
