# Verificación con OpenCode V2 real

Fecha: 2026-09-21. OpenCode `v2.0.12` (contrato `>=2.0.4 <3`).
Modelo: `opencode/muse-spark-1.3-contributor-free`, agente `build`.

Procedimiento:

```text
DB_PATH=/tmp/obs-e2e/events.db PORT=4000 bun apps/server/src/index.ts
./scripts/setup.sh   # instala en ~/.config/opencode/plugins/opencode-observability
opencode plugin list # muestra el plugin (source .../opencode-observability)
cd /tmp/obs-e2e/proj
opencode run --standalone --model ... --auto "Read the file notes.txt ..."
opencode run --standalone --model ... --auto "Run the shell command 'exit 3' ..."
curl "http://localhost:4000/events/recent?limit=60"
```

## Observado de verdad (SQLite + `/events/recent`)

Dos sesiones reales (`ses_f3a0575d6...`, `ses_f3a0482db...`), 16 eventos:

| Evento | Evidencia |
|---|---|
| `session.execution.started` / `.succeeded` | presentes en ambas sesiones, mismo `sessionID` |
| `session.step.started` | `agent: "build"`, `model: {id, providerID: "opencode", variant: "default"}`, `started`, `assistantMessageID` |
| `session.step.ended` | `finish: "tool-calls"` y `"stop"`, `tokens: {input, output, reasoning, cache:{read,write}}`, `cost: 0` |
| `tool.execute.before` | `tool_name: "read"`/`"shell"`, `tool_input` real, `payload: {agent, messageID, callID}` |
| `tool.execute.after` | `status: "completed"`, `durationMs` (28 ms read, 206 ms shell), `tool_output` real |
| `sessions` | `source_app: "proj"` (ya no `unknown`), `status: "completed"`, correlación por `sessionID` real |
| `source_app` | `"proj"` = basename de `/tmp/obs-e2e/proj` vía `ctx.location` |

## No observado en vivo (limitaciones reales)

- **`session.created`**: ausente en ambas sesiones `opencode run`. La suscripción
  arranca en `setup`; la creación la precede o no se reemite. La correlación no
  se ve afectada (todos los eventos traen el `sessionID` real).
- **`session.deleted`, `execution.failed/interrupted`, `step.failed`,
  `retry.scheduled`, `compaction.ended`, `status`, `idle`, `permission.replied`**:
  no ocurrieron en estas dos sesiones cortas. Su normalización está cubierta por
  tests deterministas (`plugins/opencode-observability/tests/normalize.test.ts`)
  contra las formas verificadas en `@opencode/client@2.0.4`.
- **`tool.execute.after` con `status: "error"`**: OpenCode reportó el shell con
  `exit 3` como `status: "completed"` con el código de salida dentro de `output`
  (`output: {exit: 3, ...}`, `metadata: {exit: 3}`). El adaptador registra
  fielmente lo que V2 expone; la rama `error` está cubierta por tests.
- **Dashboard**: `vite build` compila; los datos que consume (`/events/recent`,
  `/sessions/active`, WS) se verificaron por API. No se hizo captura visual.

## Qué sí rompe / no rompe

- Con el servidor apagado el plugin no afecta a OpenCode (best-effort probado
  en `tests/sender.test.ts`; el `run` con servidor caído no se probó en vivo
  porque el servidor estuvo levantado durante la prueba).
- Cleanup (abort + dispose + limpieza del mapa) probado en
  `tests/plugin.test.ts`, no en vivo.
