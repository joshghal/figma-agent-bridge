#!/usr/bin/env bash
#
# figma-agent-bridge — team setup & doctor
# ----------------------------------------
# One interactive run does everything: builds the server + plugin, registers the
# MCP server fresh (absolute paths), boots it to confirm the tools, then WALKS
# YOU THROUGH the human steps — opens a browser and waits for your Figma login,
# and prompts you to import the plugin — before printing the final NEXT STEPS
# (reconnect Claude Code + run the plugin). Also DIAGNOSES: health, registration
# path, and login. In a non-interactive shell the guided steps are skipped.
#
# Usage:
#   ./setup.sh                   build + configure + diagnose
#   ./setup.sh /path/to/project  also write figma-bridge into that .mcp.json
#   ./setup.sh --check           diagnose only (no clone/build) — a "doctor"
#
# A single `./setup.sh` prepares everything: it wipes any existing figma-bridge
# registration and reinstalls it fresh with absolute paths — no extra flags.
#
# Env:
#   FIGMA_BRIDGE_DIR   install location (default: ~/figma-agent-bridge)
#
set -euo pipefail

REPO_URL="https://github.com/joshghal/figma-agent-bridge.git"
PROFILE_DIR="$HOME/.figma-agent-bridge/browser-profile"

# Install dir: honor FIGMA_BRIDGE_DIR; else if this script sits inside the repo
# (run from a clone), use that clone; else default to ~/figma-agent-bridge.
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/server/package.json" ] && [ -f "$SCRIPT_DIR/plugin/manifest.json" ]; then
  INSTALL_DIR="${FIGMA_BRIDGE_DIR:-$SCRIPT_DIR}"
else
  INSTALL_DIR="${FIGMA_BRIDGE_DIR:-$HOME/figma-agent-bridge}"
fi

# --- pretty output ----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  BOLD=; GRN=; YLW=; RED=; DIM=; RST=
fi
say()  { printf '\n%s==>%s %s%s\n' "$BOLD$GRN" "$RST" "$BOLD" "$*$RST"; }
ok()   { printf '    %s✓%s %s\n' "$GRN" "$RST" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    %s✗ %s%s\n' "$YLW" "$*" "$RST"; }
die()  { printf '%sxx %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

SERVER_ENTRY="$INSTALL_DIR/server/dist/index.js"
HEALTHCHECK="$INSTALL_DIR/server/scripts/healthcheck.mjs"
# Absolute node path — GUI-launched Claude Code often lacks Homebrew/nvm in PATH,
# so a bare "node" command fails to spawn ("MCP error -32000: Connection closed").
NODE_BIN="$(command -v node || echo node)"
PROBLEMS=0

# --- diagnostics (used by both setup and --check) ---------------------------
check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js not found — install Node 20+ from https://nodejs.org"
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "Node too old ($(node -v)) — need Node 20+."
}

health_check() {
  say "Health check — does the server boot and expose the tools?"
  if [ ! -f "$SERVER_ENTRY" ]; then
    warn "Not built yet ($SERVER_ENTRY missing). Run ./setup.sh (without --check)."
    PROBLEMS=$((PROBLEMS + 1)); return
  fi
  if node "$HEALTHCHECK"; then
    ok "server boots and all required tools (incl. pull_latest) are present."
  else
    warn "Server health check failed (see above). Rebuild: (cd $INSTALL_DIR/server && npm run build)"
    PROBLEMS=$((PROBLEMS + 1))
  fi
}

print_manual_config() {
  printf '%s{\n  "mcpServers": {\n    "figma-bridge": {\n      "type": "stdio",\n      "command": "%s",\n      "args": ["%s"]\n    }\n  }\n}%s\n' "$DIM" "$NODE_BIN" "$SERVER_ENTRY" "$RST"
}

# Reads figma-bridge's registered server path straight from the config files.
# We do NOT use `claude mcp get`/`list` — those health-check every configured MCP
# server and can hang on an unrelated one (blender, connectors, ...). Prints the
# registered path, or empty if not registered.
registered_server_path() {
  node -e '
    const fs=require("fs"), os=require("os"), path=require("path");
    const files=[path.join(os.homedir(),".claude.json"), path.join(process.cwd(),".mcp.json")];
    let out="";
    const walk=(o)=>{ if(!o||typeof o!=="object"||out) return;
      if(o.mcpServers && o.mcpServers["figma-bridge"]){ out=[].concat(o.mcpServers["figma-bridge"].args||[]).join(" ").trim(); if(out) return; }
      for(const k in o){ walk(o[k]); if(out) return; } };
    for(const f of files){ try{ walk(JSON.parse(fs.readFileSync(f,"utf8"))); }catch{} if(out) break; }
    process.stdout.write(out);
  ' 2>/dev/null
}

# Registers the bridge robustly: clears ANY prior figma-bridge entries (so a
# stale/wrong-path one can't override), then adds it once with ABSOLUTE paths at
# user scope (available in every project, no relative-path mistakes possible).
configure_mcp() {
  say "Registering figma-bridge with Claude Code (absolute paths)"
  if ! command -v claude >/dev/null 2>&1; then
    info "Claude CLI not found — add this to your MCP client config manually:"
    print_manual_config
    return
  fi
  # If one already exists, report it, then wipe EVERY scope so nothing stale
  # (e.g. a wrong-path entry) can survive or override the fresh registration.
  local existing; existing="$(registered_server_path)"
  if [ -n "$existing" ]; then
    info "Existing registration found ($existing) — removing it and reinstalling fresh."
  fi
  for s in local project user; do
    claude mcp remove figma-bridge -s "$s" >/dev/null 2>&1 || true
  done
  if claude mcp add figma-bridge --scope user -- "$NODE_BIN" "$SERVER_ENTRY" >/dev/null 2>&1; then
    ok "Registered figma-bridge (user scope, all projects):"
    info "    $NODE_BIN $SERVER_ENTRY"
  else
    warn "claude CLI registration failed — add manually:"
    print_manual_config
  fi
  # Optional: also write into a specific project's shared .mcp.json.
  if [ -n "$TARGET_DIR" ] && [ -d "$TARGET_DIR" ]; then
    node -e '
      const fs = require("fs");
      const [target, entryPath, nodeBin] = process.argv.slice(1);
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(target, "utf8")); } catch {}
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers["figma-bridge"] = { type: "stdio", command: nodeBin, args: [entryPath] };
      fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
    ' "$TARGET_DIR/.mcp.json" "$SERVER_ENTRY" "$NODE_BIN"
    ok "Also wrote figma-bridge into $TARGET_DIR/.mcp.json (absolute paths)"
  fi
}

