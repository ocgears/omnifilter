import { Injector, afterNextRender } from '@angular/core';

// Whether the keyboard focus was lost: the element that had it was taken out
// of the page or disabled, so the browser put it back on the page itself, and
// the next Tab would start again from the top.
export function focusLost(): boolean {
  const active = document.activeElement as (HTMLElement & { disabled?: boolean }) | null;
  return !active || active === document.body || !active.isConnected || !!active.disabled;
}

// Once the page has updated, puts the focus on the first element any of the
// selectors finds, tried in order; only if the focus was lost, unless
// `always`. Controls that remove or disable themselves use this to hand the
// focus to the next sensible place.
export function refocus(
  injector: Injector,
  selectors: string[],
  options: { always?: boolean; root?: ParentNode } = {},
): void {
  afterNextRender(
    {
      read: () => {
        if (!options.always && !focusLost()) return;
        for (const selector of selectors) {
          const el = (options.root ?? document).querySelector<HTMLElement>(selector);
          if (el) {
            el.focus();
            return;
          }
        }
      },
    },
    { injector },
  );
}
