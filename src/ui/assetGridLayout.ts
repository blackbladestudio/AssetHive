import type { AssetRecord } from "../types";
import { heroPartKind, heroSuitPart } from "../../shared/heroPackageRules.mjs";
import { monsterVariantGroups } from "../../shared/monsterVariants.mjs";
const independentHeroPart = (asset: AssetRecord) => Boolean(heroPartKind(asset.meta?.character as { variant?: string }));

export function getCardSpan(asset: AssetRecord): 1 | 2 | 3 {
  const previews = asset.meta?.previews as { relativeSize?: unknown } | undefined;
  const size = String(previews?.relativeSize || "").trim().match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/i);
  const ratio = size && Number(size[2]) > 0 ? Number(size[1]) / Number(size[2]) : 1;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return ratio >= 2.4 ? 3 : ratio > 1.2 ? 2 : 1;
}

export function getCardWidthClass(asset: AssetRecord) {
  return `width-${getCardSpan(asset)}x`;
}

export type AssetGridItemLayout = {
  asset: AssetRecord;
  x: number;
  y: number;
  width: number;
  height: number;
  span: number;
  variantId?: string;
  renderKey?: string;
};

export function buildMonsterVariantGridLayout(list: AssetRecord[], viewport: number, _collapsed: ReadonlySet<string>, sizingWidth?: number) {
  // Each form/variant is an independent card. No entity panels or collapsible columns.
  const occurrences = list.flatMap<{ asset: AssetRecord; variantId?: string; renderKey: string }>(asset => asset.assetType === 'monster' && !asset.meta?.componentView
    ? monsterVariantGroups([asset]).flatMap(variant => variant.assets.map(owner => ({ asset: owner, variantId: variant.id, renderKey: owner.id + ':variant:' + variant.id })))
    : [{ asset, variantId: undefined, renderKey: asset.id }]);
  const layout = buildAssetGridLayout(occurrences.map(item => item.asset), viewport, false, undefined, false, true, undefined, sizingWidth);
  return { ...layout, items: layout.items.map((item, index) => ({ ...item, variantId: occurrences[index].variantId, renderKey: occurrences[index].renderKey })) };
}

export type GridDirection = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
export type AssetGridSectionHeader = { family: string; y: number; x?: number; width?: number; label?: string; groupKey?: string; level?: number; empty?: boolean };

// A shared four-part reference keeps owner sizing independent of display filters.
const CHARACTER_CARD_SIZE = .5;
export const MIN_CARD_SCALE = .6;
export const MAX_CARD_SCALE = 2.4;
function characterOwnerHeight(viewport: number, padding: number, maxHeight = 400) {
  const available = Math.max(1, viewport - padding * 2 - 8);
  const gapRatio = 12 / 320;
  const widthRatio = (columns: number) => {
    const rows = 4 / columns;
    return .75 + gapRatio + columns * (1 - (rows - 1) * gapRatio) / rows + (columns - 1) * gapRatio;
  };
  // Fit useful two-column parts before falling back to a narrow four-row stack.
  const preferred = Math.min(maxHeight, available / widthRatio(1)) * CHARACTER_CARD_SIZE;
  const columns = [4, 2, 1].find(count => {
    const fitted = Math.min(preferred, available / widthRatio(count));
    const rows = 4 / count;
    return fitted >= preferred * .85 && fitted * (1 - (rows - 1) * gapRatio) / rows >= 48;
  }) || 1;
  return Math.min(maxHeight, available / widthRatio(columns) / CHARACTER_CARD_SIZE);
}

