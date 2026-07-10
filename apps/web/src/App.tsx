import { PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AssetTree } from "./components/AssetTree";
import { AssetWorkspace } from "./components/AssetWorkspace";
import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { IngestModal } from "./components/IngestModal";
import { RelatedRail } from "./components/RelatedRail";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { getExplorerSnapshot, getHealth, getWorkspace } from "./lib/api";
import type { ApiWorkspace, ExplorerSnapshot } from "./types";

export default function App() {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"canvas" | "explorer">("canvas");
  const [treeVisible, setTreeVisible] = useState(() =>
    typeof window.matchMedia !== "function"
      ? true
      : window.matchMedia("(min-width: 791px)").matches,
  );
  const [ingestOpen, setIngestOpen] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<ApiWorkspace | null>(null);
  const [toast, setToast] = useState("");

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }, []);

  const acceptWorkspace = useCallback((nextWorkspace: ApiWorkspace) => {
    setWorkspace((current) =>
      !current || nextWorkspace.version >= current.version ? nextWorkspace : current,
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal).then(setApiOnline);
    getExplorerSnapshot("P-101", controller.signal)
      .then(setSnapshot)
      .catch(() => {
        // Keep the visual demo usable while the local API is starting.
      });
    getWorkspace("cooling-water-system", controller.signal)
      .then(acceptWorkspace)
      .catch(() => {
        // Canvas remains available with its embedded seed while the API is starting.
      });
    return () => controller.abort();
  }, [acceptWorkspace]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;

    const desktopViewport = window.matchMedia("(min-width: 791px)");
    const syncTreeVisibility = (event: MediaQueryListEvent) => setTreeVisible(event.matches);
    desktopViewport.addEventListener("change", syncTreeVisibility);
    return () => desktopViewport.removeEventListener("change", syncTreeVisibility);
  }, []);

  const refreshExplorer = useCallback(() => {
    getExplorerSnapshot("P-101")
      .then(setSnapshot)
      .catch(() => undefined);
  }, []);

  function selectSearchResult(title: string) {
    setQuery("");
    notify(`${title} selected`);
  }

  if (viewMode === "canvas") {
    return (
      <>
        <CanvasWorkspace snapshot={snapshot} workspace={workspace} onWorkspaceUpdated={acceptWorkspace} onOpenExplorer={() => setViewMode("explorer")} onNotify={notify} />
        {toast && <div className="toast" role="status">{toast}</div>}
      </>
    );
  }

  return (
    <div className={`app-shell${treeVisible ? "" : " tree-collapsed"}`}>
      <Sidebar onUnavailable={(label) => notify(`${label} is planned for the next milestone`)} />
      <Topbar query={query} onQueryChange={setQuery} onResultSelect={selectSearchResult} apiOnline={apiOnline} />
      {treeVisible ? (
        <AssetTree onCollapse={() => setTreeVisible(false)} onSelect={(name) => name === "Pump P-101" ? notify(`${name} is already selected`) : notify(`${name} preview is coming next`)} />
      ) : (
        <button className="show-tree-button" type="button" onClick={() => setTreeVisible(true)} aria-label="Show asset hierarchy"><PanelLeftOpen size={20} /></button>
      )}
      <button className="switch-canvas-button" type="button" onClick={() => setViewMode("canvas")}>Canvas <span>⌘K</span></button>
      <AssetWorkspace onIngest={() => setIngestOpen(true)} snapshot={snapshot} />
      <RelatedRail onAction={notify} />
      <IngestModal
        open={ingestOpen}
        onClose={() => setIngestOpen(false)}
        onComplete={(message) => {
          notify(message);
          refreshExplorer();
        }}
      />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
