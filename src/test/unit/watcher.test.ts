import * as assert from "assert";
import { AdoClient, AdoError, Identity, IdentityRef, PullRequest } from "../../ado";
import { readRepositories } from "../../config";
import { Watcher } from "../../watcher";

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function pr(id: number, author: string, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    pullRequestId: id,
    title: `PR ${id}`,
    status: "active",
    createdBy: { id: author, displayName: author, uniqueName: `${author}@contoso.com` },
    creationDate: hoursAgo(1),
    sourceRefName: "refs/heads/x",
    targetRefName: "refs/heads/main",
    reviewers: [],
    repository: { id: "r", name: "repo", webUrl: "https://dev.azure.com/contoso/P/_git/repo", project: { id: "pid", name: "P" } },
    ...extra,
  };
}

/** A fake Azure DevOps with team "Team" (alice), group "[P]\Group" (bob and nested group with carol). */
function fakeClient(prs: PullRequest[]) {
  const identities: Record<string, Identity> = {
    group: { id: "group", isContainer: true, memberIds: ["bob", "nested"] },
    nested: { id: "nested", isContainer: true, memberIds: ["carol", "group"] },
    bob: { id: "bob", isContainer: false },
    carol: { id: "carol", isContainer: false },
    reviewers: { id: "reviewers", isContainer: true, memberIds: ["me"] },
    me: { id: "me", isContainer: false },
  };
  const calls: string[] = [];
  const client = {
    me: async (): Promise<IdentityRef> => ({ id: "me", displayName: "Me" }),
    pullRequests: async (_: unknown, status: string, since?: Date) => {
      calls.push(`prs:${status}`);
      return prs.filter((p) => p.status === status && (!since || !p.closedDate || Date.parse(p.closedDate) >= since.getTime()));
    },
    policyEvaluations: async () => [],
    threads: async () => [],
    teamMembers: async (_org: string, _project: string, team: string) => {
      calls.push(`team:${team}`);
      if (team === "Team") {
        return [{ id: "alice", displayName: "Alice", uniqueName: "alice@contoso.com" }];
      }
      throw new AdoError("The team does not exist", 500);
    },
    identities: async (_org: string, lookup: { name: string } | { ids: string[] }) => {
      if ("name" in lookup) {
        calls.push(`group:${lookup.name}`);
        return lookup.name === "[P]\\Group" ? [identities.group] : [];
      }
      return lookup.ids.map((id) => identities[id]).filter(Boolean);
    },
  };
  return { client: client as unknown as AdoClient, calls };
}

const options = (authors: string[]) => {
  const { repos, problems } = readRepositories([{ url: "https://dev.azure.com/contoso/P/_git/repo", authors }], []);
  return { repos, problems, retentionHours: 72, showAbandoned: true, showDrafts: false };
};

suite("watcher", () => {
  test("shows pull requests of team members, group members (also nested) and people", async () => {
    const { client, calls } = fakeClient([pr(1, "alice"), pr(2, "bob"), pr(3, "carol"), pr(4, "dave"), pr(5, "erin")]);
    const state = await new Watcher(client, () => undefined).load(options(["Team", "Group", "erin@contoso.com"]));
    assert.strictEqual(state.repos[0].error, undefined);
    assert.deepStrictEqual(
      state.repos[0].prs.map((p) => p.id),
      [1, 2, 3, 5],
    );
    // "Group" is not a team of the project, so it is looked up as [P]\Group.
    assert.ok(calls.includes("team:Group") && calls.includes("group:[P]\\Group"));
  });

  test("lists closed pull requests within the retention time, abandoned ones only if enabled, and no drafts", async () => {
    const { client } = fakeClient([
      pr(1, "alice", { status: "completed", closedDate: hoursAgo(5) }),
      pr(2, "alice", { status: "abandoned", closedDate: hoursAgo(10) }),
      pr(3, "alice", { status: "completed", closedDate: hoursAgo(80) }),
      pr(4, "alice", { isDraft: true }),
    ]);
    const watcher = new Watcher(client, () => undefined);
    const state = await watcher.load(options(["*"]));
    assert.deepStrictEqual(
      state.repos[0].prs.map((p) => [p.id, p.phase]),
      [
        [1, "merged"],
        [2, "abandoned"],
      ],
    );
    const withoutAbandoned = await watcher.load({ ...options(["*"]), showAbandoned: false });
    assert.deepStrictEqual(
      withoutAbandoned.repos[0].prs.map((p) => p.id),
      [1],
    );
  });

  test("recognizes group reviewers the viewer belongs to", async () => {
    const { client } = fakeClient([pr(1, "alice", { reviewers: [{ id: "reviewers", displayName: "Reviewers", vote: 0, isContainer: true }] })]);
    const state = await new Watcher(client, () => undefined).load(options(["*"]));
    assert.strictEqual(state.repos[0].prs[0].reviewRequested, true);
    assert.strictEqual(state.me?.id, "me");
  });

  test("shows pull requests of service accounts and agents by display name or unique name", async () => {
    const buildService = { id: "b1", displayName: "One Build Service (contoso)", uniqueName: "Build\\1234" };
    // Agents are service principals that the identity search does not find.
    const agent = { id: "a1", displayName: "Agency", uniqueName: "a1@tenant" };
    for (const [author, expected] of [
      ["One Build Service (contoso)", [1]],
      ["Build\\1234", [1]],
      ["agency", [2]],
    ] as const) {
      const { client, calls } = fakeClient([pr(1, "x", { createdBy: buildService }), pr(2, "y", { createdBy: agent }), pr(3, "dave")]);
      const state = await new Watcher(client, () => undefined).load(options([author]));
      assert.strictEqual(state.repos[0].error, undefined, author);
      assert.deepStrictEqual(
        state.repos[0].prs.map((p) => p.id),
        expected,
        author,
      );
      assert.strictEqual(calls.includes(`team:${author}`), !author.includes("\\"), author);
    }
  });

  test("reports an unknown group on its repository and still shows the other authors' pull requests", async () => {
    const { client } = fakeClient([pr(1, "alice"), pr(2, "dave")]);
    const state = await new Watcher(client, () => undefined).load(options(["Team", "[P]\\Nobody"]));
    assert.match(state.repos[0].error ?? "", /No group named "\[P\]\\Nobody"/);
    assert.deepStrictEqual(
      state.repos[0].prs.map((p) => p.id),
      [1],
    );
  });

  test("keeps the previous pull requests when a repository cannot be loaded", async () => {
    const { client } = fakeClient([pr(1, "alice")]);
    const watcher = new Watcher(client, () => undefined);
    const previous = await watcher.load(options(["*"]));
    (client as unknown as { pullRequests: () => Promise<never> }).pullRequests = async () => {
      throw new AdoError("Service unavailable", 503);
    };
    const state = await watcher.load(options(["*"]), previous);
    assert.strictEqual(state.repos[0].error, "Service unavailable");
    assert.deepStrictEqual(
      state.repos[0].prs.map((p) => p.id),
      [1],
    );
  });
});
