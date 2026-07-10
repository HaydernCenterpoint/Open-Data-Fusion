import { ChevronDown, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import { ApiRequestError, listAssets, searchPlatform } from "../lib/api";
import type { PlatformContext, PlatformSearchResult } from "../types";
import { navigationLabels, type NavigationLabel } from "./Sidebar";

interface TopbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onResultSelect: (result: PlatformSearchResult) => void;
  apiOnline: boolean | null;
  platformContext: PlatformContext | null;
  platformStatus: "loading" | "ready" | "empty" | "unauthorized" | "forbidden" | "degraded";
  activeSection: NavigationLabel;
  onSectionChange: (section: NavigationLabel) => void;
}

type SearchState = "idle" | "loading" | "ready" | "degraded" | "unauthorized" | "forbidden" | "error";

export function Topbar({ query, onQueryChange, onResultSelect, apiOnline, platformContext, platformStatus, activeSection, onSectionChange }: TopbarProps) {
  const deferredQuery = useDeferredValue(query.trim());
  const [matches, setMatches] = useState<PlatformSearchResult[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");

  useEffect(() => {
    if (!deferredQuery) {
      setMatches([]);
      setSearchState("idle");
      return undefined;
    }
    const controller = new AbortController();
    setSearchState("loading");
    if (!platformContext && platformStatus === "loading") return () => controller.abort();
    if (!platformContext && (platformStatus === "unauthorized" || platformStatus === "forbidden")) {
      setMatches([]);
      setSearchState(platformStatus);
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
        const response = await listAssets({ q: deferredQuery, limit: 20, offset: 0 }, controller.signal);
        if (controller.signal.aborted) return;
        setMatches(response.items.map((asset) => ({
          tenantId: platformContext?.tenantId ?? "",
          projectId: platformContext?.projectId ?? "",
          entityType: "asset",
          entityId: asset.externalId,
          title: asset.name,
          summary: `${asset.externalId} · ${asset.type} · ${asset.sourceSystem}`,
          updatedAt: asset.updatedAt,
        })));
        setSearchState(platformContext || platformStatus !== "ready" ? "degraded" : "ready");
      } catch {
        if (controller.signal.aborted) return;
        setMatches([]);
        setSearchState("error");
      }
    })();
    return () => controller.abort();
  }, [deferredQuery, platformContext?.tenantId, platformContext?.projectId, platformStatus]);

  const resultsAreStale = query.trim() !== deferredQuery;

  return (
    <header className="topbar">
      <div className="global-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search project data"
          placeholder="Search assets, sources, pipelines, models, and more"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query && (
          <button type="button" className="clear-search" onClick={() => onQueryChange("")} aria-label="Clear search">
            <X size={16} />
          </button>
        )}
        {query && (
          <div className={`search-results${resultsAreStale ? " is-stale" : ""}`} role="listbox" aria-label="Search results" aria-busy={searchState === "loading"}>
            {searchState === "loading" ? <div className="no-results">Searching project…</div> : null}
            {searchState === "unauthorized" ? <div className="no-results search-error">Sign-in expired. Sign in again to search this project.</div> : null}
            {searchState === "forbidden" ? <div className="no-results search-error">Your role cannot search this project.</div> : null}
            {searchState === "error" ? <div className="no-results search-error">Search is unavailable</div> : null}
            {searchState === "degraded" ? <div className="search-degraded">Platform search degraded · showing asset results only</div> : null}
            {(searchState === "ready" || searchState === "degraded") && matches.length ? (
              matches.map((item) => (
                <button
                  className="search-result-row"
                  key={`${item.entityType}:${item.entityId}`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => onResultSelect(item)}
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
        <label className="mobile-section-nav"><span className="sr-only">Workspace section</span><select aria-label="Workspace section" value={activeSection} onChange={(event) => onSectionChange(event.target.value as NavigationLabel)}>{navigationLabels.map((section) => <option key={section} value={section}>{section}</option>)}</select></label>
        <button className="environment" type="button" aria-label="Environment: Local">
          <span className={`status-dot ${apiOnline ? "online" : apiOnline === false ? "offline" : "checking"}`} />
          Local
          <ChevronDown size={14} />
        </button>
        <button className="avatar" type="button" aria-label="User profile for HD">HD</button>
      </div>
    </header>
  );
}
