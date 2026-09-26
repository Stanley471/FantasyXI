import { useState, useEffect, useRef, RefObject } from "react";

export interface VirtualItem<T> {
  index: number;
  item: T;
  offsetTop: number;
}

export interface UseVirtualListResult<T> {
  virtualItems: VirtualItem<T>[];
  totalHeight: number;
  startIndex: number;
  endIndex: number;
}

/**
 * useVirtualList — custom hook for high-performance virtualized rendering.
 *
 * Only the items in the visible viewport window (+ overscan buffer) are
 * returned, keeping the DOM lean regardless of how many items exist in the
 * full list.
 *
 * @param items         The full sorted/filtered array of items to virtualise.
 * @param itemHeight    Fixed pixel height of each row/card (must be uniform).
 * @param containerRef  Ref attached to the scrollable container element.
 * @param overscan      Number of extra items to render above and below the
 *                      visible window (default: 5). Larger values reduce blank
 *                      flashes during fast scrolling at the cost of extra DOM.
 */
export function useVirtualList<T>(
  items: T[],
  itemHeight: number,
  containerRef: RefObject<HTMLElement | null>,
  overscan: number = 5
): UseVirtualListResult<T> {
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Capture initial dimensions
    setContainerHeight(el.clientHeight);
    setScrollTop(el.scrollTop);

    // Passive scroll listener — never blocks the main thread
    const handleScroll = () => {
      setScrollTop(el.scrollTop);
    };

    // ResizeObserver keeps containerHeight in sync (e.g. window resize, modal open)
    const resizeObserver = new ResizeObserver(() => {
      setContainerHeight(el.clientHeight);
    });

    el.addEventListener("scroll", handleScroll, { passive: true });
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
    };
  }, [containerRef]);

  const totalHeight = items.length * itemHeight;

  if (items.length === 0 || containerHeight === 0) {
    return { virtualItems: [], totalHeight, startIndex: 0, endIndex: -1 };
  }

  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(
    items.length - 1,
    Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
  );

  const virtualItems: VirtualItem<T>[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
    virtualItems.push({
      index: i,
      item: items[i],
      offsetTop: i * itemHeight,
    });
  }

  return { virtualItems, totalHeight, startIndex, endIndex };
}
