// Takes the README screenshots: serves a fictional Azure DevOps organization from a local fake server,
// starts VS Code with the extension through Playwright and captures the dashboard, the authors picker
// and a new pull request notification. Run `npm run compile` first, then `npm run screenshots`.
//
// `npm run screenshots -- --live` instead opens the dashboard on the repositories of
// PR_WATCHER_LIVE_REPOS (comma-separated URLs, authors in PR_WATCHER_LIVE_AUTHORS) with the
// Azure CLI's account and saves the screenshot in the temp folder, to check the real data.
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { _electron as electron } from "playwright-core";

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(extensionRoot, "images");
const live = process.argv.includes("--live");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "prw-shots-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Fictional organization ----

const ORG = "contoso";
const PROJECT = { id: "6f1d5c3e-0000-4000-8000-000000000001", name: "Fabrikam" };
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const person = (id, displayName) => ({ id, displayName, uniqueName: `${id}@contoso.com` });
const me = person("avery", "Avery Smith");
const priya = person("priya", "Priya Patel");
const jonas = person("jonas", "Jonas Weber");
const mei = person("mei", "Mei Chen");
const omar = person("omar", "Omar Haddad");
const sofia = person("sofia", "Sofia Rossi");
const team = { id: "payments-team", displayName: "[Fabrikam]\\Payments Team", isContainer: true };
const teamMembers = [me, priya, jonas, mei, omar];

const repos = {
  "payments-api": { id: "repo-payments", name: "payments-api" },
  "web-portal": { id: "repo-portal", name: "web-portal" },
};
const webUrl = (repo) => `https://dev.azure.com/${ORG}/${PROJECT.name}/_git/${repo}`;

const vote = (identity, value, extra = {}) => ({ ...identity, vote: value, ...extra });
const teamVote = (value) => ({ ...team, vote: value });

let nextId = 4211;
/** Pull requests with their policy evaluations and comment threads. */
const prs = [];
function addPr(repo, author, title, hours, options = {}) {
  const id = nextId++;
  prs.push({
    repo,
    pr: {
      pullRequestId: id,
      title,
      status: options.status ?? "active",
      createdBy: author,
      creationDate: hoursAgo(hours),
      closedDate: options.closedHours !== undefined ? hoursAgo(options.closedHours) : undefined,
      sourceRefName: `refs/heads/users/${author.id}/${options.branch ?? `pr-${id}`}`,
      targetRefName: `refs/heads/${options.target ?? "main"}`,
      mergeStatus: options.conflicts ? "conflicts" : "succeeded",
      isDraft: options.draft ?? false,
      reviewers: options.reviewers ?? [teamVote(0)],
      autoCompleteSetBy: options.autoComplete ? author : undefined,
      completionOptions: options.autoComplete ? { mergeStrategy: "squash" } : undefined,
      repository: { ...repos[repo], webUrl: webUrl(repo), project: PROJECT },
    },
    evaluations: options.evaluations ?? [],
    threads: Array.from({ length: options.comments ?? 0 }, (_, i) => ({ id: i + 1, status: "active", comments: [{ commentType: "text" }] })),
  });
}

let evaluationId = 0;
function evaluation(type, status, { blocking = true, settings = {}, context = null } = {}) {
  return { evaluationId: String(++evaluationId), status, context, configuration: { id: evaluationId, isBlocking: blocking, isEnabled: true, type: { id: type, displayName: type }, settings } };
}
const reviewers = (status, approvers = []) =>
  evaluation("Minimum number of reviewers", status, {
    settings: { minimumApproverCount: 2, requireVoteOnLastIteration: true },
    context: { lastIterationApprovers: approvers.map((p) => p.id) },
  });
const build = (status, name = "payments-api-PR", buildId = 1200) =>
  evaluation("Build", status, { context: { buildId, buildDefinitionName: name, isExpired: false } });
const policies = (...extra) => [evaluation("Work item linking", "approved"), evaluation("Status", "approved", { settings: { statusName: "Security scan" } }), ...extra];

