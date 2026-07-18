import { Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ApiRequestError, listAssets, searchPlatform } from "../lib/api";
import type { PlatformContext, PlatformProject, PlatformSearchResult, PlatformTenant } from "../types";
import type { PlatformBootstrapState } from "./PlatformWorkspaces";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { navigationLabels, type NavigationLabel } from "./Sidebar";

interface TopbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onResultSelect: (result: PlatformSearchResult) => void;
  onSearchSubmit: (query: string) => void;
  apiOnline: boolean | null;
  platformContext: PlatformContext | null;
  tenants: PlatformTenant[];
  projects: PlatformProject[];
  selectedTenantId: string;
  platformState: PlatformBootstrapState;
  activeSection: NavigationLabel;
  onTenantChange: (tenantId: string) => void;
  onProjectChange: (projectId: string) => void;
  onRetry: () => void;
  onSectionChange: (section: NavigationLabel) => void;
  onOpenCanvas: () => void;
}

type SearchState = "idle" | "loading" | "ready" | "degraded" | "unauthorized" | "forbidden" | "error";

export function Topbar({ query, onQueryChange, onResultSelect, onSearchSubmit, apiOnline, platformContext, tenants, projects, selectedTenantId, platformState, activeSection, onTenantChange, onProjectChange, onRetry, onSectionChange, onOpenCanvas }: TopbarProps) {
  const deferredQuery = useDeferredValue(query.trim());
  const [matches, setMatches] = useState<PlatformSearchResult[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [resultsOpen, setResultsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  useEffect(() => {
    const focusGlobalSearch = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      inputRef.current?.focus();
      if (query.trim()) setResultsOpen(true);
    };
    window.addEventListener("keydown", focusGlobalSearch);
    return () => window.removeEventListener("keydown", focusGlobalSearch);
  }, [query]);

  useEffect(() => {
    if (!deferredQuery) {
      setMatches([]);
      setSearchState("idle");
      return undefined;
    }
    const controller = new AbortController();
    setSearchState("loading");
    if (!platformContext && platformState.status === "loading") return () => controller.abort();
    if (!platformContext && (platformState.status === "unauthorized" || platformState.status === "forbidden")) {
      setMatches([]);
      setSearchState(platformState.status);
      return () => controller.abort();
    }
    if (!platformContext) {
      setMatches([]);
      setSearchState("idle");
      return () => controller.abort();
    }
    void (async () => {
      if (platformContext) {
        try {
          const response = await searchPlatform(platformContext, { q: deferredQuery, limit: 20 }, controller.signal);
          if (controller.signal.aborted) return;
          setMatches(response.items);
          setSearchState("ready");
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
            setMatches([]);
            setSearchState(error.status === 401 ? "unauthorized" : "forbidden");
            return;
          }
        }
      }
      try {
        const response = await listAssets(platformContext, { q: deferredQuery, limit: 20, offset: 0 }, controller.signal);
        if (controller.signal.aborted) return;
        setMatches(response.items.map((asset) => ({
          tenantId: platformContext.tenantId,
          projectId: platformContext.projectId,
          entityType: "asset",
          entityId: asset.externalId,
          title: asset.name,
          summary: `${asset.externalId} · ${asset.type} · ${asset.sourceSystem}`,
          updatedAt: asset.updatedAt,
        })));
        setSearchState("degraded");
      } catch {
        if (controller.signal.aborted) return;
        setMatches([]);
        setSearchState("error");
      }
    })();
    return () => controller.abort();
  }, [deferredQuery, platformContext?.tenantId, platformContext?.projectId, platformState.status]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [deferredQuery, matches]);

  useEffect(() => {
    if (!query.trim()) {
      setResultsOpen(false);
      setActiveIndex(-1);
    }
  }, [query]);

  useEffect(() => {
    if (!resultsOpen) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !searchContainerRef.current?.contains(event.target)) {
        setResultsOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [resultsOpen]);

  const resultsAreStale = query.trim() !== deferredQuery;
  const resultsVisible = resultsOpen && Boolean(query.trim());
  const hasNavigableResults = !resultsAreStale && (searchState === "ready" || searchState === "degraded") && matches.length > 0;
  const activeOptionId = resultsVisible && hasNavigableResults && activeIndex >= 0 && activeIndex < matches.length
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  function closeResults() {
    setResultsOpen(false);
    setActiveIndex(-1);
  }

  function selectResult(result: PlatformSearchResult) {
    closeResults();
    onResultSelect(result);
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!query.trim()) return;
      setResultsOpen(true);
      if (!hasNavigableResults) {
        setActiveIndex(-1);
        return;
      }
      setActiveIndex((current) => {
        if (event.key === "ArrowDown") return current < matches.length - 1 ? current + 1 : 0;
        return current > 0 ? current - 1 : matches.length - 1;
      });
      return;
    }
    if (event.key === "Enter" && resultsVisible && hasNavigableResults && activeIndex >= 0 && activeIndex < matches.length) {
      event.preventDefault();
      selectResult(matches[activeIndex]);
      return;
    }
    if (event.key === "Enter" && query.trim()) {
      event.preventDefault();
      closeResults();
      onSearchSubmit(query.trim());
      return;
    }
    if (event.key === "Escape" && resultsVisible) {
      event.preventDefault();
      event.stopPropagation();
      closeResults();
    }
  }

  return (
    <header className="topbar">
      <div
        className="global-search"
        ref={searchContainerRef}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) closeResults();
        }}
      >
        <Search size={18} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Search project data"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          placeholder="Search assets, sources, pipelines, models, and more"
          value={query}
          onFocus={() => {
            if (query.trim()) setResultsOpen(true);
          }}
          onKeyDown={onSearchKeyDown}
          onChange={(event) => {
            const nextQuery = event.target.value;
            onQueryChange(nextQuery);
            setActiveIndex(-1);
            setResultsOpen(Boolean(nextQuery.trim()));
          }}
        />
        {!query ? <kbd className="search-shortcut" aria-hidden="true">Ctrl K</kbd> : null}
        {query && (
          <button
            type="button"
            className="clear-search"
            onClick={() => {
              onQueryChange("");
              closeResults();
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
          >
            <X size={16} />
          </button>
        )}
        {resultsVisible && (
          <div id={listboxId} className={`search-results${resultsAreStale ? " is-stale" : ""}`} role="listbox" aria-label="Search results" aria-busy={searchState === "loading"}>
            {searchState === "loading" ? <div className="no-results">Searching project…</div> : null}
            {searchState === "unauthorized" ? <div className="no-results search-error">Sign-in expired. Sign in again to search this project.</div> : null}
            {searchState === "forbidden" ? <div className="no-results search-error">Your role cannot search this project.</div> : null}
            {searchState === "error" ? <div className="no-results search-error">Search is unavailable</div> : null}
            {searchState === "degraded" ? <div className="search-degraded">Platform search degraded · showing asset results only</div> : null}
            {(searchState === "ready" || searchState === "degraded") && matches.length ? (
              matches.map((item, index) => (
                <button
                  id={`${listboxId}-option-${index}`}
                  className="search-result-row"
                  key={`${item.entityType}:${item.entityId}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={!resultsAreStale && activeIndex === index}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectResult(item)}
                >
                  <strong>{item.title}</strong>
                  <span>{item.entityType} · {item.summary}</span>
                </button>
              ))
            ) : null}
            {(searchState === "ready" || searchState === "degraded") && matches.length === 0 ? (
              <div className="no-results">No matching data</div>
            ) : null}
          </div>
        )}
      </div>
      <div className="topbar-actions">
        <ProjectSwitcher context={platformContext} tenants={tenants} projects={projects} selectedTenantId={selectedTenantId} state={platformState} onTenantChange={onTenantChange} onProjectChange={onProjectChange} onRetry={onRetry} />
        <label className="mobile-section-nav"><span className="sr-only">Workspace section</span><select aria-label="Workspace section" value={activeSection} onChange={(event) => onSectionChange(event.target.value as NavigationLabel)}>{navigationLabels.map((section) => <option key={section} value={section}>{section}</option>)}</select></label>
        <button className="switch-canvas-button" type="button" onClick={onOpenCanvas}>Open Canvas</button>
        <div className="environment" role="status" aria-label={`Environment: Local, API ${apiOnline ? "online" : apiOnline === false ? "offline" : "checking"}`}>
          <span className={`status-dot ${apiOnline ? "online" : apiOnline === false ? "offline" : "checking"}`} />
          Local
        </div>
        <span className="avatar" role="img" aria-label="Current development user: HD">HD</span>
      </div>
    </header>
  );
}
