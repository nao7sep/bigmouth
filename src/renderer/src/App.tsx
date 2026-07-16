import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { WorkspaceSession, type WorkspaceSessionHandle } from "./WorkspaceSession";
import { getUiState, listWorkspaces, setActiveWorkspace, updateUiState } from "./api";
import {
  DEFAULT_PANE_LEFT_WIDTH,
  DEFAULT_PANE_RIGHT_WIDTH,
  type UiState,
  type Workspace,
} from "@shared/types";
import {
  CENTER_MIN,
  DIVIDER,
  LEFT_MIN,
  RIGHT_MIN,
  clamp,
  clampPaneWidth,
} from "./paneConstants";
import "./App.css";

// Per-pane configured bounds. The lower bound is the pane's own minimum; the
// upper bound is the widest the pane can grow at all. The live splitter clamp
// (clampPaneWidth) tightens the upper bound further against the container so a
// widened pane never crushes the center pane.
const LEFT_MAX = 720;
const RIGHT_MAX = 960;

// Each side pane stores an INTENT width in pixels: the width the user dragged
// the pane to, independent of the current viewport. Intent is clamped only to
// the pane's own configured bounds on read — never against the container — so a
// narrow viewport at load time can't shrink the saved intent. The DISPLAYED
// width is derived from this intent and the live container width (see
// clampPaneWidth); only a drag updates the intent and persists it. A viewport
// resize re-derives the display from the unchanged intent and persists nothing,
// so widening the window restores the pane to its intended width.
//
// Intents live in the main process's state.json (view state), hydrated once on
// mount via getUiState and persisted on drag-end via updateUiState — no longer in
// renderer localStorage (persisted-store-separation-conventions).

