/**
 * Keyboard focus trap for modal-like overlays (drawers, dialogs).
 *
 * Framework-agnostic so it can be unit tested without rendering a full
 * React tree (issue #489).
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Attribute/inline-style based visibility check (rather than `offsetParent`,
 * which needs a real layout engine and is always null under jsdom).
 */
function isHidden(element: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  while (node) {
    if (node.hasAttribute("hidden")) return true;
    if (node.style.display === "none" || node.style.visibility === "hidden") return true;
    node = node.parentElement;
  }
  return false;
}

/** Focusable, visible descendants of `container`, in DOM (tab) order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !isHidden(el)
  );
}

/**
 * Builds a `keydown` handler that:
 * - Cycles Tab/Shift+Tab only through `container`'s focusable elements.
 * - Calls `onEscape` when Escape is pressed.
 *
 * Attach the returned handler to `document` while the overlay is open and
 * remove it when it closes.
 */
export function createFocusTrapHandler(
  container: HTMLElement,
  onEscape: () => void
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") return;

    const elements = getFocusableElements(container);
    if (elements.length === 0) {
      event.preventDefault();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    const active = container.ownerDocument.activeElement;

    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };
}
