"use client";
/**
 * The sliding selector for pill bars (main nav, Segmented, financials toggles). One white pill sits under the selected
 * item and glides to a new one when the selection changes; a faint ghost pill follows the pointer across the other
 * items; pressing and dragging moves the pill with the pointer and releasing selects the item under it (the iOS
 * segmented-control feel). The bar keeps its own markup and semantics: items stay real buttons or links, and a drag
 * ends in an ordinary `click()` on the chosen item, so keyboard use and aria state are unchanged.
 *
 * Usage: pass the hook's callback ref to the bar (it marks the bar `data-slide`) and render `<SlideLayers />` as its first child. Styles live in
 * src/app/globals.css under "Sliding selector"; without JS the bar's own selected style shows instead.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

const ACTIVE = ':is([aria-pressed="true"], [aria-current]:not([aria-current="false"]), [aria-selected="true"])';
const DRAG_THRESHOLD_PX = 4;
/** How long a clicked item holds the pill while the selection catches up (a route change for nav links). */
const PENDING_MS = 1500;

type Options = {
  /** Selector for the bar's items, matched against its direct children. Default: buttons and links. */
  item?: string;
  /** Allow touch drags. Off for bars that scroll sideways on phones (the main nav), so a swipe still scrolls. */
  dragTouch?: boolean;
};

/** Returns a callback ref for the bar; the bar can mount later (the nav is absent on /login) and still be wired. */
export function useSlidingIndicator<T extends HTMLElement>({ item = ":scope > :is(button, a)", dragTouch = true }: Options = {}): (el: T | null) => void {
  const options = useRef({ item, dragTouch });
  useEffect(() => { options.current = { item, dragTouch }; });
  const [bar, setBar] = useState<T | null>(null);

  useEffect(() => {
    if (!bar) return;
    const items = () => Array.from(bar.querySelectorAll<HTMLElement>(options.current.item)).filter((el) => !(el as HTMLButtonElement).disabled);
    const itemOf = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest<HTMLElement>(options.current.item.replace(":scope > ", "")) : null;
      return el && bar.contains(el) && items().includes(el) ? el : null;
    };
    const set = (layer: "pill" | "ghost", x: number, w: number) => {
      bar.style.setProperty(`--${layer}-x`, `${x}px`);
      bar.style.setProperty(`--${layer}-w`, `${w}px`);
    };
    const flag = (name: string, on: boolean) => { if (on) bar.setAttribute(`data-slide-${name}`, ""); else bar.removeAttribute(`data-slide-${name}`); };

    let pending: { el: HTMLElement; until: number } | null = null;
    let drag: { id: number; startX: number; moved: boolean; over: HTMLElement | null } | null = null;

    /** Put the pill on the selected item (or the one just clicked, until the selection catches up). */
    const rest = () => {
      if (drag?.moved) return;
      const active = bar.querySelector<HTMLElement>(`${options.current.item}${ACTIVE}`);
      if (pending && (pending.el === active || Date.now() > pending.until || !bar.contains(pending.el))) pending = null;
      const target = pending?.el ?? active;
      flag("has", !!target);
      if (target) set("pill", target.offsetLeft, target.offsetWidth);
    };

    bar.setAttribute("data-slide", "");
    rest();
    // Turn transitions on only after the first placement, so the pill doesn't fly in from the left on load.
    const ready = requestAnimationFrame(() => flag("ready", true));

    const resize = new ResizeObserver(rest);
    resize.observe(bar);
    items().forEach((el) => { resize.observe(el); if (el instanceof HTMLAnchorElement) el.draggable = false; });
    const mutations = new MutationObserver(() => { items().forEach((el) => resize.observe(el)); rest(); });
    mutations.observe(bar, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed", "aria-current", "aria-selected", "disabled"] });

    const hover = (el: HTMLElement | null) => {
      const show = !!el && !el.matches(ACTIVE) && el !== pending?.el;
      if (show && el) set("ghost", el.offsetLeft, el.offsetWidth);
      flag("hover", show);
    };
    const nearest = (clientX: number) => {
      const list = items();
      let best: HTMLElement | null = null, bestD = Infinity;
      for (const el of list) {
        const r = el.getBoundingClientRect();
        const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
        if (d < bestD) { best = el; bestD = d; }
      }
      return { best, list };
    };
    const endDrag = () => {
      if (drag?.moved) { try { bar.releasePointerCapture(drag.id); } catch { /* already released */ } }
      drag = null;
      flag("drag", false);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || (e.pointerType === "touch" && !options.current.dragTouch)) return;
      if (!itemOf(e.target)) return;
      drag = { id: e.pointerId, startX: e.clientX, moved: false, over: null };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) { if (e.pointerType !== "touch") hover(itemOf(e.target)); return; }
      if (e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        // Capture only once it is a drag: a capture changes the click target, which would swallow ordinary clicks.
        try { bar.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
        flag("drag", true);
        flag("hover", false);
      }
      const { best, list } = nearest(e.clientX);
      if (!best || !list.length) return;
      // The pill's centre follows the pointer, sized like the item under it, kept inside the bar.
      const barLeft = bar.getBoundingClientRect().left - bar.scrollLeft;
      const first = list[0], last = list[list.length - 1];
      const w = best.offsetWidth;
      const x = Math.min(Math.max(e.clientX - barLeft - w / 2, first.offsetLeft), last.offsetLeft + last.offsetWidth - w);
      set("pill", x, w);
      drag.over = best;
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { moved, over } = drag;
      endDrag();
      if (!moved) return; // a plain click: the browser delivers it to the item as usual
      if (over && !over.matches(ACTIVE)) over.click();
      else rest();
    };
    const onCancel = () => { endDrag(); rest(); };
    const onLeave = () => { if (!drag) flag("hover", false); };
    const onClick = (e: MouseEvent) => {
      const el = itemOf(e.target);
      if (!el || el.matches(ACTIVE)) return;
      // Move now; links keep the pill here until the new route marks them current.
      pending = { el, until: Date.now() + PENDING_MS };
      flag("hover", false);
      set("pill", el.offsetLeft, el.offsetWidth);
      setTimeout(rest, PENDING_MS + 50);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && drag?.moved) { endDrag(); rest(); } };
    const onDragStart = (e: DragEvent) => e.preventDefault();

    bar.addEventListener("pointerdown", onDown);
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onCancel);
    bar.addEventListener("pointerleave", onLeave);
    bar.addEventListener("click", onClick);
    bar.addEventListener("dragstart", onDragStart);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(ready);
      ["data-slide", "data-slide-ready", "data-slide-has", "data-slide-hover", "data-slide-drag"].forEach((a) => bar.removeAttribute(a));
      resize.disconnect();
      mutations.disconnect();
      bar.removeEventListener("pointerdown", onDown);
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onCancel);
      bar.removeEventListener("pointerleave", onLeave);
      bar.removeEventListener("click", onClick);
      bar.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("keydown", onKey);
    };
  }, [bar]);
  return setBar;
}

/** The pill and the hover ghost. Render as the bar's first child; both are decorative. */
export function SlideLayers() {
  return <>
    <span data-slide-ghost="" aria-hidden="true" />
    <span data-slide-pill="" aria-hidden="true" />
  </>;
}

/** A `role="group"` span with the sliding pill wired in, for bars that are plain markup (the financials toggles). */
export function SlideGroup({ className, label, children }: { className?: string; label: string; children: ReactNode }) {
  const bar = useSlidingIndicator<HTMLSpanElement>();
  return <span ref={bar} className={className} role="group" aria-label={label}><SlideLayers />{children}</span>;
}
