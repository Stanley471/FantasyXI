/**
 * CSS FLIP (First, Last, Invert, Play) re-ordering animation (#462).
 *
 * The pure delta math lives in `./dragDropFormation`; this hook wires it to
 * the DOM: it records each card's position before a reorder, then after the
 * render paints every moved card back at its old spot (Invert) and lets a
 * CSS transform transition carry it to its new spot (Play). Cards are found
 * by their `data-flip-id` attribute inside the container ref.
 *
 * No-ops when there is no layout (server render, jsdom) or when the user
 * prefers reduced motion.
 */

import { useLayoutEffect, useRef, type RefObject } from "react";
import {
  computeFlipDeltas,
  flipTransform,
  FLIP_DURATION_MS,
  type Point,
} from "./dragDropFormation";

function readPositions(container: HTMLElement): Map<number, Point> {
  const positions = new Map<number, Point>();
  container.querySelectorAll<HTMLElement>("[data-flip-id]").forEach((el) => {
    const id = Number(el.dataset.flipId);
    if (Number.isNaN(id)) return;
    const rect = el.getBoundingClientRect();
    positions.set(id, { x: rect.x, y: rect.y });
  });
  return positions;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Attach the returned ref to the pitch or bench container. Whenever `items`
 * (identified by `playerId`) change order, moved cards animate from their
 * previous spot to their new one.
 */
export function useFlipAnimation(
  items: ReadonlyArray<{ playerId: number }>
): RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const prevPositions = useRef<Map<number, Point>>(new Map());
  const timers = useRef<number[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const current = readPositions(container);
    const previous = prevPositions.current;
    prevPositions.current = current;

    if (prefersReducedMotion()) return;
    const deltas = computeFlipDeltas(previous, current);
    if (deltas.size === 0) return;

    const animated: HTMLElement[] = [];
    deltas.forEach((delta, id) => {
      const el = container.querySelector<HTMLElement>(`[data-flip-id="${id}"]`);
      const transform = flipTransform(delta);
      if (!el || !transform) return;
      // Invert: paint the card where it used to be, with no transition.
      el.style.transition = "none";
      el.style.transform = transform;
      animated.push(el);
    });
    if (animated.length === 0) return;

    // Play: on the next frame, transition the transform back to its natural spot.
    const frame = requestAnimationFrame(() => {
      for (const el of animated) {
        // Force a reflow so the inverted transform is painted before we animate.
        void el.offsetWidth;
        el.style.transition = `transform ${FLIP_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        el.style.transform = "";
      }
      timers.current.push(
        window.setTimeout(() => {
          for (const el of animated) el.style.transition = "";
        }, FLIP_DURATION_MS + 50)
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [items]);

  useLayoutEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    []
  );

  return containerRef;
}
