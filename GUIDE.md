# Figma Agent Bridge — Setup & Tutorial Guide

Everything to get from a fresh machine to the full duplicate → edit → sync-back loop. For the capability overview see [README.md](README.md).

---

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Figma desktop app** (Mac/Windows) | Dev plugins can only be imported in the desktop app | `figma.com/downloads` |
| **Node.js ≥ 20** | Runs the MCP server | `node --version` |
| **Google Chrome** (or run `npx playwright install chromium` once) | Browser file ops (create/duplicate/list) | installed at `/Applications/Google Chrome.app` |
| A Figma account | Free (Starter) plan is fully supported — that's the point | — |

---

## 2. One-time setup (~5 minutes)

### 2.1 Clone and build

```bash
git clone https://github.com/joshghal/figma-agent-bridge.git
cd figma-agent-bridge

cd server && npm install && npm run build
cd ../plugin && npm install && npm run build
```

Rebuild whenever you pull changes (`npm run build` in whichever half changed — `server/` or `plugin/`).

### 2.2 Register the MCP server

Add to your project's `.mcp.json` (or Claude Desktop / Cursor MCP config), with the **absolute** path to your clone:

```json
{
  "mcpServers": {
    "figma-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/figma-agent-bridge/server/dist/index.js"]
    }
  }
}
```

Restart your MCP client (or reconnect via `/mcp` in Claude Code). You should see ~50 `figma-bridge` tools.

> Multiple IDE windows are fine — the first server instance binds port `1994` and becomes **leader**; the rest become **followers** and proxy through it automatically.

### 2.3 Import the plugin into Figma (once per machine)

1. Open **any design file** in the Figma **desktop app**.
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `<clone>/plugin/manifest.json`.
4. The plugin now appears as **Figma Agent Bridge** under Plugins → Development, permanently.

Teammates repeat 2.1 + 2.3 on their own machines (each also registers the server in their own MCP client).

### 2.4 Log the browser in (once, only needed for file ops)

Ask your agent to call `figma_login`, or trigger it yourself from the MCP client. A Chrome window opens on the Figma login page — complete the login (SSO/2FA fine). The session persists in `~/.figma-agent-bridge/browser-profile`, so this is one-time until the session expires (then any file-op tool returns `LOGIN_REQUIRED` and you just run `figma_login` again).

---

## 3. Daily workflow

**Connect a file** (every Figma session — plugins cannot auto-start, this is Figma policy):

1. Open the file in the Figma desktop app.
2. Right-click canvas → **Plugins → Development → Figma Agent Bridge** (or ⌥⌘P to re-run the last plugin).
3. Keep the panel open — green "WebSocket Connected" = live. Closing the panel or the file disconnects it.

**Verify from the agent:** `list_files` → returns `[{fileKey, fileName}]`. Empty array = plugin not running.

**Target a file:** with one file connected, tools just work. With several connected, pass `fileKey` (from `list_files`) to any tool.

---

## 4. Tutorials

### T1 — First contact: read a design

```
list_files                        → note the fileKey
get_pages                         → page IDs + names
get_document                      → current page tree
get_screenshot {nodeIds:["1:23"]} → PNG of a node
get_variable_defs                 → design tokens
```

Tip for big files: `get_design_context {depth: 2}` gives a truncated tree with `childCount` stubs — much cheaper than `get_document`.

### T2 — Implement a design change

Typed tools cover the common cases:

```
create_frame {name:"Card", width:343, height:120, fillColor:"#FFFFFF"}
set_auto_layout {nodeId:"...", layoutMode:"VERTICAL", itemSpacing:12, padding:16}
create_text {parentId:"...", text:"Total Gold", fontSize:14}
set_solid_fill {nodeId:"...", color:"#F5B300"}
get_screenshot {nodeIds:["..."]}      ← always verify visually
```

Writes are refused in Dev Mode — switch the file to the design editor.

### T3 — `execute_code`: everything else

