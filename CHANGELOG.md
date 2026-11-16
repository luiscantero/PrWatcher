# Changelog

## Unreleased

- Authors can be anyone by the name shown for pull request authors, such as agents (`Agency`) and build services (`One Build Service (contoso)`), besides teams, groups and emails.
- A group that cannot be found is reported on its repository, and the other authors' pull requests are still shown.
- The dashboard shows approvals as a count (`1/2`) instead of one icon per reviewer, plus counts of *waiting for author* and *rejected* votes; *Waiting for author* and *Rejected* name the reviewers.
- Optional branch policies, such as optional reviewers, are no longer shown as pending.
- Coming back to VS Code or to the dashboard, for example after voting in the browser, checks for changes right away.
- *Needs re-approval after new push* is only shown when the minimum number of approvals is not met, not when another review policy, such as proof of presence, is missing.
- Merged pull requests are collapsed under a *Merged* row at the end of each repository; the *Recently closed* filter lists them directly.
- One icon for branch policies: a lock with the policies not met or pending, green when all are met. The *Your review* badge and the check mark next to the approvals are gone; a blue bar marks pull requests that need your review.
- Shorter labels below the title: *Conflicts*, *Failed <build>*, *Needs review from <reviewer>*, *Needs proof of presence*; states the icon already shows (*Needs review*, *Validation running*, *Ready to complete*, *Merged*) have no label, and the pull request ID moved to the title's tooltip.

## 0.1.0

- Dashboard tab with the pull requests of watched Azure DevOps repositories: state, approvals, approvals that a new push made stale, reviewers and votes, validation builds, branch policies, unresolved comments, merge conflicts and auto-complete.
- Watch the pull requests of teams, groups (including nested groups) or people per repository, or everyone's.
- Merged pull requests stay listed for 60 hours (`prWatcher.closedRetentionHours`); abandoned ones too if `prWatcher.showAbandoned` is on.
- Filters for pull requests that need your review, yours, active and recently closed ones, and a text filter.
- Status bar count of pull requests that need your review, and notifications for new pull requests.
- Sign in with VS Code's Microsoft account, the Azure CLI or a personal access token.
