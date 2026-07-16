import { ArrowRight, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiRequestError, searchPlatform } from "../lib/api";
import type { PlatformContext, PlatformSearchResult } from "../types";

type ResultSelection = Pick<PlatformSearchResult, "entityType" | "entityId"> | null;
type SearchStatus = "idle" | "loading" | "ready" | "unauthorized" | "forbidden" | "error";

const entityLabels: Record<string, { singular: string; plural: string }> = {
  asset: { singular: "Asset", plural: "Assets" },
  connector: { singular: "Connector", plural: "Connectors" },
  contextCandidate: { singular: "Context candidate", plural: "Context candidates" },
  dataModel: { singular: "Data model", plural: "Data models" },
  dataset: { singular: "Dataset", plural: "Datasets" },
  diagramExtraction: { singular: "Diagram extraction", plural: "Diagram extractions" },
  matchingEvaluation: { singular: "Matching evaluation", plural: "Matching evaluations" },
  pipeline: { singular: "Pipeline", plural: "Pipelines" },
  pipelineRun: { singular: "Pipeline run", plural: "Pipeline runs" },
  qualityRule: { singular: "Quality rule", plural: "Quality rules" },
  source: { singular: "Source", plural: "Sources" },
  spatialAssetLink: { singular: "Spatial link", plural: "Spatial links" },
  writebackRequest: { singular: "Write-back request", plural: "Write-back requests" },
};

function resultKey(result: Pick<PlatformSearchResult, "entityType" | "entityId">): string {
  return `${result.entityType}:${result.entityId}`;
}

function titleCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function entityLabel(entityType: string, plural = false): string {
  const configured = entityLabels[entityType];
  if (configured) return plural ? configured.plural : configured.singular;
  const fallback = titleCase(entityType);
  return plural ? `${fallback}s` : fallback;
}

