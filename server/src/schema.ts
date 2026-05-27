import { z } from "zod";

/**
 * Figma node IDs:
 *   - top-level node:        "4029:12345"
 *   - child inside INSTANCE: "I12740:17806;12740:17793" (and deeper, semicolon-separated)
 *
 * Both forms are valid for figma.getNodeById and are returned as-is by the plugin
 * from get_selection / get_design_context.
 */
export const figmaNodeId = z
  .string()
  .regex(
    /^(\d+:\d+|I\d+:\d+(;\d+:\d+)+)$/,
    "Node ID must use colon format, e.g. '4029:12345', or instance-child format 'I12740:17806;12740:17793'"
  );
const exportFormat = z.enum(["PNG", "SVG", "JPG", "PDF"]);

const fileKeyField = z
  .string()
  .optional()
  .describe(
    "The fileKey of the Figma file to query. Required when multiple files are connected. Use list_files to see connected files."
  );

export const toolInputSchemas = {
  get_document: z.object({
    fileKey: fileKeyField,
  }),

  get_selection: z.object({
    fileKey: fileKeyField,
  }),

  get_node: z.object({
    nodeId: figmaNodeId.describe(
      "The node ID to fetch. Accepts top-level IDs like '4029:12345' and instance-child IDs like 'I12740:17806;12740:17793'."
    ),
    fileKey: fileKeyField,
  }),

  get_styles: z.object({
    fileKey: fileKeyField,
  }),

  get_metadata: z.object({
    fileKey: fileKeyField,
  }),

  get_design_context: z.object({
    depth: z
      .number()
      .optional()
      .describe("How many levels deep to traverse the node tree (default 2)"),
    fileKey: fileKeyField,
  }),

  get_variable_defs: z.object({
    fileKey: fileKeyField,
  }),

  get_screenshot: z.object({
    nodeIds: z
      .array(figmaNodeId)
      .optional()
      .describe(
        "Optional list of node IDs to export. Accepts top-level IDs like '4029:12345' and instance-child IDs like 'I12740:17806;12740:17793'. Never use hyphens. If empty, exports the current selection.",
      ),
    format: exportFormat
      .optional()
      .describe("Export format: PNG (default) or SVG or JPG or PDF"),
    scale: z
      .number()
      .optional()
      .describe("Export scale for raster formats (default 2)"),
    fileKey: fileKeyField,
  }),

  save_screenshots: z.object({
    items: z
      .array(
        z.object({
          nodeId: figmaNodeId.describe(
            "The node ID to export. Accepts top-level IDs like '4029:12345' and instance-child IDs like 'I12740:17806;12740:17793'."
          ),
          outputPath: z
            .string()
            .min(1)
            .describe(
              "Output file path (relative paths resolve from the MCP server current working directory)",
            ),
          format: exportFormat
            .optional()
            .describe("Per-item export format override: PNG, SVG, JPG, or PDF"),
          scale: z
            .number()
            .optional()
            .describe("Per-item export scale override for raster formats"),
        }),
      )
      .min(1)
      .describe("List of screenshot save operations to execute in batch"),
    format: exportFormat
      .optional()
      .describe("Default export format: PNG (default) or SVG or JPG or PDF"),
    scale: z
      .number()
      .optional()
      .describe("Default export scale for raster formats (default 2)"),
    fileKey: fileKeyField,
  }),
} as const;

type ToolName = keyof typeof toolInputSchemas;

/**
 * Maps the RPC wire format { tool, nodeIds?, params? } to each tool's
 * expected input shape. Typed as Record<ToolName, ...> so adding a schema
 * without a mapper is a compile error.
 */
const rpcToArgs: Record<
  ToolName,
  (nodeIds?: string[], params?: Record<string, unknown>) => unknown
> = {
  get_document: (_nodeIds, params) => ({ ...params }),
  get_selection: (_nodeIds, params) => ({ ...params }),
  get_node: (nodeIds, params) => ({ ...params, nodeId: nodeIds?.[0] }),
  get_styles: (_nodeIds, params) => ({ ...params }),
  get_metadata: (_nodeIds, params) => ({ ...params }),
  get_design_context: (_nodeIds, params) => ({ ...params }),
  get_variable_defs: (_nodeIds, params) => ({ ...params }),
  get_screenshot: (nodeIds, params) => ({ nodeIds, ...params }),
  save_screenshots: (_nodeIds, params) => ({ ...params }),
};

/**
 * Validate an RPC request against the corresponding tool's input schema.
 * Returns an error string on failure, null if valid or no schema exists for the tool.
 */
export function validateRpc(
  tool: string,
  nodeIds?: string[],
  params?: Record<string, unknown>,
): string | null {
  if (!(tool in toolInputSchemas)) return null;

  const name = tool as ToolName;
  const result = toolInputSchemas[name].safeParse(
    rpcToArgs[name](nodeIds, params),
  );
  return result.success ? null : result.error.issues[0].message;
}
