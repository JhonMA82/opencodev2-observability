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

For development/verification, the canonical repository check is:

```bash
bun run check
```

To remove only the globally installed OpenCode plugin:

```bash
bun run uninstall
```

The dashboard/server data is not deleted by uninstall.

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
- Optional AndMar semantic events (`routing`, `delegation`, `verification`, `completion`) with outcome-aware dashboard severity

## OpenCode V2 Compatibility

Sección en español: el contrato V2 que este proyecto asume está documentado en
[`docs/OPENCODE-V2.md`](docs/OPENCODE-V2.md). Resumen:

- **API package:** `@opencode/plugin@2.0.12` (dependencia de runtime: `src/index.ts`
  lo importa, así que debe estar en `dependencies`, nunca en `devDependencies`).
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
  - Cada campo rico se acota primero y el cuerpo JSON final tiene un límite duro de
    16 000 caracteres; al excederlo se conserva identidad/metadata y se marca
    `truncated: true`.
  - `session.compaction.ended` es el evento detallado que usa este adapter.
    OpenCode 2.0.4 también define `session.compacted` como evento transicional
    (`durability: "ephemeral"`, solo `sessionID`); el adapter no lo usa
    intencionadamente para la observabilidad detallada de compactación.
    `session.error`, `message.updated` y `stop` se conservan en el backend
    únicamente por compatibilidad con datos antiguos.

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