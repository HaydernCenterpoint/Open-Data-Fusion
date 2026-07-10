import { Circle } from "lucide-react";
import type { ExplorerSnapshot } from "../types";

export function OverviewDetails({ snapshot }: { snapshot?: ExplorerSnapshot | null }) {
  const asset = snapshot?.detail.asset;
  if (!snapshot || !asset) return null;
  const acceptedRelation = snapshot.detail.relations.find((relation) => relation.status === "accepted");
  const site = typeof asset.metadata.site === "string" ? asset.metadata.site : snapshot.detail.parent?.name || "—";
  const properties = [
    ["Site / parent", site],
    ["Type", asset.type],
    ["Source", asset.sourceSystem],
    ["External ID", asset.externalId],
    ["Last updated", new Date(asset.updatedAt).toLocaleString()],
  ];
  return (
    <section className="detail-grid" aria-label="Asset details">
      <div className="detail-card">
        <h2>Properties</h2>
        <dl>
          {properties.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="detail-card contextualization-card">
        <h2>Contextualization</h2>
        <dl>
          <div><dt>Status</dt><dd><span className="reviewed-dot" />{acceptedRelation ? "Reviewed" : "No accepted relation"}</dd></div>
          <div><dt>Reviewed by</dt><dd>{acceptedRelation?.reviewer || "—"}</dd></div>
          <div><dt>Reviewed on</dt><dd>{acceptedRelation?.reviewedAt ? new Date(acceptedRelation.reviewedAt).toLocaleString() : "—"}</dd></div>
          <div><dt>Provenance</dt><dd><span className="text-link">{snapshot.detail.provenance.length} record{snapshot.detail.provenance.length === 1 ? "" : "s"}</span></dd></div>
          <div><dt>Confidence</dt><dd><Circle size={9} fill="#d68100" color="#d68100" /> {acceptedRelation?.confidence === null || acceptedRelation?.confidence === undefined ? "Not scored" : `${Math.round(acceptedRelation.confidence * 100)}%`}</dd></div>
        </dl>
      </div>
    </section>
  );
}
