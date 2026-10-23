import fs from "node:fs";
import { initStorageRoot, getElectronUserDataDir, getElectronSessionDataDir } from "./core/services/storagePaths.js";

/** Must finish before Electron becomes ready or creates a persistent session. */
export function configureFrameworkStorage(app: { setPath(name: "userData" | "sessionData", directory: string): void }): void {
  initStorageRoot();
  const userData = getElectronUserDataDir();
  const sessionData = getElectronSessionDataDir();
  fs.mkdirSync(sessionData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
}
