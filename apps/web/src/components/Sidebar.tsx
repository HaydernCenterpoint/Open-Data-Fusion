import {
  Activity,
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

export const navigationGroups = [
  {
    label: "Explore",
    items: [
      { label: "Overview", icon: Activity },
      { label: "Explorer", icon: Network },
    ],
  },
  {
    label: "Data engineering",
    items: [
      { label: "Sources", icon: Database },
      { label: "Pipelines", icon: Workflow },
      { label: "Models", icon: Box },
    ],
  },
  {
    label: "Contextualize",
    items: [
      { label: "Context", icon: Tags },
      { label: "Diagrams", icon: FileSearch },
      { label: "Matching", icon: GitCompareArrows },
      { label: "Spatial", icon: Cuboid },
    ],
  },
  {
    label: "Govern",
    items: [
      { label: "Write-back", icon: ShieldAlert },
      { label: "Audit", icon: ShieldCheck },
    ],
  },
] as const;

export const navigationItems = [
  ...navigationGroups[0].items,
  ...navigationGroups[1].items,
  ...navigationGroups[2].items,
  ...navigationGroups[3].items,
] as const;
export type NavigationLabel = (typeof navigationGroups)[number]["items"][number]["label"];
export const navigationLabels: NavigationLabel[] = navigationItems.map(({ label }) => label);

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
        {navigationGroups.map((group) => (
          <div className="nav-group" key={group.label} role="group" aria-label={group.label}>
            <span className="nav-group-label">{group.label}</span>
            {group.items.map(({ label, icon: Icon }) => {
              const isActive = label === active;
              return (
                <button
                  className={`nav-item${isActive ? " is-active" : ""}`}
                  key={label}
                  type="button"
                  aria-label={label}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => onNavigate(label)}
                >
                  <Icon size={20} strokeWidth={1.65} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      {!collapseLocked ? (
        <button className="collapse-nav" type="button" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!collapsed} onClick={onToggleCollapsed}>
          {collapsed ? <ChevronsRight size={25} strokeWidth={1.6} /> : <ChevronsLeft size={25} strokeWidth={1.6} />}
        </button>
      ) : null}
    </aside>
  );
}
