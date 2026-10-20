import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";
import { TYPE_AHEAD_RESET_MS, typeAheadMatch } from "../util/compositeNav";

// The app's in-app menu layer: a trigger plus a popup list of commands that
// behaves like a real menu, realizing the composite-control contract for a menu:
//
//   - The TRIGGER is the single tab stop (aria-haspopup="menu" / aria-expanded);
//     the open popup is a roving-focus group outside the page tab order.
//   - Opening initializes focus on the first eligible item (last for ArrowUp).
//     Pointer opening starts quietly; keyboard use reveals the target. Hover
//     is independent feedback and never retargets focus. Closing returns focus
//     to the trigger.
//   - Up/Down move between items (stop-at-ends, matching the app's lists),
//     Home/End jump to the ends, type-ahead by label (composition-guarded for
//     IME), Enter/Space activate + close, Escape / Tab / outside click close.
//   - Items are `menuitem`s navigated only by the arrows, never their own tab
//     stops (tabIndex -1).
//
// This is a popup, NOT a modal: it is not registered with the modal stack. It is
// hand-rolled on the app's own composing helper so every dropdown behaves the
// same. (A per-app copy by design: the composite-control conventions forbid a
// cross-app shared primitive.)

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
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  }) => ReactNode;
  children: ReactNode;
}

export function Menu({ label, trigger, children }: MenuProps) {
  const [opening, setOpening] = useState<"pointer" | "keyboard-first" | "keyboard-last" | null>(null);
  const open = opening !== null;
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { composingRef, handlers } = useComposing();
  // Type-ahead buffer with idle reset (same behaviour as the post listbox).
  const queryRef = useRef("");
  const queryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (queryTimerRef.current) clearTimeout(queryTimerRef.current);
    },
    [],
  );

  const items = (): HTMLElement[] =>
    contentRef.current
      ? Array.from(contentRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])'))
      : [];

  const close = (focusTrigger = true) => {
    setOpening(null);
    if (focusTrigger) triggerRef.current?.focus();
  };

  // Ready before paint or the first key: a deferred focus callback could undo
  // navigation that arrived before that callback.
  useLayoutEffect(() => {
    if (!opening) return;
    queryRef.current = "";
    if (queryTimerRef.current) clearTimeout(queryTimerRef.current);
    const all = items();
    (opening === "keyboard-last" ? all.at(-1) : all[0])?.focus();
  }, [opening]);

  // Outside click closes without yanking focus back (a pointer interaction).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (contentRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpening(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isComposingKeyboardEvent(composingRef, e)) return;
    setKeyboardVisible(true);
    const all = items();
    if (all.length === 0) return;
    const current = Math.max(0, all.indexOf(document.activeElement as HTMLElement));

    if (e.key === "Enter" || e.key === " ") {
      // Contained widgets (the zoom stepper) keep their native activation.
      if (!(e.target instanceof HTMLElement) || e.target.getAttribute("role") !== "menuitem") return;
      e.preventDefault();
      if (!e.metaKey && !e.ctrlKey && !e.altKey) all[current]?.click();
    } else if (e.key === "ArrowDown") {
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
      // Type-ahead: accumulate the typed string and jump to the next item whose
      // label starts with it, searching forward from the current item.
      e.preventDefault();
      queryRef.current += e.key;
      if (queryTimerRef.current) clearTimeout(queryTimerRef.current);
      queryTimerRef.current = setTimeout(() => {
        queryRef.current = "";
      }, TYPE_AHEAD_RESET_MS);
      const labels = all.map((el) => el.textContent?.trim() ?? "");
      const match = typeAheadMatch(labels, current, queryRef.current);
      if (match !== -1) all[match]?.focus();
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
        onClick: (event) => {
          if (open) { close(false); return; }
          const keyboard = event.detail === 0;
          setKeyboardVisible(keyboard);
          setOpening(keyboard ? "keyboard-first" : "pointer");
        },
        onKeyDown: (event) => {
          if (isComposingKeyboardEvent(composingRef, event)) return;
          if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          setKeyboardVisible(true);
          setOpening(event.key === "ArrowUp" ? "keyboard-last" : "keyboard-first");
        },
      })}
      {open && (
        <div
          ref={contentRef}
          role="menu"
          aria-label={label}
          className={`menu-popup${keyboardVisible ? " keyboard-navigation" : ""}`}
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
      {/* The label's own box carries the "…": a flex row cuts its text but
          draws no ellipsis. */}
      <span className="menu-item-text">{children}</span>
    </button>
  );
}
