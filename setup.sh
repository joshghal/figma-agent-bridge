#!/usr/bin/env bash
#
# figma-agent-bridge — team setup
# ---------------------------------
# Sets up the Figma -> code "follow-and-slice" bridge for a teammate:
# clones/updates the repo, builds the MCP server + Figma plugin, checks the
# browser used for file ops, and wires up (or prints) the MCP config. Then it
# prints the remaining one-time manual steps and the daily workflow.
#
# Usage:
#   ./setup.sh                 # build + print the MCP config to add yourself
#   ./setup.sh /path/to/project  # also writes the figma-bridge entry into
#                                # that project's .mcp.json (Claude Code)
#
# Env:
#   FIGMA_BRIDGE_DIR   where to install (default: ~/figma-agent-bridge)
#
set -euo pipefail

REPO_URL="https://github.com/joshghal/figma-agent-bridge.git"
INSTALL_DIR="${FIGMA_BRIDGE_DIR:-$HOME/figma-agent-bridge}"

# --- pretty output ----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  BOLD=; GRN=; YLW=; RED=; DIM=; RST=
fi
say()  { printf '\n%s==>%s %s%s\n' "$BOLD$GRN" "$RST" "$BOLD" "$*$RST"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s!! %s%s\n' "$YLW" "$*" "$RST"; }
die()  { printf '%sxx %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

# --- 1. prerequisites -------------------------------------------------------
say "Checking prerequisites"
command -v git  >/dev/null 2>&1 || die "git not found (macOS: run 'xcode-select --install')."
command -v node >/dev/null 2>&1 || die "Node.js not found — install Node 20+ from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm not found (comes with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node is too old ($(node -v)) — need Node 20 or newer."
info "git $(git --version | awk '{print $3}'), node $(node -v), npm $(npm -v) — ok"

# --- 2. clone or update -----------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || warn "Could not fast-forward — resolve git state manually."
else
  say "Cloning into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# --- 3. build server + plugin ----------------------------------------------
say "Building the MCP server"
( cd "$INSTALL_DIR/server" && npm install && npm run build )
say "Building the Figma plugin"
( cd "$INSTALL_DIR/plugin" && npm install && npm run build )

# --- 4. browser for file ops (create/duplicate/list/delete/pull_latest) -----
say "Checking the browser used for file operations"
if [ "$(uname)" = "Darwin" ] && [ -d "/Applications/Google Chrome.app" ]; then
  info "Google Chrome found — the bridge will use it."
else
  warn "Google Chrome not found — installing Playwright's bundled Chromium."
  ( cd "$INSTALL_DIR/server" && npx --yes playwright install chromium )
fi

SERVER_ENTRY="$INSTALL_DIR/server/dist/index.js"
[ -f "$SERVER_ENTRY" ] || die "Build did not produce $SERVER_ENTRY — check the output above."

# --- 5. MCP config ----------------------------------------------------------
read -r -d '' MCP_JSON <<EOF || true
{
  "mcpServers": {
    "figma-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["$SERVER_ENTRY"]
    }
  }
}
EOF

say "MCP server configuration"
TARGET_DIR="${1:-}"
if [ -n "$TARGET_DIR" ] && [ -d "$TARGET_DIR" ]; then
  TARGET="$TARGET_DIR/.mcp.json"
  node -e '
    const fs = require("fs");
    const [target, entryPath] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(target, "utf8")); } catch {}
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers["figma-bridge"] = { type: "stdio", command: "node", args: [entryPath] };
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
  ' "$TARGET" "$SERVER_ENTRY"
  info "Wrote the figma-bridge entry into $TARGET"
else
  info "Add this to your MCP client config (Claude Code .mcp.json, Cursor, Claude Desktop):"
  printf '%s\n' "$DIM$MCP_JSON$RST"
fi

# --- 6. manual steps + daily workflow --------------------------------------
say "Setup complete — 3 one-time manual steps left"
cat <<EOF
  1. Figma DESKTOP app -> Plugins -> Development -> Import plugin from manifest...
     -> select:  $INSTALL_DIR/plugin/manifest.json
  2. Restart / reconnect your MCP client so it loads the bridge.
  3. Ask your agent to run  figma_login  and complete the Figma login once,
     using the account that has view access to the designer's files.
     (Free Figma plan is fine — no paid account or official Figma MCP needed.)
EOF

say "Daily workflow — follow a designer's file and slice it to code"
cat <<EOF
  You  ->  "pull the latest <designer file URL> and slice the <screen>"
  Bridge:  duplicates the file (view-only access is enough), auto-trashes your
           previous copy, and opens the fresh copy in Figma desktop.
  You  ->  press  Option+Cmd+P  in that file to run the bridge plugin
           (keep the plugin panel open).
  Agent -> reads the design over the bridge and generates the code.

  Repeat whenever the designer updates the file.
  No manual duplicating. No cleanup — the old copy is trashed automatically.

  Full guide: $INSTALL_DIR/GUIDE.md
EOF

printf '\n%sDone.%s\n' "$BOLD$GRN" "$RST"
