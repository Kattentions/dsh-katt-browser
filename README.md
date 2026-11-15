# dsh-katt-browser

A DeepSeek Harness (DSH) plugin that turns the desktop app's built-in sidebar browser into an agent-controllable browser.

**Structure first, screenshots last.** Page state is read from the accessibility tree, DOM, worker messages and the network layer; screenshots exist only as a fallback.

## Requirements

- DSH desktop app (Electron, Windows/macOS/Linux) with the sidebar browser.
- The app must be launched with a DevTools port, e.g. `--remote-debugging-port=9222`. The plugin can also fall back to a DOM bridge when CDP is unavailable, but CDP is the primary and recommended path.

## Install

```sh
dsh plugin --profile desktop add github:Kattentions/dsh-katt-browser
```

Or from a local checkout:

```sh
dsh plugin --profile desktop add file:/path/to/dsh-katt-browser
```

Restart DSH after installing. The sidebar browser tab is the shared surface: you and the agent operate the same page, the same cookies and the same scroll position.

## Configuration

```yaml
- id: katt-browser
  config:
    driver: webview        # webview (default) | headless (legacy)
    cdpPort: 9222          # DevTools port used by the desktop app
    idbLimit: 50           # rows per page when snapshotting IndexedDB (500 per DB max)
    downloadDir: ''        # default folder for browser_download
    allowedHosts: []       # non-empty = allow these domains (and subdomains) only
```

## What it gives the agent

**Reading (no screenshots)**

- `browser_snapshot` — accessibility tree with `eN` refs; `detail=compact` for interactive elements only
- `browser_text` — readable page text (title, body, links)
- `browser_table` — tables as headers + rows
- `browser_evaluate` — run JS in the page
- `browser_console` — console logs, uncaught exceptions
- `browser_network` — request history (method/URL/status/MIME/duration), filterable
- `browser_instrument` — worker messages, fetch/XHR/WebSocket traffic, storage writes (canvas games expose state here)

**Interaction**

- `browser_open` / `back` / `forward` / `reload` with `waitFor` / `waitMs` for SPA hydration
- `browser_click` (ref or coordinates), `browser_type`, `browser_press_key`, `browser_scroll`, `browser_hover`, `browser_upload`
- `browser_tabs` — list / switch / new / close
- Dangerous clicks (delete/pay/unsubscribe…) require `confirm=true`

**Accounts and state**

- `browser_cookies` — `list / save / load / clear / clear-site / clear-cache / profiles`
- Snapshots cover cookies + localStorage/sessionStorage + IndexedDB + Cache Storage, and are encrypted at rest (AES-256-GCM, key under `~/.dsh/katt-browser/profile.key`)
- Default is shared login state inside one workspace partition; switch accounts by loading another snapshot
- `browser_serve` — local HTTP server for local pages (`file://` is blocked by the sidebar webview)
- `browser_download` — native downloads are disabled by the shell, so files are fetched in-page and written to disk
- `browser_history`, `browser_probe`, `browser_page_diag` — diagnostics

## Known limits

- `file://` cannot be opened; use `browser_serve`.
- Native downloads are blocked by the shell; use `browser_download`.
- Service Worker registration itself is not restorable from a snapshot (Cache Storage content is).
- Sites that require a human (login walls, CAPTCHA, rate limits) surface a `barriers` hint; the user completes that step in the sidebar.

## License

MIT
