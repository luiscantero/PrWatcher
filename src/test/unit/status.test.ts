import * as assert from "assert";
import { PolicyEvaluation, PullRequest, Reviewer } from "../../ado";
import { countThreads, isRetained, toPrView } from "../../status";

const ME = "me-id";
const AUTHOR = "author-id";

function reviewer(id: string, vote: number, extra: Partial<Reviewer> = {}): Reviewer {
  return { id, displayName: id, vote, ...extra };
}

function pr(extra: Partial<PullRequest> = {}): PullRequest {
  return {
    pullRequestId: 1,
    title: "Change",
    status: "active",
    createdBy: { id: AUTHOR, displayName: "Author", uniqueName: "author@contoso.com" },
    creationDate: "2026-11-16T08:00:00Z",
    sourceRefName: "refs/heads/users/a/change",
    targetRefName: "refs/heads/main",
    mergeStatus: "succeeded",
    reviewers: [],
    repository: { id: "r", name: "repo", project: { id: "p", name: "Project" } },
    ...extra,
  };
}

function evaluation(type: string, status: PolicyEvaluation["status"], extra: { blocking?: boolean; settings?: Record<string, unknown>; context?: Record<string, unknown> } = {}): PolicyEvaluation {
  return {
    evaluationId: `${type}-${status}`,
    status,
    context: extra.context ?? null,
    configuration: { id: 1, isBlocking: extra.blocking ?? true, isEnabled: true, type: { id: type, displayName: type }, settings: extra.settings ?? {} },
  };
}

const minReviewers = (status: PolicyEvaluation["status"], approvers?: string[]) =>
  evaluation("Minimum number of reviewers", status, {
    settings: { minimumApproverCount: 1, requireVoteOnLastIteration: true },
    context: approvers ? { lastIterationApprovers: approvers } : {},
  });

function view(input: { pr?: Partial<PullRequest>; evaluations?: PolicyEvaluation[]; groupIds?: string[]; me?: string; watchedAuthors?: boolean }) {
  return toPrView({
    pr: pr(input.pr),
    repoKey: "contoso/project/repo",
    webUrl: "https://dev.azure.com/contoso/Project/_git/repo",
    evaluations: input.evaluations ?? [],
    viewer: { id: input.me ?? ME, groupIds: new Set(input.groupIds ?? []) },
    watchedAuthors: input.watchedAuthors ?? true,
    retentionHours: 72,
  });
}

