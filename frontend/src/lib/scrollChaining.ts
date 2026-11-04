/**
 * ─── A list that scrolls inside the page hands over to the page at its ends ──────────────────
 *
 * Giving an element `overflow-y: auto` makes it a scroller of its own. A mouse wheel or trackpad over
 * it scrolls IT first — and then, at its first or last row, the browser is supposed to carry on into
 * the scroller around it. For a wheel it does not do so promptly. It "latches" the gesture to the
 * element it started on, and keeps sending every wheel tick of that gesture to it, even though it can
 * move no further: the page only starts to move after the wheel has been still for a moment. In use,
 * that is a list that holds the cursor at its edge until the pointer is moved off it — the dead stop
 * this removes.
 *
 * (`overscroll-behavior` is not the cause once the list stops setting `contain`, and cannot fix it:
 * it decides WHETHER scrolling chains, not WHEN.)
 *
 * So, for the wheel only, a scroller given this ref watches for a tick that its own scroll position
 * cannot take — it is already at the end the wheel is pushing towards — and passes exactly that tick
 * to the nearest scrolling ancestor itself. Everything else is left alone: while the list has room,
 * the browser scrolls it as it always did; a horizontal or pinch-zoom wheel is not touched; touch
 * scrolling is not wheel and chains natively. The page and the list move at the same speed, because
 * the page is given the wheel's own distance.
 *
 * Use: `<div className="overflow-y-auto" ref={scrollChaining}>`.
 */

/** Pixels the browser moves for one wheel "line", for mice that report lines rather than pixels. */
const LINE_HEIGHT_PX = 16;

export interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Whether a wheel tick of `deltaY` is one this scroller cannot take: it scrolls vertically at all,
 * and is already at the end the tick pushes towards. A scroller with nothing to scroll is not
 * "at an end" — the browser already passes its wheel up the page.
 */
export function wheelIsPastEnd(position: ScrollPosition, deltaY: number): boolean {
  const { scrollTop, clientHeight, scrollHeight } = position;
  if (deltaY === 0 || scrollHeight <= clientHeight + 1) return false;
  const atTop = scrollTop <= 0;
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
  return deltaY > 0 ? atBottom : atTop;
}

/** The distance of a wheel tick in pixels, whatever unit the device reported it in. */
function wheelDistance(event: WheelEvent, outer: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * LINE_HEIGHT_PX;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * outer.clientHeight;
  return event.deltaY;
}

/** The nearest ancestor that can scroll vertically — the page's own scroll container. */
function scrollingAncestor(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight + 1) return parent;
  }
  return null;
}

/** A ref callback: attaches the hand-over to the scroller and removes it when the scroller goes. */
export function scrollChaining(node: HTMLElement | null): (() => void) | undefined {
  if (!node) return undefined;

  const onWheel = (event: WheelEvent) => {
    // A pinch-zoom (ctrl) or a mostly-sideways wheel is not a request to scroll the page.
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (!wheelIsPastEnd(node, event.deltaY)) return;

    const outer = scrollingAncestor(node);
    if (!outer) return;
    // Stops the browser also latching this tick to the list, which would move the page twice.
    event.preventDefault();
    outer.scrollBy({ top: wheelDistance(event, outer), behavior: 'auto' });
  };

  // Not passive: preventDefault is what keeps the tick from being handled twice.
  node.addEventListener('wheel', onWheel, { passive: false });
  return () => node.removeEventListener('wheel', onWheel);
}