check_registration() {
  say "MCP registration — is figma-bridge configured correctly?"
  # Read the registration from the config file (no server health-check / hang).
  local regpath; regpath="$(registered_server_path)"
  if [ -z "$regpath" ]; then
    warn "figma-bridge is NOT registered. Re-run ./setup.sh (it registers it)."
    PROBLEMS=$((PROBLEMS + 1)); return
  fi
  # regpath is the server .js path; validate it — the #1 real-world break is a
  # stale entry pointing at a path that doesn't exist ("Connection closed").
  local serverfile; serverfile="$(printf '%s' "$regpath" | awk '{print $NF}')"
  if [ ! -f "$serverfile" ]; then
    warn "figma-bridge points to a MISSING file: $serverfile"
    info "    This causes 'MCP error -32000: Connection closed'. Re-run ./setup.sh to fix."
    PROBLEMS=$((PROBLEMS + 1))
  elif [ "$serverfile" != "$SERVER_ENTRY" ]; then
    warn "figma-bridge points to a DIFFERENT path than this install:"
    info "    registered: $serverfile"
    info "    expected:   $SERVER_ENTRY"
    info "    Re-run ./setup.sh to fix."
    PROBLEMS=$((PROBLEMS + 1))
  else
    ok "figma-bridge registered ($serverfile). Reconnect the session to load it."
  fi
}

check_login() {
  say "Browser login — is a Figma session saved for file ops?"
  if [ -d "$PROFILE_DIR" ]; then
    ok "browser profile exists — figma_login likely done."
    info "(If create/duplicate/pull_latest return LOGIN_REQUIRED, re-run figma_login.)"
  else
    warn "No browser profile yet. Ask your agent to run figma_login once before file ops."
    PROBLEMS=$((PROBLEMS + 1))
  fi
}

reconnect_reminder() {
  say "Reconnect reminder"
  info "A running Claude Code session does NOT hot-reload a rebuilt server."
  info "If a session is open, load this build with either:"
  info "    - /mcp reconnect   (in the session), or"
  info "    - quit & reopen Claude Code."
}

# Interactive: open the browser and wait for the user to log into Figma.
guided_login() {
  say "Figma login — a browser window will open"
  info "Log into Figma in the window (it closes itself when you're in; skips if already logged in)."
  if node "$INSTALL_DIR/server/scripts/login.mjs"; then
    ok "Figma session ready."
  else
    warn "Login step didn't complete — you can run figma_login later via your agent."
    PROBLEMS=$((PROBLEMS + 1))
  fi
}

