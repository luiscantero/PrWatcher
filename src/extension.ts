import * as vscode from "vscode";
import { AdoClient, AuthError } from "./ado";
import { Auth } from "./auth";
import { RepositorySetting, WatchedRepo, parseRepoUrl, readRepositories, repoKey, repoWebUrl } from "./config";
import { Dashboard } from "./dashboard";
import { PrView } from "./status";
import { DashboardState, Watcher } from "./watcher";

const SEEN_KEY = "prWatcher.seen";
const STATE_KEY = "prWatcher.lastState";
const SEEN_DAYS = 30;

type SettingEntry = string | RepositorySetting;

function config() {
  return vscode.workspace.getConfiguration("prWatcher");
}

function watchOptions() {
  const c = config();
  const { repos, problems } = readRepositories(c.get<SettingEntry[]>("repositories", []), c.get<string[]>("authors", []));
  return {
    repos,
    problems,
    retentionHours: c.get<number>("closedRetentionHours", 60),
    showAbandoned: c.get<boolean>("showAbandoned", false),
    showDrafts: c.get<boolean>("showDrafts", false),
  };
}

/** Writes `prWatcher.repositories` where it is defined (workspace or user settings). */
async function updateRepositories(update: (entries: SettingEntry[]) => SettingEntry[]): Promise<void> {
  const inspect = config().inspect<SettingEntry[]>("repositories");
  const target =
    inspect?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspect?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  const current =
    target === vscode.ConfigurationTarget.WorkspaceFolder
      ? inspect?.workspaceFolderValue
      : target === vscode.ConfigurationTarget.Workspace
        ? inspect?.workspaceValue
        : inspect?.globalValue;
  await config().update("repositories", update([...(current ?? [])]), target);
}

