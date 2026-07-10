import { Circle } from "lucide-react";
import type { ExplorerSnapshot } from "../types";

export function OverviewDetails({ snapshot }: { snapshot?: ExplorerSnapshot | null }) {
  const asset = snapshot?.detail.asset;
  const properties = [
    ["Site", "North Plant"],
    ["Type", asset?.type === "Pump" ? "Centrifugal Pump" : asset?.type || "Centrifugal Pump"],
    ["Source", asset?.sourceSystem || "OSIsoft PI"],
    ["External ID", asset?.externalId || "P-101"],
    ["Last updated", asset?.updatedAt ? new Date(asset.updatedAt).toLocaleString() : "May 14, 2025 11:58:12 AM"],
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
          <div><dt>Status</dt><dd><span className="reviewed-dot" />Reviewed</dd></div>
          <div><dt>Reviewed by</dt><dd>harper.dennis</dd></div>
          <div><dt>Reviewed on</dt><dd>May 13, 2025 04:22:31 PM</dd></div>
          <div><dt>Provenance</dt><dd><button className="text-link" type="button">4 sources</button></dd></div>
          <div><dt>Confidence</dt><dd><Circle size={9} fill="#d68100" color="#d68100" /> Medium</dd></div>
        </dl>
      </div>
    </section>
  );
}