addPr("payments-api", priya, "Add idempotency keys to refund requests", 2, {
  reviewers: [teamVote(0), vote(mei, 10)],
  evaluations: policies(reviewers("queued", [mei]), build("approved")),
  comments: 2,
});
addPr("payments-api", jonas, "Retry webhook deliveries with exponential backoff", 20, {
  reviewers: [teamVote(10), vote(priya, 10, { votedFor: [team] }), vote(omar, 10)],
  evaluations: policies(reviewers("queued", []), build("approved", "payments-api-PR", 1201)),
});
addPr("payments-api", mei, "Migrate settlement jobs to the new scheduler", 6, {
  reviewers: [teamVote(0)],
  evaluations: policies(reviewers("queued"), build("rejected", "payments-api-PR", 1202)),
  comments: 1,
});
addPr("payments-api", omar, "Bump Azure SDK packages", 3, {
  reviewers: [teamVote(10), vote(priya, 10), vote(jonas, 10)],
  evaluations: policies(reviewers("approved", [priya, jonas]), build("running", "payments-api-PR", 1203)),
  autoComplete: true,
});
addPr("payments-api", me, "Validate currency codes against ISO 4217", 26, {
  reviewers: [teamVote(0), vote(jonas, 5)],
  evaluations: policies(reviewers("queued", [jonas]), build("approved", "payments-api-PR", 1204)),
  comments: 3,
});
addPr("payments-api", priya, "Split the ledger service into read and write paths", 30, {
  reviewers: [teamVote(-5), vote(me, -5)],
  evaluations: policies(reviewers("queued"), build("approved", "payments-api-PR", 1205)),
  comments: 4,
});
addPr("payments-api", jonas, "Log correlation IDs in payment events", 30, {
  status: "completed",
  closedHours: 5,
  reviewers: [teamVote(10), vote(me, 10), vote(mei, 10)],
});
addPr("web-portal", sofia, "Dark mode for the account settings page", 8, {
  reviewers: [vote(me, 10), vote(mei, 10)],
  evaluations: policies(reviewers("approved", [me, mei]), build("approved", "web-portal-PR", 1206)),
});
addPr("web-portal", mei, "Show pending refunds on the order history", 12, {
  reviewers: [vote(sofia, 10), vote(jonas, 10)],
  evaluations: policies(reviewers("approved", [sofia, jonas]), build("approved", "web-portal-PR", 1207), evaluation("Comment requirements", "rejected")),
  comments: 1,
});
addPr("web-portal", sofia, "Upgrade the router and lazy-load the checkout", 40, {
  reviewers: [vote(priya, 0)],
  evaluations: policies(reviewers("queued"), build("approved", "web-portal-PR", 1208)),
  conflicts: true,
});
addPr("web-portal", omar, "Fix focus order in the payment form", 70, {
  status: "completed",
  closedHours: 50,
  reviewers: [vote(sofia, 10), vote(me, 10)],
});

/** Appears after the first refresh, for the notification. */
function addNewPr() {
  addPr("payments-api", omar, "Reject expired cards before authorization", 0.05, {
    reviewers: [teamVote(0)],
    evaluations: policies(reviewers("queued"), build("running", "payments-api-PR", 1209)),
  });
}

// ---- Fake Azure DevOps REST API ----

