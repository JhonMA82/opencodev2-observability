export interface EventPayload {
  source_app: string;
  session_id: string;
  event_type: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  payload?: Record<string, unknown>;
}

function serverUrl(): string {
  return process.env.OPENCODE_OBSERVABILITY_URL || "http://localhost:4000";
}

function debugEnabled(): boolean {
  return process.env.OPENCODE_OBSERVABILITY_DEBUG === "1";
}

/** Small explicit timeout: observability must never block a tool call. */
const SEND_TIMEOUT_MS = 2000;

/** Bound each rich field before the final event-level guard. */
export const MAX_FIELD_CHARS = 8000;

/** Hard ceiling for the final serialized event body sent to the local server. */
export const MAX_EVENT_CHARS = 16000;

/** Drop new observations instead of allowing an unbounded fetch fan-out. */
export const MAX_IN_FLIGHT = 32;

function debugLog(message: string): void {
  if (debugEnabled()) {
    console.log(`[Observability] ${message}`);
  }
}

let outageNotified = false;
let inFlight = 0;

function notifyFailureOnce(message: string): void {
  if (outageNotified) return;
  outageNotified = true;
  debugLog(message);
}

export function notifyRecovered(): void {
  outageNotified = false;
}

function scalarCost(value: unknown): number {
  const encoded = JSON.stringify(value);
  return encoded?.length ?? 0;
}

/**
 * Recursively bound one value. This is a first-pass readability-preserving
 * limit; serializeEvent() below is the authoritative whole-event ceiling.
 */
export function boundValue<T>(value: T, budget: number = MAX_FIELD_CHARS): { value: T; truncated: boolean } {
  let remaining = budget;
  let truncated = false;

  function walk(input: unknown): unknown {
    if (typeof input === "string") {
      if (input.length <= remaining) {
        remaining -= input.length;
        return input;
      }
      truncated = true;
      const kept = input.slice(0, Math.max(0, remaining));
      remaining = 0;
      return kept;
    }

    if (Array.isArray(input)) {
      const out: unknown[] = [];
      for (const item of input) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        out.push(walk(item));
      }
      if (out.length < input.length) truncated = true;
      return out;
    }

    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      const entries = Object.entries(input as Record<string, unknown>);
      for (const [key, entry] of entries) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const keyCost = Math.min(key.length, remaining);
        remaining -= keyCost;
        out[key] = walk(entry);
      }
      if (Object.keys(out).length < entries.length) truncated = true;
      return out;
    }

    const cost = scalarCost(input);
    if (cost > remaining) {
      truncated = true;
      remaining = 0;
      return undefined;
    }
    remaining -= cost;
    return input;
  }

  return { value: walk(value) as T, truncated };
}

export function boundEvent(payload: EventPayload): { event: EventPayload; truncated: boolean } {
  const input = boundValue(payload.tool_input);
  const output = boundValue(payload.tool_output);
  const extra = boundValue(payload.payload);
  const truncated = input.truncated || output.truncated || extra.truncated;
  return {
    event: {
      ...payload,
      tool_input: input.value,
      tool_output: output.value,
      payload: extra.value,
    },
    truncated,
  };
}

/**
 * Serialize with an authoritative hard event ceiling. If the useful bounded
 * representation still exceeds the limit, preserve identity + event metadata
 * and drop large tool I/O rather than storing an oversized SQLite blob.
 */
export function serializeEvent(payload: EventPayload, timestamp: number = Date.now()): string {
  const { event, truncated } = boundEvent(payload);
  const body = {
    ...event,
    timestamp,
    payload: {
      ...(event.payload ?? {}),
      ...(truncated ? { truncated: true } : {}),
    },
  };

  const serialized = JSON.stringify(body);
  if (serialized.length <= MAX_EVENT_CHARS) return serialized;

  const fallback = {
    source_app: event.source_app.slice(0, 512),
    session_id: event.session_id.slice(0, 512),
    event_type: event.event_type.slice(0, 256),
    ...(event.tool_name ? { tool_name: event.tool_name.slice(0, 256) } : {}),
    timestamp,
    payload: {
      truncated: true,
      oversized: true,
      originalChars: serialized.length,
    },
  };

  const bounded = JSON.stringify(fallback);
  if (bounded.length > MAX_EVENT_CHARS) {
    throw new Error("bounded observability envelope exceeds MAX_EVENT_CHARS");
  }
  return bounded;
}

/**
 * Best-effort sender. A local HTTP failure, an offline server, a timeout or
 * an invalid response must never fail a tool, block completion, abort
 * OpenCode or retry forever.
 */
export async function sendEvent(payload: EventPayload): Promise<void> {
  if (inFlight >= MAX_IN_FLIGHT) {
    notifyFailureOnce(`observability saturated at ${MAX_IN_FLIGHT} in-flight sends; dropping new events`);
    return;
  }

  inFlight += 1;
  try {
    const response = await fetch(`${serverUrl()}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEvent(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      notifyFailureOnce(`event lost (server responded ${response.status}); OpenCode continues`);
      return;
    }
    notifyRecovered();
    await response.arrayBuffer().catch(() => undefined);
  } catch {
    notifyFailureOnce("observability server unreachable; events dropped until it recovers (debug with OPENCODE_OBSERVABILITY_DEBUG=1)");
  } finally {
    inFlight -= 1;
  }
}
