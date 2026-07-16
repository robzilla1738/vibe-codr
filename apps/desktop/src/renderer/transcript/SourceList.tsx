import type { SourceItem } from "../../shared/sources";
import { ExternalLink } from "../primitives";

export function SourceList({ sources }: { sources: SourceItem[] }) {
  if (!sources.length) {
    return (
      <div className="source-empty" role="status">
        No sources returned.
      </div>
    );
  }
  return (
    <ol className="source-list" aria-label="Sources">
      {sources.map((source, index) => (
        <li key={`${source.url ?? source.title}-${index}`} className="source-card">
          <span className="source-index" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div className="source-card-body">
            <div className="source-card-copy">
              {source.url ? (
                <ExternalLink href={source.url} className="source-title">
                  {source.title}
                </ExternalLink>
              ) : (
                <span className="source-title">{source.title}</span>
              )}
              {source.domain ? <span className="source-domain">{source.domain}</span> : null}
            </div>
            {source.snippet ? <p className="source-snippet">{source.snippet}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
