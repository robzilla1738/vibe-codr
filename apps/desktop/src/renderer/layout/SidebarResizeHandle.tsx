import { useEffect, useRef, useState } from "react";

type ResizeSide = "start" | "end";

const STEP = 16;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredWidth(key: string, min: number, max: number): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null;
    const stored = Number(raw);
    return Number.isFinite(stored) ? clamp(stored, min, max) : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(key: string, width: number) {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // Persisting layout preference is best-effort.
  }
}

export function SidebarResizeHandle({
  side,
  cssVar,
  defaultWidth,
  min,
  max,
  storageKey,
  label,
}: {
  side: ResizeSide;
  cssVar: "--project-rail-w" | "--activity-rail-w" | "--changes-rail-w" | "--browser-rail-w" | "--terminal-rail-w";
  defaultWidth: number;
  min: number;
  max: number;
  storageKey: string;
  label: string;
}) {
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(defaultWidth);
  const draggingRef = useRef(false);

  const applyWidth = (next: number, persist = false) => {
    const value = clamp(next, min, max);
    widthRef.current = value;
    setWidth(value);
    document.documentElement.style.setProperty(cssVar, `${value}px`);
    if (persist) writeStoredWidth(storageKey, value);
  };

  useEffect(() => {
    const stored = readStoredWidth(storageKey, min, max);
    applyWidth(stored ?? defaultWidth);
    // Restore a saved width only after the rail has mounted. The default is
    // explicit so a width transition cannot be mistaken for the user's size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cssVar, defaultWidth, max, min, storageKey]);

  useEffect(() => () => {
    document.body.classList.remove("is-resizing-sidebar");
  }, []);

  const stopDragging = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.classList.remove("is-resizing-sidebar");
    writeStoredWidth(storageKey, widthRef.current);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    draggingRef.current = true;
    const startX = event.clientX;
    const startWidth = widthRef.current;
    document.body.classList.add("is-resizing-sidebar");

    const onPointerMove = (move: PointerEvent) => {
      const delta = move.clientX - startX;
      applyWidth(startWidth + (side === "start" ? delta : -delta));
    };
    const onPointerUp = () => {
      stopDragging();
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "ArrowRight") next = widthRef.current + (side === "start" ? STEP : -STEP);
    else if (event.key === "ArrowLeft") next = widthRef.current + (side === "start" ? -STEP : STEP);
    if (next == null) return;
    event.preventDefault();
    applyWidth(next, true);
  };

  return (
    <div
      className={`sidebar-resize-handle is-${side}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
