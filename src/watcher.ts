import { AdoClient, AdoError, AuthError, IdentityRef, PullRequest } from "./ado";
import { AuthorSpec, ConfigProblem, WatchedRepo, repoWebUrl } from "./config";
import { PrView, countThreads, isRetained, toPrView } from "./status";

export interface RepoView {
  key: string;
  name: string;
  organization: string;
  project: string;
  url: string;
  authorsLabel: string;
  error?: string;
  prs: PrView[];
}

export interface DashboardState {
  repos: RepoView[];
  me?: { id: string; name: string };
  updated?: string;
  loading: boolean;
  /** Set when Azure DevOps needs (new) credentials. */
  signIn?: string;
  problems: ConfigProblem[];
  retentionHours: number;
}

export interface WatchOptions {
  repos: WatchedRepo[];
  problems: ConfigProblem[];
  retentionHours: number;
  showAbandoned: boolean;
  showDrafts: boolean;
}

/** Authors whose pull requests are shown: everyone, or the listed identity IDs, unique names (emails) and display names. */
export type AuthorFilter = { everyone: true } | { everyone: false; ids: Set<string>; emails: Set<string>; names: Set<string> };

interface Resolved {
  ids: Set<string>;
  emails: Set<string>;
  names: Set<string>;
}

export function matchesAuthor(filter: AuthorFilter, author: IdentityRef): boolean {
  if (filter.everyone) {
    return true;
  }
  return (
    filter.ids.has(author.id.toLowerCase()) ||
    (author.uniqueName !== undefined && filter.emails.has(author.uniqueName.toLowerCase())) ||
    filter.names.has(author.displayName.toLowerCase())
  );
}

const HOUR = 3_600_000;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

class Cache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; time: number }>();
  constructor(private readonly ttl: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const known = this.entries.get(key);
    if (known && Date.now() - known.time < this.ttl) {
      return known.value;
    }
    const value = load();
    this.entries.set(key, { value, time: Date.now() });
    // Failures are not cached.
    value.catch(() => this.entries.get(key)?.value === value && this.entries.delete(key));
    return value;
  }

  clear() {
    this.entries.clear();
  }
}

/** Loads the pull requests of the watched repositories. */
export class Watcher {
  private readonly members = new Cache<Resolved>(HOUR);
  private readonly groupMembers = new Cache<Set<string>>(HOUR);
  private readonly me = new Cache<IdentityRef>(12 * HOUR);

  constructor(
    private readonly client: AdoClient,
    private readonly log: (message: string) => void,
  ) {}

  /** Forgets cached identities, for example after signing in with another account. */
  reset() {
    this.members.clear();
    this.groupMembers.clear();
    this.me.clear();
  }

  async load(options: WatchOptions, previous?: DashboardState): Promise<DashboardState> {
    const now = Date.now();
    const closedSince = new Date(now - options.retentionHours * HOUR);
    let signIn: string | undefined;
    const organizations = [...new Set(options.repos.map((r) => r.organization.toLowerCase()))];
    const viewers = new Map<string, IdentityRef | undefined>();
    for (const org of organizations) {
      try {
        viewers.set(org, await this.me.get(org, () => this.client.me(org)));
      } catch (e) {
        if (e instanceof AuthError) {
          signIn = e.message;
        }
        this.log(`Could not identify the signed-in user in ${org}: ${(e as Error).message}`);
        viewers.set(org, undefined);
      }
    }
    if (signIn) {
      return { ...(previous ?? { repos: [] }), problems: options.problems, retentionHours: options.retentionHours, loading: false, signIn };
    }

    const repos = await mapLimit(options.repos, 4, async (repo): Promise<RepoView> => {
      const base: RepoView = {
        key: repo.key,
        name: repo.repository,
        organization: repo.organization,
        project: repo.project,
        url: repoWebUrl(repo),
        authorsLabel: repo.authorsLabel,
        prs: [],
      };
      try {
        const viewer = viewers.get(repo.organization.toLowerCase());
        const { filter, problems } = await this.authorFilter(repo);
        if (problems.length > 0) {
          base.error = problems.join(" ");
        }
        const [active, completed, abandoned] = await Promise.all([
          this.client.pullRequests(repo, "active"),
          this.client.pullRequests(repo, "completed", closedSince),
          options.showAbandoned ? this.client.pullRequests(repo, "abandoned", closedSince) : Promise.resolve([] as PullRequest[]),
        ]);
        const closed = [...completed, ...abandoned].filter((pr) => isRetained(pr.closedDate, options.retentionHours, now));
        const prs = [...active, ...closed].filter((pr) => matchesAuthor(filter, pr.createdBy) && (options.showDrafts || !pr.isDraft || pr.status !== "active"));
        const webUrl = prs[0]?.repository.webUrl ?? base.url;
        base.url = webUrl;
        const groupIds = viewer ? await this.viewerGroups(repo.organization, viewer.id, prs) : new Set<string>();
        base.prs = await mapLimit(prs, 6, async (pr) => {
          let evaluations;
          let comments;
          if (pr.status === "active") {
            [evaluations, comments] = await Promise.all([
              this.client.policyEvaluations(repo.organization, pr.repository.project.id, pr.pullRequestId).catch((e) => this.soft(e, `policies of !${pr.pullRequestId}`)),
              this.client
                .threads(repo, pr.pullRequestId)
                .then(countThreads)
                .catch((e) => this.soft(e, `comments of !${pr.pullRequestId}`)),
            ]);
          }
          return toPrView({
            pr,
            repoKey: repo.key,
            webUrl,
            evaluations,
            comments,
            viewer: viewer ? { id: viewer.id, groupIds } : undefined,
            watchedAuthors: !filter.everyone,
            retentionHours: options.retentionHours,
          });
        });
      } catch (e) {
        if (e instanceof AuthError) {
          signIn = e.message;
        }
        base.error = (e as Error).message;
        // Keep showing what was loaded before.
        base.prs = previous?.repos.find((r) => r.key === repo.key)?.prs ?? [];
        this.log(`${repo.key}: ${(e as Error).stack ?? e}`);
      }
      return base;
    });

    const me = viewers.values().next().value;
    return {
      repos,
      me: me ? { id: me.id, name: me.displayName } : undefined,
      updated: new Date(now).toISOString(),
      loading: false,
      signIn,
      problems: options.problems,
      retentionHours: options.retentionHours,
    };
  }