function entryKey(entry: SettingEntry): string | undefined {
  const ref = parseRepoUrl(typeof entry === "string" ? entry : (entry?.url ?? ""));
  return ref ? repoKey(ref) : undefined;
}

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("PR Watcher", { log: true });
  const auth = new Auth(context.secrets, log);
  // Undocumented: a fake Azure DevOps for the screenshots (scripts/screenshots.mjs).
  const fakeAdo = process.env.PR_WATCHER_ADO_URL;
  const client = new AdoClient(
    fakeAdo ? async () => "Bearer demo" : () => auth.header(),
    (m) => log.trace(m),
    fakeAdo,
  );
  const watcher = new Watcher(client, (m) => log.info(m));
  const cached = context.globalState.get<DashboardState>(STATE_KEY);
  let state: DashboardState = cached
    ? { ...cached, loading: false }
    : { repos: [], loading: false, problems: [], retentionHours: watchOptions().retentionHours };
  const dashboard = new Dashboard(context.extensionUri, () => state);
  const statusBar = vscode.window.createStatusBarItem("prWatcher.status", vscode.StatusBarAlignment.Left, 50);
  statusBar.name = "PR Watcher";
  statusBar.command = "prWatcher.openDashboard";
  context.subscriptions.push(log, auth, dashboard, statusBar);

  const updateStatusBar = () => {
    const c = config();
    if (!c.get<boolean>("statusBar", true) || watchOptions().repos.length === 0) {
      statusBar.hide();
      return;
    }
    const all = state.repos.flatMap((r) => r.prs);
    const review = all.filter((pr) => pr.needsMyReview);
    statusBar.text = state.signIn ? "$(git-pull-request) $(account)" : `$(git-pull-request) ${review.length}`;
    const tooltip = new vscode.MarkdownString(undefined, true);
    if (state.signIn) {
      tooltip.appendMarkdown(`**PR Watcher:** ${state.signIn}`);
    } else if (review.length === 0) {
      tooltip.appendMarkdown(`**PR Watcher:** nothing needs your review (${all.filter((pr) => pr.status === "active").length} active)`);
    } else {
      tooltip.appendMarkdown(`**PR Watcher:** ${review.length} pull request${review.length === 1 ? "" : "s"} need${review.length === 1 ? "s" : ""} your review\n\n`);
      for (const pr of review.slice(0, 10)) {
        tooltip.appendMarkdown(`- [${escapeMarkdown(pr.title)}](${pr.url}) — ${escapeMarkdown(pr.author)}\n`);
      }
    }
    statusBar.tooltip = tooltip;
    statusBar.accessibilityInformation = { label: `PR Watcher: ${review.length} pull requests need your review` };
    statusBar.show();
  };

  const setState = (next: DashboardState) => {
    state = next;
    dashboard.update();
    updateStatusBar();
  };

  // Notifications for pull requests that were not there before.
  const notify = async (prs: PrView[], loadedRepos: string[]) => {
    const seen = context.globalState.get<{ keys: Record<string, number>; repos: string[] }>(SEEN_KEY);
    const now = Date.now();
    const keys: Record<string, number> = {};
    for (const [key, time] of Object.entries(seen?.keys ?? {})) {
      if (now - time < SEEN_DAYS * 86_400_000) {
        keys[key] = time;
      }
    }
    const knownRepos = new Set(seen?.repos ?? []);
    const mode = config().get<string>("notifications", "all");
    const fresh = prs.filter(
      (pr) =>
        keys[pr.key] === undefined &&
        knownRepos.has(pr.repoKey) &&
        pr.status === "active" &&
        !pr.draft &&
        !pr.mine &&
        (mode === "all" || (mode === "reviewRequested" && pr.reviewRequested)),
    );
    prs.forEach((pr) => (keys[pr.key] = keys[pr.key] ?? now));
    loadedRepos.forEach((r) => knownRepos.add(r));
    await context.globalState.update(SEEN_KEY, { keys, repos: [...knownRepos] });
    if (mode === "off" || fresh.length === 0) {
      return;
    }
    if (fresh.length === 1) {
      const pr = fresh[0];
      const repo = pr.repoKey.split("/").pop();
      const choice = await vscode.window.showInformationMessage(`New pull request in ${repo} by ${pr.author}: ${pr.title}`, "Open", "Show Dashboard");
      if (choice === "Open") {
        void vscode.env.openExternal(vscode.Uri.parse(pr.url, true));
      } else if (choice === "Show Dashboard") {
        dashboard.show();
      }
    } else {
      const choice = await vscode.window.showInformationMessage(`${fresh.length} new pull requests from your team.`, "Show Dashboard");
      if (choice) {
        dashboard.show();
      }
    }
  };

  let running: Promise<void> | undefined;
  let again = false;
  let lastRefresh = 0;
  const refresh = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const options = watchOptions();
        if (options.repos.length === 0) {
          setState({ repos: [], loading: false, problems: options.problems, retentionHours: options.retentionHours, me: state.me });
          lastRefresh = Date.now();
          continue;
        }
        // Keep the previous list, in the order of the settings, while loading.
        const previous = new Map(state.repos.map((r) => [r.key, r]));
        setState({
          ...state,
          loading: true,
          problems: options.problems,
          retentionHours: options.retentionHours,
          repos: options.repos.map((r) => ({
            ...(previous.get(r.key) ?? { key: r.key, name: r.repository, organization: r.organization, project: r.project, url: repoWebUrl(r), prs: [] }),
            authorsLabel: r.authorsLabel,
          })),
        });
        try {
          const next = await watcher.load(options, state);
          lastRefresh = Date.now();
          setState(next);
          if (next.signIn) {
            await auth.invalidate();
          } else {
            await context.globalState.update(STATE_KEY, next);
            await notify(
              next.repos.flatMap((r) => r.prs),
              next.repos.filter((r) => !r.error).map((r) => r.key),
            );
          }
        } catch (e) {
          log.error(`${(e as Error).stack ?? e}`);
          setState({ ...state, loading: false, signIn: e instanceof AuthError ? e.message : state.signIn });
        }
      } while (again);
    })().finally(() => (running = undefined));
    return running;
  };

  const intervalMs = () => Math.max(30, config().get<number>("refreshIntervalSeconds", 120)) * 1000;
  const refreshIfOlderThan = (ms: number) => {
    if (vscode.window.state.focused && Date.now() - lastRefresh >= ms && watchOptions().repos.length > 0) {
      void refresh();
    }
  };
  const refreshIfDue = () => refreshIfOlderThan(intervalMs());
  // Coming back to VS Code, for example after voting in the browser, shows the change right away.
  const onReturn = () => refreshIfOlderThan(15_000);
  const timer = setInterval(refreshIfDue, 15_000);
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidChangeWindowState((e) => e.focused && onReturn()),
    dashboard.onDidChangeVisibility((visible) => visible && onReturn()),
    auth.onDidChange(() => {
      watcher.reset();
      void refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("prWatcher")) {
        updateStatusBar();
        if (!e.affectsConfiguration("prWatcher.statusBar") || e.affectsConfiguration("prWatcher.repositories") || e.affectsConfiguration("prWatcher.authors")) {
          void refresh();
        }
      }
    }),
  );

  const guard =
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (e) {
        log.error(`${(e as Error).stack ?? e}`);
        void vscode.window.showErrorMessage(`PR Watcher: ${(e as Error).message}`, "Show Log").then((a) => a && log.show());
      }
    };

  const pickRepo = async (key: unknown, placeHolder: string): Promise<WatchedRepo | undefined> => {
    const repos = watchOptions().repos;
    if (typeof key === "string") {
      return repos.find((r) => r.key === key);
    }
    if (repos.length === 0) {
      void vscode.window.showInformationMessage("PR Watcher: no repositories are watched yet.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: r.repository, description: `${r.organization}/${r.project}`, detail: `Authors: ${r.authorsLabel}`, repo: r })),
      { placeHolder },
    );
    return picked?.repo;
  };

  /** Asks whose pull requests to show; undefined when cancelled, [] to use `prWatcher.authors`. */
  const pickAuthors = async (repo: { organization: string; project: string; repository: string }, current: string[]): Promise<string[] | undefined> => {
    type Item = vscode.QuickPickItem & { value?: string; kind?: vscode.QuickPickItemKind };
    const defaults = config().get<string[]>("authors", []);
    const teams = await client.myTeams(repo.organization, repo.project).catch((e) => {
      log.warn(`Could not list your teams in ${repo.project}: ${(e as Error).message}`);
      return [];
    });
    const values = new Set([...current, ...teams.map((t) => t.name)]);
    const items: Item[] = [
      { label: "$(globe) Everyone", value: "*", picked: current.includes("*"), description: "All pull requests of the repository" },
      { label: "Teams and people", kind: vscode.QuickPickItemKind.Separator },
      ...[...values]
        .filter((v) => v !== "*")
        .map((v) => ({
          label: `${v.includes("@") ? "$(person)" : "$(organization)"} ${v}`,
          value: v,
          picked: current.includes(v),
          description: teams.some((t) => t.name === v) ? "your team" : undefined,
        })),
    ];
    const quickPick = vscode.window.createQuickPick<Item>();
    quickPick.title = `Whose pull requests to show in ${repo.repository}${defaults.length > 0 ? ` (none checked: ${defaults.join(", ")})` : ""}`;
    quickPick.placeholder = "Type a team, [Project]\\Group, email or name (for example a build service) and press Enter to add it";
    quickPick.canSelectMany = true;
    quickPick.items = items;
    quickPick.selectedItems = items.filter((i) => i.picked);
    quickPick.ignoreFocusOut = true;
    return new Promise((resolve) => {
      let done = false;
      quickPick.onDidAccept(() => {
        const typed = quickPick.value.trim();
        if (typed) {
          // Add what was typed as a new checked entry and keep the picker open.
          const item: Item = { label: `${typed.includes("@") ? "$(person)" : "$(organization)"} ${typed}`, value: typed, picked: true };
          quickPick.items = [...quickPick.items, item];
          quickPick.selectedItems = [...quickPick.selectedItems, item];
          quickPick.value = "";
          return;
        }
        done = true;
        resolve(quickPick.selectedItems.flatMap((i) => (i.value ? [i.value] : [])));
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        if (!done) {
          resolve(undefined);
        }
        quickPick.dispose();
      });
      quickPick.show();
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("prWatcher.openDashboard", () => {
      dashboard.show();
      if (Date.now() - lastRefresh > 30_000) {
        void refresh();
      }
    }),
    vscode.commands.registerCommand("prWatcher.refresh", guard(refresh)),
    vscode.commands.registerCommand(
      "prWatcher.addRepository",
      guard(async () => {
        const clipboard = await vscode.env.clipboard.readText();
        const url = await vscode.window.showInputBox({
          title: "PR Watcher: Add Repository",
          prompt: "URL of an Azure DevOps repository or of its pull requests page",
          placeHolder: "https://dev.azure.com/organization/project/_git/repository",
          value: parseRepoUrl(clipboard) ? clipboard.trim() : undefined,
          ignoreFocusOut: true,
          validateInput: (v) => (parseRepoUrl(v) ? undefined : "Enter a URL such as https://dev.azure.com/organization/project/_git/repository"),
        });
        const ref = url ? parseRepoUrl(url) : undefined;
        if (!ref) {
          return;
        }
        const key = repoKey(ref);
        if (watchOptions().repos.some((r) => r.key === key)) {
          void vscode.window.showInformationMessage(`PR Watcher: ${ref.repository} is already watched.`);
          dashboard.show();
          return;
        }
        let repository: Awaited<ReturnType<AdoClient["repository"]>>;
        try {
          repository = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Looking up ${ref.repository}…` }, () => client.repository(ref));
        } catch (e) {
          if (e instanceof AuthError) {
            const choice = await vscode.window.showWarningMessage(`PR Watcher: ${e.message}`, "Sign In");
            if (choice && (await auth.signIn())) {
              await vscode.commands.executeCommand("prWatcher.addRepository");
            }
            return;
          }
          throw new Error(`Could not open ${ref.organization}/${ref.project}/${ref.repository}: ${(e as Error).message}`);
        }
        const canonical = { organization: ref.organization, project: repository.project.name, repository: repository.name };
        const authors = await pickAuthors(canonical, []);
        if (authors === undefined) {
          return;
        }
        const entry: RepositorySetting = { url: repository.webUrl || repoWebUrl(canonical) };
        if (authors.length > 0) {
          entry.authors = authors;
        }
        await updateRepositories((entries) => [...entries, entry]);
        dashboard.show();
      }),
    ),
    vscode.commands.registerCommand(
      "prWatcher.removeRepository",
      guard(async (key?: unknown) => {
        const repo = await pickRepo(key, "Repository to stop watching");
        if (!repo) {
          return;
        }
        const choice = await vscode.window.showWarningMessage(`Stop watching pull requests in ${repo.repository}?`, { modal: true }, "Remove");
        if (choice === "Remove") {
          await updateRepositories((entries) => entries.filter((e) => entryKey(e) !== repo.key));
        }
      }),
    ),
    vscode.commands.registerCommand(
      "prWatcher.editAuthors",
      guard(async (key?: unknown) => {
        const repo = await pickRepo(key, "Repository whose watched authors to edit");
        if (!repo) {
          return;
        }
        const entries = config().get<SettingEntry[]>("repositories", []);
        const entry = entries.find((e) => entryKey(e) === repo.key);
        const current = entry && typeof entry !== "string" ? (entry.authors ?? []) : [];
        const authors = await pickAuthors(repo, current);
        if (authors === undefined) {
          return;
        }
        await updateRepositories((list) =>
          list.map((e) => {
            if (entryKey(e) !== repo.key) {
              return e;
            }
            const url = typeof e === "string" ? e : e.url;
            return authors.length > 0 ? { url, authors } : { url };
          }),
        );
      }),
    ),
    vscode.commands.registerCommand(
      "prWatcher.signIn",
      guard(async () => {
        if (await auth.signIn()) {
          watcher.reset();
          await refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("prWatcher.setPersonalAccessToken", guard(() => auth.promptForPat())),
    vscode.commands.registerCommand("prWatcher.showLog", () => log.show()),
    vscode.commands.registerCommand("prWatcher.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`),
    ),
  );

  updateStatusBar();
  if (watchOptions().repos.length > 0) {
    // Load in the background so the status bar and the dashboard are current.
    setTimeout(() => void refresh(), 2000);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

export function deactivate() {
  // Disposables registered on the context stop the timer.
}
