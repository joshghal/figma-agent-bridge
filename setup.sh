#!/usr/bin/env bash
#
# figma-agent-bridge — team setup & doctor
# ----------------------------------------
# Sets up the Figma -> code "follow-and-slice" bridge, then DIAGNOSES the
# result: builds the server + plugin, boots the server to confirm it exposes
# the expected tools, checks whether the MCP server is registered with Claude
# Code, checks the browser login profile, and reminds you to reconnect a
# running session (which won't hot-reload a rebuilt server).
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
  local existing; existing="$(claude mcp get figma-bridge 2>/dev/null | awk -F'Args:' '/Args:/{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2}')"
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
  if ! command -v claude >/dev/null 2>&1; then
    info "Claude CLI not found — ensure your MCP client runs: $NODE_BIN $SERVER_ENTRY"
    return
  fi
  local out; out="$(claude mcp get figma-bridge 2>/dev/null || true)"
  if [ -z "$out" ] || printf '%s' "$out" | grep -qiE 'no mcp server|not found'; then
    warn "figma-bridge is NOT registered. Fix:"
    info "    claude mcp add figma-bridge --scope user -- $NODE_BIN $SERVER_ENTRY"
    PROBLEMS=$((PROBLEMS + 1)); return
  fi
  # Extract the registered server path and validate it — the #1 real-world break
  # is a stale entry pointing at a path that doesn't exist ("Connection closed").
  local regpath; regpath="$(printf '%s\n' "$out" | awk -F'Args:' '/Args:/{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2}')"
  if [ -n "$regpath" ] && [ ! -f "$regpath" ]; then
    warn "figma-bridge points to a MISSING file: $regpath"
    info "    This causes 'MCP error -32000: Connection closed'. Fix:"
    info "    for s in local project user; do claude mcp remove figma-bridge -s \$s; done"
    info "    claude mcp add figma-bridge --scope user -- $NODE_BIN $SERVER_ENTRY"
    PROBLEMS=$((PROBLEMS + 1))
  elif [ -n "$regpath" ] && [ "$regpath" != "$SERVER_ENTRY" ]; then
    warn "figma-bridge points to a DIFFERENT path than this install:"
    info "    registered: $regpath"
    info "    expected:   $SERVER_ENTRY"
    info "    Re-run ./setup.sh to fix, or re-register with the correct absolute path."
    PROBLEMS=$((PROBLEMS + 1))
  elif printf '%s' "$out" | grep -qi connected; then
    ok "figma-bridge registered and connected ($regpath)."
  else
    ok "figma-bridge registered ($regpath) — reconnect the session to load it."
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

# All the human-facing guidance, printed once at the very end of setup.
print_next_steps() {
  say "NEXT STEPS — finish setup (do these in order)"
  info "1. Figma DESKTOP app: Plugins -> Development -> Import plugin from manifest..."
  info "      select:  $INSTALL_DIR/plugin/manifest.json"
  info "2. Load the bridge into Claude Code: run  /mcp reconnect , or quit & reopen it."
  info "      (A running session does NOT hot-reload a rebuilt server.)"
  info "3. Ask your agent to run  figma_login  once"
  info "      (use the account with view access to the designer's files)."
  info ""
  info "Then — the daily workflow (follow a designer's file, slice it to code):"
  info "   You    ->  \"pull the latest <designer file URL> and slice the <screen>\""
  info "   Bridge ->  duplicates it (view access is enough), trashes the previous copy,"
  info "              opens the fresh copy in Figma desktop."
  info "   You    ->  press  Option+Cmd+P  in that file to run the bridge plugin."
  info "   Agent  ->  reads the design and generates the code."
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

# --- verify -----------------------------------------------------------------
health_check
check_registration
check_login

if [ "$PROBLEMS" -eq 0 ]; then
  printf '\n%sSetup complete — all checks passed.%s\n' "$BOLD$GRN" "$RST"
else
  printf '\n%sSetup done, but %d check(s) need attention — see ✗ above.%s\n' "$BOLD$YLW" "$PROBLEMS" "$RST"
fi

# --- guide (all human steps, last) ------------------------------------------
print_next_steps
