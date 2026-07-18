#!/usr/bin/env node
//
// Opens the bridge's browser profile and waits for the user to log into Figma.
// Skips quickly if already logged in. Session persists in the profile dir so
// the bridge's file-op tools (pull_latest, duplicate_file, ...) are authenticated.
// Exit 0 = logged in (or already), non-zero = could not open / not completed.
//
import os from "node:os";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

const PROFILE_DIR = path.join(os.homedir(), ".figma-agent-bridge", "browser-profile");
const TIMEOUT_MS = Number(process.env.FIGMA_LOGIN_TIMEOUT_MS || 300_000);
const isLoginUrl = (u) => /figma\.com\/(login|signup)/.test(u);

async function launch() {
  const opts = { headless: false, viewport: { width: 1440, height: 900 } };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: "chrome" });
  } catch {
    return await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

let ctx;
try {
  ctx = await launch();
} catch (e) {
  const msg = String(e && e.message);
  if (/ProcessSingleton|already running|context or browser has been closed/i.test(msg)) {
    console.error("The bridge browser profile is already in use — the bridge MCP server likely has it open.");
    console.error("Log in via the MCP tool instead: ask your agent to run figma_login (add switchAccount:true to change accounts).");
  } else if (/Executable doesn't exist|playwright install/i.test(msg)) {
    console.error("Playwright's browser isn't installed. Run:  npx playwright install chromium  (in the server/ folder), then retry.");
  } else {
    console.error("Could not open a browser:", msg);
    console.error("Try: npx playwright install chromium  (in the server/ folder).");
  }
  process.exit(1);
}

try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.figma.com/files", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
  if (!isLoginUrl(page.url())) {
    console.log("Already logged into Figma — session is saved. ✓");
  } else {
    console.log(">> Log into Figma in the browser window that just opened.");
    console.log("   (Waiting up to 5 minutes; this window closes automatically when you're in.)");
    await page.waitForURL((u) => !isLoginUrl(u.toString()), { timeout: TIMEOUT_MS });
    console.log("Logged in — session saved. ✓");
  }
  process.exitCode = 0;
} catch (e) {
  console.error("Login not completed:", String(e && e.message));
  console.error("You can finish this later by asking your agent to run figma_login.");
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
}
