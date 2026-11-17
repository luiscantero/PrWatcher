# PR Watcher for Azure DevOps

**A dashboard of your team's Azure DevOps pull requests across repositories**, right in VS Code:
which ones need your review, how many approvals they have, which approvals a new push made stale,
whether validation failed or a policy still blocks them, and whether auto-complete is set. Merged
pull requests stay listed for 60 hours, so whoever missed them can still leave comments.

Built to replace review requests in a chat, where merged pull requests stay around and people keep
opening links only to find that they are already merged.

![Dashboard with pull requests of two repositories, their review state, approvals, validation and policies](images/dashboard.png)

## Features

- **Dashboard tab** (*PR Watcher: Open Dashboard*, or click the pull request count in the status
  bar): pull requests of every watched repository, grouped by repository or as one list, newest
  first, with merged ones at the end under a collapsed *Merged* row. Click a pull request to open
  it in the browser.
  Each row shows
  - its **state** as an icon, from the most to the least urgent: *Conflicts*, *Failed* (with the
    build), *Rejected*, *Waiting for author*, *Needs re-approval after new push*, *Needs review*,
    *Validation running*, *Blocked* (for example by unresolved comments), *Ready to complete*,
    *Approved, auto-complete set*, *Merged* and, if `prWatcher.showAbandoned` is on, *Abandoned*;
    hover it for the state,
  - the author and age; hover the title for the pull request ID and branches,
  - five status icons, always in the same columns, red when something required is missing, orange
    for something less urgent, green when done and faded when there is nothing to show. Their
    tooltips list the details from the most to the least urgent, so what remains once the problems
    are solved is green:
    1. **Approvals** on the latest push against the approvals the branch policy requires (`1/2`):
       red without approvals or with a rejection, orange while waiting for the author or for more
       approvals or a required reviewer. The tooltip lists who rejected, who is
       waiting, what is missing, approvals of an earlier push that no longer count, and who
       approved.
    2. **Validation builds**: red when a required build failed or expired, spinning while required
       builds run, orange when an optional build failed, green when all passed. Click it to open
       the most urgent build.
    3. **Branch policies** (a lock): red when a required policy is not met or still pending, orange
       when an optional one failed (marked *(optional)*, such as *Link work item*), green when all
       are met. Proof of presence is listed here too.
    4. **Comments**: orange with the number of unresolved threads, green when all are resolved,
       faded without comments; the tooltip shows how many are resolved (`Resolved comments: 3/5`).
    5. **Auto-complete**: green when set (the tooltip names who set it and the merge strategy),
       faded otherwise.
  - a blue bar on the left when it needs your review, and *Yours* for your own.

  The tabs at the top count the active pull requests, those that need your review and yours, and
  list the recently closed ones; type to filter by title,
  author, branch or state.

  ![Needs review filter](images/needs-review.png)

