import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

const PROFILE_DIR = path.join(
  os.homedir(),
  ".figma-agent-bridge",
  "browser-profile"
);

/**
 * Error with a stable machine-readable code so agents can react
 * (e.g. LOGIN_REQUIRED → call figma_login and retry).
 */
export class FigmaBrowserError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "FigmaBrowserError";
  }
}

let contextPromise: Promise<BrowserContext> | null = null;

async function launchContext(): Promise<BrowserContext> {
  const options = {
    headless: false,
    viewport: { width: 1440, height: 900 },
  };
  try {
    // Prefer the system Chrome so no browser download is needed.
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      ...options,
      channel: "chrome" as const,
    });
  } catch {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("ProcessSingleton") ||
        message.includes("Target page, context or browser has been closed") ||
        message.includes("browser is already running")
      ) {
        throw new FigmaBrowserError(
          "The bridge browser profile is already in use — most likely another MCP server instance has it open. Run file-op tools from a single instance, or close the other bridge browser window.",
          "PROFILE_LOCKED"
        );
      }
      throw new FigmaBrowserError(
        `Could not launch a browser: ${message}. If Google Chrome is not installed, run: npx playwright install chromium`,
        "LAUNCH_FAILED"
      );
    }
  }
}

/** Returns the shared persistent browser context, launching it on first use. */
export async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = launchContext().then((ctx) => {
      ctx.on("close", () => {
        contextPromise = null;
      });
      return ctx;
    });
    contextPromise.catch(() => {
      contextPromise = null;
    });
  }
  return contextPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextPromise = null;
  await ctx?.close().catch(() => {});
}

export const FILE_URL_RE =
  /figma\.com\/(?:design|file|board|slides)\/([A-Za-z0-9]+)/;

/** Accepts a full Figma file URL or a bare file key; returns the key. */
export function parseFileKey(input: string): string {
  const match = input.match(FILE_URL_RE);
  if (match) return match[1];
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{10,}$/.test(trimmed)) return trimmed;
  throw new FigmaBrowserError(
    `Not a Figma file URL or file key: ${input}`,
    "BAD_INPUT"
  );
}

export function isLoginUrl(url: string): boolean {
  return /figma\.com\/(login|signup)/.test(url);
}

export function assertLoggedIn(page: Page): void {
  if (isLoginUrl(page.url())) {
    throw new FigmaBrowserError(
      "Not logged into Figma in the bridge browser. Run the figma_login tool and complete the login in the window it opens.",
      "LOGIN_REQUIRED"
    );
  }
}
