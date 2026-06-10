import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { WorkspaceSession, type WorkspaceSessionHandle } from "./WorkspaceSession";
import { fetchWorkspaces, setActiveWorkspace } from "./api";
import type { Workspace } from "./types";
import "./App.css";

const STORAGE_LEFT = "bm-pane-left-width";
const STORAGE_RIGHT = "bm-pane-right-width";
const STORAGE_WS = "bm-workspace-id";

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function readStoredWidth(key: string, fallback: number, min: number, max: number) {
  const v = localStorage.getItem(key);
  return v ? clamp(+v, min, max) : fallback;
}

export function App() {
  const [activeWorkspace, setActiveWorkspaceState] = useState<Workspace | null>(null);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [wsChecked, setWsChecked] = useState(false);

  const [leftWidth, setLeftWidth] = useState(() => readStoredWidth(STORAGE_LEFT, 360, 240, 720));
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredWidth(STORAGE_RIGHT, 480, 320, 960)
  );
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  const sessionRef = useRef<WorkspaceSessionHandle>(null);
  leftWidthRef.current = leftWidth;
  rightWidthRef.current = rightWidth;

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
        setWidth(clamp(startW + sign * (ev.clientX - startX), min, max));
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
        key={activeWorkspace.id}
        workspace={activeWorkspace}
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        onStartLeftDrag={(e) => startDrag(e, leftWidthRef, setLeftWidth, STORAGE_LEFT, 1, 240, 720)}
        onStartRightDrag={(e) =>
          startDrag(e, rightWidthRef, setRightWidth, STORAGE_RIGHT, -1, 320, 960)
        }
        onSwitchWorkspace={() => setWorkspaceModalOpen(true)}
      />
      {workspaceModalOpen && workspaceModal}
    </>
  );
}
