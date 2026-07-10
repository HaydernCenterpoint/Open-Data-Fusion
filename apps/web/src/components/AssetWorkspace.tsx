import { Activity, AlertCircle, Check, Factory, FileText, GitBranch, History, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import type { ExplorerSnapshot } from "../types";
import { OverviewDetails } from "./OverviewDetails";
import { PressureChart } from "./PressureChart";
import { PumpIcon } from "./PumpIcon";

const tabs = ["Overview", "Time series", "Documents", "Relations", "Lineage"] as const;
type Tab = (typeof tabs)[number];

interface AssetWorkspaceProps {
  onIngest: () => void;
  snapshot?: ExplorerSnapshot | null;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

interface AlternateEntry {
  id: string;
  title: string;
  meta: string;
}

function alternateContent(tab: Exclude<Tab, "Overview">, snapshot: ExplorerSnapshot) {
  const assetName = snapshot.detail.asset.name;
  if (tab === "Time series") {
    const rows: AlternateEntry[] = snapshot.detail.timeSeries.map((series) => ({ id: series.externalId, title: series.name, meta: `${series.externalId} · ${series.unit || "No unit"} · ${series.sourceSystem}` }));
    return { icon: Activity, title: tab, summary: `${rows.length} telemetry stream${rows.length === 1 ? "" : "s"} linked to ${assetName}`, rows };
  }
  if (tab === "Documents") {
    const rows: AlternateEntry[] = snapshot.detail.documents.map((document) => ({ id: document.externalId, title: document.title, meta: `${document.mimeType || "Unknown type"} · ${document.sourceSystem}` }));
    return { icon: FileText, title: tab, summary: `${rows.length} document${rows.length === 1 ? "" : "s"} linked to ${assetName}`, rows };
  }
  if (tab === "Relations") {
    const rows: AlternateEntry[] = snapshot.detail.relations.map((relation) => ({ id: relation.id, title: `${relation.source.externalId} ${relation.type} ${relation.target.externalId}`, meta: `${relation.status} · ${relation.confidence === null ? "Not scored" : `${Math.round(relation.confidence * 100)}% confidence`}` }));
    return { icon: GitBranch, title: tab, summary: `${rows.length} contextual relationship${rows.length === 1 ? "" : "s"} linked to ${assetName}`, rows };
  }
  const rows: AlternateEntry[] = snapshot.detail.provenance.map((record) => ({ id: String(record.id), title: record.sourceSystem, meta: `${record.ingestionRunId} · model ${record.modelVersion} · ${new Date(record.transactionTime).toLocaleString()}` }));
  return { icon: History, title: tab, summary: `${rows.length} provenance record${rows.length === 1 ? "" : "s"} for ${assetName}`, rows };
}

function AlternateTab({ tab, snapshot }: { tab: Exclude<Tab, "Overview">; snapshot: ExplorerSnapshot }) {
  const content = alternateContent(tab, snapshot);
  const Icon = content.icon;
  return (
    <section className="alternate-tab">
      <div className="alternate-heading"><span><Icon size={23} /></span><div><h2>{content.title}</h2><p>{content.summary}</p></div></div>
      {content.rows.length > 0 ? (
        <div className="alternate-list">
          {content.rows.map((row) => <div className="alternate-data-row" key={row.id}><span><strong>{row.title}</strong><small>{row.meta}</small></span></div>)}
        </div>
      ) : <p className="alternate-empty">No {content.title.toLowerCase()} are linked to this asset.</p>}
    </section>
  );
}

function ExplorerDataState({ loading, error, onRetry }: { loading: boolean; error: string; onRetry?: () => void }) {
  return (
    <div className={`explorer-data-state${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
      {error ? <AlertCircle size={24} /> : <Activity className="spin" size={24} />}
      <div><strong>{error ? "Asset data unavailable" : "Loading asset data"}</strong><p>{error || "Fetching properties, telemetry, documents, and contextual relationships…"}</p></div>
      {error && onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={15} /> Retry</button> : null}
    </div>
  );
}

function AssetTitleIcon({ type }: { type: string }) {
  return type.toLowerCase().includes("pump") ? <PumpIcon size={33} strokeWidth={1.45} /> : <Factory size={31} strokeWidth={1.45} />;
}

export function AssetWorkspace({ onIngest, snapshot, loading = false, error = "", onRetry }: AssetWorkspaceProps) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [range, setRange] = useState("24h");
  const [live, setLive] = useState(true);
  const series = snapshot?.telemetry.series.find((item) => item.externalId.toLowerCase().includes("pressure")) ?? snapshot?.telemetry.series[0];
  const values = series?.points.map((point) => point.value);
  const acceptedRelations = snapshot?.detail.relations.filter((relation) => relation.status === "accepted").length ?? 0;

  return (
    <main className="asset-workspace">
      <div className="page-heading-row"><h1>Asset Explorer</h1><button className="ingest-button" type="button" onClick={onIngest}><Upload size={19} /> Ingest data</button></div>
      {loading || error ? <ExplorerDataState loading={loading} error={error} onRetry={onRetry} /> : null}
      {!loading && !error && !snapshot ? <div className="explorer-data-state"><AlertCircle size={24} /><div><strong>No asset selected</strong><p>Choose an asset from the hierarchy or global search.</p></div></div> : null}
      {!loading && !error && snapshot ? (
        <div className="asset-content">
          <div className="asset-title-row">
            <div className="asset-title"><AssetTitleIcon type={snapshot.detail.asset.type} /><h2>{snapshot.detail.asset.name}</h2></div>
            <div className="review-status"><span><Check size={11} /></span><div><strong>{acceptedRelations > 0 ? "Reviewed" : "No accepted relations"}</strong><small>Contextualization status</small></div></div>
          </div>
          <div className="tabs" role="tablist" aria-label="Asset data views">
            {tabs.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>)}
          </div>
          {tab === "Overview" ? (
            <><PressureChart range={range} onRangeChange={setRange} live={live} onLiveToggle={() => setLive((value) => !value)} values={values} title={series?.name || "Telemetry"} unit={series?.unit || "value"} /><OverviewDetails snapshot={snapshot} /></>
          ) : <AlternateTab tab={tab} snapshot={snapshot} />}
        </div>
      ) : null}
    </main>
  );
}