# Interactive: guide the plugin import and wait for confirmation.
guided_plugin_import() {
  say "Import the Figma plugin (one-time, in the DESKTOP app)"
  info "   Plugins -> Development -> Import plugin from manifest..."
  info "   select:  $INSTALL_DIR/plugin/manifest.json"
  printf '    Press Enter once the plugin is imported (or Enter to skip)... '
  read -r _ || true
  ok "Continuing."
}

# Final guidance, printed once at the very end.
print_next_steps() {
  say "NEXT STEPS — finish and start using it"
  info "1. Load the bridge into Claude Code:  /mcp reconnect  (or quit & reopen it)."
  info "      A running session does NOT hot-reload a rebuilt server."
  info "2. Run the plugin in your Figma file:  Plugins -> Development -> Figma Agent Bridge"
  info "      (or press  Option+Cmd+P ). Keep the panel open — it should show Connected."
  info "      If you skipped import above: Import from manifest -> $INSTALL_DIR/plugin/manifest.json"
  info "      If you skipped login above:  ask your agent to run  figma_login ."
  info ""
  info "Then — daily use (follow a designer's file, slice it to code):"
  info "   \"pull the latest <designer file URL> and slice the <screen>\"  ->  Option+Cmd+P  ->  done"
  info ""
  info "Diagnose anytime:  ./setup.sh --check      Full guide:  $INSTALL_DIR/GUIDE.md"
}

# --- arg parsing ------------------------------------------------------------
MODE="setup"; TARGET_DIR=""
for a in "$@"; do
  case "$a" in
    --check|--doctor) MODE="check" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) TARGET_DIR="$a" ;;
  esac
done

# --- --check (doctor) mode --------------------------------------------------
if [ "$MODE" = "check" ]; then
  say "Diagnosing figma-agent-bridge at $INSTALL_DIR"
  check_node
  [ -d "$INSTALL_DIR" ] || die "Not installed at $INSTALL_DIR — run ./setup.sh first."
  health_check
  check_registration
  check_login
  reconnect_reminder
  if [ "$PROBLEMS" -eq 0 ]; then
    printf '\n%sAll checks passed.%s\n' "$BOLD$GRN" "$RST"
  else
    printf '\n%s%d issue(s) found — see ✗ above.%s\n' "$BOLD$YLW" "$PROBLEMS" "$RST"
  fi
  exit 0
fi

# --- full setup -------------------------------------------------------------
say "Checking prerequisites"
command -v git  >/dev/null 2>&1 || die "git not found (macOS: run 'xcode-select --install')."
check_node
command -v npm  >/dev/null 2>&1 || die "npm not found (comes with Node.js)."
ok "git $(git --version | awk '{print $3}'), node $(node -v), npm $(npm -v)"

if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || warn "Could not fast-forward — resolve git state manually."
else
  say "Cloning into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

say "Building the MCP server"
( cd "$INSTALL_DIR/server" && npm install && npm run build )
say "Building the Figma plugin"
( cd "$INSTALL_DIR/plugin" && npm install && npm run build )

say "Checking the browser used for file operations"
if [ "$(uname)" = "Darwin" ] && [ -d "/Applications/Google Chrome.app" ]; then
  ok "Google Chrome found — the bridge will use it."
else
  warn "Google Chrome not found — installing Playwright's bundled Chromium."
  ( cd "$INSTALL_DIR/server" && npx --yes playwright install chromium )
fi

[ -f "$SERVER_ENTRY" ] || die "Build did not produce $SERVER_ENTRY — check the output above."

configure_mcp

# --- verify + guided interactive steps --------------------------------------
health_check
check_registration

# In a real terminal, walk the user through login + plugin import right here so
# a single run completes everything. Skipped in non-interactive shells.
if [ -t 0 ] && [ -t 1 ]; then
  guided_login
  guided_plugin_import
else
  info "(non-interactive shell — do figma_login + plugin import from NEXT STEPS below.)"
fi

check_login

if [ "$PROBLEMS" -eq 0 ]; then
  printf '\n%sSetup complete — all checks passed.%s\n' "$BOLD$GRN" "$RST"
else
  printf '\n%sSetup done, but %d check(s) need attention — see ✗ above.%s\n' "$BOLD$YLW" "$PROBLEMS" "$RST"
fi

# --- guide (all human steps, last) ------------------------------------------
print_next_steps