function destinationLabel(entityType: string): string | null {
  if (entityType === "asset") return "Explorer";
  if (["source", "connector", "dataset"].includes(entityType)) return "Sources";
  if (["pipeline", "pipelineRun", "qualityRule"].includes(entityType)) return "Pipelines";
  if (entityType === "dataModel") return "Models";
  if (entityType === "contextCandidate") return "Context";
  if (entityType === "diagramExtraction") return "Diagrams";
  if (entityType === "matchingEvaluation") return "Matching";
  if (entityType === "spatialAssetLink") return "Spatial";
  if (entityType === "writebackRequest") return "Write-back";
  if (entityType === "audit") return "Audit";
  return null;
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

export function DataExplorerWorkspace({
  context,
  query,
  selected,
  onSelect,
  onOpen,
  onClear,
}: {
  context: PlatformContext | null;
  query: string;
  selected: ResultSelection;
  onSelect: (result: PlatformSearchResult) => void;
  onOpen: (result: PlatformSearchResult) => void;
  onClear: () => void;
}) {
  const [items, setItems] = useState<PlatformSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [activeType, setActiveType] = useState("all");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<ResultSelection>(selected);
  const [reloadToken, setReloadToken] = useState(0);
  const normalizedQuery = query.trim();

  useEffect(() => {
    setLocalSelection(selected);
  }, [selected?.entityType, selected?.entityId]);

  useEffect(() => {
    if (!context || !normalizedQuery) {
      setItems([]);
      setStatus("idle");
      return undefined;
    }
    const controller = new AbortController();
    setStatus("loading");
    void searchPlatform(context, { q: normalizedQuery, limit: 100 }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiRequestError && error.status === 401) setStatus("unauthorized");
        else if (error instanceof ApiRequestError && error.status === 403) setStatus("forbidden");
        else setStatus("error");
      });
    return () => controller.abort();
  }, [context, normalizedQuery, reloadToken]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.entityType, (counts.get(item.entityType) ?? 0) + 1);
    return counts;
  }, [items]);

  const categories = useMemo(() => [...categoryCounts.keys()].sort((left, right) => entityLabel(left, true).localeCompare(entityLabel(right, true))), [categoryCounts]);
  const filteredItems = useMemo(() => activeType === "all" ? items : items.filter((item) => item.entityType === activeType), [activeType, items]);
  const selectedKey = localSelection ? resultKey(localSelection) : null;
  const selectedResult = useMemo(() => selectedKey ? items.find((item) => resultKey(item) === selectedKey) ?? null : null, [items, selectedKey]);

  useEffect(() => {
    if (activeType !== "all" && !categoryCounts.has(activeType)) setActiveType("all");
  }, [activeType, categoryCounts]);

  useEffect(() => {
    const preferred = selectedKey && filteredItems.some((item) => resultKey(item) === selectedKey)
      ? selectedKey
      : filteredItems[0] ? resultKey(filteredItems[0]) : null;
    setActiveKey((current) => current && filteredItems.some((item) => resultKey(item) === current) ? current : preferred);
  }, [filteredItems, selectedKey]);

  function selectResult(result: PlatformSearchResult) {
    setLocalSelection({ entityType: result.entityType, entityId: result.entityId });
    setActiveKey(resultKey(result));
    onSelect(result);
  }

  function moveActive(key: "ArrowDown" | "ArrowUp" | "Home" | "End" | "Enter") {
    if (filteredItems.length === 0) return;
    const currentIndex = Math.max(0, filteredItems.findIndex((item) => resultKey(item) === activeKey));
    if (key === "Enter") {
      selectResult(filteredItems[currentIndex]);
      return;
    }
    const nextIndex = key === "Home" ? 0 : key === "End" ? filteredItems.length - 1 : key === "ArrowDown"
      ? (currentIndex + 1) % filteredItems.length
      : (currentIndex - 1 + filteredItems.length) % filteredItems.length;
    setActiveKey(resultKey(filteredItems[nextIndex]));
  }

  return (
    <main className="data-explorer" aria-labelledby="data-explorer-title">
      <section className="data-explorer__filters" aria-label="Search filters">
        <div className="data-explorer__heading">
          <Search size={20} aria-hidden="true" />
          <div><h1 id="data-explorer-title">Data Explorer</h1><p>Discover connected industrial data in this project.</p></div>
        </div>
        <div className="data-explorer__query"><span>Query</span><strong>{normalizedQuery || "No query"}</strong><button type="button" onClick={onClear} aria-label="Clear data explorer search"><X size={15} /></button></div>
        <div className="data-explorer__filter-list" role="group" aria-label="Result categories">
          <button type="button" className={activeType === "all" ? "is-active" : ""} aria-pressed={activeType === "all"} onClick={() => setActiveType("all")}>All ({items.length})</button>
          {categories.map((entityType) => <button type="button" key={entityType} className={activeType === entityType ? "is-active" : ""} aria-pressed={activeType === entityType} onClick={() => setActiveType(entityType)}>{entityLabel(entityType, true)} ({categoryCounts.get(entityType)})</button>)}
        </div>
      </section>

      <section className="data-explorer__results" aria-labelledby="data-explorer-results-title">
        <header><div><span>{status === "ready" ? `${filteredItems.length} result${filteredItems.length === 1 ? "" : "s"}` : "Search results"}</span><h2 id="data-explorer-results-title">{activeType === "all" ? "All project data" : entityLabel(activeType, true)}</h2></div></header>
        {status === "idle" ? <p className="data-explorer__empty">Enter a search term to discover project data.</p> : null}
        {status === "loading" ? <p className="data-explorer__empty" role="status">Searching project data…</p> : null}
        {status === "unauthorized" ? <p className="data-explorer__error" role="alert">Sign-in expired. Sign in again to search this project.</p> : null}
        {status === "forbidden" ? <p className="data-explorer__error" role="alert">Your role cannot search this project.</p> : null}
        {status === "error" ? <p className="data-explorer__error" role="alert">Search is unavailable <button type="button" onClick={() => setReloadToken((value) => value + 1)}>Retry</button></p> : null}
        {status === "ready" && filteredItems.length === 0 ? <p className="data-explorer__empty">No matching data in this category.</p> : null}
        {status === "ready" && filteredItems.length > 0 ? (
          <div className="data-explorer__result-list" role="listbox" aria-label="Data Explorer results" tabIndex={0} onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) {
              event.preventDefault();
              moveActive(event.key as "ArrowDown" | "ArrowUp" | "Home" | "End" | "Enter");
            }
          }}>
            {filteredItems.map((item) => {
              const key = resultKey(item);
              const isActive = key === activeKey;
              const isSelected = key === selectedKey;
              return <button type="button" role="option" key={key} aria-selected={isActive} className={`data-explorer__result${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`} onClick={() => selectResult(item)}><span className="data-explorer__result-type">{entityLabel(item.entityType)}</span><strong>{item.title}</strong><span>{item.summary}</span><time dateTime={item.updatedAt}>Updated {formatUpdatedAt(item.updatedAt)}</time></button>;
            })}
          </div>
        ) : null}
      </section>

      <aside className="data-explorer__preview" aria-label="Result preview">
        {selectedResult ? <><span className="data-explorer__preview-type">{entityLabel(selectedResult.entityType)}</span><h2>{selectedResult.title}</h2><p>{selectedResult.summary}</p><dl><div><dt>Record ID</dt><dd>{selectedResult.entityId}</dd></div><div><dt>Updated</dt><dd>{formatUpdatedAt(selectedResult.updatedAt)}</dd></div></dl>{destinationLabel(selectedResult.entityType) ? <button type="button" className="data-explorer__open" onClick={() => onOpen(selectedResult)}>Open {destinationLabel(selectedResult.entityType)} <ArrowRight size={16} /></button> : <p className="data-explorer__empty">This indexed record has no dedicated workspace yet.</p>}</> : <div className="data-explorer__preview-empty"><Search size={24} aria-hidden="true" /><h2>Preview a result</h2><p>Choose a record to inspect its scope and continue into the relevant workspace.</p></div>}
      </aside>
    </main>
  );
}
