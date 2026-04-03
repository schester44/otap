# otap

Local observability TUI — tap into Datadog traces and Sentry errors right in your terminal.

Single command. No config. Starts receivers, renders a TUI, tears down on exit.

## Quick Start

```bash
# Via brew
brew tap schester44/tap
brew install otap
otap

# Or run from source
./bin/otap

# Start your app — dd-trace already defaults to localhost:8126
DD_API_KEY=local SENTRY_DNS=http://key@localhost:8137/1 yarn start
```

## What It Does

Embeds two HTTP receivers and a terminal UI in a single process:

- **Datadog receiver** (`:8126`) — accepts `dd-trace` msgpack payloads (`/v0.3/traces`, `/v0.4/traces`, etc.). Uses the default DD Agent port so no extra config needed.
- **Sentry receiver** (`:8137`) — accepts `@sentry/node` envelope payloads (`/api/{id}/envelope/`)
- **TUI** — OpenTUI React app with trace waterfall, span inspection, error viewer, keyboard navigation

Noisy spans (pgboss polling, etc.) are filtered by default.

## Keyboard

| Key | Action |
|-----|--------|
| `↑↓` / `jk` | Navigate list |
| `enter` | Inspect span tags/meta/metrics |
| `esc` | Back to trace list |
| `Tab` | Switch Traces ↔ Errors |
| `s` / `S` | Cycle service filter forward/backward |
| `←→` / `hl` | Scroll detail pane |
| `PgUp/PgDn` | Jump 10 items |
| `Space` | Pause/resume |
| `x` | Clear all data |
| `Ctrl+C` | Quit |

## Filtering Noisy Spans

pgboss polling queries are dropped by default. Add more patterns with `--drop`:

```bash
# Drop additional patterns
otap --drop health_check --drop "SELECT 1"
```

## Multi-Service Support

Captures traces from **all** instrumented apps on your machine (any app sending to `localhost:8126`). Press `s` to cycle through discovered services as a filter.

## Agent API

otap exposes a JSON API on port 8126 for LLM/agent integration:

| Endpoint | Description |
|----------|-------------|
| `GET /api/summary` | Trace/error/service counts |
| `GET /api/services` | List discovered services |
| `GET /api/traces?service=X&limit=N` | List traces |
| `GET /api/traces/:id` | Single trace with all spans |
| `GET /api/errors?level=X&limit=N` | List errors |
| `POST /api/clear` | Clear all data |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `DD_PORT` | `8126` | Datadog receiver port |
| `SENTRY_PORT` | `8137` | Sentry receiver port |

## Requirements

- [Bun](https://bun.sh) — dependencies auto-install on first run
