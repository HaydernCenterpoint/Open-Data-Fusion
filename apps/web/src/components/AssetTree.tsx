import {
  Building2,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Droplets,
  Factory,
  Flame,
  Gauge,
  PanelLeftClose,
  RefreshCw,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiAsset } from "../types";
import { PumpIcon } from "./PumpIcon";

interface AssetBranch {
  asset: ApiAsset;
  children: AssetBranch[];
}

function compareAssets(left: AssetBranch, right: AssetBranch): number {
  return left.asset.name.localeCompare(right.asset.name, undefined, { sensitivity: "base" });
}

function buildAssetForest(assets: ApiAsset[]): AssetBranch[] {
  const branches = new Map<string, AssetBranch>();
  for (const asset of assets) branches.set(asset.externalId, { asset, children: [] });

  const roots: AssetBranch[] = [];
  for (const branch of branches.values()) {
    const parentId = branch.asset.parentExternalId;
    const parent = parentId && parentId !== branch.asset.externalId ? branches.get(parentId) : undefined;
    if (parent) parent.children.push(branch);
    else roots.push(branch);
  }

  const sortBranch = (branch: AssetBranch) => {
    branch.children.sort(compareAssets);
    branch.children.forEach(sortBranch);
  };
  roots.sort(compareAssets);
  roots.forEach(sortBranch);
  return roots;
}

function AssetGlyph({ asset }: { asset: ApiAsset }) {
  const descriptor = `${asset.type} ${asset.name}`.toLowerCase();
  if (descriptor.includes("pump")) return <PumpIcon size={20} strokeWidth={1.45} aria-hidden="true" />;
  if (descriptor.includes("exchanger")) return <SlidersHorizontal size={20} strokeWidth={1.45} aria-hidden="true" />;
  if (descriptor.includes("valve")) return <Gauge size={20} strokeWidth={1.45} aria-hidden="true" />;
  if (descriptor.includes("meter") || descriptor.includes("instrument")) return <CircleGauge size={20} strokeWidth={1.45} aria-hidden="true" />;
  if (descriptor.includes("boiler") || descriptor.includes("heat")) return <Flame size={20} strokeWidth={1.45} aria-hidden="true" />;
  if (descriptor.includes("utility") || descriptor.includes("electric")) return <Zap size={20} strokeWidth={1.45} aria-hidden="true" />;
  if (descriptor.includes("water") || descriptor.includes("system")) return <Droplets size={20} strokeWidth={1.45} aria-hidden="true" />;
  if (descriptor.includes("plant") || descriptor.includes("site") || descriptor.includes("area")) return <Building2 size={20} strokeWidth={1.45} aria-hidden="true" />;
  return <Factory size={20} strokeWidth={1.45} aria-hidden="true" />;
}

interface TreeRowProps {
  branch: AssetBranch;
  depth: number;
  expanded: Set<string>;
  selectedExternalId: string;
  onToggle: (externalId: string) => void;
  onSelect: (asset: ApiAsset) => void;
}

function TreeRow({ branch, depth, expanded, selectedExternalId, onToggle, onSelect }: TreeRowProps) {
  const { asset, children } = branch;
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(asset.externalId);
  const selected = asset.externalId === selectedExternalId;

  return (
    <>
      <div className={`tree-row asset-tree-row-virtual${selected ? " is-selected" : ""}`} style={{ "--tree-depth": depth } as React.CSSProperties}>
        {hasChildren ? (
          <button className="tree-toggle" type="button" onClick={() => onToggle(asset.externalId)} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${asset.name}`}>
            {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </button>
        ) : <span className="tree-toggle-spacer" />}
        <button className="tree-label" type="button" aria-current={selected ? "true" : undefined} onClick={() => onSelect(asset)}>
          <AssetGlyph asset={asset} />
          <span><strong>{asset.name}</strong><small>{asset.externalId}</small></span>
        </button>
      </div>
      {hasChildren && isExpanded ? children.map((child) => (
        <TreeRow key={child.asset.externalId} branch={child} depth={depth + 1} expanded={expanded} selectedExternalId={selectedExternalId} onToggle={onToggle} onSelect={onSelect} />
      )) : null}
    </>
  );
}

interface AssetTreeProps {
  assets: ApiAsset[];
  total: number;
  selectedExternalId: string;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  onSelect: (asset: ApiAsset) => void;
  onCollapse: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

export function AssetTree({ assets, total, selectedExternalId, loading, loadingMore, error, onSelect, onCollapse, onRetry, onLoadMore }: AssetTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const initializedParents = useRef(new Set<string>());
  const forest = useMemo(() => buildAssetForest(assets), [assets]);

  useEffect(() => {
    const parentIds = new Set(assets.map((asset) => asset.parentExternalId).filter((id): id is string => Boolean(id)));
    const additions = [...parentIds].filter((id) => !initializedParents.current.has(id));
    if (additions.length === 0) return;
    additions.forEach((id) => initializedParents.current.add(id));
    setExpanded((current) => new Set([...current, ...additions]));
  }, [assets]);

  function toggle(externalId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  }

  return (
    <aside className="asset-tree" aria-label="Asset hierarchy">
      <div className="tree-toolbar"><strong>Assets</strong><button type="button" aria-label="Hide asset hierarchy" onClick={onCollapse}><PanelLeftClose size={20} strokeWidth={1.55} /></button></div>
      <div className="tree-content">
        {loading && assets.length === 0 ? <p className="tree-data-state">Loading assets…</p> : null}
        {error && assets.length === 0 ? <div className="tree-data-state is-error"><span>{error}</span><button type="button" onClick={onRetry}><RefreshCw size={14} /> Retry</button></div> : null}
        {!loading && !error && assets.length === 0 ? <p className="tree-data-state">No assets are available.</p> : null}
        {forest.map((branch) => <TreeRow key={branch.asset.externalId} branch={branch} depth={0} expanded={expanded} selectedExternalId={selectedExternalId} onToggle={toggle} onSelect={onSelect} />)}
        {assets.length < total ? <button className="tree-load-more" type="button" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading…" : `Load more (${total - assets.length})`}</button> : null}
        {error && assets.length > 0 ? <p className="tree-inline-error" role="alert">{error}</p> : null}
      </div>
    </aside>
  );
}
