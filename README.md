# OpenCode Observability

> **OpenCode V2 only** — minimum tested version: **2.0.4** (`@opencode/plugin@2.0.4`,
> `engines.opencode >=2.0.4 <3`). No compatible con OpenCode V1.

Real-time monitoring and visualization for OpenCode agents.

![Dashboard](docs/dashboard-preview.png)

## Quick Start

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Install the Plugin

```bash
./scripts/setup.sh
```

### 3. Start the System

```bash
./scripts/start-system.sh
```

Opens:
- Dashboard: http://localhost:5173
- API: http://localhost:4000

This installs a **global plugin** that tracks ALL your OpenCode sessions across ALL projects.

**Restart OpenCode** to activate.

## Requirements

- **Bun** 1.0+
- **OpenCode** (the AI agent)
- **Linux, WSL, or macOS**

## What It Tracks

- Tool executions (before/after, with real completed/error status)
- Session lifecycle (created, execution started/succeeded/failed/interrupted, deleted)
- Step lifecycle (started/ended/failed, with agent, model, tokens and cost when available)
- Retry scheduling, compaction, idle status and permission replies
- Full I/O capture with JSON details (bounded: oversized payloads are truncated and flagged)

## OpenCode V2 Compatibility

Sección en español: el contrato V2 que este proyecto asume está documentado en
[`docs/OPENCODE-V2.md`](docs/OPENCODE-V2.md). Resumen:

- **API package:** `@opencode/plugin@2.0.4` (solo tipos/build; el runtime lo pone OpenCode).
- **Entrypoint:** `Plugin.define({ id: "opencode.observability", setup })`.
- **Hooks usados:** `ctx.tool.hook("execute.before")`, `ctx.tool.hook("execute.after")`.
- **Eventos usados:** `ctx.event.subscribe()` — `session.created/deleted`,
  `session.execution.started/succeeded/failed/interrupted`, `session.step.started/ended/failed`,
  `session.retry.scheduled`, `session.compaction.ended`, `session.status`, `session.idle`,
  `permission.replied`.
- **Ubicación global del plugin:** `~/.config/opencode/plugins/opencode-observability/`
  (Linux; ver `scripts/setup.sh` para macOS/Windows). Instalación con `./scripts/setup.sh`.
- **Comprobaciones:**
  - `curl http://localhost:4000/health`
  - `curl "http://localhost:4000/events/recent?limit=5"`
  - `opencode plugin list` debe incluir el plugin tras reiniciar OpenCode.
- **Limitaciones actuales:**
  - Los `sessionID` de OpenCode son autoritativos: sin `sessionID` no se envía nada
    (nunca se inventan sesiones).
  - Si el servidor está apagado, la observación se pierde y OpenCode continúa
    (best-effort, timeout de 2 s, sin reintentos).
  - Los payloads de herramientas se truncan a 8000 caracteres serializados
    (`truncated: true` en `payload`).
  - `session.compacted`, `session.error`, `message.updated` y `stop` son nombres V1:
    no existen en V2 y solo se conservan en el backend por compatibilidad
    con datos antiguos.

## Event Flow

```
OpenCode → Plugin → HTTP POST → Bun Server → SQLite → WebSocket → Vue Dashboard
```

## Configuration

Optional environment variables:

```bash
# Server (apps/server/.env)
PORT=4000
DB_PATH=./data/events.db

# Plugin (.env.opencode.observability)
OPENCODE_OBSERVABILITY_URL=http://localhost:4000
```

## Credits

Inspired by [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) by [@disler](https://github.com/disler).

## License

MIT