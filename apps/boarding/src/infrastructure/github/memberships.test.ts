import { describe, expect, it, vi } from "vitest";

import { GitHubMemberships } from "./memberships.js";
import { GitHubRequest } from "./request.js";

const person = { databaseId: 1, login: "alice" };
const pageInfo = { hasNextPage: false, endCursor: null };
const response = (privacy = "VISIBLE") =>
  Response.json({
    data: {
      u0: person,
      organization: {
        login: "densanken",
        t0: { privacy, m0: { pageInfo, edges: [{ role: "MAINTAINER", node: person }] } },
      },
    },
  });

describe("GitHubMemberships", () => {
  it("Team の現在の role を取得し Org は照会しない", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response());
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.teamMemberships([{ id: 1, login: "alice" }], ["blog"])).resolves.toEqual([
      { person: { id: 1, login: "alice" }, orgRole: undefined, teams: { blog: "maintainer" } },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("2 人の Reviewer の Team 所属を 1 回の GraphQL 照会で取得する", async () => {
    const bob = { id: 2, login: "bob" };
    const carol = { id: 3, login: "carol" };
    const people = [bob, carol];
    const nodes = people.map((person) => ({ databaseId: person.id, login: person.login }));
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValueOnce(
      Response.json({
        data: {
          u0: nodes[0],
          u1: nodes[1],
          organization: {
            login: "densanken",
            t0: {
              m0: { pageInfo, edges: [{ role: "MEMBER", node: nodes[0] }] },
              m1: { pageInfo, edges: [{ role: "MAINTAINER", node: nodes[1] }] },
            },
          },
        },
      })
    );
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.teamMemberships(people, ["blog"])).resolves.toEqual([
      { person: bob, orgRole: undefined, teams: { blog: "member" } },
      { person: carol, orgRole: undefined, teams: { blog: "maintainer" } },
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(fetcher.mock.calls[0]?.[1].body as string) as { query: string };
    expect(body.query).toContain('query: "bob"');
    expect(body.query).toContain('query: "carol"');
  });

  it("多数の Reviewer の Team 所属を上限内に分けて取得する", async () => {
    const people = Array.from({ length: 151 }, (_, index) => ({ id: index + 1, login: `user${String(index)}` }));
    const responseFor = (batch: typeof people) =>
      Response.json({
        data: {
          ...Object.fromEntries(
            batch.map((person, index) => [`u${String(index)}`, { databaseId: person.id, login: person.login }])
          ),
          organization: {
            login: "densanken",
            t0: Object.fromEntries(batch.map((_, index) => [`m${String(index)}`, { pageInfo, edges: [] }])),
          },
        },
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(responseFor(people.slice(0, 100)))
      .mockResolvedValueOnce(responseFor(people.slice(100)));
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    const memberships = await gateway.teamMemberships(people, ["blog"]);
    expect(memberships).toHaveLength(151);
    expect(memberships.every((membership) => membership.teams.blog === null)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("Team が不要なら API を呼ばない", async () => {
    const fetcher = vi.fn();
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.teamMemberships([{ id: 1, login: "alice" }], [])).resolves.toEqual([
      { person: { id: 1, login: "alice" }, orgRole: undefined, teams: {} },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("Org の role を個別に取得する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ state: "active", role: "admin", user: { id: 1 }, organization: { login: "densanken" } })
      );
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.orgMembership({ id: 1, login: "alice" })).resolves.toBe("admin");
  });

  it("所属 API の 404 は非 Member として扱う", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.orgMembership({ id: 1, login: "alice" })).resolves.toBeNull();
  });

  it("所属 API の権限エラーは非 Member と扱わない", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }));
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.orgMembership({ id: 1, login: "alice" })).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("Editor の実在確認と同じ応答から User ID を返す", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { u0: { databaseId: 1, login: "Alice" }, organization: { login: "densanken" } } })
      );
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.validateEditors(["alice"], [])).resolves.toEqual([
      { login: "alice", person: { id: 1, login: "Alice" } },
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("存在しない個人 Editor は、person を null にして返す", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      Response.json({
        data: { u0: null, organization: { login: "densanken" } },
        errors: [{ type: "NOT_FOUND", path: ["u0"] }],
      })
    );
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.validateEditors(["missing"], [])).resolves.toEqual([{ login: "missing", person: null }]);
  });

  it.each([
    ["別名の欠落", { organization: { login: "densanken" } }],
    ["ID の形式の不正", { u0: { databaseId: "1", login: "alice" }, organization: { login: "densanken" } }],
    ["login の不一致", { u0: { databaseId: 1, login: "bob" }, organization: { login: "densanken" } }],
  ])("%s は存在しないとせず、応答の異常にする", async (_name, data) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data }));
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.validateEditors(["alice"], [])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    [[{ type: "FORBIDDEN", path: ["u0"] }]],
    [[{ type: "NOT_FOUND", path: ["organization"] }]],
    [
      [
        { type: "NOT_FOUND", path: ["u0"] },
        { type: "FORBIDDEN", path: ["u0"] },
      ],
    ],
  ])("Editor 以外の GraphQL エラーを許容しない", async (errors) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { u0: null, organization: { login: "densanken" } }, errors }));
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.validateEditors(["missing"], [])).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("存在しないか見えない Team を実在確認で拒否する", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { organization: { login: "densanken", t0: null } } }));
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.validateEditors([], ["blog"])).rejects.toMatchObject({ code: "INVALID_METADATA" });
  });

  it("Secret Team を実在確認で拒否する", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response("SECRET"));
    const gateway = new GitHubMemberships({
      request: new GitHubRequest(fetcher),
      getToken: () => Promise.resolve("token"),
    });
    await expect(gateway.validateEditors([], ["blog"])).rejects.toMatchObject({ code: "INVALID_METADATA" });
  });
});
