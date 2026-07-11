import { Activity, AlertCircle, Check, Factory, FileText, GitBranch, History, RefreshCw, Upload } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ExplorerSnapshot } from "../types";
import { OverviewDetails } from "./OverviewDetails";
import { PressureChart, type PressureChartRange } from "./PressureChart";
import { PumpIcon } from "./PumpIcon";

const tabs = ["Overview", "Time series", "Documents", "Relations", "Lineage"] as const;
type Tab = (typeof tabs)[number];

function tabKey(tab: Tab): string {
  return tab.toLowerCase().replaceAll(" ", "-");
}

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
  const [range, setRange] = useState<PressureChartRange>("24h");
  const tabsetId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const series = snapshot?.telemetry.series.find((item) => item.externalId.toLowerCase().includes("pressure")) ?? snapshot?.telemetry.series[0];
  const points = series?.points;
  const acceptedRelations = snapshot?.detail.relations.filter((relation) => relation.status === "accepted").length ?? 0;

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setTab(tabs[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <main className="asset-workspace">
      <div className="page-heading-row"><h1>Asset Explorer</h1><button className="ingest-button" type="button" onClick={onIngest}><Upload size={19} /> Ingest sample</button></div>
      {loading || error ? <ExplorerDataState loading={loading} error={error} onRetry={onRetry} /> : null}
      {!loading && !error && !snapshot ? <div className="explorer-data-state"><AlertCircle size={24} /><div><strong>No asset selected</strong><p>Choose an asset from the hierarchy or global search.</p></div></div> : null}
      {!loading && !error && snapshot ? (
        <div className="asset-content">
          <div className="asset-title-row">
            <div className="asset-title"><AssetTitleIcon type={snapshot.detail.asset.type} /><h2>{snapshot.detail.asset.name}</h2></div>
            <div className="review-status"><span><Check size={11} /></span><div><strong>{acceptedRelations > 0 ? "Reviewed" : "No accepted relations"}</strong><small>Contextualization status</small></div></div>
          </div>
          <div className="tabs" role="tablist" aria-label="Asset data views">
            {tabs.map((item, index) => {
              const key = tabKey(item);
              const selected = tab === item;
              return <button ref={(element) => { tabRefs.current[index] = element; }} id={`${tabsetId}-${key}-tab`} key={item} type="button" role="tab" aria-controls={`${tabsetId}-${key}-panel`} aria-selected={selected} tabIndex={selected ? 0 : -1} className={selected ? "is-active" : ""} onKeyDown={(event) => onTabKeyDown(event, index)} onClick={() => setTab(item)}>{item}</button>;
            })}
          </div>
          <div id={`${tabsetId}-${tabKey(tab)}-panel`} role="tabpanel" aria-labelledby={`${tabsetId}-${tabKey(tab)}-tab`} tabIndex={0}>
            {tab === "Overview" ? (
              <><PressureChart range={range} onRangeChange={setRange} points={points} rangeEnd={snapshot.telemetry.range.to} title={series?.name || "Telemetry"} unit={series?.unit || "value"} /><OverviewDetails snapshot={snapshot} /></>
            ) : <AlternateTab tab={tab} snapshot={snapshot} />}
          </div>
        </div>
      ) : null}
    </main>
  );
}
