export interface MatchPrediction {
  sourceExternalId: string;
  targetExternalId: string;
  score: number;
}

export interface MatchGroundTruth {
  sourceExternalId: string;
  targetExternalId: string;
  accepted: boolean;
}

export interface MatchingEvaluation {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  evaluatedPairs: number;
}

function pairKey(sourceExternalId: string, targetExternalId: string): string {
  return `${sourceExternalId}\u0000${targetExternalId}`;
}

export function evaluateMatchingPredictions(
  predictions: readonly MatchPrediction[],
  truth: readonly MatchGroundTruth[],
  threshold: number,
): MatchingEvaluation {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Matching threshold must be between 0 and 1");
  const truthByPair = new Map(truth.map((item) => [pairKey(item.sourceExternalId, item.targetExternalId), item.accepted]));
  const predictedPositive = new Set(
    predictions
      .filter((prediction) => Number.isFinite(prediction.score) && prediction.score >= threshold)
      .map((prediction) => pairKey(prediction.sourceExternalId, prediction.targetExternalId)),
  );
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const [key, accepted] of truthByPair) {
    if (predictedPositive.has(key) && accepted) truePositives += 1;
    else if (predictedPositive.has(key) && !accepted) falsePositives += 1;
    else if (!predictedPositive.has(key) && accepted) falseNegatives += 1;
  }
  for (const key of predictedPositive) if (!truthByPair.has(key)) falsePositives += 1;
  const precision = truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    threshold,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: Number(precision.toFixed(6)),
    recall: Number(recall.toFixed(6)),
    f1: Number(f1.toFixed(6)),
    evaluatedPairs: new Set([...truthByPair.keys(), ...predictedPositive]).size,
  };
}

export function rankProposedMatches(predictions: readonly MatchPrediction[]): Array<MatchPrediction & { state: "proposed" }> {
  return predictions
    .filter((prediction) => Number.isFinite(prediction.score) && prediction.score >= 0 && prediction.score <= 1)
    .map((prediction) => ({ ...prediction, state: "proposed" as const }))
    .toSorted((left, right) => right.score - left.score || left.sourceExternalId.localeCompare(right.sourceExternalId));
}
