import type { EventPayload } from "./sender";

/**
 * Structural view of the OpenCode V2 contracts this adapter depends on.
 * Verified against `@opencode/plugin@2.0.4` (`dist/promise/tool.d.ts`) and
 * `@opencode/client@2.0.4` (generated `V2Event` union). The plugin compiles
 * against those exact types, so a breaking upstream change fails the build
 * instead of silently changing what we observe.
 */

export interface ToolBeforeInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
}

export interface ToolResultShape {
  readonly output?: unknown;
  readonly content?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolErrorShape {
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ToolAfterInput = {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
} & (
  | { readonly status: "completed"; readonly result: ToolResultShape }
  | { readonly status: "error"; readonly error: ToolErrorShape }
);

/** Wire shape of one item from `ctx.event.subscribe()`: `{ type, data }`. */
export interface V2StreamEvent {
  readonly type: string;
  readonly id?: string;
  readonly created?: number;
  readonly data?: unknown;
}

/**
 * Session events the adapter normalizes. Names are real V2 event types
 * (`session.compaction.ended`, not the V1 `session.compacted` which does
 * not exist in V2).
 */
export const SUPPORTED_STREAM_EVENTS: readonly string[] = [
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.retry.scheduled",
  "session.compaction.ended",
  "session.idle",
  "session.status",
  "permission.replied",
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** OpenCode session IDs are authoritative: missing/empty means drop. */
export function sessionIdOf(data: unknown): string | undefined {
  const record = asRecord(data);
  const raw = record?.["sessionID"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function errorSummary(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof record["type"] === "string") out["type"] = record["type"];
  if (typeof record["message"] === "string") out["message"] = record["message"];
  if (typeof record["status"] === "number") out["status"] = record["status"];
  return out;
}

function modelSummary(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof record["id"] === "string") out["id"] = record["id"];
  if (typeof record["providerID"] === "string") out["providerID"] = record["providerID"];
  if (typeof record["variant"] === "string") out["variant"] = record["variant"];
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Operational subset of a `session.step.*` data payload: agent, model,
 * tokens, cost, finish and error. Never reasoning text or message content.
 */
function stepSummary(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof data["assistantMessageID"] === "string") out["assistantMessageID"] = data["assistantMessageID"];
  if (typeof data["agent"] === "string") out["agent"] = data["agent"];
  const model = modelSummary(data["model"]);
  if (model) out["model"] = model;
  if (typeof data["finish"] === "string") out["finish"] = data["finish"];
  if (typeof data["started"] === "number") out["started"] = data["started"];
  const tokens = asRecord(data["tokens"]);
  if (tokens) out["tokens"] = tokens;
  if (typeof data["cost"] === "number") out["cost"] = data["cost"];
  else {
    const cost = asRecord(data["cost"]);
    if (cost) out["cost"] = cost;
  }
  const error = errorSummary(data["error"]);
  if (error) out["error"] = error;
  if (typeof data["attempt"] === "number") out["attempt"] = data["attempt"];
  if (typeof data["at"] === "number") out["at"] = data["at"];
  return out;
}

export function normalizeToolBefore(sourceApp: string, input: ToolBeforeInput): EventPayload | undefined {
  if (!input.sessionID) return undefined;
  return {
    source_app: sourceApp,
    session_id: input.sessionID,
    event_type: "tool.execute.before",
    tool_name: input.tool,
    tool_input: input.input,
    payload: {
      agent: input.agent,
      messageID: input.messageID,
      callID: input.id,
    },
  };
}

export function normalizeToolAfter(
  sourceApp: string,
  input: ToolAfterInput,
  durationMs?: number,
): EventPayload | undefined {
  if (!input.sessionID) return undefined;
  const basePayload: Record<string, unknown> = {
    agent: input.agent,
    messageID: input.messageID,
    callID: input.id,
    status: input.status,
  };
  if (durationMs !== undefined) basePayload["durationMs"] = durationMs;

  if (input.status === "completed") {
    return {
      source_app: sourceApp,
      session_id: input.sessionID,
      event_type: "tool.execute.after",
      tool_name: input.tool,
      tool_input: input.input,
      tool_output: input.result,
      payload: basePayload,
    };
  }
  return {
    source_app: sourceApp,
    session_id: input.sessionID,
    event_type: "tool.execute.after",
    tool_name: input.tool,
    tool_input: input.input,
    tool_output: { error: input.error.message },
    payload: {
      ...basePayload,
      error: errorSummary(input.error),
    },
  };
}

/**
 * Normalize one `ctx.event.subscribe()` item. Returns `undefined` for event
 * types we do not track or when no authoritative `data.sessionID` exists —
 * such observations are dropped, never assigned an invented session.
 */
export function normalizeStreamEvent(sourceApp: string, event: V2StreamEvent): EventPayload | undefined {
  if (!SUPPORTED_STREAM_EVENTS.includes(event.type)) return undefined;
  const data = asRecord(event.data);
  const sessionID = sessionIdOf(data);
  if (!sessionID || !data) return undefined;

  switch (event.type) {
    case "session.created":
      return {
        source_app: sourceApp,
        session_id: sessionID,
        event_type: event.type,
        payload: {
          projectID: typeof data["projectID"] === "string" ? data["projectID"] : undefined,
          title: typeof data["title"] === "string" ? data["title"] : undefined,
          agent: typeof data["agent"] === "string" ? data["agent"] : undefined,
          model: modelSummary(data["model"]),
          parentID: typeof data["parentID"] === "string" ? data["parentID"] : undefined,
        },
      };
    case "session.step.started":
    case "session.step.ended":
    case "session.step.failed":
    case "session.retry.scheduled":
      return {
        source_app: sourceApp,
        session_id: sessionID,
        event_type: event.type,
        payload: stepSummary(data),
      };
    case "session.execution.failed": {
      return {
        source_app: sourceApp,
        session_id: sessionID,
        event_type: event.type,
        payload: { error: errorSummary(data["error"]) },
      };
    }
    case "session.execution.interrupted":
      return {
        source_app: sourceApp,
        session_id: sessionID,
        event_type: event.type,
        payload: {
          reason: typeof data["reason"] === "string" ? data["reason"] : undefined,
        },
      };
    case "session.compaction.ended":
      return {
        source_app: sourceApp,
        session_id: sessionID,
        event_type: event.type,
        payload: {
          reason: typeof data["reason"] === "string" ? data["reason"] : undefined,
          model: modelSummary(data["model"]),
          tokens: asRecord(data["tokens"]),
        },
      };
    case "session.status":
      return {
        source_app: sourceApp,
        session_id: sessionID,
        event_type: event.type,
        payload: {
          status: typeof data["status"] === "string" ? data["status"] : undefined,
        },
      };
    case "permission.replied":
      return {
        source_app: sourceApp,
        session_id: sessionID,
        event_type: event.type,
        payload: {
          requestID: typeof data["requestID"] === "string" ? data["requestID"] : undefined,
          reply: asRecord(data["reply"]) ?? data["reply"],
        },
      };
    default:
      return {
        source_app: sourceApp,
        session_id: sessionID,
        event_type: event.type,
      };
  }
}
