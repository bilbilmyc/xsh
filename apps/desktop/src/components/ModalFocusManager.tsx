import { useEffect } from "react";

const focusableSelector = 'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]';

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) =>
    element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]")
    && element.getClientRects().length > 0,
  );
}

// All application dialogs, including nested confirmations rendered in a portal,
// share one focus boundary. Terminal panes stay mounted behind that boundary.
export function ModalFocusManager() {
  useEffect(() => {
    const openers = new Map<HTMLElement, HTMLElement | null>();
    const lastFocus = new Map<HTMLElement, HTMLElement>();
    const originalInert = new Map<HTMLElement, boolean>();
    let previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let active: HTMLElement | null = null;
    let titleId = 0;
    let synchronizing = false;

    const restoreBackground = () => {
      for (const [element, inert] of originalInert) element.inert = inert;
      originalInert.clear();
    };
    const focusInside = (backdrop: HTMLElement) => {
      const saved = lastFocus.get(backdrop);
      const target = saved?.isConnected && !saved.matches(":disabled") && saved.getClientRects().length
        ? saved : focusableElements(backdrop)[0] ?? backdrop;
      target.focus({ preventScroll: true });
    };
    const sync = () => {
      if (synchronizing) return;
      synchronizing = true;
      try {
        const backdrops = [...document.querySelectorAll<HTMLElement>(".modal-backdrop")]
          .filter((element) => element.getClientRects().length > 0);
        for (const backdrop of backdrops) {
          if (openers.has(backdrop)) continue;
          openers.set(backdrop, previousFocus);
          backdrop.tabIndex = -1;
          const card = backdrop.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? backdrop.firstElementChild;
          if (card instanceof HTMLElement) {
            if (!card.hasAttribute("role")) card.setAttribute("role", "dialog");
            card.setAttribute("aria-modal", "true");
            const heading = card.querySelector<HTMLElement>("h2, h3");
            if (heading && !card.hasAttribute("aria-label") && !card.hasAttribute("aria-labelledby")) {
              heading.id ||= `xsh-modal-heading-${++titleId}`;
              card.setAttribute("aria-labelledby", heading.id);
            }
          }
        }
        // Stable sort keeps the most recently mounted dialog above its peers.
        backdrops.sort((left, right) => (Number.parseInt(getComputedStyle(left).zIndex) || 0) - (Number.parseInt(getComputedStyle(right).zIndex) || 0));
        const next = backdrops[backdrops.length - 1] ?? null;
        const returnTo = active && !backdrops.includes(active) ? openers.get(active) : null;
        restoreBackground();
        active = next;
        if (active) {
          // Inert siblings along the ancestry path also covers dialogs nested
          // in file panes and settings, without making their ancestor inert.
          let branch: HTMLElement = active;
          while (branch.parentElement) {
            for (const sibling of branch.parentElement.children) {
              if (sibling !== branch && sibling instanceof HTMLElement) {
                originalInert.set(sibling, sibling.inert);
                sibling.inert = true;
              }
            }
            if (branch.parentElement === document.body) break;
            branch = branch.parentElement;
          }
        }
        for (const backdrop of openers.keys()) {
          if (!backdrops.includes(backdrop)) { openers.delete(backdrop); lastFocus.delete(backdrop); }
        }
        if (returnTo?.isConnected && !returnTo.closest("[inert]") && (!active || active.contains(returnTo))) {
          returnTo.focus({ preventScroll: true });
        } else if (active && !active.contains(document.activeElement)) {
          focusInside(active);
        }
      } finally { synchronizing = false; }
    };
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      sync();
      if (active && !active.contains(event.target)) {
        focusInside(active);
        return;
      }
      previousFocus = event.target;
      if (active) lastFocus.set(active, event.target);
    };
    const onKey = (event: KeyboardEvent) => {
      if (!active || event.key !== "Tab") return;
      const elements = focusableElements(active);
      const current = elements.indexOf(document.activeElement as HTMLElement);
      if (!elements.length || current < 0 || (event.shiftKey ? current === 0 : current === elements.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? elements[elements.length - 1] : elements[0])?.focus();
        if (!elements.length) active.focus();
      }
      event.stopImmediatePropagation();
    };
    const observer = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
        node instanceof Element && (node.matches(".modal-backdrop") || node.querySelector(".modal-backdrop")),
      ))) sync();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("focusin", onFocus, true);
    window.addEventListener("keydown", onKey, true);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("keydown", onKey, true);
      restoreBackground();
    };
  }, []);
  return null;
}
