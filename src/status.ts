import { PolicyEvaluation, PullRequest, Reviewer } from "./ado";

export type Phase =
  | "draft"
  | "conflicts"
  | "validationFailed"
  | "rejected"
  | "waitingForAuthor"
  | "reapproval"
  | "needsReview"
  | "validationRunning"
  | "blocked"
  | "ready"
  | "autoComplete"
  | "merged"
  | "abandoned";

export type CheckKind =
  | "build"
  | "reviewers"
  | "requiredReviewers"
  | "proofOfPresence"
  | "comments"
  | "workItems"
  | "status"
  | "mergeStrategy"
  | "other";
export type CheckStatus = "approved" | "rejected" | "running" | "queued" | "broken" | "expired";

export interface CheckView {
  kind: CheckKind;
  name: string;
  status: CheckStatus;
  blocking: boolean;
  url?: string;
}

/**
 * One status icon of a pull request: its color, and the tooltip's sections from the most to the least
 * urgent, so that what is left once the problems are solved is green.
 */
export interface Summary {
  /** bad: red; warn: orange; running: in progress; good: green; none: nothing to show (faded). */
  level: "bad" | "warn" | "running" | "good" | "none";
  sections: { heading: string; items: string[] }[];
  /** For validations, the build to open on click: the most urgent one. */
  url?: string;
}

export interface ThreadCounts {
  unresolved: number;
  resolved: number;
}

export interface ReviewerView {
  id: string;
  name: string;
  vote: number;
  required: boolean;
  group: boolean;
  me: boolean;
  /** Approved, but not the latest push, and the policy requires a vote on the last iteration. */
  stale: boolean;
  declined: boolean;
}

export interface PrView {
  key: string;
  id: number;
  repoKey: string;
  title: string;
  url: string;
  author: string;
  authorId: string;
  created: string;
  closed?: string;
  /** When a closed pull request disappears from the list. */
  expires?: string;
  status: "active" | "completed" | "abandoned";
  draft: boolean;
  source: string;
  target: string;
  reviewers: ReviewerView[];
  approvals: number;
  staleApprovals: number;
  /** Approvals required by the "Minimum number of reviewers" policy, if one applies. */
  requiredApprovals?: number;
  checks: CheckView[];
  conflicts: boolean;
  autoComplete?: { setBy: string; mergeStrategy?: string };
  /** Comment threads written by people; undefined when they could not be loaded. */
  comments?: ThreadCounts;
  approvalSummary: Summary;
  validationSummary: Summary;
  policySummary: Summary;
  mine: boolean;
  myVote?: number;
  /** You or one of your groups is a reviewer. */
  reviewRequested: boolean;
  needsMyReview: boolean;
  phase: Phase;
  phaseLabel: string;
}

export interface Viewer {
  id: string;
  /** IDs of groups (teams) the viewer belongs to, to recognize group reviewers. */
  groupIds: ReadonlySet<string>;
}

