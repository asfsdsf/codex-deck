import {
  ClipboardCheck,
  FileCode2,
  CheckCircle2,
  CircleAlert,
  Code2,
} from "lucide-react";
import type { ReviewReport } from "../review-report";
import { reviewLocationHref } from "../review-report";
import { getPathTail } from "../path-utils";
import { MarkdownRenderer } from "./markdown-renderer";

const priorityStyles = [
  "border-rose-500/30 bg-rose-500/10 text-rose-200",
  "border-orange-500/30 bg-orange-500/10 text-orange-200",
  "border-amber-500/30 bg-amber-500/10 text-amber-200",
  "border-cyan-500/30 bg-cyan-500/10 text-cyan-200",
];
const priorityLabels = ["Critical", "High", "Medium", "Low"];

export function ReviewReportRenderer(props: {
  report: ReviewReport;
  raw: string;
  forceExpanded?: boolean;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const { report, onFilePathLinkClick } = props;
  const count = report.findings.length;
  return (
    <section aria-label="Code review" className="min-w-0 space-y-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 pr-16">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <ClipboardCheck
            size={16}
            className="shrink-0 text-cyan-300"
            aria-hidden="true"
          />
          Code review
        </span>
        {report.verdict && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${report.verdict === "correct" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200" : "border-amber-500/25 bg-amber-500/10 text-amber-200"}`}
          >
            {report.verdict === "correct" ? (
              <CheckCircle2 size={12} aria-hidden="true" />
            ) : (
              <CircleAlert size={12} aria-hidden="true" />
            )}
            {report.verdict === "correct" ? "Looks good" : "Changes requested"}
          </span>
        )}
        {(count > 0 || report.format === "json") && (
          <span className="text-xs text-zinc-400">
            {count === 0
              ? "No findings"
              : `${count} ${count === 1 ? "finding" : "findings"}`}
          </span>
        )}
      </header>
      {report.summary && (
        <div className="text-zinc-300">
          <MarkdownRenderer
            content={report.summary}
            onFilePathLinkClick={onFilePathLinkClick}
          />
        </div>
      )}
      {count > 0 && (
        <ol aria-label="Review findings" className="space-y-2.5">
          {report.findings.map((finding, index) => (
            <li key={index}>
              <article
                aria-label={`Finding ${index + 1}: ${finding.title}`}
                className="min-w-0 rounded-xl border border-zinc-700/60 bg-zinc-950/45 p-3 sm:p-3.5"
              >
                <div className="flex items-start gap-2.5">
                  {finding.priority !== null && (
                    <span
                      title={priorityLabels[finding.priority]}
                      className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${priorityStyles[finding.priority]}`}
                    >
                      P{finding.priority}
                    </span>
                  )}
                  <h3 className="min-w-0 break-words text-[13px] font-semibold leading-relaxed text-zinc-100">
                    {finding.title}
                  </h3>
                </div>
                {finding.location && (
                  <a
                    href={reviewLocationHref(finding.location)}
                    title={`${finding.location.path}:${finding.location.startLine}${finding.location.endLine === finding.location.startLine ? "" : `-${finding.location.endLine}`}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => {
                      if (
                        onFilePathLinkClick?.(
                          reviewLocationHref(finding.location!),
                        )
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                    className="mt-2 inline-flex max-w-full items-start gap-1.5 rounded text-xs text-cyan-300 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                  >
                    <FileCode2
                      size={13}
                      className="mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 break-all font-mono text-[11px]">
                      {getPathTail(finding.location.path, 3)}
                      <span className="text-zinc-400">
                        :{finding.location.startLine}
                        {finding.location.endLine !== finding.location.startLine
                          ? `–${finding.location.endLine}`
                          : ""}
                      </span>
                    </span>
                  </a>
                )}
                {finding.body && (
                  <div className="mt-1.5">
                    <MarkdownRenderer
                      content={finding.body}
                      onFilePathLinkClick={onFilePathLinkClick}
                    />
                  </div>
                )}
                {finding.confidence !== null && (
                  <p className="mt-2 text-[10px] text-zinc-400">
                    {Math.round(finding.confidence * 100)}% confidence
                  </p>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
      <footer className="border-t border-zinc-700/50 pt-2.5 text-[11px] text-zinc-400">
        {report.confidence !== null && (
          <p className="mb-2">
            Overall confidence: {Math.round(report.confidence * 100)}%
          </p>
        )}
        <details open={props.forceExpanded || undefined}>
          <summary className="w-fit cursor-pointer rounded hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">
            <Code2
              size={12}
              className="mr-1.5 inline-block align-middle"
              aria-hidden="true"
            />
            Original review
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-300">
            {props.raw}
          </pre>
        </details>
      </footer>
    </section>
  );
}
