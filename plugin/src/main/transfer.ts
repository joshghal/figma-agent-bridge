/**
 * Cross-file node transfer: serialize a subtree in one file
 * (export_node_data) and rebuild it in another (import_node_data).
 *
 * Structural types (FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, GROUP) are rebuilt
 * as editable nodes. Everything else (vectors, stars, booleans, instances,
 * components, …) falls back to an SVG snapshot — visually faithful but
 * flattened. Image fills travel as base64 bytes and are re-created on import.
 */

export type TransferTextSegment = {
  start: number;
  end: number;
  fontSize: number;
  fontName: FontName;
  fills: Paint[];
};

export type TransferNode = {
  kind: "structural" | "svg";
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
  opacity?: number;
  rotation?: number;
  cornerRadius?: number;
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  effects?: Effect[];
  layout?: {
    layoutMode: "NONE" | "HORIZONTAL" | "VERTICAL";
    itemSpacing: number;
    paddingLeft: number;
    paddingRight: number;
    paddingTop: number;
    paddingBottom: number;
    primaryAxisAlignItems: string;
    counterAxisAlignItems: string;
    primaryAxisSizingMode: string;
    counterAxisSizingMode: string;
    layoutWrap?: string;
    clipsContent?: boolean;
  };
  text?: {
    characters: string;
    textAlignHorizontal: string;
    textAlignVertical: string;
    textAutoResize: string;
    segments: TransferTextSegment[];
  };
  svg?: string;
  children?: TransferNode[];
};

export type TransferPayload = {
  node: TransferNode;
  /** imageHash → base64 bytes, shared across the subtree */
  images: Record<string, string>;
  warnings: string[];
};

const STRUCTURAL_TYPES = new Set([
  "FRAME",
  "TEXT",
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "GROUP",
]);

const MAX_IMAGE_BYTES_TOTAL = 20 * 1024 * 1024;

const isMixed = (value: unknown): boolean =>
  typeof value === "symbol" || value === figma.mixed;