- **Watch teams, groups or people**: the pull requests of the members of a team
  (`AIO Connectors Team`), of a group (`[Project]\Group`, nested groups included), of people
  (`someone@contoso.com`), of anyone by the name Azure DevOps shows as a pull request's author,
  such as agents (`Agency`), build services (`One Build Service (contoso)`) or people
  (`Jane Doe`), or everyone's. A name that is not a team of the repository's project or a group
  of it is matched against the authors' names; a `[Project]\Group` that does not exist is reported
  on the repository without hiding the other authors' pull requests.
  *PR Watcher: Add Repository…* takes the URL of a repository or of its pull requests page
  (pasted from the clipboard if it holds one). *Edit Watched Authors…* (the person button in the
  dashboard's toolbar) sets the authors for all repositories at once and offers your teams of
  their projects. A repository can still have its own `authors` in `prWatcher.repositories`;
  editing the authors in the dashboard replaces them with the shared list.

- **Share the configuration with your team**: *Export Settings…* (a link at the top of PR
  Watcher's settings, opened with the gear button in the dashboard, or the Command Palette) saves
  the watched repositories, the authors and the other settings you changed to a JSON file
  (`pr-watcher-settings.json`, with the same `prWatcher.*` keys as settings.json). Your teammates
  load it with *Import Settings…* (the link next to it) and choose
  *Add*, to keep their repositories and authors and add the imported ones, or *Replace*. Personal
  settings, such as how you sign in, are not exported.

  ![Choosing whose pull requests to show](images/authors.png)

- **Notifications** for new pull requests of the watched authors (see `prWatcher.notifications`),
  and the **status bar** shows how many pull requests need your review, with a tooltip that lists
  them.

  ![Notification about a new pull request](images/notification.png)

- **Recently closed**: merged pull requests stay listed for
  `prWatcher.closedRetentionHours` (60 by default), with the time until they disappear. They are
  collapsed under *Merged* at the end of each repository (click to expand); the *Recently closed*
  filter lists them directly.

The dashboard checks for changes every 2 minutes while the VS Code window is focused or the
dashboard is visible, and right away when you come back to VS Code or to the dashboard (for example
after voting in the browser), unless it checked in the last 15 seconds. It opens with the pull
requests of the last check.

## How the state is determined

PR Watcher reads the pull request, its reviewers, its [policy
evaluations](https://learn.microsoft.com/rest/api/azure/devops/policy/evaluations) and its comment
threads:

- **Approvals** count people who voted *Approved* or *Approved with suggestions*, not the author
  and not group reviewers (a group's vote reflects its members).
- **Re-approval after a new push**: when the *Minimum number of reviewers* policy requires a vote
  on the last iteration, the approvers it lists for the latest push are current; other approvals
  are of an earlier push. (When the policy resets votes on new pushes instead, the votes are
  already back to *No vote*.)
- **Needs review** while a blocking reviewer policy (*Minimum number of reviewers*, *Required
  reviewers*, *Proof of presence*) is not met, a required reviewer has not approved, or, without
  reviewer policies, nobody has approved.
- **Validation failed** when a blocking build policy failed or expired; optional builds are only
  shown when they failed.
- **Blocked** by other blocking policies that are not met, such as comment requirements, work item
  linking or status checks. *Require a merge strategy* is only met when completing, so it is
  ignored until then.
- **Needs your review** (the blue bar and the *Needs review* tab) applies to pull requests
  that still need reviews, that you have not approved
  on their latest push and did not reject or wait on, and that are not yours or drafts. In
  repositories that show everyone's pull requests, only those where you or one of your groups is a
  reviewer count.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `prWatcher.repositories` | `[]` | Repositories to watch: URLs, or `{ "url": "…", "authors": ["…"] }` to override `prWatcher.authors` for that repository. |
| `prWatcher.authors` | `[]` | Whose pull requests to show where a repository has no `authors`: team names (of each repository's project), groups such as `[Project]\Group` or `[TEAM FOUNDATION]\Group`, emails, or the name shown for pull request authors, such as `Agency` or `One Build Service (contoso)`. Empty or `*` shows everyone's. |
| `prWatcher.closedRetentionHours` | `60` | How long merged and abandoned pull requests stay listed, in hours. |
| `prWatcher.showAbandoned` | `false` | List abandoned pull requests too, like merged ones. |
| `prWatcher.showDrafts` | `false` | List draft pull requests. |
| `prWatcher.refreshIntervalSeconds` | `120` | How often to check for changes while the window is focused. |
| `prWatcher.notifications` | `all` | `off`, `reviewRequested` (you or one of your groups is a reviewer) or `all` (every new pull request of the watched authors except yours). |
| `prWatcher.statusBar` | `true` | Show the number of pull requests that need your review in the status bar. |
| `prWatcher.authentication` | `microsoft` | `microsoft` (the Microsoft account of VS Code's Accounts menu), `azureCli` (`az login`) or `pat` (a personal access token with *Code (Read)* scope). |
| `prWatcher.tenant` | `""` | Microsoft Entra tenant to sign in to, when the organization is not in your account's home tenant. |

For example:

```jsonc
"prWatcher.authors": ["Payments Team", "sofia@contoso.com"],
"prWatcher.repositories": [
  "https://dev.azure.com/contoso/Fabrikam/_git/payments-api",
  "https://dev.azure.com/contoso/Fabrikam/_git/web-portal",
  // Everyone's pull requests in this one.
  { "url": "https://dev.azure.com/contoso/Fabrikam/_git/shared-libraries", "authors": ["*"] }
]
```

## Commands

| Command | Description |
| --- | --- |
| `PR Watcher: Open Dashboard` | Open the dashboard tab. |
| `PR Watcher: Refresh` | Check for changes now. |
| `PR Watcher: Add Repository…` | Watch a repository, given its URL, and choose whose pull requests to show. |
| `PR Watcher: Edit Watched Authors…` | Change whose pull requests to show in all repositories. |
| `PR Watcher: Export Settings…` | Save the repositories, authors and other shared settings to a file for your team. |
| `PR Watcher: Import Settings…` | Load an exported file, adding to or replacing your repositories and authors. |
| `PR Watcher: Remove Repository…` | Stop watching a repository. |
| `PR Watcher: Sign In to Azure DevOps` | Sign in with the configured authentication. |
| `PR Watcher: Set Personal Access Token…` | Store a personal access token and use it. |
| `PR Watcher: Show Log` | Show the requests to Azure DevOps (at *Trace* level) and errors. |

## Authentication and privacy

By default PR Watcher asks VS Code for a Microsoft account token for Azure DevOps (the first time,
use *Sign In* on the dashboard). Alternatively it uses the Azure CLI's account or a personal access
token, which is kept in VS Code's secret storage. It only reads: pull requests, policy evaluations,
comment threads, team and group members, and your identity. Requests go only to `dev.azure.com`
and `vssps.dev.azure.com`; nothing is sent anywhere else.

## Limitations

- Azure DevOps Services only (`dev.azure.com` and `*.visualstudio.com`), not Azure DevOps Server.
- Each VS Code window checks on its own while it is focused or shows the dashboard.

## Install

Install it from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=luiscantero.pr-watcher),
search for **PR Watcher** in VS Code's Extensions view, or run:

```powershell
code --install-extension luiscantero.pr-watcher
```

## Build from source

Requirements: Node.js 20+.

```powershell
npm install
npm test          # unit tests
npm run package   # writes pr-watcher-<version>.vsix
code --install-extension pr-watcher-0.1.1.vsix
```

For development, run `npm run watch` and press `F5` (*Run Extension*).

### Screenshots

`npm run screenshots` recreates the images in `images/` from a fictional organization served by a
local fake Azure DevOps, in a downloaded VS Code. The images are not packaged; the Marketplace
shows them from GitHub, so push them before publishing.

`npm run screenshots -- --live` instead shows the repositories in `PR_WATCHER_LIVE_REPOS`
(comma-separated URLs, authors in `PR_WATCHER_LIVE_AUTHORS`) with the Azure CLI's account and
saves the screenshot in the temp folder, to check real data.

### Release

1. Set the new version (`npm version <x.y.z> --no-git-tag-version`), add it to `CHANGELOG.md`,
   and update the VSIX file name in the `code --install-extension` example above.
2. Commit as `Release v<x.y.z>`, tag it (`git tag -a v<x.y.z> -m v<x.y.z>`), and push the commit
   and the tag.
3. `npm test` and `npm run package`.
4. Upload `pr-watcher-<x.y.z>.vsix` at
   [marketplace.visualstudio.com/manage/publishers/luiscantero](https://marketplace.visualstudio.com/manage/publishers/luiscantero)
   (or `npx vsce publish --packagePath pr-watcher-<x.y.z>.vsix`).

## Feedback

Report issues and ideas at
[github.com/luiscantero/PrWatcher/issues](https://github.com/luiscantero/PrWatcher/issues).