function checkKind(e: PolicyEvaluation): CheckKind {
  const name = e.configuration.type.displayName.toLowerCase();
  if (name === "build") {
    return "build";
  }
  if (name.startsWith("minimum number of reviewers")) {
    return "reviewers";
  }
  if (name.startsWith("required reviewers")) {
    return "requiredReviewers";
  }
  if (name.startsWith("comment requirements")) {
    return "comments";
  }
  if (name.startsWith("work item linking")) {
    return "workItems";
  }
  if (name.startsWith("proof of presence")) {
    return "proofOfPresence";
  }
  if (name.startsWith("require a merge strategy")) {
    return "mergeStrategy";
  }
  if (name === "status") {
    return "status";
  }
  return "other";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkName(e: PolicyEvaluation, kind: CheckKind): string {
  const s = e.configuration.settings ?? {};
  const c = e.context ?? {};
  switch (kind) {
    case "build":
      return str(s.displayName) ?? str(c.buildDefinitionName) ?? "Build";
    case "status":
      return str(s.defaultDisplayName) ?? str(s.statusName) ?? "Status check";
    case "requiredReviewers":
      return str(s.message) ? `Required reviewers: ${s.message}` : "Required reviewers";
    case "workItems":
      return "Link work item";
    default:
      return e.configuration.type.displayName;
  }
}

const SEVERITY: Record<CheckStatus, number> = { approved: 0, queued: 1, running: 2, expired: 3, broken: 4, rejected: 5 };

/** Enabled policies that apply to the pull request, one per kind and name, with the worst status. */
export function toChecks(evaluations: readonly PolicyEvaluation[], buildUrl: (buildId: number) => string): CheckView[] {
  const checks = new Map<string, CheckView>();
  for (const e of evaluations) {
    if (!e.configuration.isEnabled || e.status === "notApplicable") {
      continue;
    }
    const kind = checkKind(e);
    // The merge strategy is chosen when completing, so it is only unmet until then.
    if (kind === "mergeStrategy" && e.status !== "approved") {
      continue;
    }
    const name = checkName(e, kind);
    let status: CheckStatus = e.status;
    if (kind === "build" && status === "approved" && e.context?.isExpired === true) {
      status = "expired";
    }
    const buildId = kind === "build" && typeof e.context?.buildId === "number" ? e.context.buildId : undefined;
    const check: CheckView = { kind, name, status, blocking: e.configuration.isBlocking, url: buildId !== undefined ? buildUrl(buildId) : undefined };
    const key = `${kind}|${name}`;
    const known = checks.get(key);
    // Several policies of one kind can apply (for example per path); a blocking one wins, then the worst status.
    const replace = !known || (check.blocking !== known.blocking ? check.blocking : SEVERITY[check.status] > SEVERITY[known.status]);
    if (replace) {
      checks.set(key, check);
    }
  }
  return [...checks.values()];
}

const pending = (c: CheckView) => c.status !== "approved";

interface LabelInfo {
  approvals: number;
  requiredApprovals?: number;
  pendingRequired: string[];
  proofOfPresence: boolean;
  blockers: CheckView[];
  failedBuilds: CheckView[];
  /** Reviewers who voted "Waiting for author" and "Rejected". */
  waiting: string[];
  rejecting: string[];
}

function needsReviewLabel(pr: LabelInfo): string {
  if (pr.requiredApprovals !== undefined && pr.approvals < pr.requiredApprovals) {
    return "Needs review";
  }
  if (pr.pendingRequired.length > 0) {
    return pr.pendingRequired.length === 1
      ? `Needs review from ${pr.pendingRequired[0]}`
      : `Needs review from ${pr.pendingRequired.length} required reviewers`;
  }
  if (pr.proofOfPresence) {
    return "Needs proof of presence";
  }
  return "Needs review";
}

function phaseLabel(phase: Phase, pr: LabelInfo): string {
  switch (phase) {
    case "draft":
      return "Draft";
    case "conflicts":
      return "Conflicts";
    case "validationFailed":
      return `Failed ${pr.failedBuilds.map((c) => c.name).join(", ")}`;
    case "rejected":
      return `Rejected (${pr.rejecting.join(", ")})`;
    case "waitingForAuthor":
      return `Waiting for author (${pr.waiting.join(", ")})`;
    case "reapproval":
      return "Needs re-approval after new push";
    case "needsReview":
      return needsReviewLabel(pr);
    case "validationRunning":
      return "Validation running";
    case "blocked":
      return `Blocked: ${pr.blockers.map((c) => c.name).join(", ")}`;
    case "ready":
      return "Ready to complete";
    case "autoComplete":
      return "Approved, auto-complete set";
    case "merged":
      return "Merged";
    case "abandoned":
      return "Abandoned";
  }
}

function lastIterationApprovers(evaluations: readonly PolicyEvaluation[]): { required: boolean; ids: Set<string> } {
  let required = false;
  const ids = new Set<string>();
  for (const e of evaluations) {
    if (!e.configuration.isEnabled || e.status === "notApplicable" || checkKind(e) !== "reviewers") {
      continue;
    }
    if (e.configuration.settings?.requireVoteOnLastIteration === true) {
      required = true;
    }
    const approvers = e.context?.lastIterationApprovers;
    if (Array.isArray(approvers)) {
      approvers.forEach((id) => typeof id === "string" && ids.add(id.toLowerCase()));
    }
  }
  return { required, ids };
}

const optional = (c: CheckView) => (c.blocking ? c.name : `${c.name} (optional)`);
const isFailed = (c: CheckView) => c.status === "rejected" || c.status === "broken" || c.status === "expired";
const isRunning = (c: CheckView) => c.status === "running" || c.status === "queued";
const sections = (list: [string, string[]][]) => list.filter(([, items]) => items.length > 0).map(([heading, items]) => ({ heading, items }));

/** Validation builds: required failures, then running builds, optional failures and passed builds. */
export function validationSummary(checks: readonly CheckView[]): Summary {
  const builds = checks.filter((c) => c.kind === "build");
  const failed = builds.filter(isFailed).sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const running = builds.filter(isRunning).sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const passed = builds.filter((c) => c.status === "approved");
  const label = (c: CheckView) => `${optional(c)}${c.status === "expired" ? " (expired)" : ""}${c.status === "queued" ? " (queued)" : ""}`;
  let level: Summary["level"] = "none";
  if (failed.some((c) => c.blocking)) {
    level = "bad";
  } else if (running.some((c) => c.blocking)) {
    level = "running";
  } else if (failed.length > 0) {
    level = "warn";
  } else if (builds.length > 0) {
    level = "good";
  }
  return {
    level,
    sections: sections([
      ["Failed", failed.map(label)],
      ["Running", running.map(label)],
      ["Passed", passed.map(label)],
    ]),
    url: (failed[0] ?? running[0] ?? passed[0])?.url,
  };
}

const REVIEW_KINDS: CheckKind[] = ["reviewers", "requiredReviewers", "proofOfPresence"];

/** Other branch policies: required ones not met (or pending), then optional ones not met, then met. */
export function policySummary(checks: readonly CheckView[]): Summary {
  const policies = checks.filter((c) => c.kind !== "build" && !REVIEW_KINDS.includes(c.kind));
  const requiredUnmet = policies.filter((c) => c.blocking && c.status !== "approved");
  // Optional policies only matter once they failed; pending ones would just be noise.
  const optionalUnmet = policies.filter((c) => !c.blocking && isFailed(c));
  const met = policies.filter((c) => c.blocking && c.status === "approved");
  let level: Summary["level"] = "none";
  if (requiredUnmet.length > 0) {
    level = "bad";
  } else if (optionalUnmet.length > 0) {
    level = "warn";
  } else if (met.length > 0) {
    level = "good";
  }
  return {
    level,
    sections: sections([
      ["Not met", [...requiredUnmet.map((c) => `${c.name}${isRunning(c) ? " (pending)" : ""}`), ...optionalUnmet.map(optional)]],
      ["Met", met.map((c) => c.name)],
    ]),
  };
}

export interface PrInput {
  pr: PullRequest;
  repoKey: string;
  webUrl: string;
  /** Undefined for closed pull requests, or when they could not be loaded. */
  evaluations?: readonly PolicyEvaluation[];
  comments?: ThreadCounts;
  viewer?: Viewer;
  /** The repository watches specific authors (a team, group or people) rather than everyone. */
  watchedAuthors: boolean;
  retentionHours: number;
}

export function toPrView(input: PrInput): PrView {
  const { pr, viewer } = input;
  const evaluations = input.evaluations ?? [];
  const me = viewer?.id.toLowerCase();
  const authorId = pr.createdBy.id.toLowerCase();
  const mine = me !== undefined && authorId === me;
  const organization = input.repoKey.split("/")[0];
  const buildUrl = (buildId: number) =>
    `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(pr.repository.project.name)}/_build/results?buildId=${buildId}`;
  const checks = toChecks(evaluations, buildUrl);
  const lastIteration = lastIterationApprovers(evaluations);
  const reviewerChecks = checks.filter((c) => c.kind === "reviewers" && c.blocking);
  const reviewersSatisfied = reviewerChecks.length > 0 && reviewerChecks.every((c) => c.status === "approved");

  const isApproval = (r: Reviewer) => r.vote >= 5;
  const reviewers: ReviewerView[] = (pr.reviewers ?? []).map((r) => {
    const id = r.id.toLowerCase();
    const group = r.isContainer === true;
    // Approvers who are missing from the policy's last-iteration approvers approved an older push.
    const stale = isApproval(r) && !group && lastIteration.required && (lastIteration.ids.size > 0 || !reviewersSatisfied) && !lastIteration.ids.has(id);
    return {
      id: r.id,
      name: r.displayName,
      vote: r.vote,
      required: r.isRequired === true,
      group,
      me: id === me || (group && viewer?.groupIds.has(id) === true),
      stale,
      declined: r.hasDeclined === true,
    };
  });
  const people = reviewers.filter((r) => !r.group && r.id.toLowerCase() !== authorId);
  const approvals = people.filter((r) => r.vote >= 5 && !r.stale).length;
  const staleApprovals = people.filter((r) => r.stale).length;
  const counts = evaluations
    .filter((e) => e.configuration.isEnabled && e.configuration.isBlocking && e.status !== "notApplicable" && checkKind(e) === "reviewers")
    .map((e) => e.configuration.settings?.minimumApproverCount)
    .filter((n): n is number => typeof n === "number");
  const requiredApprovals = counts.length > 0 ? Math.max(...counts) : undefined;

  const myReviewer = reviewers.find((r) => !r.group && r.id.toLowerCase() === me);
  const myVote = myReviewer?.vote;
  const reviewRequested = reviewers.some((r) => r.me);
  const status = pr.status === "completed" || pr.status === "abandoned" ? pr.status : "active";
  const draft = pr.isDraft === true;
  const conflicts = pr.mergeStatus === "conflicts";

  const votes = people.map((r) => r.vote);
  const blockingPending = checks.filter((c) => c.blocking && pending(c));
  const failedBuilds = checks.filter((c) => c.kind === "build" && c.blocking && (c.status === "rejected" || c.status === "broken" || c.status === "expired"));
  const runningBuilds = blockingPending.filter((c) => c.kind === "build" && (c.status === "running" || c.status === "queued"));
  const reviewKinds: CheckKind[] = ["reviewers", "requiredReviewers", "proofOfPresence"];
  const pendingRequired = reviewers.filter((r) => r.required && r.vote < 5 && r.id.toLowerCase() !== authorId).map((r) => r.name);
  const reviewPending =
    blockingPending.some((c) => reviewKinds.includes(c.kind)) ||
    // Without review policies, a pull request needs at least one approval.
    (checks.every((c) => c.kind !== "reviewers") && approvals === 0) ||
    pendingRequired.length > 0;
  const otherBlockers = blockingPending.filter((c) => !reviewKinds.includes(c.kind) && c.kind !== "build");

  let phase: Phase;
  if (status === "completed") {
    phase = "merged";
  } else if (status === "abandoned") {
    phase = "abandoned";
  } else if (draft) {
    phase = "draft";
  } else if (conflicts) {
    phase = "conflicts";
  } else if (failedBuilds.length > 0) {
    phase = "validationFailed";
  } else if (votes.includes(-10)) {
    phase = "rejected";
  } else if (votes.includes(-5)) {
    phase = "waitingForAuthor";
  } else if (reviewPending && staleApprovals > 0 && blockingPending.some((c) => c.kind === "reviewers")) {
    // Only when the approvals are missing because of the new push, not for other review policies.
    phase = "reapproval";
  } else if (reviewPending) {
    phase = "needsReview";
  } else if (runningBuilds.length > 0) {
    phase = "validationRunning";
  } else if (otherBlockers.length > 0) {
    phase = "blocked";
  } else {
    phase = pr.autoCompleteSetBy ? "autoComplete" : "ready";
  }

  const myApprovalCurrent = myReviewer !== undefined && myReviewer.vote >= 5 && !myReviewer.stale;
  const myRequiredVote = myReviewer?.required === true && !myApprovalCurrent;
  // In repositories that show everyone's pull requests, only those that ask you or your groups for a review are yours to review.
  const audience = input.watchedAuthors || reviewRequested;
  const needsMyReview =
    status === "active" &&
    !draft &&
    !mine &&
    audience &&
    !myApprovalCurrent &&
    (myVote === undefined || myVote >= 0) &&
    !votes.some((v) => v < 0) &&
    (reviewPending || myRequiredVote);

  const closed = status !== "active" ? pr.closedDate : undefined;
  const expires = closed ? new Date(Date.parse(closed) + input.retentionHours * 3_600_000).toISOString() : undefined;
  const strip = (ref: string) => ref.replace(/^refs\/heads\//, "");

  // Approvals: rejections, waiting for author, what is missing, approvals of an earlier push, then approvals.
  const rejecting = people.filter((r) => r.vote === -10).map((r) => r.name);
  const waiting = people.filter((r) => r.vote === -5).map((r) => r.name);
  const missing: string[] = [];
  if (reviewPending) {
    const reviewerPolicyPending = blockingPending.some((c) => c.kind === "reviewers");
    const noReviewerPolicy = checks.every((c) => c.kind !== "reviewers");
    const missingCount = reviewerPolicyPending && requiredApprovals !== undefined ? requiredApprovals - approvals : noReviewerPolicy && approvals === 0 ? 1 : 0;
    if (missingCount > 0) {
      missing.push(`${missingCount} more approval${missingCount === 1 ? "" : "s"}`);
    }
    missing.push(...pendingRequired.map((name) => `${name} (required)`));
    for (const c of blockingPending.filter((c) => c.kind === "requiredReviewers" || c.kind === "proofOfPresence")) {
      missing.push(c.kind === "proofOfPresence" ? "Proof of presence" : c.name);
    }
  }
  let approvalLevel: Summary["level"];
  if (rejecting.length > 0 || (reviewPending && approvals === 0)) {
    approvalLevel = "bad";
  } else if (waiting.length > 0 || reviewPending) {
    approvalLevel = "warn";
  } else {
    approvalLevel = "good";
  }
  const approvalSummary: Summary = {
    level: approvalLevel,
    sections: sections([
      ["Rejected by", rejecting],
      ["Waiting for author", waiting],
      ["Missing", missing],
      ["Approved an earlier push", people.filter((r) => r.stale).map((r) => r.name)],
      ["Approved", people.filter((r) => r.vote >= 5 && !r.stale).map((r) => (r.vote < 10 ? `${r.name} (with suggestions)` : r.name))],
    ]),
  };

  return {
    key: `${input.repoKey}#${pr.pullRequestId}`,
    id: pr.pullRequestId,
    repoKey: input.repoKey,
    title: pr.title,
    url: `${input.webUrl}/pullrequest/${pr.pullRequestId}`,
    author: pr.createdBy.displayName,
    authorId: pr.createdBy.id,
    created: pr.creationDate,
    closed,
    expires,
    status,
    draft,
    source: strip(pr.sourceRefName),
    target: strip(pr.targetRefName),
    reviewers,
    approvals,
    staleApprovals,
    requiredApprovals,
    checks,
    conflicts,
    autoComplete: pr.autoCompleteSetBy ? { setBy: pr.autoCompleteSetBy.displayName, mergeStrategy: pr.completionOptions?.mergeStrategy } : undefined,
    comments: input.comments,
    approvalSummary,
    validationSummary: validationSummary(checks),
    policySummary: policySummary(checks),
    mine,
    myVote,
    reviewRequested,
    needsMyReview,
    phase,
    phaseLabel: phaseLabel(phase, {
      approvals,
      requiredApprovals,
      pendingRequired,
      proofOfPresence: blockingPending.some((c) => c.kind === "proofOfPresence"),
      blockers: otherBlockers,
      failedBuilds,
      waiting: people.filter((r) => r.vote === -5).map((r) => r.name),
      rejecting: people.filter((r) => r.vote === -10).map((r) => r.name),
    }),
  };
}

/** Comment threads written by people (not system messages), unresolved (active or pending) and resolved. */
export function countThreads(threads: readonly { status?: string; isDeleted?: boolean; comments?: { commentType?: string; isDeleted?: boolean }[] }[]): ThreadCounts {
  const counts: ThreadCounts = { unresolved: 0, resolved: 0 };
  for (const t of threads) {
    if (t.isDeleted || !t.status || t.status === "unknown" || !(t.comments ?? []).some((c) => !c.isDeleted && c.commentType !== "system")) {
      continue;
    }
    if (t.status === "active" || t.status === "pending") {
      counts.unresolved++;
    } else {
      counts.resolved++;
    }
  }
  return counts;
}

/** Whether a closed pull request is still within the retention window. */
export function isRetained(closedDate: string | undefined, retentionHours: number, now: number): boolean {
  if (!closedDate) {
    return false;
  }
  return now - Date.parse(closedDate) <= retentionHours * 3_600_000;
}
