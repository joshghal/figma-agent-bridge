import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const TOKEN_DIR = path.join(os.homedir(), ".figma-agent-bridge");
const TOKEN_PATH = path.join(TOKEN_DIR, "token");

let cachedToken: string | null = null;

/**
 * Returns this install's per-machine bridge auth token, generating and
 * persisting one (0600, under the user's home dir) on first use. Safe to
 * call concurrently from multiple sibling MCP server processes: uses an
 * exclusive create so exactly one writer wins; every other caller falls
 * back to reading the winner's value. Never checked into the repo.
 */
export function getOrCreateToken(): string {
  if (cachedToken) return cachedToken;
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  try {
    const token = crypto.randomBytes(32).toString("hex");
    // Trailing newline so `cat ~/.figma-agent-bridge/token` prints cleanly
    // (no zsh "%" no-newline marker that users copy by accident when pairing).
    // The read path below trims, so the stored value stays the bare token.
    fs.writeFileSync(TOKEN_PATH, token + "\n", { flag: "wx", mode: 0o600 });
    cachedToken = token;
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    cachedToken = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    return cachedToken;
  }
}

export function tokenFilePath(): string {
  return TOKEN_PATH;
}

/** Constant-time compare; mismatched length short-circuits (length isn't secret). */
export function tokensMatch(a: string | undefined | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Guard against equal .length but different byte length (multibyte input),
  // which would make timingSafeEqual throw. No auth impact, avoids a crash path.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