function route(url) {
  const u = new URL(url, "http://localhost");
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const json = (value) => ({ status: 200, body: value });
  const list = (value) => json({ count: value.length, value });
  if (parts[1] === "_apis" && parts[2] === "connectionData") {
    return json({ authenticatedUser: { id: me.id, providerDisplayName: me.displayName, properties: { Account: { $value: me.uniqueName } } } });
  }
  if (parts[1] === "_apis" && parts[2] === "identities") {
    const ids = (u.searchParams.get("identityIds") ?? "").split(",").filter(Boolean);
    const name = u.searchParams.get("filterValue");
    const group = { id: team.id, isContainer: true, memberIds: teamMembers.map((m) => m.id) };
    if (name) {
      return list(name.toLowerCase() === team.displayName.toLowerCase() ? [group] : []);
    }
    return list(ids.map((id) => (id === team.id ? group : { id, isContainer: false })));
  }
  if (parts[1] === "_apis" && parts[2] === "projects" && parts[4] === "teams") {
    if (parts[6] === "members") {
      return parts[5].toLowerCase() === "payments team" ? list(teamMembers.map((identity) => ({ identity }))) : { status: 404, body: { message: "Team not found" } };
    }
    return list([{ id: team.id, name: "Payments Team" }]);
  }
  if (parts[2] === "_apis" && parts[3] === "policy") {
    const id = Number(u.searchParams.get("artifactId").split("/").pop());
    return list(prs.find((p) => p.pr.pullRequestId === id)?.evaluations ?? []);
  }
  if (parts[2] === "_apis" && parts[3] === "git" && parts[4] === "repositories") {
    const repo = repos[parts[5]];
    if (!repo) {
      return { status: 404, body: { message: "Repository not found" } };
    }
    if (parts.length === 6) {
      return json({ ...repo, webUrl: webUrl(repo.name), project: PROJECT });
    }
    if (parts[6].toLowerCase() === "pullrequests" && parts[8] === "threads") {
      return list(prs.find((p) => p.pr.pullRequestId === Number(parts[7]))?.threads ?? []);
    }
    const status = u.searchParams.get("searchCriteria.status");
    const skip = Number(u.searchParams.get("$skip") ?? 0);
    return list(skip > 0 ? [] : prs.filter((p) => p.repo === repo.name && p.pr.status === status).map((p) => p.pr));
  }
  return { status: 404, body: { message: `No route for ${u.pathname}` } };
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { status, body } = route(req.url);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ---- VS Code ----

async function main() {
  const server = live ? undefined : await startServer();
  const executablePath = await downloadAndUnzipVSCode(process.env.PR_WATCHER_TEST_VSCODE ?? "stable");
  const userData = path.join(profile, "data");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  const repositories = live
    ? (process.env.PR_WATCHER_LIVE_REPOS ?? "").split(",").filter(Boolean)
    : [webUrl("payments-api"), webUrl("web-portal")];
  const authors = live ? (process.env.PR_WATCHER_LIVE_AUTHORS ?? "").split(",").filter(Boolean) : ["Payments Team", "Sofia Rossi"];
  fs.writeFileSync(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({
      "window.dialogStyle": "custom",
      "window.restoreWindows": "none",
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.layoutControl.enabled": false,
      "workbench.activityBar.location": "hidden",
      "chat.disableAIFeatures": true,
      "window.commandCenter": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.ignoreRecommendations": true,
      "workbench.colorTheme": "Default Dark Modern",
      "prWatcher.repositories": repositories,
      "prWatcher.authors": authors,
      ...(live ? { "prWatcher.authentication": "azureCli" } : {}),
    }),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("VSCODE_")) {
      delete env[key];
    }
  }
  if (server) {
    env.PR_WATCHER_ADO_URL = `http://127.0.0.1:${server.address().port}`;
  }
  const app = await electron.launch({
    executablePath,
    env,
    args: [
      `--extensionDevelopmentPath=${extensionRoot}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(profile, "extensions")}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--force-device-scale-factor=1",
    ],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setContentSize(1440, 820);
      win.center();
    });
    await sleep(3000);

    const runCommand = async (title) => {
      await page.keyboard.press("F1");
      await page.waitForSelector(".quick-input-widget:not([style*='display: none'])");
      await page.keyboard.type(title);
      await sleep(600);
      await page.keyboard.press("Enter");
      await sleep(800);
    };
    const shot = async (name, clip) => {
      await page.mouse.move(1430, 600);
      await sleep(800);
      const file = live ? path.join(os.tmpdir(), `prw-live-${name}`) : path.join(imagesDir, name);
      await page.screenshot({ path: file, clip });
      console.log(`wrote ${file}`);
    };
    /** The dashboard's document, inside the webview's nested iframes. */
    const dashboard = async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        for (const frame of page.frames()) {
          if (await frame.locator("#toolbar").count().catch(() => 0)) {
            return frame;
          }
        }
        await sleep(500);
      }
      throw new Error("The dashboard did not open.");
    };

    fs.mkdirSync(imagesDir, { recursive: true });
    await runCommand("Notifications: Clear All Notifications");
    if (await page.locator(".part.sidebar").isVisible()) {
      await page.keyboard.press("Control+B");
    }
    await runCommand("PR Watcher: Open Dashboard");
    const frame = await dashboard();
    await frame.waitForSelector(".pr", { timeout: live ? 120_000 : 30_000 });
    await frame.waitForFunction(() => !document.querySelector(".updated")?.textContent?.startsWith("Refreshing"), undefined, { timeout: 120_000 });
    await sleep(1500);
    await shot("dashboard.png");
    if (live) {
      return;
    }

    await frame.locator(".filter", { hasText: "Needs review" }).click();
    await sleep(500);
    await shot("needs-review.png");
    await frame.locator(".filter", { hasText: "Active" }).first().click();

    // A new pull request appears on the next refresh.
    addNewPr();
    await runCommand("PR Watcher: Refresh");
    await page.waitForSelector(".notification-toast", { timeout: 30_000 });
    await sleep(1000);
    await shot("notification.png");
    await runCommand("Notifications: Clear All Notifications");

    await runCommand("PR Watcher: Edit Watched Authors…");
    await page.waitForSelector(".quick-input-list .monaco-list-row", { timeout: 30_000 });
    await sleep(500);
    await page.keyboard.type("sofia@contoso.com");
    await page.keyboard.press("Enter");
    await sleep(800);
    await shot("authors.png");
    await page.keyboard.press("Escape");
  } catch (e) {
    const page = app.windows()[0];
    const file = path.join(os.tmpdir(), "prw-shots-debug.png");
    await page?.screenshot({ path: file }).catch(() => undefined);
    console.error(`Debug screenshot: ${file}`);
    throw e;
  } finally {
    await app.close().catch(() => undefined);
    server?.close();
  }
}

try {
  await main();
} finally {
  await sleep(1000);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
