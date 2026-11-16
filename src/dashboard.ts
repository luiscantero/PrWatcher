import * as vscode from "vscode";
import { DashboardState } from "./watcher";

export type DashboardMessage =
  | { type: "ready" }
  | { type: "open"; url: string }
  | { type: "copy"; text: string }
  | { type: "command"; command: string; args?: unknown[] };

const ALLOWED_COMMANDS = new Set([
  "prWatcher.refresh",
  "prWatcher.addRepository",
  "prWatcher.removeRepository",
  "prWatcher.editAuthors",
  "prWatcher.signIn",
  "prWatcher.showLog",
  "prWatcher.openSettings",
]);

export class Dashboard implements vscode.Disposable {
  static readonly viewType = "prWatcher.dashboard";
  private panel?: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly visibility = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this.visibility.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: () => DashboardState,
  ) {
    this.subscriptions.push(
      this.visibility,
      vscode.window.registerWebviewPanelSerializer(Dashboard.viewType, {
        deserializeWebviewPanel: async (panel) => this.attach(panel),
      }),
    );
  }

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.attach(
      vscode.window.createWebviewPanel(Dashboard.viewType, "Pull Requests", vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media"), vscode.Uri.joinPath(this.extensionUri, "dist", "codicons")],
      }),
    );
  }

  update() {
    void this.panel?.webview.postMessage({ type: "state", state: this.state() });
  }

  private attach(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "pr-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "pr-dark.svg"),
    };
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media"), vscode.Uri.joinPath(this.extensionUri, "dist", "codicons")],
    };
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.visibility.fire(false);
    });
    panel.onDidChangeViewState((e) => this.visibility.fire(e.webviewPanel.visible));
    panel.webview.onDidReceiveMessage((m: DashboardMessage) => this.receive(m));
    this.visibility.fire(true);
  }

  private receive(message: DashboardMessage) {
    switch (message.type) {
      case "ready":
        this.update();
        break;
      case "open":
        if (/^https:\/\//i.test(message.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(message.url, true));
        }
        break;
      case "copy":
        void vscode.env.clipboard.writeText(message.text).then(() => vscode.window.setStatusBarMessage("$(copy) Copied pull request link", 3000));
        break;
      case "command":
        if (ALLOWED_COMMANDS.has(message.command)) {
          void vscode.commands.executeCommand(message.command, ...(message.args ?? []));
        }
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css"));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${codicons}" rel="stylesheet">
<link href="${media("dashboard.css")}" rel="stylesheet">
<title>Pull Requests</title>
</head>
<body>
<header id="toolbar"></header>
<main id="content"></main>
<script nonce="${nonce}" src="${media("dashboard.js")}"></script>
</body>
</html>`;
  }

  dispose() {
    this.panel?.dispose();
    this.subscriptions.forEach((s) => s.dispose());
  }
}
