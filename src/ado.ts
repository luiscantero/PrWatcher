import { RepoRef } from "./config";

export interface IdentityRef {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
}

export interface Reviewer extends IdentityRef {
  /** 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected. */
  vote: number;
  isRequired?: boolean;
  isContainer?: boolean;
  hasDeclined?: boolean;
  votedFor?: IdentityRef[];
}

export interface PullRequest {
  pullRequestId: number;
  title: string;
  status: "active" | "completed" | "abandoned" | "notSet";
  createdBy: IdentityRef;
  creationDate: string;
  closedDate?: string;
  closedBy?: IdentityRef;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: "notSet" | "queued" | "conflicts" | "succeeded" | "rejectedByPolicy" | "failure";
  isDraft?: boolean;
  reviewers?: Reviewer[];
  autoCompleteSetBy?: IdentityRef;
  completionOptions?: { mergeStrategy?: string; deleteSourceBranch?: boolean };
  repository: { id: string; name: string; webUrl?: string; project: { id: string; name: string } };
}

export type EvaluationStatus = "queued" | "running" | "approved" | "rejected" | "notApplicable" | "broken";

export interface PolicyEvaluation {
  evaluationId: string;
  status: EvaluationStatus;
  context?: Record<string, unknown> | null;
  configuration: {
    id: number;
    isBlocking: boolean;
    isEnabled: boolean;
    type: { id: string; displayName: string };
    settings?: Record<string, unknown>;
  };
}

export interface CommentThread {
  id: number;
  status?: "unknown" | "active" | "fixed" | "wontFix" | "closed" | "byDesign" | "pending";
  isDeleted?: boolean;
  comments?: { commentType?: string; isDeleted?: boolean }[];
}

export interface Identity {
  id: string;
  isContainer: boolean;
  memberIds?: string[];
  providerDisplayName?: string;
}

export interface Team {
  id: string;
  name: string;
}

export class AdoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class AuthError extends AdoError {}

export type AuthHeader = (organization: string) => Promise<string>;

const API = "api-version=7.1";

/** Thin client for the Azure DevOps REST API; every request goes through `authHeader`. */
export class AdoClient {
  /**
   * @param baseUrl Serves both `dev.azure.com` and `vssps.dev.azure.com` requests instead, for screenshots and tests.
   */
  constructor(
    private readonly authHeader: AuthHeader,
    private readonly log?: (message: string) => void,
    private readonly baseUrl?: string,
  ) {}

  private async get<T>(organization: string, url: string): Promise<T> {
    const started = Date.now();
    const response = await fetch(url, {
      headers: { Authorization: await this.authHeader(organization), Accept: "application/json", "X-TFS-FedAuthRedirect": "Suppress" },
    });
    this.log?.(`GET ${url} -> ${response.status} (${Date.now() - started} ms)`);
    if (response.status === 401 || response.status === 203) {
      throw new AuthError(`Azure DevOps rejected the credentials for ${organization} (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = ((await response.json()) as { message?: string }).message ?? "";
      } catch {
        // Not JSON.
      }
      throw new AdoError(detail || `HTTP ${response.status} ${response.statusText}`, response.status);
    }
    return (await response.json()) as T;
  }

  private org(organization: string, service: "dev" | "vssps" = "dev"): string {
    const host = this.baseUrl ?? (service === "vssps" ? "https://vssps.dev.azure.com" : "https://dev.azure.com");
    return `${host}/${encodeURIComponent(organization)}`;
  }

  private repoBase(ref: RepoRef): string {
    const e = encodeURIComponent;
    return `${this.org(ref.organization)}/${e(ref.project)}/_apis/git/repositories/${e(ref.repository)}`;
  }

  async me(organization: string): Promise<IdentityRef> {
    const data = await this.get<{ authenticatedUser: { id: string; providerDisplayName: string; properties?: { Account?: { $value?: string } } } }>(
      organization,
      `${this.org(organization)}/_apis/connectionData`,
    );
    const user = data.authenticatedUser;
    return { id: user.id, displayName: user.providerDisplayName, uniqueName: user.properties?.Account?.$value };
  }

  async repository(ref: RepoRef): Promise<{ id: string; name: string; webUrl: string; project: { id: string; name: string } }> {
    return this.get(ref.organization, `${this.repoBase(ref)}?${API}`);
  }

  /** Active pull requests, or those closed (`completed`/`abandoned`) since `closedSince`. */
  async pullRequests(ref: RepoRef, status: "active" | "completed" | "abandoned", closedSince?: Date): Promise<PullRequest[]> {
    const all: PullRequest[] = [];
    const top = 100;
    for (let skip = 0; skip < 1000; skip += top) {
      let query = `searchCriteria.status=${status}&$top=${top}&$skip=${skip}&${API}`;
      if (closedSince) {
        query += `&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime=${encodeURIComponent(closedSince.toISOString())}`;
      }
      const page = await this.get<{ value: PullRequest[] }>(ref.organization, `${this.repoBase(ref)}/pullrequests?${query}`);
      all.push(...page.value);
      if (page.value.length < top) {
        break;
      }
    }
    return all;
  }

  async policyEvaluations(organization: string, projectId: string, pullRequestId: number): Promise<PolicyEvaluation[]> {
    const artifact = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`);
    const data = await this.get<{ value: PolicyEvaluation[] }>(
      organization,
      `${this.org(organization)}/${encodeURIComponent(projectId)}/_apis/policy/evaluations?artifactId=${artifact}&api-version=7.1-preview.1`,
    );
    return data.value;
  }

  async threads(ref: RepoRef, pullRequestId: number): Promise<CommentThread[]> {
    const data = await this.get<{ value: CommentThread[] }>(ref.organization, `${this.repoBase(ref)}/pullRequests/${pullRequestId}/threads?${API}`);
    return data.value;
  }

  async teamMembers(organization: string, project: string, team: string): Promise<IdentityRef[]> {
    const e = encodeURIComponent;
    const members: IdentityRef[] = [];
    const top = 500;
    for (let skip = 0; skip < 5000; skip += top) {
      const page = await this.get<{ value: { identity: IdentityRef }[] }>(
        organization,
        `${this.org(organization)}/_apis/projects/${e(project)}/teams/${e(team)}/members?$top=${top}&$skip=${skip}&${API}`,
      );
      members.push(...page.value.map((m) => m.identity));
      if (page.value.length < top) {
        break;
      }
    }
    return members;
  }

  /**
   * Identities with their direct members, looked up by `[Scope]\Name` or by IDs.
   * (`queryMembership=Expanded` returns no members for many groups, so callers expand nested groups.)
   */
  async identities(organization: string, lookup: { name: string } | { ids: string[] }): Promise<Identity[]> {
    const filter =
      "name" in lookup ? `searchFilter=General&filterValue=${encodeURIComponent(lookup.name)}` : `identityIds=${lookup.ids.map(encodeURIComponent).join(",")}`;
    const data = await this.get<{ value: (Identity | null)[] }>(
      organization,
      `${this.org(organization, "vssps")}/_apis/identities?${filter}&queryMembership=Direct&${API}`,
    );
    return data.value.filter((i): i is Identity => i !== null);
  }

  async myTeams(organization: string, project: string): Promise<Team[]> {
    const data = await this.get<{ value: Team[] }>(
      organization,
      `${this.org(organization)}/_apis/projects/${encodeURIComponent(project)}/teams?$mine=true&$top=200&${API}`,
    );
    return data.value;
  }
}
