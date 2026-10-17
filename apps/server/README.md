# `apps/server` — Comfyrizz local server (C2)

Loopback-only HTTP server that serves the built `apps/web` shell and owns the package revisions,
CPU render and SSE events. It is deliberately not a public service: bind is `127.0.0.1`, the token
travels only in the URL fragment, and state-changing requests must be same-origin.

## Start

```bash
cd apps/server
npm start          # builds planner + web, then listens on 127.0.0.1:4319
```

It prints a URL like `http://127.0.0.1:4319/#token=…`. The browser strips the fragment from the
address bar and keeps the token in `sessionStorage`; it is sent as `x-comfyrizz-token` on API
requests and as `?token=` only for the SSE `EventSource` (which cannot set headers).

`COMFYRIZZ_PORT` overrides the port, `COMFYRIZZ_RUNTIME` overrides the state directory, and
`COMFYRIZZ_TOKEN` fixes the token (tests use this). The generated token is written to
`.runtime/server-token` with mode `0600`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Public, host-checked: `{ok:true, service:"comfyrizz-local"}` |
| `GET` | `/api/package/:id` | `{package, revision}` |
| `PATCH` | `/api/package/:id` | `{baseRevision, package}`; mismatch → `409 {currentRevision}`; invalid → `422 {details}` |
| `POST` | `/api/render` | `{packageId, baseRevision}`, or a C1-style `{package}` draft; returns `video/mp4` |
| `GET` | `/api/events` | `text/event-stream`, replay from `Last-Event-ID`/`lastEventId` |

Render events: `render.started`, `render.log`, `render.finished`, `render.failed`,
`package.updated`. The route is synchronous (the HTTP response is the MP4); SSE carries the same
lifecycle for the Activity panel and for future async progress. Only one CPU render runs at a
time; a second request gets `409 render busy`.

The web shell persists an edit with a base revision before rendering, so a stale `PATCH` gets a
conflict instead of silently overwriting an accepted edit. A render records the revision it used
in the response headers (`x-comfyrizz-revision`) together with the timeline hash and frame count.

## Security checks

- Host must be `127.0.0.1`, `localhost` or `[::1]` (any port) — DNS-rebinding hosts get `403`.
- API requests need the token (header, bearer or query for SSE); missing/wrong → `401`.
- `POST`/`PATCH` must carry `Origin` whose host exactly equals `Host`; otherwise `403`.
- Package ids are restricted to `[A-Za-z0-9_.-]`; static paths are resolved under `apps/web/dist`
  and traversal is rejected.
- Package writes are validated with B1's `validatePackage` and atomic-renamed.
- Package and render state live under `apps/server/.runtime/` (gitignored); no secrets in packages.

## Verify

```bash
npm test          # 10 tests: host/token/origin, revisions/conflict, invalid package,
                  # render + SSE, replay, traversal
```

Real end-to-end check (2026-10-17): built web served by this server, opened with the fragment
token, edited a headline, clicked **Export MP4**. The server saved revision 2, rendered it, and
the browser downloaded a **1920×1080 H.264, 1095-frame, 36.500 s** MP4. `evil.example` Host and a
missing `Origin` were both rejected with `403`.

The shared render path is `apps/renderer/scripts/render-package-lib.mjs` (validate → A2 compile →
Remotion CPU render); C1's Vite dev route uses the same library.
