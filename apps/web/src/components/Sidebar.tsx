import {
  Box,
  ChevronsLeft,
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
  onNavigate: (label: NavigationLabel) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand">Open Data Fusion</div>
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
      <button className="collapse-nav" type="button" aria-label="Collapse navigation">
        <ChevronsLeft size={25} strokeWidth={1.6} />
      </button>
    </aside>
  );
}
