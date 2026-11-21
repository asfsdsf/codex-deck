import { ArrowLeft, ChevronRight, Search, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { RightPaneIcon } from "./deepseek/right-pane-icons";

export interface CatalogItem {
  key: string;
  title: string;
  description: string;
  meta: string;
  status: string;
  tone: "active" | "muted" | "review";
  searchText: string;
}

export default function RightPaneCatalog(props: {
  label: string;
  icon: ReactNode;
  items: CatalogItem[];
  loading: boolean;
  error: string | null;
  filters: Array<{
    value: string;
    label: string;
    matches: (item: CatalogItem) => boolean;
  }>;
  notices?: ReactNode;
  onRefresh: () => void;
  onSelect: (key: string) => void;
  renderDetails: (key: string) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLSpanElement>(null);
  const listScroll = useRef(0);
  const activeItem = props.items.find((item) => item.key === detailKey);
  const activeFilter = props.filters.find((entry) => entry.value === filter);
  const visibleItems = props.items.filter(
    (item) =>
      (!activeFilter || activeFilter.matches(item)) &&
      item.searchText.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const showDetails = Boolean(activeItem);

  function backToList() {
    const key = detailKey;
    setDetailKey(null);
    requestAnimationFrame(() => {
      if (!list.current) return;
      list.current.scrollTop = listScroll.current;
      const previousRow = Array.from(
        list.current.querySelectorAll<HTMLButtonElement>("[data-catalog-key]"),
      ).find((element) => element.dataset.catalogKey === key);
      if (previousRow) previousRow.focus({ preventScroll: true });
      else search.current?.focus();
    });
  }

  return (
    <div
      className="right-pane-catalog"
      aria-label={props.label}
      onKeyDown={(event) => {
        if (showDetails && event.key === "Escape") {
          event.stopPropagation();
          backToList();
        }
      }}
    >
      <div className="right-pane__page-toolbar">
        {showDetails ? (
          <>
            <button
              type="button"
              className="right-pane__icon-button"
              aria-label={`Back to ${props.label.toLowerCase()}`}
              title={`Back to ${props.label.toLowerCase()}`}
              onClick={backToList}
            >
              <ArrowLeft />
            </button>
            <span
              ref={detailHeading}
              tabIndex={-1}
              className="right-pane-catalog__breadcrumb"
            >
              {activeItem?.title}
            </span>
          </>
        ) : (
          <label className="right-pane__search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={search}
              aria-label={`Search ${props.label.toLowerCase()}`}
              placeholder={`Search ${props.label.toLowerCase()}…`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="right-pane-catalog__clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  search.current?.focus();
                }}
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
        )}
        {showDetails ? <span className="right-pane__fill" /> : null}
        <button
          type="button"
          className="right-pane__icon-button"
          aria-label={`Refresh ${props.label.toLowerCase()}`}
          title={`Refresh ${props.label.toLowerCase()}`}
          disabled={props.loading}
          onClick={props.onRefresh}
        >
          <RightPaneIcon name="refresh" />
        </button>
      </div>
      {!showDetails ? (
        <div
          className="right-pane-catalog__filters"
          role="group"
          aria-label={`Filter ${props.label.toLowerCase()}`}
        >
          {props.filters.map((entry) => (
            <button
              key={entry.value}
              type="button"
              aria-pressed={filter === entry.value}
              onClick={() => setFilter(entry.value)}
            >
              {entry.label}
              <span>{props.items.filter(entry.matches).length}</span>
            </button>
          ))}
        </div>
      ) : null}
      {props.error ? (
        <div className="right-pane-catalog__notice" role="alert">
          {props.error}
        </div>
      ) : null}
      {props.loading && !props.items.length ? (
        <div className="right-pane__empty" role="status">
          Loading {props.label.toLowerCase()}…
        </div>
      ) : showDetails ? (
        <div className="right-pane-catalog__detail">
          {props.renderDetails(activeItem!.key)}
        </div>
      ) : (
        <div
          ref={list}
          className="right-pane-catalog__list"
          aria-busy={props.loading}
        >
          {props.notices}
          {visibleItems.length ? (
            visibleItems.map((item) => (
              <button
                type="button"
                key={item.key}
                data-catalog-key={item.key}
                className="right-pane-catalog__row"
                onClick={() => {
                  listScroll.current = list.current?.scrollTop ?? 0;
                  setDetailKey(item.key);
                  props.onSelect(item.key);
                  requestAnimationFrame(() => detailHeading.current?.focus());
                }}
              >
                <span
                  className={`right-pane-catalog__icon right-pane-catalog__icon--${props.label.toLowerCase()}`}
                >
                  {props.icon}
                </span>
                <span className="right-pane-catalog__copy">
                  <span className="right-pane-catalog__name">{item.title}</span>
                  <span className="right-pane-catalog__description">
                    {item.description}
                  </span>
                  <span className="right-pane-catalog__meta">
                    <span
                      className="right-pane-catalog__status"
                      data-tone={item.tone}
                    >
                      {item.status}
                    </span>
                    <span>·</span>
                    <span>{item.meta}</span>
                  </span>
                </span>
                <ChevronRight
                  size={14}
                  className="right-pane-catalog__chevron"
                  aria-hidden="true"
                />
              </button>
            ))
          ) : (
            <div className="right-pane-catalog__empty">
              {props.icon}
              <strong>
                {props.items.length
                  ? "No matches"
                  : `No ${props.label.toLowerCase()} available`}
              </strong>
              <span>
                {props.items.length
                  ? "Try another search or filter."
                  : `Refresh to check for ${props.label.toLowerCase()} in this workspace.`}
              </span>
              {props.items.length ? (
                <button
                  type="button"
                  className="right-pane-catalog__button"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                    search.current?.focus();
                  }}
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
