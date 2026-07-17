import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Page } from "playwright";
import {
  FILE_URL_RE,
  FigmaBrowserError,
  assertLoggedIn,
  getContext,
  isLoginUrl,
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
          const fileKey = await waitForFileUrl(page, 60_000, () => true);
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
                (key) => key !== sourceKey
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
    "List Figma files visible in your account's file browser (Drafts or Recents) by scraping figma.com/files in the bridge browser. Best-effort: returns what the file browser renders. Requires a logged-in browser session (figma_login).",
    {
      view: z
        .enum(["drafts", "recents"])
        .optional()
        .describe("Which file-browser view to list (default drafts)"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of files to return (default 50)"),
    },
    async ({ view, limit }): Promise<ToolResult> => {
      try {
        return await withPage(async (page) => {
          const target =
            (view ?? "drafts") === "drafts"
              ? "https://www.figma.com/files/drafts"
              : "https://www.figma.com/files/recents";
          await page.goto(target, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(2_000);
          assertLoggedIn(page);

          const selector = 'a[href*="/design/"], a[href*="/file/"], a[href*="/board/"], a[href*="/slides/"]';
          await page
            .waitForSelector(selector, { timeout: 15_000 })
            .catch(() => {});
          // Nudge the virtualized list to render more tiles.
          for (let i = 0; i < 3; i++) {
            await page.mouse.wheel(0, 2_000);
            await page.waitForTimeout(500);
          }

          const raw = await page.$$eval(selector, (anchors) =>
            anchors.map((a) => ({
              href: (a as HTMLAnchorElement).href,
              label:
                a.getAttribute("aria-label") ||
                a.getAttribute("title") ||
                (a.textContent ?? "").trim().split("\n")[0],
            }))
          );

          const seen = new Set<string>();
          const files: Array<{ name: string; fileKey: string; fileUrl: string }> = [];
          for (const item of raw) {
            const match = item.href.match(FILE_URL_RE);
            if (!match || seen.has(match[1])) continue;
            seen.add(match[1]);
            files.push({
              name: item.label || "(unnamed)",
              fileKey: match[1],
              fileUrl: item.href.split("?")[0],
            });
            if (files.length >= (limit ?? 50)) break;
          }
          return ok({ view: view ?? "drafts", count: files.length, files });
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
