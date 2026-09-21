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

/** Deterministic bound for serialized tool I/O. Large reads / test outputs
 *  must not become huge SQLite blobs. */
export const MAX_FIELD_CHARS = 8000;

function debugLog(message: string): void {
  if (debugEnabled()) {
    console.log(`[Observability] ${message}`);
  }
}

let outageNotified = false;

function notifyFailureOnce(message: string): void {
  if (outageNotified) return;
  outageNotified = true;
  debugLog(message);
}

export function notifyRecovered(): void {
  outageNotified = false;
}

/**
 * Recursively truncate strings inside a value so the serialized form stays
 * within `budget` chars. Shape is preserved; oversized leaves are sliced and
 * the caller is told whether anything was cut via `truncated`.
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
      for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        // Keys are short identifiers; count them but never slice them.
        remaining -= Math.min(key.length, remaining);
        out[key] = walk(entry);
      }
      if (Object.keys(out).length < Object.keys(input as Record<string, unknown>).length) truncated = true;
      return out;
    }
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
 * Best-effort sender. A local HTTP failure, an offline server, a timeout or
 * an invalid response must never fail a tool, block completion, abort
 * OpenCode or retry forever. When the server is down the observation is lost
 * and OpenCode continues — that is the correct trade-off for this tool.
 */
export async function sendEvent(payload: EventPayload): Promise<void> {
  try {
    const { event, truncated } = boundEvent(payload);
    const body = {
      ...event,
      timestamp: Date.now(),
      payload: {
        ...(event.payload ?? {}),
        ...(truncated ? { truncated: true } : {}),
      },
    };
    const response = await fetch(`${serverUrl()}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      notifyFailureOnce(`event lost (server responded ${response.status}); OpenCode continues`);
      return;
    }
    notifyRecovered();
    // Drain the body so the connection can be reused; ignore its content.
    await response.arrayBuffer().catch(() => undefined);
  } catch {
    // Server offline, timeout, invalid response: drop the observation.
    notifyFailureOnce("observability server unreachable; events dropped until it recovers (debug with OPENCODE_OBSERVABILITY_DEBUG=1)");
  }
}