export function App() {
  const [activeWorkspace, setActiveWorkspaceState] = useState<Workspace | null>(null);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [wsChecked, setWsChecked] = useState(false);

  // Intent widths (px): what the user dragged each side pane to. Seeded with the
  // shared defaults and replaced by the persisted intents once state.json is
  // hydrated on mount (below), clamped only to per-pane bounds — restoring keeps
  // the persisted intent rather than overwriting it with a viewport-fitted value.
  // The whole app is gated behind `wsChecked`, which flips true only after hydration,
  // so these seed values are never shown.
  const [leftIntent, setLeftIntent] = useState(DEFAULT_PANE_LEFT_WIDTH);
  const [rightIntent, setRightIntent] = useState(DEFAULT_PANE_RIGHT_WIDTH);
  // The measured pane-row width, used to derive the displayed pane widths from
  // the intents. Tracked in state (updated by a ResizeObserver) so a viewport
  // resize re-derives the display without ever touching the stored intent.
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const leftIntentRef = useRef(leftIntent);
  const rightIntentRef = useRef(rightIntent);
  const sessionRef = useRef<WorkspaceSessionHandle>(null);
  // The live pane-row element, so the displayed-width clamp measures the real
  // container width rather than a guessed maximum.
  const appLayoutRef = useRef<HTMLDivElement>(null);
  leftIntentRef.current = leftIntent;
  rightIntentRef.current = rightIntent;

  // Displayed widths: the intent clamped against the live container so a widened
  // pane never crushes the center pane. Until the container is measured (first
  // paint) the intent is shown as-is; the observer corrects it immediately
  // after, and below the summed minimum the row scrolls (overflow-x: auto).
  // Display-only — these are never persisted.
  const leftWidth =
    containerWidth === null
      ? leftIntent
      : clampPaneWidth(
          leftIntent,
          LEFT_MIN,
          LEFT_MAX,
          containerWidth,
          rightIntent + CENTER_MIN + 2 * DIVIDER
        );
  const rightWidth =
    containerWidth === null
      ? rightIntent
      : clampPaneWidth(
          rightIntent,
          RIGHT_MIN,
          RIGHT_MAX,
          containerWidth,
          leftIntent + CENTER_MIN + 2 * DIVIDER
        );

  // Measure the pane row and keep the measurement live. A viewport resize fires
  // the observer, which only updates containerWidth — the intents are untouched,
  // so the display re-derives and nothing is persisted. Re-attached whenever the
  // session (and thus the .app-layout element) changes.
  useEffect(() => {
    const el = appLayoutRef.current;
    if (!el) {
      setContainerWidth(null);
      return;
    }
    setContainerWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeWorkspace]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Hydrate view state (pane intents + last workspace) from state.json before
      // the app renders. The whole tree is gated on wsChecked, flipped true only at
      // the end, so nothing paints with the seed pane widths or a stale workspace.
      let state: UiState;
      try {
        state = await getUiState();
      } catch {
        // A failed state read is non-fatal: fall back to defaults and the picker.
        if (!cancelled) {
          setWorkspaceModalOpen(true);
          setWsChecked(true);
        }
        return;
      }
      if (cancelled) return;
      setLeftIntent(clamp(state.paneLeftWidth, LEFT_MIN, LEFT_MAX));
      setRightIntent(clamp(state.paneRightWidth, RIGHT_MIN, RIGHT_MAX));

      const storedId = state.activeWorkspaceId;
      if (!storedId) {
        setWorkspaceModalOpen(true);
        setWsChecked(true);
        return;
      }

      try {
        const workspaces = await listWorkspaces();
        if (cancelled) return;
        const ws = workspaces.find((workspace) => workspace.id === storedId);
        if (ws) {
          setActiveWorkspace(ws.id);
          setActiveWorkspaceState(ws);
        } else {
          await updateUiState({ activeWorkspaceId: "" });
          if (cancelled) return;
          setWorkspaceModalOpen(true);
        }
      } catch {
        await updateUiState({ activeWorkspaceId: "" });
        if (cancelled) return;
        setWorkspaceModalOpen(true);
      } finally {
        if (!cancelled) setWsChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectWorkspace = useCallback(async (ws: Workspace) => {
    const flushed = (await sessionRef.current?.flushPendingChanges()) ?? true;
    if (!flushed) return;

    setActiveWorkspace(ws.id);
    setActiveWorkspaceState(ws);
    void updateUiState({ activeWorkspaceId: ws.id });
    setWorkspaceModalOpen(false);
  }, []);

  const handleActiveWorkspaceDeleted = useCallback(
    async (workspaceId: string) => {
      if (activeWorkspace?.id !== workspaceId) return true;

      const flushed = (await sessionRef.current?.flushPendingChanges()) ?? true;
      if (!flushed) return false;

      setActiveWorkspace("");
      void updateUiState({ activeWorkspaceId: "" });
      setActiveWorkspaceState(null);
      setWorkspaceModalOpen(true);
      return true;
    },
    [activeWorkspace]
  );

  const handleActiveWorkspaceUpdated = useCallback((workspace: Workspace) => {
    setActiveWorkspaceState((current) => {
      if (!current || current.id !== workspace.id) return current;
      return workspace;
    });
  }, []);

  const startDrag = useCallback(
    (
      e: ReactMouseEvent,
      intentRef: MutableRefObject<number>,
      setIntent: (width: number) => void,
      stateKey: "paneLeftWidth" | "paneRightWidth",
      sign: 1 | -1,
      min: number,
      max: number
    ) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = intentRef.current;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        // A drag sets the pane's INTENT, clamped only to its own configured
        // bounds — not against the container. The displayed width is derived
        // from this intent against the live container width (see leftWidth /
        // rightWidth above), so dragging in a narrow viewport can still record a
        // wide intent that reappears once the viewport grows.
        setIntent(clamp(startW + sign * (ev.clientX - startX), min, max));
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Only a drag persists, and it persists the INTENT (px) to state.json.
        // Resize and mount never reach here, so they never overwrite the stored value.
        void updateUiState({ [stateKey]: intentRef.current });
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    []
  );

  if (!wsChecked) return null;

  const workspaceModal = (
    <WorkspaceModal
      dismissable={activeWorkspace !== null}
      onClose={() => setWorkspaceModalOpen(false)}
      onSelect={handleSelectWorkspace}
      activeWorkspaceId={activeWorkspace?.id ?? null}
      onWorkspaceDeleted={handleActiveWorkspaceDeleted}
      onWorkspaceUpdated={handleActiveWorkspaceUpdated}
    />
  );

  if (!activeWorkspace) {
    return workspaceModal;
  }

  return (
    <>
      <WorkspaceSession
        ref={sessionRef}
        appLayoutRef={appLayoutRef}
        key={activeWorkspace.id}
        workspace={activeWorkspace}
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        onStartLeftDrag={(e) =>
          startDrag(e, leftIntentRef, setLeftIntent, "paneLeftWidth", 1, LEFT_MIN, LEFT_MAX)
        }
        onStartRightDrag={(e) =>
          startDrag(e, rightIntentRef, setRightIntent, "paneRightWidth", -1, RIGHT_MIN, RIGHT_MAX)
        }
        onSwitchWorkspace={() => setWorkspaceModalOpen(true)}
      />
      {workspaceModalOpen && workspaceModal}
    </>
  );
}
