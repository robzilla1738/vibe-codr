import { useLayoutEffect, useState, type RefObject } from "react";

/** Viewport box for an anchor element — used to position fixed portals. */
export type AnchorBox = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/**
 * Tracks an element's getBoundingClientRect while `active`, updating on
 * resize and scroll (capture) so fixed menus stay glued to the composer.
 */
export function useFloatingAnchor(
  anchorRef: RefObject<HTMLElement | null>,
  active: boolean,
): AnchorBox | null {
  const [box, setBox] = useState<AnchorBox | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      setBox(null);
      return;
    }

    const el = anchorRef.current;
    if (!el) return;

    const update = () => {
      const r = el.getBoundingClientRect();
      setBox({
        top: r.top,
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active, anchorRef]);

  return box;
}
