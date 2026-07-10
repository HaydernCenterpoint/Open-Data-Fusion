import {
  Activity,
  ArrowLeft,
  ArrowRight,
  FileText,
  GitBranch,
  ShieldCheck,
} from "lucide-react";
import { documents, relations, timeSeries } from "../data/demo";

interface RelatedRailProps {
  onAction: (message: string) => void;
}

export function RelatedRail({ onAction }: RelatedRailProps) {
  return (
    <aside className="related-rail" aria-label="Related data">
      <section className="rail-section">
        <h2><Activity size={19} /> Related time series (3)</h2>
        {timeSeries.map((series) => (
          <button className="series-row" type="button" key={series.name} onClick={() => onAction(`${series.name}: ${series.value}`)}>
            <Activity className="spark-icon" size={35} strokeWidth={1.6} />
            <span><strong>{series.name}</strong><small>{series.meta}</small></span>
          </button>
        ))}
        <button className="view-all" type="button" onClick={() => onAction("Showing all related time series")}>View all time series</button>
      </section>

      <section className="rail-section">
        <h2><FileText size={19} /> Related documents (2)</h2>
        {documents.map((document) => (
          <button className="document-row" type="button" key={document.name} onClick={() => onAction(`Opening ${document.name}`)}>
            <span className="pdf-icon"><FileText size={21} /></span>
            <span><strong>{document.name}</strong><small>{document.meta}</small></span>
          </button>
        ))}
        <button className="view-all" type="button" onClick={() => onAction("Showing all related documents")}>View all documents</button>
      </section>

      <section className="rail-section">
        <h2><GitBranch size={19} /> Reviewed relations (4)</h2>
        {relations.map((relation) => (
          <button className="relation-row" type="button" key={relation.to} onClick={() => onAction(`${relation.from} ${relation.type.toLowerCase()} ${relation.to}`)}>
            <Activity size={19} strokeWidth={1.4} />
            <span className="relation-copy">
              <span><strong>{relation.from}</strong>{relation.direction === "left" ? <ArrowLeft size={14} /> : <ArrowRight size={14} />}<strong>{relation.to}</strong></span>
              <small>{relation.type}</small>
            </span>
          </button>
        ))}
        <button className="view-all" type="button" onClick={() => onAction("Showing all reviewed relations")}>View all relations</button>
      </section>

      <section className="rail-section provenance">
        <h2><ShieldCheck size={19} /> Provenance &amp; evidence</h2>
        <p>Derived from 4 sources</p>
        <ul>
          <li>OSIsoft PI <span>(Pressure, Flow, Current)</span></li>
          <li>SAP PM <span>(Equipment master data)</span></li>
          <li>Plant Drawings <span>(DWG-2314)</span></li>
          <li>Manual Upload <span>(P-101 O&amp;M Manual)</span></li>
        </ul>
        <button className="view-all" type="button" onClick={() => onAction("Showing complete provenance")}>View all provenance</button>
      </section>
    </aside>
  );
}
