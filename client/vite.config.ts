import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Pinned to 5273 instead of Vite's default 5173 so the launcher's
    // port-kill (scripts/run.command) only ever clears this app's port and
    // never some other local dev server squatting the shared 5173 default.
    port: 5273,
    proxy: {
      "/api": "http://127.0.0.1:3141",
      "/assets": "http://127.0.0.1:3141",
    },
  },
});
