import { useState } from "react";
import { LeftPane } from "./components/LeftPane";
import { CenterPane } from "./components/CenterPane";
import { RightPane } from "./components/RightPane";
import "./App.css";

export function App() {
  // null means no post selected — center+right merge into empty state
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);

  return (
    <div className="app-layout">
      <LeftPane />
      {selectedPostId ? (
        <>
          <CenterPane />
          <RightPane />
        </>
      ) : (
        <div className="pane-empty">
          Select a post or create a new one
        </div>
      )}
    </div>
  );
}
