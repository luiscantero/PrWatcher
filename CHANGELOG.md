# Changelog

## Unreleased

- Five status icons in fixed columns: approvals, validation builds, branch policies, comments and auto-complete. Each is red, orange, green or faded, and its tooltip lists the details from the most to the least urgent.
- No more state labels below the titles (such as *Failed …* or *Needs re-approval after new push*); the state icon's and the status icons' tooltips have the details.
- Proof of presence is listed with the branch policies (lock), not the approvals; the lock is always closed; the comments tooltip reads *Resolved comments: 3/5*.
- *Edit Watched Authors…* moved to the dashboard's toolbar and sets the authors for all repositories at once; *Add Repository…* only asks for authors when none are set yet.

## 0.1.1

- The dashboard no longer stops updating after a notification about a new pull request was left unanswered, or a request to Azure DevOps did not answer.
- A visible dashboard updates every 2 minutes even when its window is not focused.
- Optional policies that are not met, such as *Link work item*, are listed under the policies not met, marked *(optional)*.
- *Work item linking* is listed as *Link work item*.
- The icons for conflicts, comments and auto-complete line up across rows.

## 0.1.0

- Dashboard tab with the pull requests of watched Azure DevOps repositories: state, approvals on the latest push (`1/2`), *waiting for author* and *rejected* votes, validation builds, blocking branch policies, unresolved comments, merge conflicts and auto-complete.
- States from the most to the least urgent, with short labels only where the icon cannot say it all, such as *Failed <build>*, *Needs re-approval after new push*, *Needs review from <reviewer>* or *Needs proof of presence*.
- Watch the pull requests of teams, groups (including nested groups), people, agents such as `Agency` or build services such as `One Build Service (contoso)` per repository, or everyone's.
- Merged pull requests stay listed for 60 hours (`prWatcher.closedRetentionHours`), collapsed under *Merged* at the end of each repository; abandoned ones too if `prWatcher.showAbandoned` is on.
- Tabs *Active*, *Needs review*, *Mine* and *Recently closed*, and a text filter.
- Status bar count of pull requests that need your review, and notifications for new pull requests.
- Checks for changes every 2 minutes while VS Code is focused, and right away when you come back to it, for example after voting in the browser.
- Sign in with VS Code's Microsoft account, the Azure CLI or a personal access token.
