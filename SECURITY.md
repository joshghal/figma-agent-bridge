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

## Status (Review #1)

- [x] Finding 1 fixed (auth token + Origin check)
- [x] Finding 2 fixed (localhost-only bind)
- [x] Re-verified post-fix (independent adversarial recheck agent — CSRF path, WS-hijack path, legitimate Follower/plugin paths, and 5 categories of possible regressions all confirmed clean; one cosmetic UX bug found and fixed — resubmitting an identical wrong token now forces a fresh reconnect attempt via a nonce)
- [x] Manually installed & tested by author (auth pairing + port change confirmed working end-to-end)

> Note: after Review #1 the WebSocket port was moved `1994 → 31856` (1994 = IANA `stun-port`, and low in range; 31856 is a fixed uncommon port below the OS ephemeral range). Line numbers above predate that change and the auth edits; they refer to the original review commit.

---

# Security Review #2 — 2026-07-23 (post-fix re-audit @ a910536)

Full re-review of the current tree after the auth rework + port change, with extra scrutiny on the new `auth.ts`. **Both prior findings confirmed genuinely closed** (token gates every reachable `/rpc` and `/ws` path; unauthorized WS sockets closed 4001 before registration; bind is `127.0.0.1`; token is 256-bit, 0600, never logged / never in a URL / never committed). Command injection, path traversal, browser-automation navigation, deserialization/prototype-pollution, and hardcoded secrets all clean. One new finding cleared the bar.

### Finding 3 — MEDIUM: SSRF blocklist bypass via IPv4-mapped IPv6 literals

**File:** `server/src/tools.ts` — `isBlockedIp()` (the `create_image` remote-fetch guard).

The blocklist assumed IPv4-mapped addresses serialize dotted (`::ffff:127.0.0.1`) and recursed on that prefix. But the WHATWG `URL` parser normalizes `http://[::ffff:127.0.0.1]/` to the **hex** form `::ffff:7f00:1`; the recursion then runs `isIP("7f00:1") === 0`, matches no rule, and returns `false` (not blocked). Execution-proven bypass:

```
http://[::ffff:127.0.0.1]/          → ::ffff:7f00:1     not blocked   (loopback)
http://[::ffff:169.254.169.254]/…   → ::ffff:a9fe:a9fe  not blocked   (cloud metadata)
http://[::ffff:10.0.0.5]/           → ::ffff:a00:5      not blocked   (RFC-1918 LAN)
```

Dual-stack sockets route these to the underlying IPv4, reaching the real internal target. Secondary gap: the link-local test `/^fe[89ab]:/` never matches the canonical `fe80::…` form, so `fe80::/10` was unblocked too.

**Exploit (stated threat model):** a crafted Figma file carries prompt-injection text the agent ingests via `get_document`/`get_design_context` instructing it to `create_image` from `http://[::ffff:169.254.169.254]/latest/meta-data/…`. Blind SSRF with a status/size oracle; on a cloud dev box the metadata credential endpoint is reachable (Medium on a laptop, trending High in cloud).

**Fix (planned → implemented):** rework `isBlockedIp` to fail closed on the whole low special-purpose IPv6 block — treat every literal starting with `::` (unspecified, loopback, IPv4-mapped in both dotted and hex forms, deprecated IPv4-compatible) as blocked, since none are legitimate public image hosts and mapped literals were the bypass; block NAT64 `64:ff9b::/96` likewise; and fix ULA/link-local/multicast to proper bitmask range checks (`fc00::/7`, `fe80::/10`, `ff00::/8`) so `fe80::` actually matches. Non-parseable inputs fail closed (return blocked). Verified empirically against all bypass vectors plus legitimate public IPv4/IPv6.

Also applied (Review #2 sub-bar hardening, not a filed vuln): `tokensMatch` in `auth.ts` now guards on `Buffer.byteLength` before `timingSafeEqual`, so a same-`.length`/different-byte-length input can't throw a `RangeError` (was DoS-class only, no auth bypass).

Additionally, the Review #2 fix went beyond the filed finding and closed the reviewer's defense-in-depth follow-ups in the same pass: 6to4 `2002::/16`, Teredo `2001:0::/32`, and deprecated site-local `fec0::/10` are now blocked too (each can embed/route to an internal IPv4). Verified against 41 vectors (all internal/mapped/6to4/Teredo/NAT64/fec0/link-local forms blocked; all public IPv4 + global-unicast IPv6 incl. `2001:4860::`/`2606:4700::` allowed; boundary cases `172.15`/`172.32`/`192.167`/`100.63`/`100.128` correctly allowed).

Two residual items are **accepted as known, non-blocking** (documented, not fixed this pass): (a) the `startsWith("::")` rule is correct only because every current caller passes a URL-parser- or resolver-canonicalized (compressed) string — an uncompressed `0:0:0:0:0:ffff:…` literal is not reachable through any caller today but would bypass if `isBlockedIp` were reused on raw input; (b) pre-existing DNS-rebinding TOCTOU (hostname validated, then `fetch` re-resolves independently) — a broader fix (pin the validated IP at connect time) is out of scope for this SSRF-literal fix.

## Status (Review #2)

- [x] Finding 3 fixed (SSRF blocklist rework — IPv4-mapped hex form, link-local, + 6to4/Teredo/fec0/NAT64)
- [x] tokensMatch byte-length guard added
- [x] Re-audited post-fix (independent adversarial agent: original bypass CLOSED, no new practical bypass on a default/cloud host, no regression on public addresses, `isBlockedIpv4` + `tokensMatch` confirmed correct — verdict GO)
- [ ] Manually re-tested by author
