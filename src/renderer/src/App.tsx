import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { SetupModal } from "./components/SetupModal";
import { WorkspaceSession, type WorkspaceSessionHandle } from "./WorkspaceSession";
import { getAppSettings, getUiState, listWorkspaces, reportProblem, setActiveWorkspace, updateUiState } from "./api";
import {
  DEFAULT_PANE_LEFT_WIDTH,
  DEFAULT_PANE_RIGHT_WIDTH,
  type UiState,
  type Workspace,
  type WorkspaceDeleteResult,
} from "@shared/types";
import {
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_MAX,
  RIGHT_MIN,
  clamp,
  displayedLeftWidth,
  displayedRightWidth,
  restoredLeftIntent,
  restoredRightIntent,
} from "./paneConstants";
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "@shared/layout";
import { presentFailure } from "./util/presentFailure";
import { OperationalResult } from "./components/OperationalResult";
import { useI18n } from "./i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import { StorageResults, useStorageResultReporter } from "./StorageResults";
import "./App.css";

// Each side pane stores an INTENT width in pixels: the width the user resized
// the pane to, independent of the current viewport. Intent is clamped only to
// the pane's own configured bounds on read — never against the container — so a
// narrow viewport at load time can't shrink the saved intent. The DISPLAYED
// width is derived from this intent and the live container width (see
// clampPaneWidth); only an explicit resize updates and persists the intent. A viewport
// resize re-derives the display from the unchanged intent and persists nothing,
// so widening the window restores the pane to its intended width.
//
// Intents live in the main process's state.json (view state), hydrated once on
// mount via getUiState and persisted on resize completion via updateUiState, not in
// renderer localStorage: view state has one owner, the main process
// (persisted-store-separation-conventions).

