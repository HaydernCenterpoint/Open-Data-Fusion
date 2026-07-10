import { ChevronDown, Search, X } from "lucide-react";
import { searchableItems } from "../data/demo";

interface TopbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onResultSelect: (title: string) => void;
  apiOnline: boolean | null;
}

export function Topbar({ query, onQueryChange, onResultSelect, apiOnline }: TopbarProps) {
  const matches = query.trim()
    ? searchableItems.filter((item) =>
        `${item.title} ${item.meta}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];

  return (
    <header className="topbar">
      <div className="global-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search assets, time series, and documents"
          placeholder="Search assets, time series, and documents"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query && (
          <button type="button" className="clear-search" onClick={() => onQueryChange("")} aria-label="Clear search">
            <X size={16} />
          </button>
        )}
        {query && (
          <div className="search-results" role="listbox" aria-label="Search results">
            {matches.length ? (
              matches.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => onResultSelect(item.title)}
                >
                  <strong>{item.title}</strong>
                  <span>{item.meta}</span>
                </button>
              ))
            ) : (
              <div className="no-results">No matching data</div>
            )}
          </div>
        )}
      </div>
      <div className="topbar-actions">
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
