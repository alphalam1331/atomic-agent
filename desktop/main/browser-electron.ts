import { session, WebContentsView } from "electron";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { DesktopBrowserService, type BrowserPaneState } from "./browser-service";

/** Agent-owned logins persist separately from the shell and personal browsers. */
export function createDesktopBrowserService(options: { profilePath: string; onState?: (state: BrowserPaneState) => void }): DesktopBrowserService {
  mkdirSync(options.profilePath, { recursive: true, mode: 0o700 });
  if (lstatSync(options.profilePath).isSymbolicLink()) throw new Error("The agent browser profile must be its own directory, not a symbolic link.");
  if (process.platform !== "win32") chmodSync(options.profilePath, 0o700);
  const browserSession = session.fromPath(options.profilePath);
  return new DesktopBrowserService({
    browserSession,
    onState: options.onState,
    createView: () => new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        // There is deliberately no preload and no privileged IPC bridge.
      },
    }),
  });
}
