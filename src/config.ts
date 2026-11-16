export interface RepoRef {
  organization: string;
  project: string;
  repository: string;
}

export type AuthorSpec =
  | { kind: "everyone" }
  | { kind: "person"; email: string }
  /** A team of the repository's project, or a group when `scope` is set (`[scope]\name`). */
  | { kind: "group"; name: string; scope?: string };

export interface WatchedRepo extends RepoRef {
  /** Stable, case-insensitive identity of the repository. */
  key: string;
  /** The URL as written in the settings. */
  configuredUrl: string;
  authors: AuthorSpec[];
  /** The `authors` entries as written, for display. */
  authorsLabel: string;
  /** Whether `authors` came from the repository entry instead of `prWatcher.authors`. */
  ownAuthors: boolean;
}

export interface RepositorySetting {
  url: string;
  authors?: string[];
}

const SEGMENT = /^[^/?#]+$/;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parses web, pull request, clone and SSH URLs of Azure DevOps repositories:
 * `https://dev.azure.com/org/project/_git/repo/pullrequests`, `https://org@dev.azure.com/org/project/_git/repo`,
 * `https://org.visualstudio.com/DefaultCollection/project/_git/repo`, `git@ssh.dev.azure.com:v3/org/project/repo`.
 */
export function parseRepoUrl(input: string): RepoRef | undefined {
  const text = input.trim();
  const ssh = /^(?:ssh:\/\/)?[^@\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/](?:v3\/)?([^/]+)\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(text);
  if (ssh) {
    return { organization: decode(ssh[1]), project: decode(ssh[2]), repository: decode(ssh[3]) };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  let segments = url.pathname.split("/").filter((s) => s.length > 0);
  let organization: string;
  if (host === "dev.azure.com") {
    organization = segments.shift() ?? "";
  } else if (host.endsWith(".visualstudio.com")) {
    organization = host.slice(0, -".visualstudio.com".length);
    if (segments[0]?.toLowerCase() === "defaultcollection") {
      segments = segments.slice(1);
    }
  } else {
    return undefined;
  }
  const git = segments.findIndex((s) => s.toLowerCase() === "_git");
  if (!organization || git < 0 || git > 1 || !segments[git + 1]) {
    return undefined;
  }
  const repository = decode(segments[git + 1]).replace(/\.git$/i, "");
  // `dev.azure.com/org/_git/repo` is the repository named like its project.
  const project = git === 1 ? decode(segments[0]) : repository;
  if (![organization, project, repository].every((s) => SEGMENT.test(s))) {
    return undefined;
  }
  return { organization: decode(organization), project, repository };
}

export function repoKey(ref: RepoRef): string {
  return `${ref.organization}/${ref.project}/${ref.repository}`.toLowerCase();
}

export function repoWebUrl(ref: RepoRef): string {
  const e = encodeURIComponent;
  return `https://dev.azure.com/${e(ref.organization)}/${e(ref.project)}/_git/${e(ref.repository)}`;
}

export function parseAuthor(input: string): AuthorSpec | undefined {
  const text = input.trim();
  if (!text) {
    return undefined;
  }
  if (text === "*") {
    return { kind: "everyone" };
  }
  const scoped = /^\[([^\]]+)\]\\(.+)$/.exec(text);
  if (scoped) {
    return { kind: "group", scope: scoped[1].trim(), name: scoped[2].trim() };
  }
  if (/^[^\s@\\]+@[^\s@\\]+$/.test(text)) {
    return { kind: "person", email: text.toLowerCase() };
  }
  return { kind: "group", name: text };
}

export function authorsLabel(authors: string[]): string {
  const shown = authors.map((a) => a.trim()).filter((a) => a.length > 0);
  return shown.length === 0 || shown.includes("*") ? "everyone" : shown.join(", ");
}

export interface ConfigProblem {
  entry: string;
  message: string;
}

/** Turns the `prWatcher.repositories` and `prWatcher.authors` settings into watched repositories. */
export function readRepositories(
  repositories: readonly (string | RepositorySetting)[] | undefined,
  defaultAuthors: readonly string[] | undefined,
): { repos: WatchedRepo[]; problems: ConfigProblem[] } {
  const repos: WatchedRepo[] = [];
  const problems: ConfigProblem[] = [];
  const seen = new Set<string>();
  for (const entry of repositories ?? []) {
    const url = typeof entry === "string" ? entry : entry?.url;
    if (typeof url !== "string") {
      problems.push({ entry: JSON.stringify(entry), message: "has no url" });
      continue;
    }
    const ref = parseRepoUrl(url);
    if (!ref) {
      problems.push({ entry: url, message: "is not an Azure DevOps repository URL" });
      continue;
    }
    const key = repoKey(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const own = typeof entry === "string" ? undefined : entry.authors?.filter((a) => typeof a === "string" && a.trim().length > 0);
    const ownAuthors = own !== undefined && own.length > 0;
    const raw = ownAuthors ? own : [...(defaultAuthors ?? [])];
    const specs = raw.map(parseAuthor).filter((a): a is AuthorSpec => a !== undefined);
    const authors = specs.length === 0 || specs.some((a) => a.kind === "everyone") ? [{ kind: "everyone" } as const] : specs;
    repos.push({ ...ref, key, configuredUrl: url, authors, authorsLabel: authorsLabel(raw), ownAuthors });
  }
  return { repos, problems };
}
