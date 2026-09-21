# Contrato OpenCode V2

Mapa del contrato de OpenCode V2 del que depende este proyecto. Verificado contra
`@opencode/plugin@2.0.4` y `@opencode/client@2.0.4` (los `.d.ts` de `2.0.4` son
idénticos a los de `2.0.10` en `promise/plugin.d.ts`, `promise/tool.d.ts`,
`promise/event.d.ts` y `promise/registration.d.ts`; diff comprobado el 2026-09-21).
Si OpenCode cambia su API, este documento dice exactamente dónde mirar.

Implementación canónica: `plugins/opencode-observability/src/`.

## Entrypoint

```ts
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "opencode.observability",
  async setup(ctx) {
    // ... registrar hooks y suscripción ...
    return async () => {
      // ... dispose ...
    };
  },
});
```

- `setup` recibe el `Context` V2 y devuelve un cleanup (sync o async).
- Fuente: `dist/promise/plugin.d.ts` de `@opencode/plugin`.

## Tool hooks

Fuente: `dist/promise/tool.d.ts` (`ToolDomain.hook`, `ToolHooks`).

```ts
await ctx.tool.hook("execute.before", (input) => { /* ... */ });
await ctx.tool.hook("execute.after", (input) => { /* ... */ });
```

- Devuelven `Promise<Registration>` (`{ dispose(): Promise<void> }`); se guardan y
  se liberan en el cleanup. Fuente: `dist/promise/registration.d.ts`.
- `execute.before` expone `{ tool, sessionID, agent, messageID, id, input }`.
  No existen `output.args`, `input.args` ni `input.worktree` como contrato.
- `execute.after` expone lo mismo más el discriminante:
  `{ status: "completed", result }` o `{ status: "error", error }`.
  - `result: Tool.Result` = `{ output?, content?, metadata? }`.
  - `error: Tool.Error` = `{ message, error?, metadata? }`.
  - No se asume `result.duration`: la duración se calcula correlacionando
    `before`/`after` en RAM por `callID` (`input.id`), con mapa acotado
    (1000 entradas, se elimina tras el `after`, se limpia en dispose).
- Sin `sessionID` (vacío/ausente) no se observa nada. No hay `generateSessionId()`.

Normalización: `src/normalize.ts` (`normalizeToolBefore`, `normalizeToolAfter`).

## Suscripción a eventos

Fuente: `dist/promise/client.d.ts` (`event.subscribe`) y `shared-events.d.ts`.

```ts
const abort = new AbortController();
const running = (async () => {
  try {
    for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
      // event.type + event.data
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      // diagnóstico acotado (solo con OPENCODE_OBSERVABILITY_DEBUG=1)
    }
  }
})();
// cleanup: abort.abort(); ...; await running;
```

- Sin polling y sin leer internals: el stream ya trae la información.
- Forma de cada evento: `{ id, created, type, location?, data }` (**`data`, no
  `properties`**). Fuente: tipos generados `V2Event` en
  `@opencode/client/dist/promise/generated/types.d.ts`.

## Eventos normalizados

| Evento V2 (`event.type`) | Correlación | Resumen guardado en `payload` |
|---|---|---|
| `session.created` | `data.sessionID` | `projectID`, `title`, `agent`, `model{id,providerID,variant}`, `parentID` |
| `session.deleted` | `data.sessionID` | — |
| `session.execution.started` | `data.sessionID` | — |
| `session.execution.succeeded` | `data.sessionID` | — |
| `session.execution.failed` | `data.sessionID` | `error{type,message,status}` |
| `session.execution.interrupted` | `data.sessionID` | `reason` |
| `session.step.started` | `data.sessionID` | `assistantMessageID`, `agent`, `model{...}`, `started` |
| `session.step.ended` | `data.sessionID` | `assistantMessageID`, `finish`, `cost`, `tokens{input,output,reasoning,cache}` |
| `session.step.failed` | `data.sessionID` | `assistantMessageID`, `error{...}`, `cost?`, `tokens?` |
| `session.retry.scheduled` | `data.sessionID` | `assistantMessageID`, `attempt`, `at`, `error` |
| `session.compaction.ended` | `data.sessionID` | `reason`, `model?`, `tokens?` |
| `session.status` | `data.sessionID` | `status` |
| `session.idle` | `data.sessionID` | — |
| `permission.replied` | `data.sessionID` | `requestID`, `reply` |

Notas verificadas (no inventar):

- En V2 la compactación es `session.compaction.ended`; **`session.compacted` no existe**.
- **`session.error`, `message.updated` y `stop` no existen** en el `V2Event` de 2.0.4;
  se conservan en `EventType` del servidor/cliente solo por filas antiguas.
- Los `session.step.*` no traen texto de razonamiento: solo metadata operativa
  (agente, modelo, tokens, coste, finish, error). No se captura chain-of-thought.
- `model` = `ModelRef{id, providerID, variant?}`; `tokens` = `TokenUsageInfo`;
  `error` = `SessionStructuredError{type, message, status?}`.

## Identidad de proyecto

- `ctx.location: Location.Info` = `{ directory, project: { id, directory, canonical } }`.
- `source_app` = último segmento de `project.canonical` (fallback: `directory`).
- No se usa `process.cwd()` como fuente primaria.
- La identidad de sesión (`sessionID`) nunca se mezcla con la del proyecto.

## Envío best-effort

`src/sender.ts` (`sendEvent`):

- `POST {url}/events` con `AbortSignal.timeout(2000)`.
- Fallo HTTP, servidor apagado, timeout o respuesta inválida → se pierde la
  observación y OpenCode continúa. Sin reintentos, sin colas, sin outbox.
- Diagnóstico acotado: un solo aviso hasta que el servidor responde
  (más detalle con `OPENCODE_OBSERVABILITY_DEBUG=1`). Sin spam por evento.
- Los hooks disparan `void sendEvent(...)`: nunca bloquean la tool.

## Payloads acotados

- `boundValue(value, budget=8000)`: trunca strings recursivamente preservando la
  forma; devuelve `{ value, truncated }` de forma determinista.
- `boundEvent` lo aplica a `tool_input`, `tool_output` y `payload`; si algo se
  cortó, el evento lleva `payload.truncated: true`.
- No se guardan secretos deliberadamente ni razonamiento privado.

## Limpieza

En dispose, en orden: `abort.abort()`, `dispose()` de cada hook registrado,
limpiar el mapa de correlación, `await running`. Sin timers ni listeners huérfanos.

## Frontera conservada

```text
OpenCode event → adapter V2 → EventPayload normalizado → HTTP /events → SQLite
```

`EventPayload{ source_app, session_id, event_type, tool_name?, tool_input?,
tool_output?, payload? }`. El esquema SQLite no depende de estructuras internas
de OpenCode; `payload` transporta metadata V2 sin migraciones.

La tabla `sessions` conserva el `source_app` observado (ya no `unknown`) y su
`status` solo cambia con eventos reales: `active` (created/execution.started),
`completed` (execution.succeeded/deleted), `failed` (execution.failed),
`interrupted` (execution.interrupted). Nunca se infiere por inactividad.

## Reserva AndMar (no implementada)

`event_type` + `payload` bastan para una futura extensión
(`andmar.intake/routing/delegation/verification/completion/lifecycle`).
No crear SDK ni abstracciones por anticipación.

## Verificación real

Ver `docs/VERIFICATION-V2.md` (generado tras la prueba con OpenCode V2 real):
qué eventos se observaron de verdad en SQLite/dashboard y con qué versión.
No afirmar compatibilidad basándose solo en mocks o en `tsc`.
