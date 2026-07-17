import { createHash } from "node:crypto";

import {
  canonicalModelGraphJson,
  ModelValidationError,
  normalizeModelInstance,
  normalizeModelViews,
} from "@open-data-fusion/platform-core";
import type {
  PublicInstanceKey,
  PublicInstanceUpsertItem,
  PublicInstanceUpsertRequest,
  PublicModelViewDefinition,
} from "./platform-types.js";
import type { JsonObject } from "./types.js";

export interface NormalizedModelInstanceBatch {
  instances: PublicInstanceUpsertItem[];
  referencedKeys: PublicInstanceKey[];
  requestHash: string;
}

export function publicInstanceKey(key: PublicInstanceKey): string {
  return canonicalModelGraphJson([key.space, key.externalId]);
}

function asPublicKey(value: unknown): PublicInstanceKey {
  return value as PublicInstanceKey;
}

export function normalizeModelInstanceBatch(
  modelId: string,
  version: number,
  viewsInput: PublicModelViewDefinition[],
  input: PublicInstanceUpsertRequest,
): NormalizedModelInstanceBatch {
  if (!Array.isArray(input.instances) || input.instances.length < 1 || input.instances.length > 100) {
    throw new ModelValidationError([{ path: "instances", message: "Use 1-100 instances" }]);
  }
  const views = normalizeModelViews(viewsInput);
  const viewsById = new Map(views.map((view) => [view.externalId, view]));
  const seen = new Set<string>();
  const references = new Map<string, PublicInstanceKey>();
  const instances = input.instances.map((item, index) => {
    const view = viewsById.get(item.viewExternalId);
    if (!view) {
      throw new ModelValidationError([{
        path: `instances.${index}.viewExternalId`,
        message: `Unknown view '${item.viewExternalId}'`,
      }]);
    }
    const normalized = normalizeModelInstance(view, item);
    const publicItem: PublicInstanceUpsertItem = {
      space: normalized.space,
      externalId: normalized.externalId,
      kind: normalized.kind,
      viewExternalId: normalized.viewExternalId,
      properties: normalized.properties as JsonObject,
      ...(normalized.source ? { source: normalized.source } : {}),
      ...(normalized.target ? { target: normalized.target } : {}),
    };
    const key = publicInstanceKey(publicItem);
    if (seen.has(key)) {
      throw new ModelValidationError([{ path: `instances.${index}`, message: "Duplicate instance key in batch" }]);
    }
    seen.add(key);

    if (publicItem.source) references.set(publicInstanceKey(publicItem.source), publicItem.source);
    if (publicItem.target) references.set(publicInstanceKey(publicItem.target), publicItem.target);
    for (const [property, definition] of Object.entries(view.properties)) {
      if (definition.type !== "direct") continue;
      const value = publicItem.properties[property];
      if (value === null || value === undefined) continue;
      const values = definition.list ? value as unknown[] : [value];
      for (const reference of values) {
        const publicKey = asPublicKey(reference);
        references.set(publicInstanceKey(publicKey), publicKey);
      }
    }
    return publicItem;
  });
  const requestHash = createHash("sha256")
    .update(canonicalModelGraphJson({ modelId, version, instances }), "utf8")
    .digest("hex");
  return { instances, referencedKeys: [...references.values()], requestHash };
}
