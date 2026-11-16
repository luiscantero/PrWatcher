import { execFile } from "child_process";
import * as vscode from "vscode";
import { AuthError } from "./ado";

/** The Azure DevOps resource of Microsoft Entra ID. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const PAT_KEY = "prWatcher.pat";

export type AuthMethod = "microsoft" | "azureCli" | "pat";

export class Auth implements vscode.Disposable {
  private cliToken?: { token: string; expires: number };
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subscriptions.push(
      this.changed,
      vscode.authentication.onDidChangeSessions((e) => e.provider.id === "microsoft" && this.method() === "microsoft" && this.changed.fire()),
      secrets.onDidChange((e) => e.key === PAT_KEY && this.changed.fire()),
    );
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
  }

  method(): AuthMethod {
    return vscode.workspace.getConfiguration("prWatcher").get<AuthMethod>("authentication", "microsoft");
  }

  private scopes(): string[] {
    const tenant = vscode.workspace.getConfiguration("prWatcher").get<string>("tenant", "").trim();
    return [`${ADO_RESOURCE}/.default`, ...(tenant ? [`VSCODE_TENANT:${tenant}`] : [])];
  }

  /** The `Authorization` header, or an `AuthError` when the user has to sign in first. */
  async header(): Promise<string> {
    switch (this.method()) {
      case "pat": {
        const pat = await this.secrets.get(PAT_KEY);
        if (!pat) {
          throw new AuthError("No personal access token is set. Run PR Watcher: Set Personal Access Token….");
        }
        return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
      }
      case "azureCli":
        return `Bearer ${await this.azureCliToken()}`;
      default: {
        const session = await vscode.authentication.getSession("microsoft", this.scopes(), { silent: true });
        if (!session) {
          throw new AuthError("Sign in with your Microsoft account to read pull requests from Azure DevOps.");
        }
        return `Bearer ${session.accessToken}`;
      }
    }
  }

  /** Interactive sign-in for the configured method. Returns whether credentials are available afterwards. */
  async signIn(): Promise<boolean> {
    switch (this.method()) {
      case "pat":
        return this.promptForPat();
      case "azureCli":
        this.cliToken = undefined;
        try {
          await this.azureCliToken();
          this.changed.fire();
          return true;
        } catch (e) {
          void vscode.window.showErrorMessage(`PR Watcher: ${(e as Error).message}`);
          return false;
        }
      default: {
        const session = await vscode.authentication.getSession("microsoft", this.scopes(), { createIfNone: true });
        this.changed.fire();
        return session !== undefined;
      }
    }
  }

  /** Called when Azure DevOps rejects the credentials, so the next request gets new ones. */
  async invalidate(): Promise<void> {
    this.cliToken = undefined;
  }

  async promptForPat(): Promise<boolean> {
    const pat = await vscode.window.showInputBox({
      title: "PR Watcher: Personal Access Token",
      prompt: "Azure DevOps personal access token with the Code (Read) scope. It is kept in VS Code's secret storage.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!pat) {
      return false;
    }
    await this.secrets.store(PAT_KEY, pat.trim());
    if (this.method() !== "pat") {
      await vscode.workspace.getConfiguration("prWatcher").update("authentication", "pat", vscode.ConfigurationTarget.Global);
    }
    this.changed.fire();
    return true;
  }

  private azureCliToken(): Promise<string> {
    if (this.cliToken && this.cliToken.expires - Date.now() > 5 * 60_000) {
      return Promise.resolve(this.cliToken.token);
    }
    return new Promise((resolve, reject) => {
      // `az` is a .cmd script on Windows, which needs a shell; the arguments are constants.
      execFile(
        "az",
        ["account", "get-access-token", "--resource", ADO_RESOURCE, "--output", "json"],
        { shell: process.platform === "win32", timeout: 60_000, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            this.log.warn(`az account get-access-token failed: ${stderr || error.message}`);
            reject(new AuthError("The Azure CLI has no token for Azure DevOps. Run `az login` in a terminal, then refresh."));
            return;
          }
          try {
            const data = JSON.parse(stdout) as { accessToken: string; expires_on?: number; expiresOn?: string };
            const expires = data.expires_on ? data.expires_on * 1000 : data.expiresOn ? Date.parse(data.expiresOn) : Date.now() + 30 * 60_000;
            this.cliToken = { token: data.accessToken, expires };
            resolve(data.accessToken);
          } catch (e) {
            reject(new AuthError(`Unexpected output of the Azure CLI: ${(e as Error).message}`));
          }
        },
      );
    });
  }
}