`execute_code` runs your JavaScript inside the plugin sandbox with the full [`figma` Plugin API](https://developers.figma.com/docs/plugins/). It's an async IIFE: use `await`, `return` a JSON-serializable value, and `console.log` is captured into the response.

**Create a component with variants:**
```js
const btn = figma.createComponent();
btn.name = "State=Default";
btn.resize(120, 40);
const btn2 = figma.createComponent();
btn2.name = "State=Pressed";
btn2.resize(120, 40);
const set = figma.combineAsVariants([btn, btn2], figma.currentPage);
set.name = "Button";
return { setId: set.id };
```

**Create variables and bind one to a fill (free plan = 1 mode per collection):**
```js
const col = figma.variables.createVariableCollection("tokens");
const gold = figma.variables.createVariable("color/gold", col, "COLOR");
gold.setValueForMode(col.modes[0].modeId, { r: 0.96, g: 0.70, b: 0, a: 1 });
const node = await figma.getNodeByIdAsync("1:23");
node.fills = [figma.variables.setBoundVariableForPaint(
  { type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", gold)];
return { variableId: gold.id };
```

**Find nodes by name:**
```js
await figma.currentPage.loadAsync();
const hits = figma.currentPage.findAll(n => n.name.includes("Button"));
return hits.map(n => ({ id: n.id, name: n.name, type: n.type }));
```

Rules of thumb:
- `timeoutMs` default 5000, max 60000. On timeout the code **keeps running** — it just stops being awaited. Keep scripts small and idempotent.
- Text edits need `await figma.loadFontAsync(node.fontName)` first.
- Under dynamic-page loading, use the `Async` API variants (`getNodeByIdAsync`, `page.loadAsync()`).

### T4 — Safe editing: checkpoints and scratch pages

Before any destructive batch:

```
save_version {title:"Before agent restyle", description:"..."}
```

That's a real entry in File → Version history — one-click rollback.

Draft-and-review inside one file (highest fidelity — no cross-file loss):

```
get_pages                                   → find page "Home"
duplicate_page {pageId:"0:1", name:"Home (agent draft)"}
set_current_page {pageId:"<clone id>"}      → work on the clone
...edit, screenshot, iterate...
```

Merge back by moving approved nodes with `execute_code`:
```js
const src = await figma.getNodeByIdAsync("<node-on-draft-page>");
const target = figma.root.children.find(p => p.name === "Home");
await target.loadAsync();
target.appendChild(src);   // moves the node, keeps its ID
return { moved: src.id };
```

Then `delete_page {pageId:"<clone id>", confirm:true}`.

### T5 — File operations (create / duplicate / list)

These drive a logged-in Chrome window (it opens briefly — that's normal):

```
create_file {name:"Spike: new onboarding"}   → {fileKey, fileUrl}
duplicate_file {file:"https://www.figma.com/design/KEY/Name"}
                                             → copy in your Drafts, new fileKey
list_account_files {view:"drafts"}           → [{name, fileKey, fileUrl}]
```

- `duplicate_file` accepts a URL or bare key, works on any file you can *view* (a view-only source lands the copy in **your Drafts** — where dev plugins can run, since Drafts copies give you edit rights).
- **The unremovable manual step:** a new/duplicated file must be opened in the desktop app and the plugin run there before plugin tools can touch it. Tool responses remind you.
- `LOGIN_REQUIRED` error → run `figma_login`, retry.

### T6 — The full loop: duplicate → edit → sync back

The flagship workflow. Example: restyle a frame on a copy of the design system, then push it back.

```
1. duplicate_file {file:"<original url>"}        → copyKey (in Drafts)
2. [manual] open the copy in Figma desktop, run the plugin
3. list_files                                    → both files connected
4. ...edit the copy (typed tools / execute_code, screenshots to verify)...
5. sync_nodes {
     sourceFileKey: "<copyKey>",
     targetFileKey: "<originalKey>",
     nodeIds: ["123:456"],                       ← IDs from the copy
     mode: "replace"
   }
```

`sync_nodes` works in **both directions** — original→copy keeps a duplicate fresh; copy→original merges approved changes back. What it does per node:

1. Saves a version checkpoint on the target (skip with `savepoint:false`).
2. Serializes the subtree in the source (image fills travel as bytes).
3. In the target, finds the **same node ID** (duplicates preserve IDs), captures its parent/index/position, deletes it, rebuilds in place. Missing ID → appends to the current page with a warning.

Fidelity contract:
- **Editable rebuild:** FRAME (auto-layout, fills, effects), TEXT (per-range fonts/sizes/colors), RECTANGLE, ELLIPSE, LINE, GROUP.
- **SVG snapshot** (visually faithful, not editable): vectors, stars, polygons, boolean ops, **instances and components** (linkage is lost — free plan can't publish libraries for re-linking).
- Rebuilt nodes get **new IDs**; existing prototype links pointing at replaced nodes break. Check `warnings` in the result.

Prefer T4's same-page workflow when the change can live in one file; use `sync_nodes` when the review must happen in a separate file.

---

## 5. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `list_files` returns `[]` | Plugin not running — run it in the file, keep panel open |
| "No file connected" / wrong file edited | Pass explicit `fileKey`; check `list_files` |
| Tool times out after long idle | Plugin iframe was killed by Figma (known platform behavior) — re-run the plugin in the file |
| `LOGIN_REQUIRED` | Run `figma_login`, complete login in the Chrome window |
| `PROFILE_LOCKED` | Another server instance has the bridge Chrome open — run file ops from one instance, or close the other Chrome window |
| `duplicate_file` hangs then fails | Source not viewable with your account, or Figma changed the `/duplicate` route — duplicate manually once and report |
| `list_account_files` misses files | It scrapes the virtualized file browser — best-effort; raise `limit`, or scroll manually and re-run |
| Writes rejected with "Dev Mode is read-only" | Switch from Dev Mode to the design editor |
| Fonts wrong after sync/text edit | Font not installed/available — bridge substitutes Inter and records a warning |
| Plugin won't import | Must use the **desktop** app, not the browser |
| Port 1994 conflicts | Another process owns it — kill it; leader-follower only coordinates bridge instances |

## 6. Maintenance

```bash
# pull upstream gethopp fixes
git fetch upstream && git merge upstream/main   # resolve, rebuild

# update deps
cd server && npm update && npm run build
cd ../plugin && npm update && npm run build
```

After plugin rebuilds, Figma picks up the new `dist/code.js` the next time you run the plugin (no re-import needed).