suite("status", () => {
  test("an approval of an earlier push is stale when the policy requires a vote on the last iteration", () => {
    const v = view({
      pr: { reviewers: [reviewer(ME, 10), reviewer("hans", 10)], autoCompleteSetBy: { id: AUTHOR, displayName: "Author" } },
      evaluations: [minReviewers("approved", [ME]), evaluation("Build", "running", { context: { buildId: 7, buildDefinitionName: "PR" } })],
    });
    assert.deepStrictEqual(
      v.reviewers.map((r) => [r.id, r.stale]),
      [
        [ME, false],
        ["hans", true],
      ],
    );
    assert.strictEqual(v.approvals, 1);
    assert.strictEqual(v.staleApprovals, 1);
    assert.strictEqual(v.phase, "validationRunning");
    assert.strictEqual(v.needsMyReview, false);
    assert.strictEqual(v.checks.find((c) => c.kind === "build")?.url, "https://dev.azure.com/contoso/Project/_build/results?buildId=7");
  });

  test("a pull request whose only approval predates the latest push needs re-approval, also from me", () => {
    const v = view({ pr: { reviewers: [reviewer("jan", 10)] }, evaluations: [minReviewers("queued")] });
    assert.strictEqual(v.phase, "reapproval");
    assert.strictEqual(v.phaseLabel, "Needs re-approval after new push");
    assert.strictEqual(v.needsMyReview, true);
    assert.strictEqual(v.approvals, 0);
  });

  test("my own stale approval still needs my review", () => {
    const v = view({ pr: { reviewers: [reviewer(ME, 10)] }, evaluations: [minReviewers("queued")] });
    assert.strictEqual(v.myVote, 10);
    assert.strictEqual(v.needsMyReview, true);
  });

  test("a met reviewer policy with a stale approval and missing proof of presence needs proof of presence, not re-approval", () => {
    const v = view({
      pr: { reviewers: [reviewer(ME, 10), reviewer("daniele", 10)] },
      evaluations: [minReviewers("approved", [ME]), evaluation("Proof Of Presence", "rejected")],
    });
    assert.strictEqual(v.staleApprovals, 1);
    assert.strictEqual(v.phase, "needsReview");
    assert.strictEqual(v.phaseLabel, "Needs proof of presence");
    assert.strictEqual(v.needsMyReview, false);
  });

  test("a failed blocking build wins over review; optional builds and pending merge strategies do not count", () => {
    const failed = view({ evaluations: [minReviewers("queued"), evaluation("Build", "rejected", { context: { buildDefinitionName: "PR" } })] });
    assert.strictEqual(failed.phase, "validationFailed");
    assert.strictEqual(failed.phaseLabel, "Failed PR");
    assert.strictEqual(failed.needsMyReview, true);

    const optional = view({
      pr: { reviewers: [reviewer("jan", 10)], autoCompleteSetBy: { id: AUTHOR, displayName: "Author" } },
      evaluations: [
        minReviewers("approved", ["jan"]),
        evaluation("Build", "rejected", { blocking: false, settings: { displayName: "Lint" } }),
        evaluation("Require a merge strategy", "rejected"),
      ],
    });
    assert.strictEqual(optional.phase, "autoComplete");
    assert.strictEqual(optional.needsMyReview, false);
    assert.deepStrictEqual(
      optional.checks.map((c) => c.name),
      ["Minimum number of reviewers", "Lint"],
    );
  });

  test("other unmet blocking policies block a reviewed pull request", () => {
    const v = view({ pr: { reviewers: [reviewer("jan", 10)] }, evaluations: [minReviewers("approved", ["jan"]), evaluation("Comment requirements", "rejected")] });
    assert.strictEqual(v.phase, "blocked");
    assert.strictEqual(v.phaseLabel, "Blocked: Comment requirements");
  });

  test("required reviewers who have not approved keep the pull request in review", () => {
    const v = view({
      pr: { reviewers: [reviewer("jan", 10), reviewer("marc", 0, { isRequired: true })] },
      evaluations: [minReviewers("approved", ["jan"])],
    });
    assert.strictEqual(v.phase, "needsReview");
    assert.strictEqual(v.phaseLabel, "Needs review from marc");
  });

  test("waiting for author and drafts never need my review; my own pull requests neither", () => {
    assert.strictEqual(view({ pr: { reviewers: [reviewer("jan", -5)] }, evaluations: [minReviewers("queued")] }).needsMyReview, false);
    assert.strictEqual(view({ pr: { reviewers: [reviewer("jan", -5)] } }).phase, "waitingForAuthor");
    assert.strictEqual(view({ pr: { reviewers: [reviewer("jan", -5), reviewer("mei", 10)] } }).phaseLabel, "Waiting for author (jan)");
    assert.strictEqual(view({ pr: { reviewers: [reviewer("jan", -10), reviewer("mei", -5)] } }).phaseLabel, "Rejected (jan)");
    assert.strictEqual(view({ pr: { isDraft: true } }).needsMyReview, false);
    const mine = view({ me: AUTHOR, evaluations: [minReviewers("queued")] });
    assert.strictEqual(mine.mine, true);
    assert.strictEqual(mine.needsMyReview, false);
  });

  test("the author's own vote does not count as an approval", () => {
    const v = view({ pr: { reviewers: [reviewer(AUTHOR, 10)] } });
    assert.strictEqual(v.approvals, 0);
    assert.strictEqual(v.phase, "needsReview");
  });

  test("a review requested from one of my groups counts as requested from me", () => {
    const v = view({ pr: { reviewers: [reviewer("team", 0, { isContainer: true })] }, groupIds: ["team"] });
    assert.strictEqual(v.reviewRequested, true);
    assert.strictEqual(v.reviewers[0].me, true);
  });

  test("in repositories watched for everyone, only pull requests that ask me or my groups need my review", () => {
    const evaluations = [minReviewers("queued")];
    assert.strictEqual(view({ watchedAuthors: false, evaluations, pr: { reviewers: [reviewer("other", 0)] } }).needsMyReview, false);
    assert.strictEqual(view({ watchedAuthors: false, evaluations, pr: { reviewers: [reviewer("team", 0, { isContainer: true })] }, groupIds: ["team"] }).needsMyReview, true);
  });

  test("merged pull requests expire after the retention time", () => {
    const v = view({ pr: { status: "completed", closedDate: "2026-11-16T08:00:00Z" } });
    assert.strictEqual(v.phase, "merged");
    assert.strictEqual(v.expires, "2026-11-19T08:00:00.000Z");
    assert.strictEqual(v.needsMyReview, false);
    const closed = Date.parse("2026-11-16T08:00:00Z");
    assert.strictEqual(isRetained("2026-11-16T08:00:00Z", 72, closed + 71 * 3_600_000), true);
    assert.strictEqual(isRetained("2026-11-16T08:00:00Z", 72, closed + 73 * 3_600_000), false);
  });

  test("conflicts are reported", () => {
    assert.strictEqual(view({ pr: { mergeStatus: "conflicts" } }).phase, "conflicts");
  });

  test("comment threads count unresolved and resolved ones written by people", () => {
    assert.deepStrictEqual(
      countThreads([
        { status: "active", comments: [{ commentType: "text" }] },
        { status: "pending", comments: [{ commentType: "text" }] },
        { status: "active", comments: [{ commentType: "system" }] },
        { status: "fixed", comments: [{ commentType: "text" }] },
        { status: "closed", comments: [{ commentType: "text" }] },
        { status: "active", isDeleted: true, comments: [{ commentType: "text" }] },
        { comments: [{ commentType: "system" }] },
      ]),
      { unresolved: 2, resolved: 2 },
    );
  });

  test("the approvals summary lists, from the most urgent, rejections, waiting, what is missing, stale and current approvals", () => {
    const v = view({
      pr: { reviewers: [reviewer("ana", 10), reviewer("bo", -5), reviewer("cy", 10), reviewer("dee", 0, { isRequired: true })] },
      evaluations: [{ ...minReviewers("queued", ["ana"]), configuration: { ...minReviewers("queued").configuration, settings: { minimumApproverCount: 2, requireVoteOnLastIteration: true } } }],
    });
    assert.strictEqual(v.approvalSummary.level, "warn");
    assert.deepStrictEqual(v.approvalSummary.sections, [
      { heading: "Waiting for author", items: ["bo"] },
      { heading: "Missing", items: ["1 more approval", "dee (required)"] },
      { heading: "Approved an earlier push", items: ["cy"] },
      { heading: "Approved", items: ["ana"] },
    ]);
    assert.strictEqual(view({ evaluations: [minReviewers("queued")] }).approvalSummary.level, "bad");
    assert.strictEqual(view({ pr: { reviewers: [reviewer("ana", -10), reviewer("bo", 10)] }, evaluations: [minReviewers("approved", ["bo"])] }).approvalSummary.level, "bad");
    assert.deepStrictEqual(view({ pr: { reviewers: [reviewer("ana", 10)] }, evaluations: [minReviewers("approved", ["ana"])] }).approvalSummary, {
      level: "good",
      sections: [{ heading: "Approved", items: ["ana"] }],
    });
  });

  test("the validation summary is red for a required failure, running while required builds run, orange for optional failures", () => {
    const build = (name: string, status: PolicyEvaluation["status"], blocking = true, buildId = 1) =>
      evaluation("Build", status, { blocking, settings: { displayName: name }, context: { buildId } });
    const summary = (...evaluations: PolicyEvaluation[]) => view({ evaluations }).validationSummary;
    const bad = summary(build("Lint", "rejected", false, 1), build("PR", "rejected", true, 2), build("E2E", "running", true, 3), build("Docs", "approved", true, 4));
    assert.strictEqual(bad.level, "bad");
    assert.deepStrictEqual(bad.sections, [
      { heading: "Failed", items: ["PR", "Lint (optional)"] },
      { heading: "Running", items: ["E2E"] },
      { heading: "Passed", items: ["Docs"] },
    ]);
    assert.match(bad.url ?? "", /buildId=2$/);
    assert.strictEqual(summary(build("Lint", "rejected", false), build("PR", "running")).level, "running");
    assert.strictEqual(summary(build("Lint", "rejected", false), build("PR", "approved")).level, "warn");
    assert.strictEqual(summary(build("PR", "approved")).level, "good");
    assert.strictEqual(summary().level, "none");
  });

  test("the policy summary is red for unmet required policies, orange for failed optional ones, and leaves out review policies", () => {
    const summary = (...evaluations: PolicyEvaluation[]) => view({ evaluations }).policySummary;
    const bad = summary(
      evaluation("Work item linking", "rejected", { blocking: false }),
      evaluation("Comment requirements", "rejected"),
      evaluation("Status", "running", { settings: { statusName: "Scan" } }),
      evaluation("Status", "approved", { settings: { statusName: "License" } }),
      evaluation("Proof Of Presence", "rejected"),
      minReviewers("queued"),
    );
    assert.strictEqual(bad.level, "bad");
    assert.deepStrictEqual(bad.sections, [
      { heading: "Not met", items: ["Comment requirements", "Scan (pending)", "Link work item (optional)"] },
      { heading: "Met", items: ["License"] },
    ]);
    assert.strictEqual(summary(evaluation("Work item linking", "rejected", { blocking: false }), evaluation("Comment requirements", "approved")).level, "warn");
    assert.strictEqual(summary(evaluation("Work item linking", "queued", { blocking: false })).level, "none");
  });
});
