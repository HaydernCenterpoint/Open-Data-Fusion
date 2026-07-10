import {
  Activity,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Droplets,
  Factory,
  Flame,
  Gauge,
  PanelLeftClose,
  SlidersHorizontal,
  Waves,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { assetTree } from "../data/demo";
import type { AssetKind, AssetNode } from "../types";
import { PumpIcon } from "./PumpIcon";

const iconByKind = {
  site: Building2,
  system: Droplets,
  pump: PumpIcon,
  exchanger: SlidersHorizontal,
  tower: Factory,
  valve: Gauge,
  meter: CircleGauge,
  boiler: Flame,
  utility: Zap,
} satisfies Record<AssetKind, typeof Activity>;

interface TreeRowProps {
  node: AssetNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (node: AssetNode) => void;
}

function TreeRow({ node, depth, expanded, onToggle, onSelect }: TreeRowProps) {
  const hasChildren = node.children !== undefined;
  const isExpanded = expanded.has(node.id);
  const Icon = iconByKind[node.kind];
  const selected = node.id === "p-101";

  return (
    <>
      <div
        className={`tree-row${selected ? " is-selected" : ""}`}
        style={{ "--tree-depth": depth } as React.CSSProperties}
      >
        {hasChildren ? (
          <button className="tree-toggle" type="button" onClick={() => onToggle(node.id)} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}>
            {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}
        <button className="tree-label" type="button" onClick={() => onSelect(node)}>
          <Icon size={20} strokeWidth={1.45} aria-hidden="true" />
          <span>{node.name}</span>
        </button>
      </div>
      {hasChildren && isExpanded && node.children?.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

interface AssetTreeProps {
  onSelect: (name: string) => void;
  onCollapse: () => void;
}

export function AssetTree({ onSelect, onCollapse }: AssetTreeProps) {
  const [expanded, setExpanded] = useState(() => new Set(["north-plant", "cooling-water"]));

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside className="asset-tree" aria-label="Asset hierarchy">
      <div className="tree-toolbar">
        <button type="button" aria-label="Hide asset hierarchy" onClick={onCollapse}>
          <PanelLeftClose size={20} strokeWidth={1.55} />
        </button>
      </div>
      <div className="tree-content">
        {assetTree.map((node) => (
          <TreeRow
            key={node.id}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            onSelect={(item) => onSelect(item.name)}
          />
        ))}
      </div>
    </aside>
  );
}
