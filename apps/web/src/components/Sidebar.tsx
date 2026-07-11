import {
  Box,
  ChevronsLeft,
  ChevronsRight,
  Cuboid,
  Database,
  FileSearch,
  GitCompareArrows,
  Network,
  ShieldAlert,
  ShieldCheck,
  Tags,
  Workflow,
} from "lucide-react";
import { BrandLogo } from "./BrandLogo";

const navigation = [
  { label: "Explorer", icon: Network },
  { label: "Sources", icon: Database },
  { label: "Pipelines", icon: Workflow },
  { label: "Models", icon: Box },
  { label: "Context", icon: Tags },
  { label: "Diagrams", icon: FileSearch },
  { label: "Matching", icon: GitCompareArrows },
  { label: "Spatial", icon: Cuboid },
  { label: "Write-back", icon: ShieldAlert },
  { label: "Audit", icon: ShieldCheck },
] as const;

export type NavigationLabel = (typeof navigation)[number]["label"];
export const navigationLabels: NavigationLabel[] = navigation.map(({ label }) => label);

interface SidebarProps {
  active: NavigationLabel;
  collapsed: boolean;
  collapseLocked: boolean;
  onNavigate: (label: NavigationLabel) => void;
  onToggleCollapsed: () => void;
}

export function Sidebar({ active, collapsed, collapseLocked, onNavigate, onToggleCollapsed }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand"><BrandLogo variant={collapsed ? "icon" : "full"} /></div>
      <nav className="primary-nav">
        {navigation.map(({ label, icon: Icon }) => {
          const isActive = label === active;
          return (
            <button
              className={`nav-item${isActive ? " is-active" : ""}`}
              key={label}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onNavigate(label)}
            >
              <Icon size={25} strokeWidth={1.65} aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
      {!collapseLocked ? (
        <button className="collapse-nav" type="button" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!collapsed} onClick={onToggleCollapsed}>
          {collapsed ? <ChevronsRight size={25} strokeWidth={1.6} /> : <ChevronsLeft size={25} strokeWidth={1.6} />}
        </button>
      ) : null}
    </aside>
  );
}