function buildCharacterRelationshipLayout(list: AssetRecord[], viewport: number, padding: number, showSections = false) {
  const gap = 12;
  const groupGap = 32;
  const available = Math.max(1, viewport - padding * 2 - 8);
  // Keep the original component card, reduced from 240px to about 160px,
  // then place a second independent Skeletal card directly underneath it.
  // Each image stays square; two 24px captions and an 8px gap add 56px.
  const groups = new Map<string, AssetRecord[]>();
  for (const asset of list) {
    const key = ['monster', 'npc'].includes(asset.assetType) ? `${asset.assetType}-owners` : characterRelationshipGroupKey(asset) || asset.id.split("::part::")[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(asset);
  }
  const items: AssetGridItemLayout[] = [];
  const outfitGroups: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
  const sectionHeaders: Array<AssetGridSectionHeader> = [];
  let y = padding;
  let previousFamily = "";
  for (const [id, assets] of groups) {
    const family = String(assets[0]?.assetType || "").toLowerCase();
    if (showSections && family !== previousFamily) {
      sectionHeaders.push({ family, y });
      y += 42;
      previousFamily = family;
    }
    // Monster forms are ordinary owner cards. Their models and weapons are
    // viewed inside details, including when suits elsewhere use expanded rows.
    if (['monster', 'npc'].includes(family)) {
      const height = characterOwnerHeight(viewport, padding) * CHARACTER_CARD_SIZE;
      const width = Math.min(available, height * .75);
      const columns = Math.max(1, Math.floor((available + gap) / (width + gap)));
      assets.forEach((asset, i) => items.push({ asset, x: padding + (i % columns) * (width + gap),
        y: y + Math.floor(i / columns) * (height + gap), width, height, span: 1 }));
      y += Math.ceil(assets.length / columns) * (height + gap) - gap + groupGap;
      continue;
    }
    const owners = assets.filter(asset => !independentHeroPart(asset) && !asset.meta?.componentView && !asset.id.includes("::part::"));
    let parts = assets.filter(asset => !owners.includes(asset));
    // Empty positions are layout records only: never assets, preview jobs or export files.
    if (family === 'suit' && owners.length === 1 && !independentHeroPart(owners[0])) {
      const owner = owners[0];
      parts = ['Head', 'Upbody', 'Downbody', 'Arm'].map(part => parts.find(asset => heroSuitPart(asset.name + '.fbx') === part) || {
        ...owner, id: `${owner.id}::missing-part::${part}`, name: part,
        meta: { ...owner.meta, missingSuitPart: part }
      });
    }
    const start = items.length;
    const innerGap = Math.min(12, available / 24);
    const fitPartWidth = (count: number) => (available - owners.length * .75 * 56
      - Math.max(0, owners.length + count - 1) * innerGap) / Math.max(1, owners.length * 1.5 + count);
    const columns = [4, 2, 1].find(count => {
      if (count > Math.max(1, parts.length)) return false;
      return fitPartWidth(Math.min(count, parts.length)) >= 92;
    }) || 1;
    const usedColumns = Math.min(columns, Math.max(1, parts.length));
    const partWidth = Math.max(1, Math.min(160, fitPartWidth(parts.length ? usedColumns : 0)));
    const height = partWidth * 2 + 56;
    const ownerWidth = height * .75;
    owners.forEach((asset, i) => items.push({ asset, x: padding + i * (ownerWidth + innerGap), y, width: ownerWidth, height, span: 1 }));
    const partsX = owners.length * (ownerWidth + innerGap);
    const columnGap = innerGap;
    parts.forEach((asset, i) => items.push({ asset, x: padding + partsX + (i % columns) * (partWidth + columnGap), y: y + Math.floor(i / columns) * (height + innerGap), width: partWidth, height, span: 1 }));
    const placed = items.slice(start);
    const bottom = Math.max(...placed.map(item => item.y + item.height));
    outfitGroups.push({ id, x: padding - 4, y: y - 4, width: Math.max(1, viewport - padding * 2 + 8), height: bottom - y + 8 });
    y = bottom + groupGap;
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  let maxBottom = -Infinity;
  gridBottomBounds.set(items, items.map(item => (maxBottom = Math.max(maxBottom, item.y + item.height))));
  return { items, outfitGroups, sectionHeaders, totalHeight: items.length ? y - groupGap + padding + 4 : 0, padding, gap, cardHeight: Math.max(1, ...items.map(item => item.height)), columns: Math.max(1, Math.floor((available + gap) / 372)) };
}

export function characterRelationshipGroupKey(asset: AssetRecord) {
  if (independentHeroPart(asset)) return "";
  const ownerId = asset.id.split("::part::")[0];
  if (asset.assetType === "suit") return ownerId;
  return "";
}

export function buildOutfitGroupBackgrounds(items: AssetGridItemLayout[], viewportWidth: number, padding: number, gap: number) {
  const groups = new Map<string, { id: string; top: number; bottom: number; owners: number; hasPart: boolean }>();
  for (const item of items) {
    const id = characterRelationshipGroupKey(item.asset);
    if (!id) continue;
    const part = item.asset.id.includes("::part::");
    const group = groups.get(id) || { id, top: item.y, bottom: item.y + item.height, owners: 0, hasPart: false };
    group.top = Math.min(group.top, item.y);
    group.bottom = Math.max(group.bottom, item.y + item.height);
    group.owners += part ? 0 : 1;
    group.hasPart ||= part;
    groups.set(id, group);
  }
  // Fit inside existing row gaps so virtual scrolling and card positions stay unchanged.
  const outset = Math.min(padding, gap / 3);
  return [...groups.values()].filter(group => group.owners > 0 && (group.hasPart || group.owners > 1)).map(group => ({
    id: group.id, x: padding - outset, y: group.top - outset,
    width: Math.max(1, viewportWidth - 2 * (padding - outset)), height: group.bottom - group.top + 2 * outset
  }));
}

// Use packed positions, since wide cards can change the incoming asset order.
export function getDirectionalGridItem<T extends { x: number; y: number; width: number; height: number }>(items: T[], current: T, direction: GridDirection): T | null {
  const vertical = direction === "ArrowUp" || direction === "ArrowDown";
  const sign = direction === "ArrowUp" || direction === "ArrowLeft" ? -1 : 1;
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  let best: T | null = null;
  let bestPrimary = Infinity;
  let bestSecondary = Infinity;
  for (const item of items) {
    if (item === current) continue;
    const dx = item.x + item.width / 2 - cx;
    const dy = item.y + item.height / 2 - cy;
    const primary = (vertical ? dy : dx) * sign;
    // Horizontal navigation stays on the current row; edges do not wrap.
    const overlapsVertically = item.y < current.y + current.height && current.y < item.y + item.height;
    if (primary <= 0 || (!vertical && !overlapsVertically) || (vertical && overlapsVertically)) continue;
    const secondary = Math.abs(vertical ? dx : dy);
    if (primary < bestPrimary || (primary === bestPrimary && secondary < bestSecondary)) {
      best = item;
      bestPrimary = primary;
      bestSecondary = secondary;
    }
  }
  return best;
}

export function buildAssetGridLayout(list: AssetRecord[], viewportWidth: number, compact = false, inset?: number, groupOutfits = false, fixedCharacterCards = false, thumbnailHeight?: number, sizingWidth?: number, showCharacterSections = false, cardScale = 1) {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(1, viewportWidth) : 1600;
  const narrow = viewport <= 900;
  const medium = viewport <= 1200;
  const characterGrid = list.length > 0 && list.every((asset) => asset.topCategory === "character" || ["suit", "monster", "npc", "weapon"].includes(String(asset.assetType || "").toLowerCase()));
  const fixed = fixedCharacterCards && characterGrid;
  const gap = fixed ? 12 : narrow ? 6 : medium ? 8 : 12;
  // Character cards keep the same origin when the details pane changes viewport width.
  const padding = Math.min(inset ?? (fixed ? 24 : narrow ? 10 : medium ? 12 : 24), Math.max(0, (viewport - 1) / 2));
  if (fixed && groupOutfits && !list.every(independentHeroPart) && list.some(asset => characterRelationshipGroupKey(asset))) return buildCharacterRelationshipLayout(list, viewport, padding, showCharacterSections);
  if (fixed && list.length && list.every(asset => Boolean(asset.meta?.componentView))) {
    const width = Math.min(160, Math.max(1, viewport - padding * 2));
    const columns = Math.max(1, Math.floor((viewport - padding * 2 + gap) / (width + gap)));
    const items: AssetGridItemLayout[] = [];
    let y = padding;
    let cardHeight = 0;
    for (let start = 0; start < list.length; start += columns) {
      const row = list.slice(start, start + columns);
      const heights = row.map(asset => (asset.meta.componentView as { visibleMeshKind?: string }).visibleMeshKind ? width + 24 : width * 2 + 56);
      row.forEach((asset, i) => items.push({ asset, x: padding + i * (width + gap), y, width, height: heights[i], span: 1 }));
      const rowHeight = Math.max(...heights);
      cardHeight = Math.max(cardHeight, rowHeight);
      y += rowHeight + gap;
    }
    let maxBottom = -Infinity;
    gridBottomBounds.set(items, items.map(item => (maxBottom = Math.max(maxBottom, item.y + item.height))));
    return { items, totalHeight: y - gap + padding, padding, gap, cardHeight, columns, outfitGroups: [], sectionHeaders: [] as Array<AssetGridSectionHeader> };
  }
  const ownerHeight = thumbnailHeight ?? characterOwnerHeight(sizingWidth ?? viewport, padding) * CHARACTER_CARD_SIZE;
  const ownerWidth = ownerHeight * .75;
  const scale = fixed ? 1 : Math.min(MAX_CARD_SCALE, Math.max(MIN_CARD_SCALE, cardScale || 1));
  const cardHeight = fixed ? ownerHeight : Math.round((characterGrid
    ? (narrow ? 190 : medium ? 250 : compact ? 260 : 300)
    : (narrow ? 125 : medium ? 145 : compact ? 200 : 220)) * scale);
  const minWidth = fixed ? ownerWidth : Math.round((characterGrid
    ? (narrow ? 150 : medium ? 210 : compact ? 220 : 260)
    : (narrow ? 110 : medium ? 130 : compact ? 180 : 220)) * scale);
  const contentWidth = viewport - padding * 2;
  const columns = Math.max(1, Math.floor((contentWidth + gap) / (minWidth + gap)));
  // Keep card sizes consistent across rows; incomplete rows leave space on the right.
  const unitWidth = fixed ? ownerWidth + gap : (contentWidth + gap) / columns;
  const items: AssetGridItemLayout[] = [];
  // Three queues allow filling a row from anywhere in the remaining list in O(n).
  // Within each size, retain the incoming order; always prefer the earliest fit.
  const queues: number[][] = [[], [], [], []];
  const heads = [0, 0, 0, 0];
  const spans = list.map((asset, index) => {
    const span = fixed ? 1 : Math.min(columns, getCardSpan(asset));
    queues[span].push(index);
    return span;
  });
  let row = 0;
  // Character relationship groups must not be split by width-based backfilling.
  const preserveCharacterOrder = list.some(asset => ["monster", "suit"].includes(asset.assetType));
  let nextOrderedIndex = 0;
  while (items.length < list.length) {
    const indices: number[] = [];
    let used = 0;
    while (used < columns) {
      let next = Infinity;
      if (preserveCharacterOrder) {
        if (nextOrderedIndex >= list.length || spans[nextOrderedIndex] > columns - used) break;
        if (groupOutfits && indices.length > 0) {
          const first = list[indices[0]];
          const candidate = list[nextOrderedIndex];
          const firstKey = characterRelationshipGroupKey(first);
          const nextKey = characterRelationshipGroupKey(candidate);
          if ((firstKey || nextKey) && firstKey !== nextKey) break;
        }
        next = nextOrderedIndex++;
      } else for (let span = 1; span <= Math.min(3, columns - used); span += 1) {
        next = Math.min(next, queues[span][heads[span]] ?? Infinity);
      }
      if (!Number.isFinite(next)) break;
      indices.push(next);
      used += spans[next];
      heads[spans[next]] += 1;
    }
    let x = padding;
    indices.forEach((index) => {
      const width = unitWidth * spans[index] - gap;
      items.push({ asset: list[index], x, y: padding + row * (cardHeight + gap), width, height: cardHeight, span: fixed ? 1 : getCardSpan(list[index]) });
      x += width + gap;
    });
    row += 1;
  }
  const totalHeight = list.length ? padding * 2 + row * cardHeight + (row - 1) * gap : 0;
  if (fixed) {
    let maxBottom = -Infinity;
    gridBottomBounds.set(items, items.map(item => (maxBottom = Math.max(maxBottom, item.y + item.height))));
  }
  const outfitGroups = groupOutfits ? buildOutfitGroupBackgrounds(items, viewport, padding, gap) : [];
  return { items, totalHeight, padding, gap, cardHeight, columns, outfitGroups, sectionHeaders: [] as Array<AssetGridSectionHeader> };
}

// Rows start at `padding` and repeat every `cardHeight + gap`. The scroll overlay
// that stands in for rows the virtual grid has not mounted must sit on those same
// cells: offsetting it by the raw scrollTop slides its cells against the real
// cards, so the placeholder shows through the gaps between them while scrolling.
export function getGridPlaceholderTop(scrollTop: number, padding: number, stride: number) {
  const step = Number.isFinite(stride) && stride > 0 ? stride : 1;
  const base = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  const top = Number.isFinite(scrollTop) ? scrollTop : 0;
  const firstCoveredRow = Math.max(0, Math.floor((top - base) / step));
  return base + firstCoveredRow * step;
}

export function getVisibleAssetGridItems(items: AssetGridItemLayout[], viewportHeight: number, scrollTop: number, cardHeight: number) {
  const overscan = Math.max(cardHeight * 4, viewportHeight * 0.75);
  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + viewportHeight + overscan;
  return getAssetGridItemsInRange(items, top, bottom);
}

const gridBottomBounds = new WeakMap<AssetGridItemLayout[], number[]>();
export function getAssetGridItemsInRange(items: AssetGridItemLayout[], top: number, bottom: number) {
  const bounds = gridBottomBounds.get(items);
  // Items are in row order. Binary search avoids scanning the entire library on scroll.
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((bounds ? bounds[mid] : items[mid].y + items[mid].height) < top) low = mid + 1;
    else high = mid;
  }
  const first = low;
  high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (items[mid].y <= bottom) low = mid + 1;
    else high = mid;
  }
  return items.slice(first, low).filter(item => item.y + item.height >= top);
}
