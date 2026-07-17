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

const TILE_SELECTOR = '[role="listitem"] [role="group"][aria-label]';
const MENU_ITEM_SELECTOR = ".multilevel_dropdown--name--uJ5IP";

/** Opens the Recents file browser and waits for tiles to render. */
async function openFileBrowser(page: Page): Promise<void> {
  // Both /files/recents and /files/drafts redirect to the team recents view.
  await page.goto("https://www.figma.com/files/recents", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(3_000);
  assertLoggedIn(page);
  await page.waitForSelector(TILE_SELECTOR, { timeout: 15_000 }).catch(() => {});
}

/** Clicks a right-click context-menu item by its exact visible text. */
async function clickMenuItem(page: Page, text: string): Promise<void> {
  await page
    .locator(MENU_ITEM_SELECTOR, { hasText: new RegExp(`^${text}$`) })
    .first()
    .click({ timeout: 5_000 });
}

/**
 * Reads a file tile's key via the sanctioned UI path: right-click → Copy link →
 * read the clipboard. Figma does not expose file keys in the DOM otherwise.
 */
async function keyViaCopyLink(page: Page, tile: import("playwright").Locator): Promise<string | null> {
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  await tile.click({ button: "right" });
  await page.waitForTimeout(500);
  await clickMenuItem(page, "Copy link");
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  const m = clip.match(FILE_URL_RE);
  return m ? m[1] : null;
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
    "List Figma files from your account's Recents browser, with real fileKeys. Figma does not expose keys in the DOM, so each file's key is read via the sanctioned right-click → Copy link → clipboard flow (one interaction per file, so this is slower than a plain scrape — keep the limit modest). Requires a logged-in browser session (figma_login).",
    {
      limit: z
        .number()
        .optional()
        .describe("Maximum number of files to return (default 20). Each file costs one right-click+copy, so higher limits are slower."),
    },
    async ({ limit }): Promise<ToolResult> => {
      try {
        return await withPage(async (page) => {
          await openFileBrowser(page);
          for (let i = 0; i < 3; i++) {
            await page.mouse.wheel(0, 2_500);
            await page.waitForTimeout(400);
          }
          const tiles = page.locator(TILE_SELECTOR);
          const total = await tiles.count();
          const max = Math.min(total, limit ?? 20);
          const files: Array<{ name: string; fileKey: string | null; fileUrl: string | null }> = [];
          const seenKeys = new Set<string>();
          for (let i = 0; i < max; i++) {
            const tile = tiles.nth(i);
            const name = (await tile.getAttribute("aria-label")) || "(unnamed)";
            let key: string | null = null;
            try {
              key = await keyViaCopyLink(page, tile);
            } catch {
              await page.keyboard.press("Escape").catch(() => {});
            }
            if (key && seenKeys.has(key)) continue;
            if (key) seenKeys.add(key);
            files.push({
              name,
              fileKey: key,
              fileUrl: key ? `https://www.figma.com/design/${key}/` : null,
            });
          }
          return ok({ count: files.length, totalTiles: total, files });
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.tool(
    "delete_file",
    "Move a Figma file to trash (recoverable from Figma's trash for 30 days). Identifies the target by fileKey via the right-click → Copy link flow, so it deletes exactly the file you name and never a same-named one. Destructive — requires confirm: true. Requires a logged-in browser session (figma_login).",
    {
      file: z.string().describe("The file to trash: a full figma.com URL or a bare file key"),
      confirm: z.boolean().describe("Must be true to confirm moving the file to trash"),
    },
    async ({ file, confirm }): Promise<ToolResult> => {
      try {
        if (confirm !== true) {
          return fail(new FigmaBrowserError("delete_file requires confirm: true", "CONFIRM_REQUIRED"));
        }
        const targetKey = parseFileKey(file);
        return await withPage(async (page) => {
          await openFileBrowser(page);
          for (let i = 0; i < 4; i++) {
            await page.mouse.wheel(0, 2_500);
            await page.waitForTimeout(400);
          }
          const tiles = page.locator(TILE_SELECTOR);
          const total = await tiles.count();
          for (let i = 0; i < total; i++) {
            const tile = tiles.nth(i);
            const name = (await tile.getAttribute("aria-label")) || "";
            let key: string | null = null;
            try {
              key = await keyViaCopyLink(page, tile);
            } catch {
              await page.keyboard.press("Escape").catch(() => {});
              continue;
            }
            if (key !== targetKey) continue;
            // Found it — re-open the menu and move to trash.
            await tile.click({ button: "right" });
            await page.waitForTimeout(500);
            await clickMenuItem(page, "Move to trash");
            // "Move to trash" opens a confirmation modal that must be confirmed.
            const confirmBtn = page.locator(
              '[data-testid="confirmation-modal-confirm-action-button"]'
            );
            await confirmBtn.click({ timeout: 5_000 });
            await confirmBtn
              .waitFor({ state: "detached", timeout: 5_000 })
              .catch(() => {});
            await page.waitForTimeout(500);
            return ok({
              deleted: true,
              fileKey: targetKey,
              name,
              note: "Moved to trash (recoverable from Figma trash for 30 days).",
            });
          }
          return fail(
            new FigmaBrowserError(
              `File ${targetKey} not found in the Recents browser (only recent files are scannable). Open it once so it appears in Recents, then retry.`,
              "FILE_NOT_FOUND"
            )
          );
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
