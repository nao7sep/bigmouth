import express from "express";
import cors from "cors";

const app = express();
const port = 3141;

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`BigMouth server listening on http://127.0.0.1:${port}`);
});
