import { Activity, Check, FileText, GitBranch, History, Upload } from "lucide-react";
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
}

function AlternateTab({ tab }: { tab: Exclude<Tab, "Overview"> }) {
  const content = {
    "Time series": { icon: Activity, title: "Time series", summary: "3 telemetry streams linked to Pump P-101", rows: ["Pressure · 111.2 psi", "Discharge Flow · 482 gpm", "Motor Current · 68.4 A"] },
    Documents: { icon: FileText, title: "Documents", summary: "2 reviewed engineering documents", rows: ["P-101 O&M Manual", "P-101 Performance Curve"] },
    Relations: { icon: GitBranch, title: "Relations", summary: "4 accepted contextual relationships", rows: ["Discharges to V-401", "Feeds HX-201", "Measured by FM-501"] },
    Lineage: { icon: History, title: "Lineage", summary: "Curated from 4 governed sources", rows: ["OSIsoft PI · telemetry", "SAP PM · equipment master", "Plant Drawings · engineering context"] },
  }[tab];
  const Icon = content.icon;

  return (
    <section className="alternate-tab">
      <div className="alternate-heading"><span><Icon size={23} /></span><div><h2>{content.title}</h2><p>{content.summary}</p></div></div>
      <div className="alternate-list">
        {content.rows.map((row) => <button type="button" key={row}><span>{row}</span><span>View details</span></button>)}
      </div>
    </section>
  );
}

export function AssetWorkspace({ onIngest, snapshot }: AssetWorkspaceProps) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [range, setRange] = useState("24h");
  const [live, setLive] = useState(true);
  const pressure = snapshot?.telemetry.series.find((series) =>
    series.externalId.toLowerCase().includes("pressure"),
  );
  const pressurePoints = pressure?.points.map((point) => point.value);

  return (
    <main className="asset-workspace">
      <div className="page-heading-row">
        <h1>Asset Explorer</h1>
        <button className="ingest-button" type="button" onClick={onIngest}><Upload size={19} /> Ingest data</button>
      </div>
      <div className="asset-content">
        <div className="asset-title-row">
          <div className="asset-title"><PumpIcon size={33} strokeWidth={1.45} /><h2>{snapshot?.detail.asset.name || "Pump P-101"}</h2></div>
          <div className="review-status"><span><Check size={11} /></span><div><strong>Reviewed</strong><small>Contextualization status</small></div></div>
        </div>
        <div className="tabs" role="tablist" aria-label="Asset data views">
          {tabs.map((item) => (
            <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>
          ))}
        </div>
        {tab === "Overview" ? (
          <>
            <PressureChart range={range} onRangeChange={setRange} live={live} onLiveToggle={() => setLive((value) => !value)} values={pressurePoints} />
            <OverviewDetails snapshot={snapshot} />
          </>
        ) : (
          <AlternateTab tab={tab} />
        )}
      </div>
    </main>
  );
}
