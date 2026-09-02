import { BrowserWindow } from "electron";

export interface PlainMessageDialogOptions {
  title: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  destructiveId?: number;
}

const CHOICE_ORIGIN = "https://bigmouth-dialog.invalid/choice/";

/** App-authored message shell: no framework severity/application icon. */
export async function showPlainMessageDialog(options: PlainMessageDialogOptions): Promise<number> {
  const buttons = options.buttons?.length ? options.buttons : ["OK"];
  const defaultId = options.defaultId ?? 0;
  const cancelId = options.cancelId ?? defaultId;
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const win = new BrowserWindow({
    parent,
    modal: Boolean(parent),
    show: false,
    width: 520,
    height: 260,
    minWidth: 420,
    minHeight: 220,
    maxWidth: 680,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: options.title,
    backgroundColor: "#f7f4ef",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  return await new Promise<number>((resolve) => {
    let settled = false;
    const settle = (choice: number): void => {
      if (settled) return;
      settled = true;
      resolve(choice);
      if (!win.isDestroyed()) win.close();
    };
    win.on("closed", () => settle(cancelId));
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(CHOICE_ORIGIN)) return;
      event.preventDefault();
      const choice = Number(url.slice(CHOICE_ORIGIN.length));
      settle(Number.isInteger(choice) && choice >= 0 && choice < buttons.length ? choice : cancelId);
    });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.key !== "Escape") return;
      event.preventDefault();
      settle(cancelId);
    });
    win.webContents.once("dom-ready", () => {
      void win.webContents.executeJavaScript(
        "document.getElementById('dialog-header').offsetHeight + document.getElementById('dialog-body').scrollHeight + document.getElementById('dialog-footer').offsetHeight",
        true,
      )
        .then((height: number) => {
          if (win.isDestroyed()) return;
          const displayHeight = parent?.getBounds().height ?? 900;
          win.setContentSize(520, Math.min(Math.max(Math.ceil(height), 220), Math.floor(displayHeight * 0.85)));
          win.show();
          return win.webContents.executeJavaScript(`document.getElementById('choice-${defaultId}')?.focus()`, true);
        });
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderPlainMessageDialogHtml(options, buttons))}`);
  });
}

export function renderPlainMessageDialogHtml(options: PlainMessageDialogOptions, buttons: string[]): string {
  const actions = buttons.map((label, index) => {
    const kind = index === options.destructiveId ? " destructive" : index === (options.defaultId ?? 0) ? " primary" : "";
    return `<button id="choice-${index}" class="button${kind}" type="button" onclick="location.href='${CHOICE_ORIGIN}${index}'">${escapeHtml(label)}</button>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:light;font:14px/1.5 system-ui,-apple-system,sans-serif;background:#f7f4ef;color:#292524}
    *{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden}.dialog{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto}
    .header{padding:24px 24px 12px}.body{min-height:0;overflow:auto;padding:0 24px;display:flex;flex-direction:column;gap:12px}
    h1{font-size:18px;line-height:1.3;margin:0}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.detail{color:#57534e}
    .actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 24px 24px}
    .button{color:#292524;border:1px solid #a8a29e;border-radius:6px;padding:7px 14px;background:#fafaf9;font:inherit}
    .button:hover,.button:focus{outline:2px solid #78716c;outline-offset:2px}.button:not(.primary):not(.destructive):hover,.button:not(.primary):not(.destructive):focus{background:#e7e5e4}
    .primary{color:white;background:#2563eb;border-color:#1d4ed8}.primary:hover,.primary:focus{background:#1d4ed8}.destructive{color:white;background:#b91c1c;border-color:#991b1b}.destructive:hover,.destructive:focus{background:#991b1b}
  </style></head><body><main class="dialog"><header class="header" id="dialog-header"><h1>${escapeHtml(options.title)}</h1></header><section class="body" id="dialog-body"><p>${escapeHtml(options.message)}</p>${options.detail ? `<p class="detail">${escapeHtml(options.detail)}</p>` : ""}</section><footer class="actions" id="dialog-footer">${actions}</footer></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
