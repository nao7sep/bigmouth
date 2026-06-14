import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";

// The app's in-app menu layer: a trigger plus a popup list of commands that
// behaves like a real menu, realizing the composite-control contract for a menu:
//
//   - The TRIGGER is the single tab stop (aria-haspopup="menu" / aria-expanded);
//     the open popup is a roving-focus group outside the page tab order.
//   - Opening moves focus into the menu (first item); closing returns focus to
//     the trigger.
//   - Up/Down move between items (stop-at-ends, matching the app's lists),
//     Home/End jump to the ends, type-ahead by label (composition-guarded for
//     IME), Enter/Space activate + close, Escape / Tab / outside click close.
//   - Items are `menuitem`s navigated only by the arrows, never their own tab
//     stops (tabIndex -1).
//
// This is a popup, NOT a modal: it is not registered with the modal stack. It is
// hand-rolled on the app's own composing helper so every dropdown behaves the
// same. (Mirrors tapebox's Menu.tsx; intentionally a separate per-app copy — the
// composite-control conventions forbid a cross-app shared primitive.)

interface MenuContextValue {
  close: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

interface MenuProps {
  /** Accessible name for the popup. */
  label: string;
  /** Renders the trigger; spread the given props onto a single `<button>`. */
  trigger: (props: {
    ref: (el: HTMLButtonElement | null) => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    onClick: () => void;
  }) => ReactNode;
  children: ReactNode;
}

export function Menu({ label, trigger, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { composingRef, handlers } = useComposing();

  const items = (): HTMLElement[] =>
    contentRef.current
      ? Array.from(contentRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      : [];

  const close = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  };

  // On open, move focus into the menu (first item).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => items()[0]?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Outside click closes without yanking focus back (a pointer interaction).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (contentRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const all = items();
    if (all.length === 0) return;
    const current = Math.max(0, all.indexOf(document.activeElement as HTMLElement));

    if (e.key === "ArrowDown") {
      e.preventDefault();
      all[Math.min(current + 1, all.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      all[Math.max(current - 1, 0)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      all[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      all[all.length - 1]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    } else if (
      e.key.length === 1 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isComposingKeyboardEvent(composingRef, e)
    ) {
      // Type-ahead: jump to the next item whose label starts with the key,
      // searching forward from the current item and wrapping once.
      const ch = e.key.toLowerCase();
      const order = [...all.slice(current + 1), ...all.slice(0, current + 1)];
      order.find((el) => el.textContent?.trim().toLowerCase().startsWith(ch))?.focus();
    }
  };

  return (
    <div className="menu-wrap">
      {trigger({
        ref: (el) => {
          triggerRef.current = el;
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => setOpen((v) => !v),
      })}
      {open && (
        <div
          ref={contentRef}
          role="menu"
          aria-label={label}
          className="menu-popup"
          onKeyDown={onKeyDown}
          onCompositionStart={handlers.onCompositionStart}
          onCompositionEnd={handlers.onCompositionEnd}
        >
          <MenuContext.Provider value={{ close }}>{children}</MenuContext.Provider>
        </div>
      )}
    </div>
  );
}

interface MenuItemProps {
  onSelect: () => void;
  children: ReactNode;
}

/**
 * One command in a {@link Menu}. A `menuitem` reachable only by the menu's arrow
 * navigation (tabIndex -1, never its own tab stop); activating it closes the
 * menu (returning focus to the trigger) and runs the action.
 */
export function MenuItem({ onSelect, children }: MenuItemProps) {
  const ctx = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="menu-item"
      onClick={() => {
        ctx?.close();
        onSelect();
      }}
    >
      {children}
    </button>
  );
}
