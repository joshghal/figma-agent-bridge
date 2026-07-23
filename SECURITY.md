# Security Review — 2026-07-23

Internal review performed prior to team-wide rollout announcement, requested by Micky Kurniawan as a precondition for posting to #ai-compendium.

## Scope

`server/src` (bridge, election, follower, leader, node, tools, schema, types), `server/src/browser` (session, tools), `plugin/src/main` (code, serializer, transfer), README/GUIDE/setup.sh, package.json (server + plugin).

## Overall risk posture

Path-traversal handling, SSRF protection on image fetch, `spawn` usage, and deserialization are all implemented safely. However, the local bridge server (`server/src/leader.ts`, `server/src/bridge.ts`) has **no authentication and no Origin validation**, and binds to all network interfaces rather than localhost-only. This is the same vulnerability class that has affected other local MCP/agent-bridge tools. Status: **fix required before broad rollout.**

## Findings

### Finding 1 — HIGH: No auth / no Origin check on the local WS + HTTP bridge

**Files:** `server/src/leader.ts:29-45,77-153`, `server/src/bridge.ts:49-70,76-93`

The `/rpc` HTTP endpoint and `/ws` WebSocket endpoint accept requests from anyone able to reach the port — no shared secret, no `Origin`/`Sec-WebSocket-Origin` check.

- **Blind CSRF via browser tab:** any page open in the user's browser while the bridge is running can `fetch('http://localhost:1994/rpc', { headers: { 'Content-Type': 'text/plain' }, body: '{"tool":"execute_code","params":{"code":"..."}}' })`. The `text/plain` content type keeps it a CORS-simple request (no preflight), and `leader.ts` never checks `Content-Type` before `JSON.parse`. This can trigger arbitrary JS execution in the Figma plugin sandbox, or destructive calls (`delete_nodes`, `delete_page`, `sync_nodes` overwrite) — no click or confirmation from the user required.
- **WS connection hijack:** a page can open `new WebSocket('ws://localhost:1994/ws?fileKey=<known-fileKey>&fileName=Evil')`. Per `bridge.ts:76-81` this replaces the real plugin's registered connection for that fileKey, letting an attacker intercept tool calls or return fabricated data to the agent. Only requires knowing/guessing a fileKey, which is routinely shared in Slack/Jira links.

**Fix:** shared per-install token (generated at setup, stored under `~/.figma-agent-bridge/`) required on both `/rpc` and `/ws`; reject requests/connections carrying a browser-style `Origin` header; don't allow a new WS connection to silently replace an existing one for the same fileKey without matching auth.

### Finding 2 — MEDIUM: Server binds to all interfaces, not localhost-only

**File:** `server/src/leader.ts:69`

`server.listen(this.port, ...)` with no host binds to `0.0.0.0`/`::`. Combined with Finding 1, anyone on the same LAN/Wi-Fi (shared office network, coworking space, conference) can reach `/rpc` and `/ws` directly — no browser tab or victim interaction needed at all.

**Fix:** `server.listen(this.port, "127.0.0.1", callback)`. Defense-in-depth only — does not replace Finding 1's fix, since a malicious page in the victim's own browser can still reach `127.0.0.1`.

## Checked and clean (no findings)

- **Path traversal** (`tools.ts:997-1012, 1020-1049`): `save_screenshots` outputPath and `create_image` local-file source both resolved against `process.cwd()` and rejected if `path.relative()` escapes root or is absolute.
- **SSRF** (`tools.ts:1127-1186`): remote image fetch resolves hostname and blocklists loopback/private/link-local/multicast ranges (incl. `169.254.169.254`), caps redirects and byte size. Minor theoretical DNS-rebinding TOCTOU noted but not exploitable for exfiltration — not filed as a finding.
- **Command/code injection**: only `child_process` use is array-form `spawn("open", [...])` in `browser/tools.ts:288-292`, fileKey pre-validated as alphanumeric. `execute_code`'s indirect `eval` (`plugin/src/main/code.ts:1941`) is the tool's documented intended feature, not a bug in itself — it's the payload Finding 1 lets an unauthenticated party trigger.
- **Browser automation**: no `page.evaluate()` takes untrusted input; all `page.goto()` targets built from pre-validated fileKeys.
- **Secrets**: none hardcoded in `server/src` or `plugin/src`.
- **Deserialization**: `serializer.ts`/`transfer.ts` use plain JSON deep-clone, direct field assignment onto Figma API objects — no prototype pollution, no eval-based deserialization.
- **Figma manifest**: `plugin/manifest.json` scopes `networkAccess.allowedDomains` to `ws://localhost:1994` only, limiting (not eliminating) exfiltration even if Finding 1 is exploited.

## Fix implemented — 2026-07-23

- **Finding 1 (`/rpc`):** `server/src/leader.ts` now rejects any request carrying an `Origin` header (403) and requires an `x-bridge-token` header matching a per-install token (401 otherwise), both checked before `handleRPC` runs. Token is generated on first use by `server/src/auth.ts` (`crypto.randomBytes(32)`, hex), persisted to `~/.figma-agent-bridge/token` (mode 0600), read by both Leader and Follower processes. `server/src/follower.ts` attaches it on every `/rpc` call.
- **Finding 1 (`/ws`):** `server/src/bridge.ts` requires the same token, passed by the client as a `Sec-WebSocket-Protocol` value (`bridge-token.<token>`). An unauthorized upgrade completes the handshake then immediately closes with code `4001` (rather than rejecting pre-handshake) so the plugin UI can distinguish "bad token" from "server not running" and prompt for re-pairing instead of retrying forever. A socket is never registered into the connections map unless authorized.
- **Finding 2:** `server.listen(this.port, "127.0.0.1", ...)` in `leader.ts` — localhost-only bind.
- **Plugin pairing:** since the Figma plugin UI iframe has no filesystem access, the token is entered once manually (paste from `~/.figma-agent-bridge/token` into the plugin), stored via `figma.clientStorage`, and auto-reused on every reconnect/Figma restart — see GUIDE.md.
- **Considered and rejected:** randomizing the WS port per install. Figma's plugin manifest (`networkAccess.allowedDomains`) statically allowlists `ws://localhost:1994` at build time with no wildcard-port support, so a random per-install port would require a custom-built plugin bundle per engineer — defeats the single shared marketplace build. It would also only be obscurity (browser-based port scanning is a known technique) rather than a real fix, so the token + Origin check was used instead.

## Status

- [x] Finding 1 fixed (auth token + Origin check)
- [x] Finding 2 fixed (localhost-only bind)
- [x] Re-verified post-fix (independent adversarial recheck agent — CSRF path, WS-hijack path, legitimate Follower/plugin paths, and 5 categories of possible regressions all confirmed clean; one cosmetic UX bug found and fixed — resubmitting an identical wrong token now forces a fresh reconnect attempt via a nonce)
- [ ] Manually installed & tested by author
