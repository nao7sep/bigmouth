import { useEffect, useState } from "react";

export function App() {
  const [health, setHealth] = useState<string>("loading...");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => setHealth(JSON.stringify(data)))
      .catch((err) => setHealth(`error: ${err.message}`));
  }, []);

  return (
    <div style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h1>BigMouth</h1>
      <p>Server health: {health}</p>
    </div>
  );
}
