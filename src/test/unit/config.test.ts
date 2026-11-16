import * as assert from "assert";
import { parseAuthor, parseRepoUrl, readRepositories } from "../../config";

suite("config", () => {
  test("parses web, pull request, clone and SSH URLs", () => {
    const expected = { organization: "msazure", project: "One", repository: "aio-opcua-connector" };
    for (const url of [
      "https://dev.azure.com/msazure/One/_git/aio-opcua-connector",
      "https://dev.azure.com/msazure/One/_git/aio-opcua-connector/pullrequests?_a=mine",
      "https://dev.azure.com/msazure/One/_git/aio-opcua-connector/pullrequest/17917120",
      "https://msazure@dev.azure.com/msazure/One/_git/aio-opcua-connector",
      "https://msazure.visualstudio.com/DefaultCollection/One/_git/aio-opcua-connector",
      "https://msazure.visualstudio.com/One/_git/aio-opcua-connector",
      "git@ssh.dev.azure.com:v3/msazure/One/aio-opcua-connector",
      "msazure@vs-ssh.visualstudio.com:v3/msazure/One/aio-opcua-connector",
    ]) {
      assert.deepStrictEqual(parseRepoUrl(url), expected, url);
    }
  });

  test("decodes spaces and treats org/_git/repo as the project's own repository", () => {
    assert.deepStrictEqual(parseRepoUrl("https://dev.azure.com/contoso/My%20Project/_git/My%20Repo"), {
      organization: "contoso",
      project: "My Project",
      repository: "My Repo",
    });
    assert.deepStrictEqual(parseRepoUrl("https://dev.azure.com/contoso/_git/Fabrikam"), { organization: "contoso", project: "Fabrikam", repository: "Fabrikam" });
  });

  test("rejects other URLs", () => {
    for (const url of ["https://github.com/luiscantero/PrWatcher", "https://dev.azure.com/msazure/One", "not a url", "ftp://dev.azure.com/a/b/_git/c"]) {
      assert.strictEqual(parseRepoUrl(url), undefined, url);
    }
  });

  test("parses authors", () => {
    assert.deepStrictEqual(parseAuthor("AIO Connectors Team"), { kind: "group", name: "AIO Connectors Team" });
    assert.deepStrictEqual(parseAuthor("[TEAM FOUNDATION]\\AIO Connectors Team"), { kind: "group", scope: "TEAM FOUNDATION", name: "AIO Connectors Team" });
    assert.deepStrictEqual(parseAuthor(" Someone@Contoso.com "), { kind: "person", email: "someone@contoso.com" });
    assert.deepStrictEqual(parseAuthor("*"), { kind: "everyone" });
    assert.strictEqual(parseAuthor("  "), undefined);
  });

  test("repository authors override the default authors, and duplicates are dropped", () => {
    const { repos, problems } = readRepositories(
      [
        "https://dev.azure.com/msazure/One/_git/aio-media",
        { url: "https://dev.azure.com/msazure/One/_git/aio-opcua-connector", authors: ["AIO Connectors Team"] },
        { url: "https://dev.azure.com/msazure/One/_git/aio-opcua-sdk", authors: [] },
        "https://dev.azure.com/MSAZURE/one/_git/AIO-MEDIA/pullrequests",
        "https://example.com/repo",
      ],
      ["a@contoso.com"],
    );
    assert.deepStrictEqual(
      repos.map((r) => [r.repository, r.authorsLabel, r.ownAuthors]),
      [
        ["aio-media", "a@contoso.com", false],
        ["aio-opcua-connector", "AIO Connectors Team", true],
        ["aio-opcua-sdk", "a@contoso.com", false],
      ],
    );
    assert.strictEqual(problems.length, 1);
  });

  test("no authors or * means everyone", () => {
    const { repos } = readRepositories(
      ["https://dev.azure.com/o/p/_git/a", { url: "https://dev.azure.com/o/p/_git/b", authors: ["*", "Team"] }],
      [],
    );
    assert.deepStrictEqual(
      repos.map((r) => [r.authors, r.authorsLabel]),
      [
        [[{ kind: "everyone" }], "everyone"],
        [[{ kind: "everyone" }], "everyone"],
      ],
    );
  });
});
