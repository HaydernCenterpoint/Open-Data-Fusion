import {
  Box,
  ChevronsLeft,
  Database,
  Network,
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
  { label: "Audit", icon: ShieldCheck },
];

interface SidebarProps {
  onUnavailable: (label: string) => void;
}

export function Sidebar({ onUnavailable }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand">Open Data Fusion</div>
      <nav className="primary-nav">
        {navigation.map(({ label, icon: Icon }) => {
          const active = label === "Explorer";
          return (
            <button
              className={`nav-item${active ? " is-active" : ""}`}
              key={label}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => !active && onUnavailable(label)}
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
