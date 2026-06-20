import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { WorkspaceSession, type WorkspaceSessionHandle } from "./WorkspaceSession";
import { fetchWorkspaces, setActiveWorkspace } from "./api";
import type { Workspace } from "./types";
import {
  CENTER_MIN,
  DIVIDER,
  LEFT_MIN,
  RIGHT_MIN,
  clamp,
  clampPaneWidth,
} from "./paneConstants";
import "./App.css";

const STORAGE_LEFT = "bm-pane-left-width";
const STORAGE_RIGHT = "bm-pane-right-width";
const STORAGE_WS = "bm-workspace-id";

// Per-pane configured bounds. The lower bound is the pane's own minimum; the
// upper bound is the widest the pane can grow at all. The live splitter clamp
// (clampPaneWidth) tightens the upper bound further against the container so a
// widened pane never crushes the center pane.
const LEFT_MAX = 720;
const RIGHT_MAX = 960;

function readStoredWidth(key: string, fallback: number, min: number, max: number) {
  const v = localStorage.getItem(key);
  return v ? clamp(+v, min, max) : fallback;
}

export function App() {
  const [activeWorkspace, setActiveWorkspaceState] = useState<Workspace | null>(null);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [wsChecked, setWsChecked] = useState(false);

  const [leftWidth, setLeftWidth] = useState(() =>
    readStoredWidth(STORAGE_LEFT, 360, LEFT_MIN, LEFT_MAX)
  );
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredWidth(STORAGE_RIGHT, 480, RIGHT_MIN, RIGHT_MAX)
  );
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  const sessionRef = useRef<WorkspaceSessionHandle>(null);
  // The live pane-row element, so the splitter clamp measures the real container
  // width rather than a guessed maximum.
  const appLayoutRef = useRef<HTMLDivElement>(null);
  leftWidthRef.current = leftWidth;
  rightWidthRef.current = rightWidth;

  // Restored widths are clamped against their per-pane bounds, but a window that
  // shrank since the last save can leave a stored width that would now crush the
  // center pane. Re-clamp both against the current container on mount.
  useEffect(() => {
    const container = appLayoutRef.current?.getBoundingClientRect().width;
    if (!container) return;
    setLeftWidth((w) =>
      clampPaneWidth(w, LEFT_MIN, LEFT_MAX, container, rightWidthRef.current + CENTER_MIN + 2 * DIVIDER)
    );
    setRightWidth((w) =>
      clampPaneWidth(w, RIGHT_MIN, RIGHT_MAX, container, leftWidthRef.current + CENTER_MIN + 2 * DIVIDER)
    );
  }, [activeWorkspace]);

  useEffect(() => {
    const storedId = localStorage.getItem(STORAGE_WS);
    if (!storedId) {
      setWorkspaceModalOpen(true);
      setWsChecked(true);
      return;
    }

    fetchWorkspaces()
      .then((workspaces) => {
        const ws = workspaces.find((workspace) => workspace.id === storedId);
        if (ws) {
          setActiveWorkspace(ws.id);
          setActiveWorkspaceState(ws);
        } else {
          localStorage.removeItem(STORAGE_WS);
          setWorkspaceModalOpen(true);
        }
      })
      .catch(() => {
        localStorage.removeItem(STORAGE_WS);
        setWorkspaceModalOpen(true);
      })
      .finally(() => setWsChecked(true));
  }, []);

  const handleSelectWorkspace = useCallback(async (ws: Workspace) => {
    const flushed = (await sessionRef.current?.flushPendingChanges()) ?? true;
    if (!flushed) return;

    setActiveWorkspace(ws.id);
    setActiveWorkspaceState(ws);
    localStorage.setItem(STORAGE_WS, ws.id);
    setWorkspaceModalOpen(false);
  }, []);

  const handleActiveWorkspaceDeleted = useCallback(
    async (workspaceId: string) => {
      if (activeWorkspace?.id !== workspaceId) return true;

      const flushed = (await sessionRef.current?.flushPendingChanges()) ?? true;
      if (!flushed) return false;

      setActiveWorkspace("");
      localStorage.removeItem(STORAGE_WS);
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
      widthRef: MutableRefObject<number>,
      otherWidthRef: MutableRefObject<number>,
      setWidth: (width: number) => void,
      storageKey: string,
      sign: 1 | -1,
      min: number,
      max: number
    ) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        const container = appLayoutRef.current?.getBoundingClientRect().width ?? Infinity;
        // The siblings this pane must not crush: the OTHER resizable pane, the
        // center pane's minimum, and the two dividers between the three panes.
        const siblingMins = otherWidthRef.current + CENTER_MIN + 2 * DIVIDER;
        setWidth(
          clampPaneWidth(startW + sign * (ev.clientX - startX), min, max, container, siblingMins)
        );
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        localStorage.setItem(storageKey, String(widthRef.current));
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
          startDrag(e, leftWidthRef, rightWidthRef, setLeftWidth, STORAGE_LEFT, 1, LEFT_MIN, LEFT_MAX)
        }
        onStartRightDrag={(e) =>
          startDrag(
            e,
            rightWidthRef,
            leftWidthRef,
            setRightWidth,
            STORAGE_RIGHT,
            -1,
            RIGHT_MIN,
            RIGHT_MAX
          )
        }
        onSwitchWorkspace={() => setWorkspaceModalOpen(true)}
      />
      {workspaceModalOpen && workspaceModal}
    </>
  );
}
