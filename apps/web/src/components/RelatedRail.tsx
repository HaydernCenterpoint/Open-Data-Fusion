import { Activity, ArrowRight, FileText, GitBranch, ShieldCheck } from "lucide-react";
import type { ExplorerSnapshot } from "../types";

interface RelatedRailProps {
  snapshot: ExplorerSnapshot | null;
  onAction: (message: string) => void;
}

function EmptyRailRow({ children }: { children: React.ReactNode }) {
  return <p className="rail-empty-row">{children}</p>;
}

export function RelatedRail({ snapshot, onAction }: RelatedRailProps) {
  const timeSeries = snapshot?.detail.timeSeries ?? [];
  const documents = snapshot?.detail.documents ?? [];
  const relations = snapshot?.detail.relations ?? [];
  const provenance = snapshot?.detail.provenance ?? [];
  const telemetryById = new Map((snapshot?.telemetry.series ?? []).map((series) => [series.externalId, series]));

  return (
    <aside className="related-rail" aria-label="Related data">
      <section className="rail-section">
        <h2><Activity size={19} /> Related time series ({timeSeries.length})</h2>
        {timeSeries.length === 0 ? <EmptyRailRow>No time series linked.</EmptyRailRow> : timeSeries.map((series) => {
          const latestPoint = telemetryById.get(series.externalId)?.points.at(-1);
          const value = latestPoint ? `${latestPoint.value} ${series.unit || ""}`.trim() : "No recent value";
          return <button className="series-row" type="button" key={series.externalId} onClick={() => onAction(`${series.name}: ${value}`)}><Activity className="spark-icon" size={35} strokeWidth={1.6} /><span><strong>{series.name}</strong><small>{value} · {series.sourceSystem}</small></span></button>;
        })}
      </section>

      <section className="rail-section">
        <h2><FileText size={19} /> Related documents ({documents.length})</h2>
        {documents.length === 0 ? <EmptyRailRow>No documents linked.</EmptyRailRow> : documents.map((document) => <button className="document-row" type="button" key={document.externalId} onClick={() => onAction(document.uri ? `Document URI: ${document.uri}` : `${document.title} has no URI`)}><span className="pdf-icon"><FileText size={21} /></span><span><strong>{document.title}</strong><small>{document.mimeType || "Unknown type"} · {document.sourceSystem}</small></span></button>)}
      </section>

      <section className="rail-section">
        <h2><GitBranch size={19} /> Contextual relations ({relations.length})</h2>
        {relations.length === 0 ? <EmptyRailRow>No contextual relations linked.</EmptyRailRow> : relations.map((relation) => <button className="relation-row" type="button" key={relation.id} onClick={() => onAction(`${relation.source.externalId} ${relation.type} ${relation.target.externalId}`)}><Activity size={19} strokeWidth={1.4} /><span className="relation-copy"><span><strong>{relation.source.externalId}</strong><ArrowRight size={14} /><strong>{relation.target.externalId}</strong></span><small>{relation.type} · {relation.status}</small></span></button>)}
      </section>

      <section className="rail-section provenance">
        <h2><ShieldCheck size={19} /> Provenance &amp; evidence</h2>
        <p>{provenance.length} governed record{provenance.length === 1 ? "" : "s"}</p>
        {provenance.length === 0 ? <EmptyRailRow>No provenance recorded.</EmptyRailRow> : <ul>{provenance.slice(0, 6).map((record) => <li key={record.id}>{record.sourceSystem} <span>({record.ingestionRunId})</span></li>)}</ul>}
      </section>
    </aside>
  );
}
