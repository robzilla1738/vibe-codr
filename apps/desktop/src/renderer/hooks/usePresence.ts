import { useLayoutEffect, useRef, useState } from "react";

/**
 * Keeps a surface mounted just long enough for its tokenized exit animation.
 * The logical `open` state still changes immediately, so focus/ARIA ownership
 * never lingers while the visual surface eases out.
 */
export function usePresence(open: boolean, exitMs = 140): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }

    if (!mounted) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reducedMotion) {
      setClosing(false);
      setMounted(false);
      return;
    }

    setClosing(true);
    const timeout = window.setTimeout(() => {
      setClosing(false);
      setMounted(false);
    }, exitMs);
    return () => window.clearTimeout(timeout);
  }, [exitMs, mounted, open]);

  return {
    mounted: open || mounted,
    closing: !open && mounted && closing,
  };
}

/** Retains the last live payload while its surface is leaving. */
export function useRetainedValue<T>(value: T | null): T | null {
  const retained = useRef<T | null>(value);
  if (value !== null) retained.current = value;
  return value ?? retained.current;
}
