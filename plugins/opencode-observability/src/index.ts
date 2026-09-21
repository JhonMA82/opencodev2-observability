import { Plugin } from "@opencode/plugin";
import {
  normalizeStreamEvent,
  normalizeToolAfter,
  normalizeToolBefore,
} from "./normalize";
import { sendEvent } from "./sender";

interface PendingToolCall {
  startedAt: number;
}

/** Upper bound for in-flight tool calls kept only to compute durations. */
const MAX_PENDING_CALLS = 1000;

function debugEnabled(): boolean {
  return process.env.OPENCODE_OBSERVABILITY_DEBUG === "1";
}

function debugLog(message: string): void {
  if (debugEnabled()) {
    console.log(`[Observability] ${message}`);
  }
}

/**
 * Human-readable project name from the V2 location context. The session
 * identity always stays separate from the project identity.
 */
function projectNameOf(location: {
  readonly directory?: string;
  readonly project?: { readonly canonical?: string; readonly directory?: string };
}): string {
  const canonical = location.project?.canonical || location.project?.directory || location.directory || "";
  const parts = canonical.split(/[/\\]/).filter((part) => part.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : "unknown-project";
}

export default Plugin.define({
  id: "opencode.observability",

  async setup(ctx) {
    const sourceApp = projectNameOf(ctx.location);
    const registrations: { dispose: () => Promise<void> }[] = [];
    const pendingCalls = new Map<string, PendingToolCall>();
    const abort = new AbortController();

    debugLog(`plugin loaded for project: ${sourceApp}`);

    function trackCallStart(callID: string): void {
      if (pendingCalls.size >= MAX_PENDING_CALLS) {
        const oldest = pendingCalls.keys().next();
        if (!oldest.done) pendingCalls.delete(oldest.value);
      }
      pendingCalls.set(callID, { startedAt: Date.now() });
    }

    function takeCallDuration(callID: string): number | undefined {
      const pending = pendingCalls.get(callID);
      pendingCalls.delete(callID);
      if (!pending) return undefined;
      return Math.max(0, Date.now() - pending.startedAt);
    }

    registrations.push(
      await ctx.tool.hook("execute.before", (input) => {
        if (!input.sessionID) return;
        trackCallStart(input.id);
        const normalized = normalizeToolBefore(sourceApp, input);
        // Fire-and-forget: observability must never delay a tool call.
        if (normalized) void sendEvent(normalized);
      }),
    );

    registrations.push(
      await ctx.tool.hook("execute.after", (input) => {
        if (!input.sessionID) return;
        const normalized = normalizeToolAfter(sourceApp, input, takeCallDuration(input.id));
        if (normalized) void sendEvent(normalized);
      }),
    );

    const running = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          try {
            const normalized = normalizeStreamEvent(sourceApp, event);
            if (normalized) void sendEvent(normalized);
          } catch (error) {
            debugLog(`event handler error: ${String(error)}`);
          }
        }
      } catch (error) {
        // AbortError on dispose is expected; anything else is a bounded diagnostic.
        if (!abort.signal.aborted) {
          debugLog(`event subscription ended: ${String(error)}`);
        }
      }
    })();

    return async () => {
      abort.abort();
      for (const registration of registrations) {
        try {
          await registration.dispose();
        } catch (error) {
          debugLog(`registration dispose error: ${String(error)}`);
        }
      }
      registrations.length = 0;
      pendingCalls.clear();
      await running;
      debugLog("disposed");
    };
  },
});
