"use client";

import { Search, X } from "lucide-react";
import type { ReactNode } from "react";

interface SearchControl {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
}

interface FilterToolbarProps {
  search?: SearchControl;
  filters?: ReactNode;
  actions?: ReactNode;
  summary?: ReactNode;
  onClear?: () => void;
  clearLabel?: string;
}

export function FilterToolbar({
  search,
  filters,
  actions,
  summary,
  onClear,
  clearLabel = "Clear filters",
}: FilterToolbarProps) {
  return (
    <section aria-label="Table filters" className="filter-toolbar">
      <div className="filter-toolbar__controls">
        {search ? (
          <label className="filter-search">
            <span className="sr-only">{search.label ?? "Search records"}</span>
            <Search aria-hidden="true" />
            <input
              type="search"
              value={search.value}
              placeholder={search.placeholder ?? "Search"}
              onChange={(event) => search.onChange(event.currentTarget.value)}
            />
          </label>
        ) : null}
        {filters ? <div className="filter-toolbar__filters">{filters}</div> : null}
        {onClear ? (
          <button className="filter-toolbar__clear" type="button" onClick={onClear}>
            <X aria-hidden="true" />
            {clearLabel}
          </button>
        ) : null}
      </div>
      {summary || actions ? (
        <div className="filter-toolbar__meta">
          {summary ? <span className="filter-toolbar__summary">{summary}</span> : null}
          {actions ? <div className="filter-toolbar__actions">{actions}</div> : null}
        </div>
      ) : null}
    </section>
  );
}
