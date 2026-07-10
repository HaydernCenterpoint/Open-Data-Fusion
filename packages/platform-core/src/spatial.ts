import type { SpatialAssetLink } from "@open-data-fusion/contracts";

export class SpatialTransformError extends Error {}

export function validateSpatialTransform(transform: readonly number[]): number[] {
  if (transform.length !== 16) throw new SpatialTransformError("A spatial transform must contain a 4x4 matrix (16 values)");
  if (transform.some((value) => !Number.isFinite(value))) throw new SpatialTransformError("A spatial transform may contain only finite values");
  const homogeneousScale = transform[15];
  if (homogeneousScale === undefined || Math.abs(homogeneousScale) < Number.EPSILON) {
    throw new SpatialTransformError("A spatial transform must have a non-zero homogeneous scale");
  }
  return [...transform];
}

export function createProposedSpatialLink(input: Omit<SpatialAssetLink, "reviewState" | "transform" | "confidence"> & {
  transform: readonly number[];
  confidence: number;
}): SpatialAssetLink {
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new SpatialTransformError("Spatial-link confidence must be between 0 and 1");
  }
  return {
    assetExternalId: input.assetExternalId,
    sceneExternalId: input.sceneExternalId,
    nodeExternalId: input.nodeExternalId,
    transform: validateSpatialTransform(input.transform),
    confidence: input.confidence,
    reviewState: "proposed",
  };
}