export function App() {
  const [activeWorkspace, setActiveWorkspaceState] = useState<Workspace | null>(null);
  const [workspaceReloadVersion, setWorkspaceReloadVersion] = useState(0);
  const reportStorageResult = useStorageResultReporter();
  const removalSelection = useRef(new Map<string, number>());
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  // First run: the workspace window created the only workspace, and setup asks
  // for its first target before opening it.
  const [setupWorkspace, setSetupWorkspace] = useState<Workspace | null>(null);
  const [wsChecked, setWsChecked] = useState(false);
  const { text } = useI18n();
  const [workspaceRegistryError, setWorkspaceRegistryError] = useState<Message | null>(null);
  const [shellResults, setShellResults] = useState<Array<{ key: string; message: Message }>>([]);
  const reportShellResult = useCallback((key: string, text: Message) => {
    setShellResults((current) => [
      ...current.filter((result) => result.key !== key),
      { key, message: text },
    ]);
  }, []);
  const resolveShellResult = useCallback((key: string) => {
    setShellResults((current) => current.filter((result) => result.key !== key));
  }, []);

  // Intent widths (px): what the user resized each side pane to. Seeded with the
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
  const workspaceSelectionRef = useRef(0);
  const workspaceSelectionIntent = useRef<{ workspaceId: string; selection: number } | null>(null);
  const activeWorkspaceRef = useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
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
  const leftWidth = containerWidth === null ? leftIntent : displayedLeftWidth(leftIntent, rightIntent, containerWidth);
  const rightWidth = containerWidth === null ? rightIntent : displayedRightWidth(rightIntent, leftIntent, containerWidth);

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

  // The app-wide settings file is read before the window exists (it carries the
  // theme); a file it could not use is reported here, once, by path.
  useEffect(() => {
    let cancelled = false;
    getAppSettings()
      .then(({ notice }) => {
        if (cancelled || notice === null) return;
        reportShellResult("app-settings-notice", notice);
      })
      .catch((err: unknown) => reportProblem("renderer: app settings load failed", err));
    return () => {
      cancelled = true;
    };
  }, [reportShellResult]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Hydrate view state (pane intents + last workspace) from state.json before
      // the app renders. The whole tree is gated on wsChecked, flipped true only at
      // the end, so nothing paints with the seed pane widths or a stale workspace.
      let storedId = "";
      try {
        const state: UiState = await getUiState();
        if (cancelled) return;
        setLeftIntent(restoredLeftIntent(state.paneLeftWidth));
        setRightIntent(restoredRightIntent(state.paneRightWidth));
        storedId = state.activeWorkspaceId;
      } catch (err) {
        // A failed state read is non-fatal: fall back to defaults and no
        // remembered workspace.
        reportProblem("could not read the saved UI state", err);
        if (cancelled) return;
        reportShellResult(
          "ui-state-load",
          message("app.uiStateLoadFailed"),
        );
      }

      // The registry is read even with nothing remembered: an empty one is a
      // first run, which the workspace window opens on its new-workspace form.
      try {
        const workspaces = await listWorkspaces();
        if (cancelled) return;
        setWorkspaceRegistryError(null);
        const ws = storedId ? workspaces.find((workspace) => workspace.id === storedId) : undefined;
        if (ws) {
          setActiveWorkspace(ws.id);
          setActiveWorkspaceState(ws);
        } else {
          // A remembered id that names nothing is cleared, unless nothing is
          // registered: opening the first workspace replaces it then.
          if (storedId && workspaces.length > 0) {
            await updateUiState({ activeWorkspaceId: "" });
            if (cancelled) return;
          }
          setWorkspaceModalOpen(true);
        }
      } catch (err) {
        const failure = presentFailure(
          message(storedId ? "app.workspacesLoadFailed" : "workspaces.loadFailed"),
          "renderer: workspace registry startup load failed",
          err,
          { storedId },
        );
        if (cancelled) return;
        setWorkspaceRegistryError(failure);
        setWorkspaceModalOpen(true);
      } finally {
        if (!cancelled) setWsChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reportShellResult]);

  const handleSelectWorkspace = useCallback(async (ws: Workspace) => {
    const selection = ++workspaceSelectionRef.current;
    const intent = { workspaceId: ws.id, selection };
    workspaceSelectionIntent.current = intent;
    let flushed: boolean;
    try { flushed = (await sessionRef.current?.flushPendingChanges()) ?? true; }
    finally { if (workspaceSelectionIntent.current === intent) workspaceSelectionIntent.current = null; }
    if (!flushed || workspaceSelectionRef.current !== selection) return;

    setActiveWorkspace(ws.id);
    setActiveWorkspaceState(ws);
    activeWorkspaceRef.current = ws;
    setWorkspaceRegistryError(null);
    // Selection has happened. Its optional preference save must not later close
    // a newly opened picker or setup surface.
    setWorkspaceModalOpen(false);
    setSetupWorkspace(null);
    try {
      await updateUiState({ activeWorkspaceId: ws.id });
      if (workspaceSelectionRef.current !== selection) return;
      resolveShellResult("active-workspace");
    } catch (err) {
      if (workspaceSelectionRef.current !== selection) return;
      reportShellResult("active-workspace", presentFailure(
        message("app.activeWorkspaceSaveFailed"),
        "renderer: active workspace preference save failed",
        err,
        { workspaceId: ws.id },
      ));
    }
  }, [reportShellResult, resolveShellResult]);

  const clearActiveWorkspacePreference = useCallback(async (workspaceId: string, selection: number) => {
    try {
      await updateUiState({ activeWorkspaceId: "" });
      if (workspaceSelectionRef.current !== selection || activeWorkspaceRef.current !== null) return;
      resolveShellResult("active-workspace");
    } catch (err) {
      if (workspaceSelectionRef.current !== selection || activeWorkspaceRef.current !== null) return;
      reportShellResult("active-workspace", presentFailure(
        message("app.activeWorkspaceClearFailed"),
        "renderer: cleared active workspace preference save failed",
        err,
        { workspaceId },
      ));
    }
  }, [reportShellResult, resolveShellResult]);

  const handleActiveWorkspaceDeleted = useCallback(
    async (workspaceId: string) => {
      if (activeWorkspaceRef.current?.id !== workspaceId) return true;

      const flushed = (await sessionRef.current?.flushPendingChanges()) ?? true;
      if (!flushed) return false;
      if (activeWorkspaceRef.current?.id !== workspaceId) return true;

      const selection = ++workspaceSelectionRef.current;
      removalSelection.current.set(workspaceId, selection);
      setActiveWorkspace("");
      activeWorkspaceRef.current = null;
      setActiveWorkspaceState(null);
      setWorkspaceModalOpen(true);
      await clearActiveWorkspacePreference(workspaceId, selection);
      return true;
    },
    [clearActiveWorkspacePreference]
  );

  const handleWorkspaceRemovalCompleted = useCallback((workspace: Workspace, result: WorkspaceDeleteResult) => {
    removalSelection.current.delete(workspace.id);
    // A stale picker may still offer this row while removal is running. Retire
    // only that identity, including a selection still awaiting another session's
    // flush, without cancelling a selection of a different workspace.
    if (workspaceSelectionIntent.current?.workspaceId === workspace.id) {
      workspaceSelectionIntent.current = null;
      workspaceSelectionRef.current += 1;
    }
    if (activeWorkspaceRef.current?.id === workspace.id) {
      const selection = workspaceSelectionIntent.current
        ? workspaceSelectionRef.current
        : ++workspaceSelectionRef.current;
      setActiveWorkspace("");
      activeWorkspaceRef.current = null;
      setActiveWorkspaceState(null);
      setWorkspaceModalOpen(true);
      setSetupWorkspace(null);
      void clearActiveWorkspacePreference(workspace.id, selection);
    }
    setWorkspaceReloadVersion((version) => version + 1);
    if (result.keyCleanupIncomplete) reportStorageResult(message("workspaces.keyCleanupIncomplete", { name: workspace.name }), "warning");
  }, [clearActiveWorkspacePreference, reportStorageResult]);

  const handleWorkspaceRemovalFailed = useCallback(async (workspace: Workspace) => {
    const selection = removalSelection.current.get(workspace.id);
    removalSelection.current.delete(workspace.id);
    setWorkspaceReloadVersion((version) => version + 1);
    if (selection !== undefined && selection === workspaceSelectionRef.current && activeWorkspaceRef.current === null) {
      await handleSelectWorkspace(workspace);
    }
  }, [handleSelectWorkspace]);

  const handleActiveWorkspaceUpdated = useCallback((workspace: Workspace) => {
    setActiveWorkspaceState((current) => {
      if (!current || current.id !== workspace.id) return current;
      return workspace;
    });
  }, []);

  // Tears down an in-flight splitter drag: set while one is running, null otherwise.
  const activeDragRef = useRef<(() => void) | null>(null);

  const savePaneWidth = useCallback((stateKey: "paneLeftWidth" | "paneRightWidth", width: number) => {
    void updateUiState({ [stateKey]: width })
      .then(() => resolveShellResult(stateKey))
      .catch((err: unknown) => {
        reportShellResult(stateKey, presentFailure(
          message("app.paneWidthSaveFailed"),
          "renderer: pane width save failed",
          err,
          { stateKey },
        ));
      });
  }, [reportShellResult, resolveShellResult]);

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
        endDrag();
        // Resizing explicitly persists intent; measuring the viewport does not.
        savePaneWidth(stateKey, intentRef.current);
      };
      const endDrag = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        activeDragRef.current = null;
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      // Held so unmount can tear the drag down. Without it, a session torn down
      // mid-drag (a workspace switch fired from a menu, say) left both document
      // listeners attached and the body stuck with col-resize and no selection.
      activeDragRef.current = endDrag;
    },
    [savePaneWidth]
  );

  useEffect(() => () => activeDragRef.current?.(), []);

  if (!wsChecked) return null;

  const workspaceModal = (
    <WorkspaceModal
      dismissable={activeWorkspace !== null}
      onClose={() => setWorkspaceModalOpen(false)}
      onSelect={handleSelectWorkspace}
      onCreated={(workspace, firstRun) => {
        if (firstRun) setSetupWorkspace(workspace);
        else return handleSelectWorkspace(workspace);
      }}
      activeWorkspaceId={activeWorkspace?.id ?? null}
      onWorkspaceDeleted={handleActiveWorkspaceDeleted}
      onWorkspaceUpdated={handleActiveWorkspaceUpdated}
      onWorkspaceRemovalCompleted={handleWorkspaceRemovalCompleted}
      onWorkspaceRemovalFailed={handleWorkspaceRemovalFailed}
      reloadVersion={workspaceReloadVersion}
      initialLoadError={workspaceRegistryError}
      onLoadRecovered={() => setWorkspaceRegistryError(null)}
    />
  );

  const shellResultStack = (
    <div className="app-operational-results">
      <StorageResults />
      {shellResults.map((result) => (
        <OperationalResult
          key={result.key}
          severity="error"
          className="app-operational-result"
          onDismiss={() => resolveShellResult(result.key)}
        >
          {text(result.message)}
        </OperationalResult>
      ))}
    </div>
  );

  if (!activeWorkspace) {
    const gate = setupWorkspace ? (
      <SetupModal workspace={setupWorkspace} onFinish={handleSelectWorkspace} />
    ) : workspaceModal;
    return <>{gate}{shellResultStack}</>;
  }

  return (
    <>
      <div className="workspace-viewport">
        <div
          className="workspace-floor"
          style={{ minWidth: WINDOW_MIN_WIDTH, minHeight: WINDOW_MIN_HEIGHT }}
        >
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
            onLeftWidthChange={setLeftIntent}
            onRightWidthChange={setRightIntent}
            onLeftWidthCommit={(width) => savePaneWidth("paneLeftWidth", width)}
            onRightWidthCommit={(width) => savePaneWidth("paneRightWidth", width)}
            onSwitchWorkspace={() => setWorkspaceModalOpen(true)}
            onWorkspaceUpdated={handleActiveWorkspaceUpdated}
          />
        </div>
      </div>
      {workspaceModalOpen && workspaceModal}
      {shellResultStack}
    </>
  );
}
