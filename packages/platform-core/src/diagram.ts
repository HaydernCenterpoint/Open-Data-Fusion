import type { DiagramTag } from "@open-data-fusion/contracts";

const equipmentPattern = /\b(?:P|PU|HX|E|V|FV|PV|TK|C|M)-?\d{2,4}[A-Z]?\b/giu;
const instrumentPattern = /\b(?:PT|TT|FT|LT|PI|TI|FI|LI|PIT|TIT|FIT|LIT)-?\d{2,4}[A-Z]?\b/giu;
const linePattern = /\b\d{1,2}(?:\.\d+)?"?-[A-Z]{2,6}-\d{2,5}[A-Z]?\b/giu;

function collectMatches(text: string, pattern: RegExp, kind: DiagramTag["kind"], confidence: number, tags: Map<string, DiagramTag>): void {
  for (const match of text.matchAll(pattern)) {
    const tag = match[0].toUpperCase();
    if (!tags.has(tag)) tags.set(tag, { tag, kind, page: null, bounds: null, confidence });
  }
}

export function extractDiagramTags(text: string): DiagramTag[] {
  const tags = new Map<string, DiagramTag>();
  collectMatches(text, equipmentPattern, "equipment", 0.9, tags);
  collectMatches(text, instrumentPattern, "instrument", 0.94, tags);
  collectMatches(text, linePattern, "line", 0.82, tags);
  return [...tags.values()].sort((left, right) => left.tag.localeCompare(right.tag));
}
