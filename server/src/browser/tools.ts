import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Page } from "playwright";
import {
  FILE_URL_RE,
  FigmaBrowserError,
  assertLoggedIn,
  getContext,
  isLoginUrl,
  isRealFileKey,
  parseFileKey,
} from "./session.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const CONNECT_HINT =
  "To use plugin tools on this file, open it in the Figma desktop app and run the Figma Agent Bridge plugin there (the bridge cannot auto-start plugins).";

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const fail = (err: unknown): ToolResult => {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof FigmaBrowserError ? err.code : "BROWSER_ERROR";
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
};

const fileUrl = (fileKey: string): string =>
  `https://www.figma.com/design/${fileKey}/`;

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Waits until the page lands on a Figma editor URL whose key passes `accept`. */
async function waitForFileUrl(
  page: Page,
  timeoutMs: number,
  accept: (key: string) => boolean
): Promise<string> {
  await page.waitForURL(
    (url) => {
      const u = url.toString();
      if (isLoginUrl(u)) return true; // stop waiting; assertLoggedIn reports it
      const match = u.match(FILE_URL_RE);
      return match !== null && accept(match[1]);
    },
    { timeout: timeoutMs }
  );
  assertLoggedIn(page);
  const match = page.url().match(FILE_URL_RE);
  if (!match) {
    throw new FigmaBrowserError(
      `Expected a Figma editor URL, got: ${page.url()}`,
      "UNEXPECTED_URL"
    );
  }
  return match[1];
}

/** Best-effort rename of the file open in the editor tab. */
async function tryRenameOpenFile(page: Page, name: string): Promise<boolean> {
  try {
    const title = page
      .locator('[data-testid="filename"], button:has-text("Untitled")')
      .first();
    await title.dblclick({ timeout: 5_000 });
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+a" : "Control+a"
    );
    await page.keyboard.type(name, { delay: 20 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_000);
    return true;
  } catch {
    return false;
  }
}

export function registerBrowserTools(server: McpServer): void {
  server.tool(
    "figma_login",
    "Open a browser window for logging into Figma. The session persists in the bridge's browser profile, so this is only needed once (or after the session expires). Waits until the login completes.",
    {
      timeoutMs: z
        .number()
        .optional()
        .describe(
          "How long to wait for the user to finish logging in, in milliseconds (default 180000)"
        ),
    },
    async ({ timeoutMs }): Promise<ToolResult> => {
      try {
        return await withPage(async (page) => {
          await page.goto("https://www.figma.com/files", {
            waitUntil: "domcontentloaded",
          });
          await page.waitForTimeout(2_000);
          if (!isLoginUrl(page.url())) {
            return ok({ loggedIn: true, alreadyLoggedIn: true });
          }
          await page.waitForURL((url) => !isLoginUrl(url.toString()), {
            timeout: timeoutMs ?? 180_000,
          });
          return ok({ loggedIn: true, alreadyLoggedIn: false });
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.tool(
    "create_file",
    "Create a new blank Figma design file in your Drafts by driving figma.com/new in the bridge browser. Returns the new fileKey and URL. Requires a logged-in browser session (figma_login).",
    {
      name: z
        .string()
        .optional()
        .describe("Best-effort name for the new file (rename may fail silently)"),
    },
    async ({ name }): Promise<ToolResult> => {
      try {
        return await withPage(async (page) => {
          await page.goto("https://www.figma.com/new", {
            waitUntil: "domcontentloaded",
          });
          // figma.com/new passes through a transient design/new placeholder for
          // ~3s before the real key is assigned — wait for a real key.
          const fileKey = await waitForFileUrl(page, 60_000, isRealFileKey);
          let renamed = false;
          if (name) {
            renamed = await tryRenameOpenFile(page, name);
          }
          return ok({
            fileKey,
            fileUrl: fileUrl(fileKey),
            renamed,
            note: CONNECT_HINT,
          });
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.tool(
    "duplicate_file",
    "Duplicate a Figma file you can view, using Figma's documented /duplicate URL. The copy lands in your Drafts (or next to the original if you have edit access). Returns the new fileKey and URL. Requires a logged-in browser session (figma_login).",
    {
      file: z
        .string()
        .describe("The source file: a full figma.com file URL or a bare file key"),
    },
    async ({ file }): Promise<ToolResult> => {
      try {
        const sourceKey = parseFileKey(file);
        return await withPage(async (page) => {
          const candidates = [
            `https://www.figma.com/design/${sourceKey}/-/duplicate`,
            `https://www.figma.com/file/${sourceKey}/duplicate`,
          ];
          let lastError: unknown = null;
          for (const url of candidates) {
            try {
              await page.goto(url, { waitUntil: "domcontentloaded" });
              const newKey = await waitForFileUrl(
                page,
                90_000,
                (key) => key !== sourceKey && isRealFileKey(key)
              );
              return ok({
                sourceFileKey: sourceKey,
                fileKey: newKey,
                fileUrl: fileUrl(newKey),
                note: `Copy created (lands in Drafts for view-only sources). ${CONNECT_HINT}`,
              });
            } catch (err) {
              lastError = err;
              if (err instanceof FigmaBrowserError && err.code === "LOGIN_REQUIRED") {
                throw err;
              }
            }
          }
          throw lastError instanceof Error
            ? lastError
            : new FigmaBrowserError(
                `Could not duplicate file ${sourceKey}`,
                "DUPLICATE_FAILED"
              );
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.tool(
    "list_account_files",
    "List Figma files by NAME from your account's file browser (Recents), by reading figma.com/files in the bridge browser. IMPORTANT: Figma no longer exposes file keys in the file-browser DOM, so this returns file names only — not fileKeys/URLs. To act on a file (duplicate_file, plugin tools), open it once and use its URL. Requires a logged-in browser session (figma_login).",
    {
      limit: z
        .number()
        .optional()
        .describe("Maximum number of files to return (default 50)"),
    },
    async ({ limit }): Promise<ToolResult> => {
      try {
        return await withPage(async (page) => {
          // Both /files/recents and /files/drafts redirect to the team
          // recents-and-sharing view; navigate and scrape whatever renders.
          await page.goto("https://www.figma.com/files/recents", {
            waitUntil: "domcontentloaded",
          });
          await page.waitForTimeout(3_000);
          assertLoggedIn(page);

          // File tiles are role="group" divs whose aria-label is the file name
          // (no key anywhere in the DOM). Wait for at least one, then scroll.
          const tileSelector = '[role="listitem"] [role="group"][aria-label]';
          await page
            .waitForSelector(tileSelector, { timeout: 15_000 })
            .catch(() => {});
          for (let i = 0; i < 4; i++) {
            await page.mouse.wheel(0, 2_500);
            await page.waitForTimeout(500);
          }

          const names = await page.$$eval(tileSelector, (tiles) =>
            tiles
              .map((t) => t.getAttribute("aria-label") || "")
              .filter((n) => n.trim().length > 0)
          );

          const seen = new Set<string>();
          const files: Array<{ name: string; fileKey: null; fileUrl: null }> = [];
          for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            files.push({ name, fileKey: null, fileUrl: null });
            if (files.length >= (limit ?? 50)) break;
          }
          return ok({
            count: files.length,
            files,
            note: "Names only — Figma does not expose file keys in the file-browser DOM. Open a file to get its URL/key for duplicate_file or plugin tools.",
          });
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
