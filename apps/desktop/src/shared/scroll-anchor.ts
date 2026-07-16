export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** True while the viewport remains close enough to follow streaming output. */
export function isScrollAnchored(metrics: ScrollMetrics, threshold = 72): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distance <= threshold;
}
