import Link from "next/link";
import { marked, type Token } from "marked";
import type { ReactNode } from "react";
import {
  canonicalHeadingAnchor,
  canonicalHeadingNumber,
  safeMarkdownHref,
  tabForCanonicalHeading,
  tabPath,
} from "@/lib/research/report-ui";

type ReportToken = Token & Record<string, unknown>;

export function MarkdownReport({
  markdown,
  assetId,
  runId,
}: {
  markdown: string;
  assetId: string;
  runId?: string | null;
}) {
  const tokens = marked.lexer(markdown);
  return (
    <article className="report-markdown rounded-xl border border-slate-200 bg-white px-5 py-6 shadow-sm sm:px-8 lg:px-12 lg:py-10">
      {tokens.map((token, index) => renderBlock(token as ReportToken, `${index}`, assetId, runId))}
    </article>
  );
}

function renderBlock(token: ReportToken, key: string, assetId: string, runId?: string | null): ReactNode {
  const value = token as Record<string, any>;
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const number = canonicalHeadingNumber(String(value.text ?? ""));
      const tab = number ? tabForCanonicalHeading(number) : null;
      const depth = Number(value.depth);
      const Heading = depth === 1 ? "h1" : depth >= 3 ? "h3" : "h2";
      return (
        <div key={key} className="mt-9 first:mt-0 scroll-mt-24" id={number ? canonicalHeadingAnchor(number) : undefined}>
          {number && tab && tab !== "general" && (
            <Link
              href={tabPath(assetId, tab, runId)}
              className="mb-2 inline-flex rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 hover:border-slate-400 hover:text-slate-950"
            >
              Open {tabLabel(tab)}
            </Link>
          )}
          <Heading className={`border-b border-slate-200 pb-2 font-bold tracking-tight text-slate-950 ${depth === 1 ? "text-2xl sm:text-3xl" : depth >= 3 ? "text-base sm:text-lg" : "text-xl sm:text-2xl"}`}>
            {renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), `${key}-heading`)}
          </Heading>
        </div>
      );
    }
    case "paragraph":
      return <p key={key} className="mt-4 max-w-4xl text-[15px] leading-7 text-slate-700">{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), key)}</p>;
    case "text":
      return <span key={key}>{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? value.raw ?? ""), key)}</span>;
    case "blockquote":
      return <blockquote key={key} className="mt-4 border-l-2 border-slate-300 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">{(value.tokens as ReportToken[] | undefined)?.map((item, index) => renderBlock(item, `${key}-${index}`, assetId, runId))}</blockquote>;
    case "list": {
      const ordered = Boolean(value.ordered);
      const Tag = ordered ? "ol" : "ul";
      return <Tag key={key} className={`mt-4 space-y-2 pl-6 text-[15px] leading-7 text-slate-700 ${ordered ? "list-decimal" : "list-disc"}`}>{(value.items as ReportToken[] | undefined)?.map((item, index) => renderListItem(item, `${key}-${index}`, assetId, runId))}</Tag>;
    }
    case "code":
      return <pre key={key} className="mt-4 overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100"><code>{String(value.text ?? "")}</code></pre>;
    case "table":
      return renderTable(value, key, assetId, runId);
    case "hr":
      return <hr key={key} className="my-8 border-slate-200" />;
    case "br":
      return <br key={key} />;
    case "html":
      // Raw HTML is intentionally omitted. This keeps the Markdown export readable without an HTML sanitizer dependency.
      return null;
    default:
      return value.raw || value.text ? <span key={key}>{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? value.raw ?? ""), key)}</span> : null;
  }
}

function renderListItem(item: ReportToken, key: string, assetId: string, runId?: string | null) {
  const value = item as Record<string, any>;
  const tokens = Array.isArray(value.tokens) ? value.tokens as ReportToken[] : [];
  return <li key={key}>{tokens.length ? tokens.map((token, index) => renderBlock(token, `${key}-${index}`, assetId, runId)) : String(value.text ?? value.raw ?? "")}</li>;
}

function renderTable(value: Record<string, any>, key: string, assetId: string, runId?: string | null) {
  const header = Array.isArray(value.header) ? value.header as ReportToken[] : [];
  const rows = Array.isArray(value.rows) ? value.rows as ReportToken[][] : [];
  return (
    <div key={key} className="mt-5 overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50"><tr>{header.map((cell, index) => <th key={index} scope="col" className="whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{renderInline(cellTokens(cell), cellText(cell), `${key}-h-${index}`)}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 bg-white">{rows.map((row, rowIndex) => <tr key={rowIndex} className="align-top">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 leading-6 text-slate-700">{renderInline(cellTokens(cell), cellText(cell), `${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function renderInline(tokens: ReportToken[] | undefined, fallback: string, keyPrefix: string): ReactNode {
  if (!tokens?.length) return fallback;
  return tokens.map((token, index) => {
    const value = token as Record<string, any>;
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "strong":
        return <strong key={key} className="font-semibold text-slate-950">{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), key)}</em>;
      case "del":
        return <del key={key}>{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), key)}</del>;
      case "codespan":
        return <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800">{String(value.text ?? value.raw ?? "")}</code>;
      case "link": {
        const href = safeMarkdownHref(value.href);
        if (!href) return <span key={key}>{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), key)}</span>;
        if (href.startsWith("/")) return <Link key={key} href={href} className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-950">{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), key)}</Link>;
        if (href.startsWith("#") || href.startsWith("?")) return <a key={key} href={href} className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-950">{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), key)}</a>;
        return <a key={key} href={href} target="_blank" rel="noreferrer" className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-950">{renderInline(value.tokens as ReportToken[] | undefined, String(value.text ?? ""), key)}</a>;
      }
      case "image":
        return <span key={key} className="text-slate-500">{String(value.text ?? value.title ?? "Image")}</span>;
      case "br":
        return <br key={key} />;
      case "html":
        return null;
      default:
        return <span key={key}>{String(value.text ?? value.raw ?? "")}</span>;
    }
  });
}

function cellTokens(cell: ReportToken): ReportToken[] | undefined {
  const value = cell as Record<string, any>;
  return value.tokens as ReportToken[] | undefined;
}

function cellText(cell: ReportToken) {
  const value = cell as Record<string, any>;
  return String(value.text ?? value.raw ?? "");
}

function tabLabel(slug: string) {
  return slug === "financials" ? "financials & KPIs" : slug;
}
