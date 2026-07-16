import { type ComponentPropsWithoutRef, isValidElement, memo, type ReactNode } from "react";
import {
  CodeBlock,
  type Components,
  type ExtraProps,
  Streamdown,
  type ThemeInput,
} from "streamdown";
import { richKind } from "../../shared/rich-blocks";
import { shikiThemeFor } from "../../shared/shiki-theme";
import { parseSources } from "../../shared/sources";
import { getTheme } from "../../shared/themes";
import { CopyButton } from "../CopyButton";
import { ExternalLink } from "../primitives";
import { RichBlockView } from "./RichBlockView";
import { SourceList } from "./SourceList";

/** Resolve the current palette from `data-theme` (set by applyPalette). */
function currentPalette() {
  const themeName = document.documentElement.dataset.theme;
  return getTheme(themeName);
}

function fenceBody(children: ReactNode): string {
  if (typeof children === "string") return children.replace(/\n$/, "");
  if (isValidElement(children)) {
    const nested = (children.props as { children?: ReactNode }).children;
    if (typeof nested === "string") return nested.replace(/\n$/, "");
  }
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === "string" ? child : "")).join("").replace(/\n$/, "");
  }
  return "";
}

function fenceLang(className?: string): string {
  const match = className?.match(/language-(\S+)/);
  return match?.[1] ?? "";
}

type CodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;

/**
 * Static (finalized) fences: Shiki CodeBlock + line numbers + copy.
 * The streaming path bypasses Streamdown entirely.
 */
function Code({ className, children, ...props }: CodeProps) {
  const isBlock = "data-block" in props;
  if (!isBlock) {
    return (
      <code className={className} data-streamdown="inline-code">
        {children}
      </code>
    );
  }

  const lang = fenceLang(className);
  const body = fenceBody(children);
  const kind = richKind(lang);
  const incomplete = Boolean((props as { "data-incomplete"?: unknown })["data-incomplete"]);

  if (kind === "sources") {
    return <SourceList sources={parseSources(body)} />;
  }
  if (kind) {
    return <RichBlockView lang={lang} body={body} palette={currentPalette()} />;
  }

  return (
    <CodeBlock
      className="md-code-block"
      code={body}
      language={lang || "text"}
      lineNumbers
      isIncomplete={incomplete}
    >
      {!incomplete ? <CopyButton text={body} label="Copy code" /> : null}
    </CodeBlock>
  );
}

const staticComponents: Components = {
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  code: Code,
};

/**
 * Streaming path: lightweight pre-wrap text (no Streamdown reparse every 24ms).
 * Incomplete fences stay readable; full GFM/Shiki runs only when finalized.
 */
function StreamingPlain({ text }: { text: string }) {
  return (
    <div className="md-streaming-plain" data-streaming="true">
      <pre className="md-streaming-pre">{text}</pre>
    </div>
  );
}

export const MarkdownView = memo(function MarkdownView({
  children,
  streaming = false,
  theme,
}: {
  children: string;
  streaming?: boolean;
  /** App theme name — drives Shiki highlighting. Falls back to `data-theme`. */
  theme?: string;
}) {
  const themeName = theme ?? document.documentElement.dataset.theme;
  const shikiTheme = shikiThemeFor(themeName) as [ThemeInput, ThemeInput];

  // While streaming: plain text only — Streamdown+incomplete parse on every
  // flush was the remaining main-thread hotspot after Shiki was deferred.
  if (streaming) {
    return <StreamingPlain text={children} />;
  }

  return (
    <Streamdown
      mode="static"
      isAnimating={false}
      parseIncompleteMarkdown
      controls={{ code: false, table: { copy: true, download: false }, mermaid: false }}
      lineNumbers
      shikiTheme={shikiTheme}
      animated={false}
      components={staticComponents}
    >
      {children}
    </Streamdown>
  );
});