/** Deep-clones a Plugin API value into plain JSON (drops nothing we rebuild). */
const clonePlain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const collectImagePaints = async (
  paints: readonly Paint[] | typeof figma.mixed,
  images: Record<string, string>,
  warnings: string[]
): Promise<Paint[]> => {
  if (isMixed(paints)) return [];
  const result: Paint[] = [];
  for (const paint of paints as readonly Paint[]) {
    if (paint.type === "IMAGE" && paint.imageHash) {
      if (!(paint.imageHash in images)) {
        try {
          const image = figma.getImageByHash(paint.imageHash);
          if (image) {
            const bytes = await image.getBytesAsync();
            const total = Object.values(images).reduce(
              (sum, b64) => sum + b64.length * 0.75,
              bytes.length
            );
            if (total > MAX_IMAGE_BYTES_TOTAL) {
              warnings.push(
                `Image ${paint.imageHash} skipped: total image payload exceeds ${MAX_IMAGE_BYTES_TOTAL} bytes`
              );
              continue;
            }
            images[paint.imageHash] = figma.base64Encode(bytes);
          }
        } catch (err) {
          warnings.push(
            `Image ${paint.imageHash} could not be read: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
    result.push(clonePlain(paint));
  }
  return result;
};

const exportAsSvg = async (
  node: SceneNode,
  warnings: string[]
): Promise<TransferNode> => {
  let svg = "";
  try {
    svg = await (node as SceneNode & ExportMixin).exportAsync({
      format: "SVG_STRING",
    });
  } catch (err) {
    warnings.push(
      `SVG fallback failed for ${node.type} "${node.name}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return {
    kind: "svg",
    type: node.type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    svg,
  };
};

export const exportNodeData = async (
  node: SceneNode,
  images: Record<string, string>,
  warnings: string[]
): Promise<TransferNode> => {
  if (!STRUCTURAL_TYPES.has(node.type)) {
    warnings.push(
      `${node.type} "${node.name}" transferred as an SVG snapshot (not editable; instances lose component linkage)`
    );
    return exportAsSvg(node, warnings);
  }

  const base: TransferNode = {
    kind: "structural",
    type: node.type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    visible: node.visible,
    opacity: "opacity" in node ? node.opacity : undefined,
    rotation: "rotation" in node ? node.rotation : undefined,
  };

  if ("fills" in node) {
    base.fills = await collectImagePaints(node.fills, images, warnings);
  }
  if ("strokes" in node) {
    base.strokes = await collectImagePaints(node.strokes, images, warnings);
    if ("strokeWeight" in node && !isMixed(node.strokeWeight)) {
      base.strokeWeight = node.strokeWeight as number;
    }
  }
  if ("effects" in node) {
    base.effects = clonePlain(node.effects as Effect[]);
  }
  if ("cornerRadius" in node && !isMixed(node.cornerRadius)) {
    base.cornerRadius = node.cornerRadius as number;
  }

  if (node.type === "TEXT") {
    const text = node as TextNode;
    const segments = text.getStyledTextSegments([
      "fontSize",
      "fontName",
      "fills",
    ]);
    base.text = {
      characters: text.characters,
      textAlignHorizontal: text.textAlignHorizontal,
      textAlignVertical: text.textAlignVertical,
      textAutoResize: text.textAutoResize,
      segments: segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        fontSize: segment.fontSize,
        fontName: clonePlain(segment.fontName),
        fills: clonePlain(segment.fills as Paint[]),
      })),
    };
    // Segment fills carry per-range colors; the node-level fills would fight them.
    delete base.fills;
  }

  if (node.type === "FRAME") {
    const frame = node as FrameNode;
    base.layout = {
      layoutMode: frame.layoutMode,
      itemSpacing: frame.itemSpacing,
      paddingLeft: frame.paddingLeft,
      paddingRight: frame.paddingRight,
      paddingTop: frame.paddingTop,
      paddingBottom: frame.paddingBottom,
      primaryAxisAlignItems: frame.primaryAxisAlignItems,
      counterAxisAlignItems: frame.counterAxisAlignItems,
      primaryAxisSizingMode: frame.primaryAxisSizingMode,
      counterAxisSizingMode: frame.counterAxisSizingMode,
      layoutWrap: frame.layoutWrap,
      clipsContent: frame.clipsContent,
    };
  }

  if (node.type === "FRAME" || node.type === "GROUP") {
    const container = node as FrameNode | GroupNode;
    base.children = [];
    for (const child of container.children) {
      base.children.push(await exportNodeData(child, images, warnings));
    }
  }

  return base;
};

const decodeImages = (
  images: Record<string, string>
): Record<string, string> => {
  // old hash → new hash in the target file
  const mapping: Record<string, string> = {};
  for (const [hash, base64] of Object.entries(images)) {
    try {
      const image = figma.createImage(figma.base64Decode(base64));
      mapping[hash] = image.hash;
    } catch {
      // leave unmapped; paints referencing it keep the stale hash
    }
  }
  return mapping;
};

const remapImagePaints = (
  paints: Paint[] | undefined,
  hashMap: Record<string, string>
): Paint[] | undefined => {
  if (!paints) return undefined;
  return paints.map((paint) => {
    if (paint.type === "IMAGE" && paint.imageHash && hashMap[paint.imageHash]) {
      return { ...paint, imageHash: hashMap[paint.imageHash] };
    }
    return paint;
  });
};

const applyCommonProps = (
  node: SceneNode,
  data: TransferNode,
  hashMap: Record<string, string>
): void => {
  node.name = data.name;
  if (data.visible !== undefined) node.visible = data.visible;
  if (data.opacity !== undefined && "opacity" in node) {
    node.opacity = data.opacity;
  }
  if (data.rotation !== undefined && "rotation" in node) {
    (node as SceneNode & LayoutMixin).rotation = data.rotation;
  }
  const fills = remapImagePaints(data.fills, hashMap);
  if (fills && "fills" in node) {
    (node as GeometryMixin).fills = fills;
  }
  const strokes = remapImagePaints(data.strokes, hashMap);
  if (strokes && "strokes" in node) {
    (node as GeometryMixin).strokes = strokes;
    if (data.strokeWeight !== undefined) {
      (node as GeometryMixin).strokeWeight = data.strokeWeight;
    }
  }
  if (data.effects && "effects" in node) {
    (node as BlendMixin).effects = data.effects;
  }
  if (data.cornerRadius !== undefined && "cornerRadius" in node) {
    (node as SceneNode & CornerMixin).cornerRadius = data.cornerRadius;
  }
};

const buildText = async (
  data: TransferNode,
  hashMap: Record<string, string>,
  warnings: string[]
): Promise<TextNode> => {
  const text = figma.createText();
  const info = data.text;
  if (!info) return text;

  const fonts = new Map<string, FontName>();
  for (const segment of info.segments) {
    fonts.set(
      `${segment.fontName.family}::${segment.fontName.style}`,
      segment.fontName
    );
  }
  const fallbackFont: FontName = { family: "Inter", style: "Regular" };
  const loadedFonts = new Set<string>();
  for (const [key, font] of fonts) {
    try {
      await figma.loadFontAsync(font);
      loadedFonts.add(key);
    } catch {
      warnings.push(
        `Font ${font.family} ${font.style} unavailable — substituted ${fallbackFont.family} ${fallbackFont.style}`
      );
    }
  }
  await figma.loadFontAsync(fallbackFont);
  // The default font must be loaded before setting characters.
  text.fontName = fallbackFont;
  text.characters = info.characters;

  for (const segment of info.segments) {
    const key = `${segment.fontName.family}::${segment.fontName.style}`;
    const font = loadedFonts.has(key) ? segment.fontName : fallbackFont;
    try {
      text.setRangeFontName(segment.start, segment.end, font);
      text.setRangeFontSize(segment.start, segment.end, segment.fontSize);
      const fills = remapImagePaints(segment.fills, hashMap);
      if (fills && fills.length > 0) {
        text.setRangeFills(segment.start, segment.end, fills);
      }
    } catch (err) {
      warnings.push(
        `Text range ${segment.start}-${segment.end} styling failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  text.textAlignHorizontal =
    info.textAlignHorizontal as TextNode["textAlignHorizontal"];
  text.textAlignVertical =
    info.textAlignVertical as TextNode["textAlignVertical"];
  text.textAutoResize = info.textAutoResize as TextNode["textAutoResize"];
  if (info.textAutoResize === "NONE") {
    text.resize(data.width, data.height);
  } else if (info.textAutoResize === "HEIGHT") {
    text.resize(data.width, text.height);
  }
  return text;
};

export const importNodeData = async (
  data: TransferNode,
  parent: BaseNode & ChildrenMixin,
  hashMap: Record<string, string>,
  warnings: string[]
): Promise<SceneNode> => {
  if (data.kind === "svg") {
    if (!data.svg) {
      throw new Error(`No SVG payload for ${data.type} "${data.name}"`);
    }
    const node = figma.createNodeFromSvg(data.svg);
    node.name = data.name;
    parent.appendChild(node);
    node.x = data.x;
    node.y = data.y;
    return node;
  }

  switch (data.type) {
    case "FRAME": {
      const frame = figma.createFrame();
      parent.appendChild(frame);
      frame.resize(Math.max(data.width, 0.01), Math.max(data.height, 0.01));
      applyCommonProps(frame, data, hashMap);
      if (data.layout) {
        frame.layoutMode = data.layout.layoutMode;
        if (data.layout.clipsContent !== undefined) {
          frame.clipsContent = data.layout.clipsContent;
        }
        if (data.layout.layoutMode !== "NONE") {
          frame.itemSpacing = data.layout.itemSpacing;
          frame.paddingLeft = data.layout.paddingLeft;
          frame.paddingRight = data.layout.paddingRight;
          frame.paddingTop = data.layout.paddingTop;
          frame.paddingBottom = data.layout.paddingBottom;
          frame.primaryAxisAlignItems = data.layout
            .primaryAxisAlignItems as FrameNode["primaryAxisAlignItems"];
          frame.counterAxisAlignItems = data.layout
            .counterAxisAlignItems as FrameNode["counterAxisAlignItems"];
          if (data.layout.layoutWrap) {
            frame.layoutWrap = data.layout.layoutWrap as FrameNode["layoutWrap"];
          }
        }
      }
      for (const child of data.children ?? []) {
        await importNodeData(child, frame, hashMap, warnings);
      }
      if (data.layout && data.layout.layoutMode !== "NONE") {
        frame.primaryAxisSizingMode = data.layout
          .primaryAxisSizingMode as FrameNode["primaryAxisSizingMode"];
        frame.counterAxisSizingMode = data.layout
          .counterAxisSizingMode as FrameNode["counterAxisSizingMode"];
      }
      frame.x = data.x;
      frame.y = data.y;
      return frame;
    }
    case "GROUP": {
      const children: SceneNode[] = [];
      for (const child of data.children ?? []) {
        children.push(await importNodeData(child, parent, hashMap, warnings));
      }
      if (children.length === 0) {
        throw new Error(`Group "${data.name}" has no importable children`);
      }
      const group = figma.group(children, parent);
      group.name = data.name;
      if (data.opacity !== undefined) group.opacity = data.opacity;
      if (data.visible !== undefined) group.visible = data.visible;
      return group;
    }
    case "TEXT": {
      const text = await buildText(data, hashMap, warnings);
      applyCommonProps(text, data, hashMap);
      // buildText already applied per-range fills; keep name/effects etc.
      parent.appendChild(text);
      text.x = data.x;
      text.y = data.y;
      return text;
    }
    case "RECTANGLE":
    case "ELLIPSE":
    case "LINE": {
      const node =
        data.type === "RECTANGLE"
          ? figma.createRectangle()
          : data.type === "ELLIPSE"
          ? figma.createEllipse()
          : figma.createLine();
      parent.appendChild(node);
      if (data.type === "LINE") {
        node.resize(Math.max(data.width, 0.01), 0);
      } else {
        node.resize(Math.max(data.width, 0.01), Math.max(data.height, 0.01));
      }
      applyCommonProps(node, data, hashMap);
      node.x = data.x;
      node.y = data.y;
      return node;
    }
    default:
      throw new Error(`Unsupported structural type: ${data.type}`);
  }
};

export const importImages = decodeImages;
