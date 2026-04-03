# Skill: otap — Trace & Error Inspection

Use this skill when you need to inspect application traces, spans, or Sentry errors from the local development environment. otap must be running (`otap` or `tools/otap/bin/otap`).

## Starting otap

```bash
# Basic
otap

# Filter noisy spans by resource pattern
otap --drop health_check --drop "SELECT 1"
```

## Checking if otap is running

```bash
otap summary 2>/dev/null || echo "otap is not running"
```

## CLI Commands

All commands query the running otap instance. Output is JSON.

### otap summary

High-level overview — start here.

```bash
otap summary
```

Returns:
```json
{
  "traceCount": 42,
  "errorCount": 3,
  "services": ["risk-api", "worker", "payment-svc"],
  "spanCount": 156
}
```

### otap services

List all discovered services.

```bash
otap services
```

### otap traces

List recent traces. Filter by service name and limit results.

```bash
# All recent traces (default limit: 50)
otap traces

# Only traces from risk-api
otap traces --service risk-api --limit 10
```

Each trace contains:
- `traceId` — unique trace identifier
- `service` — service name from the root span
- `rootSpan` — the entry-point span (has `resource`, `duration`, `error`, `meta`)
- `spans[]` — all spans in the trace, each with:
  - `name` — operation name (e.g. `express.request`, `pg.query`)
  - `resource` — specific resource (e.g. `POST /graphql`, `SELECT * FROM policies`)
  - `service` — which service produced this span
  - `duration` — in nanoseconds
  - `error` — 0 or 1
  - `meta` — key-value tags (e.g. `http.method`, `db.type`, `http.status_code`)
  - `parentId` — parent span ID for tree reconstruction

### otap trace TRACE_ID

Get a single trace with all its spans.

```bash
otap trace 1234567890
```

### otap errors

List recent Sentry errors.

```bash
# All errors
otap errors

# Only error-level (not warnings)
otap errors --level error --limit 5
```

Each error contains:
- `level` — error, warning, info
- `message` — error message
- `exception.values[]` — exception chain with types and stacktraces
- `stacktrace.frames[]` — stack frames with `filename`, `function`, `lineno`, `in_app`
- `tags` — key-value metadata
- `contexts` — additional context (including Datadog trace correlation)
- `breadcrumbs.values[]` — events leading up to the error

### otap clear

Clear all stored traces and errors.

```bash
otap clear
```

## Typical Workflows

### Investigate a slow endpoint

```bash
# 1. See what services are active
otap summary

# 2. Get recent traces for the API, look for slow ones
otap traces --service risk-api --limit 20 | \
  python3 -c "
import sys, json
traces = json.load(sys.stdin)
for t in traces:
    root = t.get('rootSpan') or {}
    dur_ms = root.get('duration', 0) / 1e6
    resource = root.get('resource', '?')
    spans = len(t.get('spans', []))
    err = ' ERR' if root.get('error') else ''
    print(f'{dur_ms:8.1f}ms  {spans:2d}sp  {resource}{err}')
"

# 3. Drill into a specific slow trace
otap trace TRACE_ID
```

### Check for errors after a code change

```bash
# See if any new errors appeared
otap errors --limit 5 | \
  python3 -c "
import sys, json
errors = json.load(sys.stdin)
for e in errors:
    print(f'{e[\"level\"].upper():7s} {e[\"message\"][:80]}')
    frames = (e.get('stacktrace') or {}).get('frames') or \
             (((e.get('exception') or {}).get('values') or [{}])[0].get('stacktrace') or {}).get('frames') or []
    for f in reversed(frames[-3:]):
        if f.get('in_app', True):
            print(f'        {f.get(\"function\",\"?\")}  {f.get(\"filename\",\"?\")}:{f.get(\"lineno\",\"\")}')
"
```

## Duration Units

Span durations are in **nanoseconds**. Quick conversion:
- `÷ 1e6` → milliseconds
- `÷ 1e9` → seconds
