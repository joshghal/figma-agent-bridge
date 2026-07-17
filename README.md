# Figma Agent Bridge

A self-owned Figma ⇄ AI-agent bridge with **all five capabilities on a free Figma plan** and **zero dependency on Figma's official MCP server**:

| # | Capability | Mechanism | Tools |
|---|---|---|---|
| 1 | Read design | Plugin bridge (WebSocket) | `get_document`, `get_node`, `get_screenshot`, `get_variable_defs`, … |
| 2 | Implement design | Plugin bridge + code execution | `create_frame`, `set_auto_layout`, …, **`execute_code`** |
| 3 | Create draft/file | Embedded Playwright → `figma.com/new` | **`create_file`** |
| 4 | Duplicate file | Embedded Playwright → `/duplicate` URL | **`duplicate_file`** |
| 5 | Sync to a targeted file | Multi-file plugin registry, serialize → rebuild | **`sync_nodes`** |
| + | List account files | Embedded Playwright → files dashboard | **`list_account_files`** |

Fork of [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) (MIT) — the transport (MCP server *is* the WebSocket server on `:1994`, fileKey-keyed multi-file registry, leader-follower election) is theirs. The `execute_code` pattern follows [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp); page tooling ideas from [arinspunk/claude-talk-to-figma-mcp](https://github.com/arinspunk/claude-talk-to-figma-mcp).

**📖 New here? Follow [GUIDE.md](GUIDE.md)** — the complete, from-zero manual: install, Claude Code setup, Figma setup, the follow-and-slice workflow, tool reference, and troubleshooting.

## Why

Figma's REST API is ~6 calls/month on the free plan and its Plugin API cannot create, duplicate, or list files (single-file sandbox) — no existing bridge covers file-level operations. This bridge pairs the Plugin API (full read/write inside open files, free on every plan) with an embedded Playwright browser session (file-level operations Figma exposes only through its web UI).

**You do not need the official Figma MCP (`mcp.figma.com`) or a paid Figma account** — this bridge replaces both. If the `figma` MCP is registered, you can remove it (`claude mcp remove figma`) and keep only `figma-bridge`.

**Main use case:** follow a designer's file you have *read-only* access to and slice it to code — `pull_latest` duplicates it (view access is enough), you run the plugin, the agent reads it and generates code. See [GUIDE.md §8](GUIDE.md#8-daily-usage--follow--slice).

## Architecture

```
Claude/agent ⇄ MCP server (stdio, Node)
                ├─ WS :1994 ⇄ Figma plugin (desktop app, one instance per open file)
                │    └─ registry keyed by figma.fileKey (multiple files at once)
                └─ Playwright (persistent Chrome profile at ~/.figma-agent-bridge/browser-profile)
                     └─ create_file · duplicate_file · list_account_files · figma_login
```

## Setup

**Fastest (teammates):** clone the repo and run the setup script — it checks prerequisites, builds the server + plugin, sets up the browser, and wires (or prints) the MCP config, then lists the remaining manual steps:

```bash
./setup.sh                 # build + configure + diagnose
./setup.sh /path/to/proj   # also writes the figma-bridge entry into that project's .mcp.json
./setup.sh --check         # doctor: diagnose an existing install (health, MCP registration, login)
```

Then do the 3 one-time manual steps it prints (import the plugin in Figma desktop, reconnect your MCP client, run `figma_login` once). Run `./setup.sh --check` anytime to confirm the server is healthy, MCP is registered, and login is done. Manual setup below if you prefer.

**Server** (register in your MCP client, e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "figma-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["<repo>/server/dist/index.js"]
    }
  }
}
```

```bash
cd server && npm install && npm run build
cd ../plugin && npm install && npm run build
```

**Plugin** (each teammate, once): Figma **desktop app** → any design file → Plugins → Development → *Import plugin from manifest…* → select `plugin/manifest.json`.

**Per session**: run the *Figma Agent Bridge* plugin in every file you want connected (Figma blocks plugin auto-start — this is an unremovable platform constraint). Keep the panel open; `list_files` shows what's connected.

**File ops** (once): call `figma_login` and complete the login in the Chrome window that opens. The session persists in the profile directory.

## Tools added on top of upstream

| Tool | What it does |
|---|---|
| `execute_code` | Run arbitrary Plugin-API JavaScript in the file's sandbox (async IIFE, `return` a JSON value). Console output is captured and returned. Covers components, variables, styles, vectors, boolean ops without dedicated tools. 5s default / 60s max timeout. |
| `get_pages` / `create_page` / `duplicate_page` / `rename_page` / `delete_page` / `set_current_page` | Page CRUD. `duplicate_page` clones a full page (prototype links preserved) — the preferred scratch-copy workflow inside one file. `delete_page` requires `confirm: true`. |
| `save_version` | Named checkpoint in Figma version history (`figma.saveVersionHistoryAsync`). Call before destructive batches. |
| `figma_login` | One-time interactive login for the embedded browser. |
| `create_file` | New blank draft via `figma.com/new`; returns `fileKey` + URL. |
| `duplicate_file` | Duplicate any viewable file via Figma's documented `/duplicate` URL; copy lands in Drafts; returns the new `fileKey`. |
| `list_account_files` | List files from the Recents browser **with real fileKeys**. Figma doesn't expose keys in the DOM, so each key is read via the sanctioned right-click → Copy link → clipboard flow (one interaction per file, so keep the limit modest). |
| `delete_file` | Move a file to trash (recoverable 30 days). Identifies the target by fileKey via Copy link, so it deletes exactly the file you name — never a same-named one. Requires `confirm: true`. |
| `pull_latest` | **Follow a designer's file (read-only access is enough).** One command: makes a fresh full-fidelity duplicate of the original *and* auto-trashes your previous snapshot of it (no clutter). Remembers the last snapshot per original. Use this instead of duplicating by hand every time the file changes. |
| `sync_nodes` | Copy subtrees between two *connected* files, either direction. `replace` mode swaps same-ID nodes (duplicates preserve node IDs), `append` adds to the current page. Saves a version checkpoint on the target first. |

Everything upstream still works — see [gethopp's README](https://github.com/gethopp/figma-mcp-bridge#available-tools) for the base read/write tool catalog.

### `sync_nodes` fidelity

FRAME / TEXT (per-range styling) / RECTANGLE / ELLIPSE / LINE / GROUP rebuild as editable nodes; image fills are transported as bytes. Everything else (vectors, stars, booleans, instances, components) arrives as an **SVG snapshot** — visually faithful, not editable, instances lose component linkage. Rebuilt nodes get new IDs. For highest fidelity prefer same-file workflows (`duplicate_page` → edit → move back).

## Known constraints (platform, not fixable)

- Plugins must be started manually per file per session; the plugin dies when the file closes.
- A duplicated/created file must be opened in the desktop app (and the plugin run) before plugin tools can touch it — tool responses remind you.
- Browser file ops need a logged-in session; expect `LOGIN_REQUIRED` errors until `figma_login` is done. Run file ops from a single server instance (the Chrome profile is locked while open).
- Writes are refused in Dev Mode; free plan allows 1 variable mode per collection.

## License

MIT — original code © gethopp contributors, modifications © joshghal.
