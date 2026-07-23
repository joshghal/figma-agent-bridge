# Figma Agent Bridge — Complete Guide

A self-owned bridge that lets an AI agent (Claude Code) **read Figma designs and generate code** from them, on a **free Figma plan**, with **no official Figma MCP** and **no paid account**. Built for the "follow a designer's file → slice it to code" workflow.

This guide is self-contained: follow it top to bottom on a fresh machine/account and you'll have a working setup.

---

## Table of contents

1. [What this is & why](#1-what-this-is--why)
2. [How it works](#2-how-it-works)
3. [Prerequisites](#3-prerequisites)
4. [Install](#4-install)
5. [Claude Code setup (MCP)](#5-claude-code-setup-mcp)
6. [Figma setup (plugin + login)](#6-figma-setup-plugin--login)
7. [Verify everything (doctor)](#7-verify-everything-doctor)
8. [Daily usage — follow & slice](#8-daily-usage--follow--slice)
9. [The access model (read-only)](#9-the-access-model-read-only)
10. [Tool reference](#10-tool-reference)
11. [setup.sh reference](#11-setupsh-reference)
12. [Troubleshooting](#12-troubleshooting)
13. [Updating & maintenance](#13-updating--maintenance)
14. [Credits & license](#14-credits--license)

---

## 1. What this is & why

**The problem.** On a free Figma plan, the REST API is capped at ~6 calls/month, so REST-based MCP servers (the official Figma MCP, Framelink) are unusable for real work. And Figma's Plugin API can't create, duplicate, or list *files* (it's sandboxed to one open file). So there's no off-the-shelf way to read a designer's evolving file and turn it into code for free.

**The solution.** Two mechanisms in one MCP server:
- A **Figma plugin** connected over a local WebSocket gives full read/write **inside a file you can edit** — no REST, no rate limit, free on any plan.
- An **embedded browser** (Playwright) drives figma.com for the file-level things Figma only exposes in its UI: create, duplicate, list, delete, and "pull latest."

**The core use case.** A designer shares a file with you (read-only). You duplicate it (view access is enough → the copy lands in your Drafts where you own it), run the bridge plugin on the copy, and the agent reads it to generate code. When the designer updates the file, you pull a fresh copy. One command: `pull_latest`.

---

## 2. How it works

```
Claude Code (agent)
      │  MCP (stdio)
      ▼
MCP server  (node server/dist/index.js)
      ├─ WebSocket :1994  ⇄  Figma plugin  (runs inside the open file, desktop app)
      │        └─ registry keyed by figma.fileKey (multiple files at once)
      └─ Playwright  ⇄  figma.com  (persistent Chrome profile, logged in once)
               └─ create / duplicate / list / delete / pull_latest
```

- **Plugin tools** (read design, edit, execute_code, pages, sync) go over the WebSocket to the plugin. The plugin must be running in the target file.
- **File-op tools** (create/duplicate/list/delete/pull_latest/figma_login) drive the browser. They need a logged-in session, not the plugin.
- **Playwright is bundled, not a separate MCP.** The browser automation uses the `playwright` npm **library inside this server** (a dependency in `server/package.json`) — **not** the standalone "Playwright MCP" (`mcp__playwright__*`). There is nothing extra to register: `npm install` (run by `setup.sh`) pulls in the library, and `setup.sh` installs the browser binary (system Chrome, or `npx playwright install chromium`).
- The MCP server is a **long-running process**: it loads once and does **not** hot-reload when you rebuild. Rebuild → reconnect/restart to pick up changes (see [Troubleshooting](#12-troubleshooting)).

---

## 3. Prerequisites

| Need | Why | Check |
|---|---|---|
| **Figma desktop app** (Mac/Windows) | Dev plugins can only be imported in the desktop app | figma.com/downloads |
| **Node.js ≥ 20** | Runs the MCP server | `node -v` |
| **git** | Clone the repo | `git --version` |
| **Google Chrome** *(or run `npx playwright install chromium` once)* | Browser file ops | — |
| **Claude Code** | The agent that talks to the bridge | `claude --version` |
| A **Figma account** | Free (Starter) plan is fully supported | — |

---

## 4. Install

### Option A — one command (recommended)

```bash
git clone https://github.com/joshghal/figma-agent-bridge.git
cd figma-agent-bridge
bash setup.sh
```

`setup.sh` checks prerequisites, builds the server + plugin, sorts out the browser, prints the MCP config, then runs health/registration/login checks and lists the manual steps. See [setup.sh reference](#11-setupsh-reference).

To also write the MCP entry into a project automatically:
```bash
bash setup.sh /path/to/your/project     # merges figma-bridge into that project's .mcp.json
```

### Option B — manual

```bash
git clone https://github.com/joshghal/figma-agent-bridge.git
cd figma-agent-bridge/server && npm install && npm run build
cd ../plugin && npm install && npm run build
```

Rebuild after pulling changes (`npm run build` in whichever of `server/` or `plugin/` changed).

---

## 5. Claude Code setup (MCP)

**If you ran `setup.sh`, this is already done** — it registers `figma-bridge` at **user scope** with **absolute paths**, and first removes any prior entries so a stale/wrong-path one can't override it. Skip to §6. Otherwise, register manually:

> **⚠️ Use the ABSOLUTE path to `node`, not bare `"node"`.** Claude Code launched from the macOS Dock/Finder often has a trimmed PATH (no Homebrew/nvm), so `"command": "node"` fails to spawn with **`MCP error -32000: Connection closed`** and the server shows **"Failed"**. Find the absolute path with `command -v node` (e.g. `/opt/homebrew/bin/node`). `setup.sh` does this for you.

**CLI (recommended):**
```bash
NODE=$(command -v node)   # e.g. /opt/homebrew/bin/node
claude mcp add figma-bridge -- "$NODE" /ABSOLUTE/PATH/TO/figma-agent-bridge/server/dist/index.js
# add --scope user to make it available in every project:
claude mcp add figma-bridge --scope user -- "$NODE" /ABSOLUTE/PATH/TO/figma-agent-bridge/server/dist/index.js
```

**Or edit `.mcp.json`** in your project (use the absolute node path):
```json
{
  "mcpServers": {
    "figma-bridge": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/node",
      "args": ["/ABSOLUTE/PATH/TO/figma-agent-bridge/server/dist/index.js"]
    }
  }
}
```

Then **start (or restart) Claude Code** so it spawns the server. Confirm with `/mcp` — `figma-bridge` should be connected.

> **Important:** whenever you rebuild the server, a *running* Claude Code session keeps the old process. Load the new build with `/mcp reconnect`, or quit and reopen Claude Code. A session never hot-reloads a rebuilt MCP server.

---

## 6. Figma setup (plugin + login)

> **If you ran `setup.sh` in a terminal, it already guided both of these** — it opened a browser and waited for your Figma login, and prompted you to import the plugin. This section is the manual reference (and what to do in a non-interactive shell).

### 6a. Import the plugin (once per machine)

1. Open the Figma **desktop app** and open any design file.
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `figma-agent-bridge/plugin/manifest.json`.
4. It now appears permanently under **Plugins → Development → Figma Agent Bridge**.

### 6b. Log the browser in (once)

Ask your agent to run **`figma_login`**. A Chrome window opens on the Figma login page — sign in **there** (the bridge never sees your password). Use the account that has view access to the designer's files. The session persists in `~/.figma-agent-bridge/browser-profile`, so this is one-time until it expires.

### 6c. Pair the plugin with your bridge token (once per machine)

The plugin's WebSocket connection is authenticated with a random token generated on your machine the first time the bridge runs — this stops another process (or a malicious webpage, if you had one open) from connecting to your bridge instead of the real plugin.

1. Start the bridge once (open a Figma file with the plugin running, or just let Claude Code launch the MCP server) so the token file gets created.
2. Get the token: `cat ~/.figma-agent-bridge/token`
3. Open the plugin panel in Figma — it shows a small "Paste bridge token" field instead of the connection badge until paired.
4. Paste the token and click **Pair**.

The token is stored via Figma's `clientStorage` (scoped to your plugin install) and reused automatically on every reconnect and Figma restart — you only do this once. If the field reappears asking to re-pair, the token was rejected (e.g. you deleted/regenerated `~/.figma-agent-bridge/token`) — `cat` it again and re-paste.

---

## 7. Verify everything (doctor)

```bash
bash setup.sh --check
```

This runs diagnostics only (no rebuild) and reports:

- **Health check** — boots the server and confirms all tools (incl. `pull_latest`) are exposed. Catches a **stale build**.
- **MCP registration** — whether `figma-bridge` is configured in Claude Code (prints the `claude mcp add` fix if not).
- **Browser login** — whether a Figma session is saved (prints "run figma_login" if not).
- **Reconnect reminder** — a running session won't hot-reload a rebuilt server.

All green = ready. Any ✗ prints the exact fix.

---

## 8. Daily usage — follow & slice

The whole workflow, in your words to the agent:

> **"pull the latest `<designer file URL>` and slice the `<screen>` to React Native"**

What happens:

1. **Agent runs `pull_latest`** → makes a fresh, full-fidelity duplicate of the designer's file in your Drafts, and **auto-trashes your previous copy** of it (no clutter). It tries to open the new copy in your desktop app.
2. **You press ⌥⌘P** in that file to run the bridge plugin (keep the panel open). *This is the one manual step — Figma blocks plugin auto-start for everyone.*
3. **Agent reads the design** over the bridge (`get_document`, `get_node`, `get_screenshot`, `get_variable_defs`) and generates the code.

When the designer updates the file, just say "pull the latest" again. Same one-liner, no manual duplicating, no cleanup — the old copy is trashed automatically. You always have exactly one current copy per designer file.

### Reading tips for accurate slicing
- Big file? `get_design_context {depth: 2}` gives a cheaper truncated tree than `get_document`.
- `get_screenshot {nodeIds:[...]}` to see a frame; `get_variable_defs` for design tokens.
- `get_pages` then work one page at a time.

---

## 9. The access model (read-only)

**You only need read-only access to the designer's file.** Here's why it works and what the limits are:

- **Duplicating needs only view access** — the copy lands in *your* Drafts, where you have full edit rights. So you never touch or edit the original.
- **The plugin needs edit access** — but it runs on *your copy* (which you own), never the original. That's why you duplicate.
- **You can never write back into the designer's original** (read-only is a hard Figma permission — no tool can bypass it). But the follow-workflow is pull-only, so this never comes up.

### "duplicate once, sync forever"?
Not literally possible with a read-only source: to read the original's latest state you must duplicate it (a read-only file can't run the plugin). `pull_latest` is the real-world version — **one command, one current full-fidelity copy, old one auto-trashed.**

### When to use `sync_nodes` instead
Only if you keep your *own* edits on the copy (dev notes, etc.) and need to preserve them across updates. Then keep one working copy and `sync_nodes` fresh content into it — but it's a **lossy rebuild** (components/vectors become flat SVGs, node IDs change), so it's the wrong choice for accurate slicing. For pure read-and-slice, always use `pull_latest`.

---

## 10. Tool reference

### File ops (browser — need `figma_login`)
| Tool | Does |
|---|---|
| `figma_login` | One-time interactive Figma login for the embedded browser. |
| `pull_latest` | **Primary follow tool.** Fresh full-fidelity duplicate of an original + auto-trash your previous snapshot of it. Read-only access is enough. |
| `create_file` | New blank draft via `figma.com/new`. Returns fileKey + URL. |
| `duplicate_file` | Duplicate any viewable file via the `/duplicate` URL. Copy lands in Drafts. |
| `list_account_files` | List your files (name + real fileKey) from the Recents browser (keys read via right-click → Copy link). |
| `delete_file` | Move a file to trash by fileKey (recoverable 30 days). Requires `confirm: true`. |

### Plugin ops (need the plugin running in the file)
| Tool | Does |
|---|---|
| `list_files` | List currently *connected* files (plugin running). Empty = plugin not running. |
| `get_document` / `get_node` / `get_selection` | Read the tree / a node / the selection. |
| `get_design_context` | Cheaper depth-limited tree (design-to-code). |
| `get_screenshot` / `save_screenshots` | Export PNG/SVG/JPG/PDF (inline, or batch to disk). |
| `get_styles` / `get_variable_defs` / `get_metadata` | Styles, variables/tokens, metadata. |
| `create_frame` / `create_text` / `create_shape` / `create_image` | Create nodes. |
| `set_*` (fills, strokes, effects, auto-layout, text, node props, visibility) | Edit nodes. |
| `duplicate_nodes` / `reparent_nodes` / `group_nodes` / `ungroup_node` / `delete_nodes` | Structure ops. |
| `get_pages` / `create_page` / `duplicate_page` / `rename_page` / `delete_page` / `set_current_page` | Page ops (`duplicate_page` clones a page with prototype links). |
| `save_version` | Named version checkpoint before destructive batches. |
| `execute_code` | **Escape hatch:** run arbitrary Plugin-API JS (async IIFE, `return` JSON, console captured). Covers components/variants, variables, styles, vectors, booleans. |
| `sync_nodes` | Copy node subtrees between two connected files (lossy rebuild). See §9. |
| motion tools | `get_motion_styles`, `apply_animation_style`, etc. (Motion API beta). |

Writes are refused in **Dev Mode** (switch to the design editor). Deletes require `confirm: true`.

---

## 11. setup.sh reference

```bash
bash setup.sh                   # build + configure + diagnose
bash setup.sh /path/to/project  # also write figma-bridge into that project's .mcp.json
bash setup.sh --check           # diagnose only (no clone/build) — "doctor" mode
bash setup.sh --help            # usage
```

Environment:
- `FIGMA_BRIDGE_DIR` — install location (default `~/figma-agent-bridge`).

What full setup does: prereq checks → clone/update → build server + plugin → browser check (Chrome or install Chromium) → MCP config (merge into a project `.mcp.json`, or print `claude mcp add`) → health/registration/login checks → prints manual steps + workflow + reconnect reminder.

`--check` runs the health, registration, and login checks with a pass/fail summary — use it whenever something feels off.

---

## 12. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| **`MCP error -32000: Connection closed`** / figma-bridge **"Failed"** / plugin stuck "Disconnected", nothing on `:1994` | The client can't spawn the server. **First diagnose with `bash setup.sh --check`** — it reads the registered server path straight from config (fast, no hang). *(Avoid `claude mcp get`/`claude mcp list` for this — they health-check every configured MCP server and can hang.)* Two common causes: **(a) wrong/relative server path** — e.g. a `local`-scope entry pointing at `.../<project>/server/dist/index.js` (which doesn't exist) that *overrides* your `.mcp.json`. Fix: `claude mcp remove figma-bridge -s local`, then re-add with **absolute** paths: `claude mcp add figma-bridge -s local -- $(command -v node) /ABS/PATH/figma-agent-bridge/server/dist/index.js`. **(b) bare `node` not on the app's PATH** (GUI launch lacks Homebrew/nvm) → use the absolute node path. Always use absolute paths for both `node` and the server entry (`setup.sh` does). Then `/mcp reconnect` or restart Claude Code. Verify the binary itself is fine with `bash setup.sh --check`. |
| A new tool (e.g. `pull_latest`) shows "not found" but it's in the code | **Stale running server.** A session doesn't hot-reload. `/mcp reconnect` or quit & reopen Claude Code. Verify with `bash setup.sh --check`. |
| `/mcp` shows figma-bridge disconnected | `/mcp reconnect`, or restart Claude Code. Check the path in `.mcp.json` / `claude mcp get figma-bridge`. |
| `list_files` returns `[]` | Plugin not running. Open the file in Figma desktop and run the plugin (⌥⌘P); keep the panel open. |
| Tool times out after long idle | Figma killed the background plugin iframe. Re-run the plugin in the file. |
| `LOGIN_REQUIRED` on a file op | Run `figma_login` and complete the login in the Chrome window. |
| `PROFILE_LOCKED` | The bridge's Chrome profile is open in another server instance. Run file ops from one instance, or close the other bridge Chrome window. |
| Writes rejected: "Dev Mode is read-only" | Switch the file from Dev Mode to the design editor. |
| Plugin crashes / won't run | Make sure you ran `npm run build` in `plugin/` after pulling; re-run the plugin (it reloads the built code). |
| `create_file`/`pull_latest` returns a weird key like "new" | Old build. Rebuild + reconnect (`bash setup.sh` then reconnect). |
| `list_account_files` slow | It reads each file's key via right-click→Copy link (one interaction per file). Keep `limit` modest. |
| Fonts look wrong after a text op | The font isn't available locally; the bridge substitutes Inter and records a warning. |
| Plugin won't import | Must use the Figma **desktop** app, not the browser. |
| Wrong Figma account in the browser | Log out in the bridge's Chrome window and back into the right account, then re-check `figma_login`. |

---

## 13. Updating & maintenance

```bash
cd ~/figma-agent-bridge         # or your FIGMA_BRIDGE_DIR
git pull                        # get latest
cd server && npm install && npm run build
cd ../plugin && npm install && npm run build
```

Then **reconnect the bridge** (`/mcp reconnect` or restart Claude Code) and, after a plugin rebuild, re-run the plugin in your file (no re-import needed). Run `bash setup.sh --check` to confirm.

To pull upstream (gethopp) fixes: `git fetch upstream && git merge upstream/main` (resolve, rebuild).

### Clean reinstall from scratch

If you've ended up with **multiple clones** in different folders (a common source of "which one is registered / which one did I pull" confusion), collapse everything down to a single canonical clone. All your work lives on `origin`, and your Figma login lives in `~/.figma-agent-bridge/browser-profile` (separate from the clones) — so this loses nothing.

```bash
# 1. Remove every clone you might have (add any other paths you used)
rm -rf ~/figma-agent-bridge \
       ~/Documents/**/figma-agent-bridge

# 2. Fresh clone — use EXACTLY this path so the MCP registration matches
git clone https://github.com/joshghal/figma-agent-bridge.git ~/figma-agent-bridge

# 3. Build + register + browser setup
cd ~/figma-agent-bridge && bash setup.sh
```

Then **`/mcp reconnect`** (a running session never hot-reloads a rebuilt server), and re-run the plugin in your Figma file. Your saved Figma session carries over — no `figma_login` needed unless it reports `LOGIN_REQUIRED`. Confirm with `bash setup.sh --check`.

> Clone to **exactly `~/figma-agent-bridge`** — that's the path `setup.sh` registers with Claude Code. A clone at any other path means you'd have to re-register (or the old registration points at a now-missing folder).

---

## 14. Credits & license

Fork of [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) (MIT) — the WebSocket transport, fileKey registry, and leader-follower election are theirs. The `execute_code` pattern follows [southleft/figma-console-mcp](https://github.com/southleft/figma-console-mcp); page tooling ideas from [arinspunk/claude-talk-to-figma-mcp](https://github.com/arinspunk/claude-talk-to-figma-mcp). Added here: file ops via embedded Playwright (create/duplicate/list/delete/**pull_latest**), `execute_code`, page tools, `save_version`, `sync_nodes`, and the diagnostics in `setup.sh`.

MIT — original code © gethopp contributors, modifications © joshghal.