  private soft(e: unknown, what: string): undefined {
    if (e instanceof AuthError) {
      throw e;
    }
    this.log(`Could not load ${what}: ${(e as Error).message}`);
    return undefined;
  }

  /** The authors to show, and messages about those that could not be found (the others still count). */
  private async authorFilter(repo: WatchedRepo): Promise<{ filter: AuthorFilter; problems: string[] }> {
    if (repo.authors.some((a) => a.kind === "everyone")) {
      return { filter: { everyone: true }, problems: [] };
    }
    const filter: AuthorFilter = { everyone: false, ids: new Set(), emails: new Set(), names: new Set() };
    const problems: string[] = [];
    for (const author of repo.authors) {
      try {
        const resolved = await this.resolve(repo, author);
        resolved.ids.forEach((id) => filter.ids.add(id));
        resolved.emails.forEach((email) => filter.emails.add(email));
        resolved.names.forEach((name) => filter.names.add(name));
      } catch (e) {
        if (!(e instanceof AdoError) || e instanceof AuthError || e.status !== undefined) {
          throw e;
        }
        problems.push(e.message);
      }
    }
    return { filter, problems };
  }

  private resolve(repo: WatchedRepo, author: AuthorSpec): Promise<Resolved> {
    const none = (): Resolved => ({ ids: new Set(), emails: new Set(), names: new Set() });
    if (author.kind === "person") {
      return Promise.resolve({ ...none(), emails: new Set([author.email]) });
    }
    if (author.kind === "everyone") {
      return Promise.resolve(none());
    }
    const org = repo.organization;
    const key = `${org}|${author.scope ?? `team:${repo.project}`}|${author.name}`.toLowerCase();
    return this.members.get(key, async () => {
      if (author.scope === undefined && !author.name.includes("\\")) {
        try {
          const members = await this.client.teamMembers(org, repo.project, author.name);
          return {
            ...none(),
            ids: new Set(members.map((m) => m.id.toLowerCase())),
            emails: new Set(members.flatMap((m) => (m.uniqueName ? [m.uniqueName.toLowerCase()] : []))),
          };
        } catch (e) {
          // Unknown teams are 404, or 500 for some names (for example with parentheses); then try groups and names.
          if (!(e instanceof AdoError) || e instanceof AuthError) {
            throw e;
          }
        }
      }
      const qualified = `[${author.scope ?? repo.project}]\\${author.name}`;
      try {
        const [group] = (await this.client.identities(org, { name: qualified })).filter((i) => i.isContainer);
        if (group) {
          return { ...none(), ids: await this.expand(org, group.id, group.memberIds ?? []) };
        }
      } catch (e) {
        if (author.scope !== undefined || !(e instanceof AdoError) || e instanceof AuthError) {
          throw e;
        }
        this.log(`Could not look up group ${qualified}: ${e.message}`);
      }
      if (author.scope !== undefined) {
        throw new AdoError(`No group named "${qualified}".`);
      }
      // Anyone else by the name Azure DevOps shows for pull request authors, or by unique name. Service principals
      // such as agents ("Agency") and build services ("One Build Service (contoso)", "Build\<id>") cannot be looked up.
      const name = author.name.toLowerCase();
      return { ...none(), emails: new Set([name]), names: new Set([name]) };
    });
  }

  /** IDs of the members of a group, including members of nested groups. */
  private expand(org: string, groupId: string, memberIds?: string[]): Promise<Set<string>> {
    return this.groupMembers.get(`${org}|${groupId}`.toLowerCase(), async () => {
      const ids = new Set<string>();
      const visited = new Set<string>([groupId.toLowerCase()]);
      let pending = memberIds ?? (await this.client.identities(org, { ids: [groupId] }))[0]?.memberIds ?? [];
      for (let depth = 0; depth < 4 && pending.length > 0; depth++) {
        const next: string[] = [];
        for (let i = 0; i < pending.length; i += 50) {
          const batch = pending.slice(i, i + 50).filter((id) => !visited.has(id.toLowerCase()));
          batch.forEach((id) => visited.add(id.toLowerCase()));
          if (batch.length === 0) {
            continue;
          }
          for (const identity of await this.client.identities(org, { ids: batch })) {
            if (identity.isContainer) {
              next.push(...(identity.memberIds ?? []));
            } else {
              ids.add(identity.id.toLowerCase());
            }
          }
        }
        pending = next;
      }
      return ids;
    });
  }

  /** Group reviewers of these pull requests that the viewer belongs to. */
  private async viewerGroups(org: string, viewerId: string, prs: readonly PullRequest[]): Promise<Set<string>> {
    const groups = [...new Set(prs.flatMap((pr) => (pr.reviewers ?? []).filter((r) => r.isContainer).map((r) => r.id.toLowerCase())))];
    const me = viewerId.toLowerCase();
    const mine = new Set<string>();
    await mapLimit(groups, 4, async (id) => {
      try {
        if ((await this.expand(org, id)).has(me)) {
          mine.add(id);
        }
      } catch (e) {
        this.soft(e, `members of group ${id}`);
      }
    });
    return mine;
  }
}
