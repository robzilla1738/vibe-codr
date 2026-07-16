import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "./icons";

async function writeClipboard(text: string): Promise<void> {
  if (typeof window !== "undefined" && window.vibe?.writeClipboardText) {
    const result = await window.vibe.writeClipboardText(text);
    if (!result.ok) throw new Error(result.error);
    return;
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard API not available");
}

/** Quiet copy affordance for code fences / tool output. */
export function CopyButton({
  text,
  className,
  label = "Copy",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  // "copied" | "failed" | null — surfaced so clipboard failures are not silent (I18).
  const [state, setState] = useState<"copied" | "failed" | null>(null);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const reset = (delay: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState(null), delay);
  };

  const onCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!text || state) return;
    try {
      await writeClipboard(text);
      setState("copied");
      reset(1600);
    } catch {
      // Native select-to-copy still works if the Clipboard API is blocked; show
      // a brief error state so the user knows the button itself did not copy.
      setState("failed");
      reset(2200);
    }
  };

  const ariaLabel = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  const cls = `copy-btn${state === "copied" ? " is-copied" : ""}${state === "failed" ? " is-failed" : ""}${className ? ` ${className}` : ""}`;

  return (
    <button
      type="button"
      className={cls}
      onClick={onCopy}
      onMouseDown={(event) => event.stopPropagation()}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {state === "copied" ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}
