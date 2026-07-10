import type { ContextualizationEvidence } from "@open-data-fusion/contracts";

const evidenceWeights: Record<ContextualizationEvidence["kind"], number> = {
  exact: 1,
  rule: 0.95,
  spatial: 0.9,
  fuzzy: 0.75,
  model: 0.7,
};

export function normalizeIndustrialText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bigrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, " ");
  if (compact.length < 2) return new Set(compact ? [compact] : []);
  const result = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) result.add(compact.slice(index, index + 2));
  return result;
}

export function fuzzySimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeIndustrialText(left);
  const normalizedRight = normalizeIndustrialText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  const leftPairs = bigrams(normalizedLeft);
  const rightPairs = bigrams(normalizedRight);
  let intersection = 0;
  for (const pair of leftPairs) if (rightPairs.has(pair)) intersection += 1;
  return (2 * intersection) / (leftPairs.size + rightPairs.size);
}

export function compareContextValues(field: string, sourceValue: string, targetValue: string): ContextualizationEvidence {
  const exact = normalizeIndustrialText(sourceValue) === normalizeIndustrialText(targetValue);
  const score = exact ? 1 : fuzzySimilarity(sourceValue, targetValue);
  return {
    kind: exact ? "exact" : "fuzzy",
    field,
    sourceValue,
    targetValue,
    score,
    explanation: exact ? "Normalized values match exactly" : `Normalized bigram similarity is ${score.toFixed(3)}`,
  };
}

export function scoreContextualizationEvidence(evidence: readonly ContextualizationEvidence[]): number {
  if (evidence.length === 0) return 0;
  let weightedScore = 0;
  let totalWeight = 0;
  for (const item of evidence) {
    const weight = evidenceWeights[item.kind];
    weightedScore += Math.max(0, Math.min(1, item.score)) * weight;
    totalWeight += weight;
  }
  return Number((weightedScore / totalWeight).toFixed(6));
}

export function candidateRequiresHumanReview(_confidence: number): true {
  // A score is evidence, not authorization to turn a candidate into canonical truth.
  return true;
}
