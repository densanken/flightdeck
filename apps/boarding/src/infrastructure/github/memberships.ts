import * as v from "valibot";

import { BoardingError } from "../../errors.js";

import type { GitHubRequest } from "./request.js";
import type { Membership, Person, ResolvedUser } from "../../domain/editors.js";

const user = v.object({ databaseId: v.pipe(v.number(), v.safeInteger(), v.minValue(1)), login: v.string() });
const teamMembers = v.object({
  pageInfo: v.object({ hasNextPage: v.boolean() }),
  edges: v.array(v.object({ role: v.picklist(["MAINTAINER", "MEMBER"]), node: user })),
});

const userSelections = (logins: string[]): string =>
  logins
    .map((login, index) => `u${String(index)}: user(login: ${JSON.stringify(login)}) { databaseId login }`)
    .join("\n");

const editorTeamSelections = (slugs: string[]): string =>
  slugs.map((slug, index) => `t${String(index)}: team(slug: ${JSON.stringify(slug)}) { privacy }`).join("\n");

const membershipTeamSelections = (slugs: string[], people: Person[]): string =>
  slugs
    .map((slug, index) => {
      const members = people
        .map(
          (person, actor) =>
            `m${String(actor)}: members(first: 100, membership: ALL, query: ${JSON.stringify(person.login)}) { pageInfo { hasNextPage } edges { role node { databaseId login } } }`
        )
        .join("\n");

      return `t${String(index)}: team(slug: ${JSON.stringify(slug)}) { ${members} }`;
    })
    .join("\n");

const validateEditorResponse = (data: unknown, users: string[], slugs: string[]): ResolvedUser[] => {
  const resolvedUsers: ResolvedUser[] = [];
  const parsed = v.safeParse(v.object({ organization: v.record(v.string(), v.unknown()) }), data);
  const top = v.safeParse(v.record(v.string(), v.unknown()), data);
  if (!parsed.success || !top.success) throw new BoardingError("INVALID_RESPONSE", "GitHub editor response is invalid");

  for (const [index, login] of users.entries()) {
    const alias = `u${String(index)}`;
    // 別名が明示的に null のときだけ、ユーザーが存在しないとみなす
    if (top.output[alias] === null) {
      resolvedUsers.push({ login, person: null });
      continue;
    }

    const resolved = v.safeParse(user, top.output[alias]);
    if (!resolved.success || resolved.output.login.toLowerCase() !== login) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub editor response is invalid");
    }
    resolvedUsers.push({ login, person: { id: resolved.output.databaseId, login: resolved.output.login } });
  }

  for (const [index] of slugs.entries()) {
    const teamData = parsed.output.organization[`t${String(index)}`];
    if (teamData === null) throw new BoardingError("INVALID_METADATA", "GitHub team does not exist or is not visible");

    const team = v.safeParse(v.object({ privacy: v.picklist(["VISIBLE", "SECRET"]) }), teamData);
    if (!team.success) throw new BoardingError("INVALID_RESPONSE", "GitHub team is unavailable");
    if (team.output.privacy !== "VISIBLE") throw new BoardingError("INVALID_METADATA", "GitHub team is not visible");
  }
  return resolvedUsers;
};

const parseTeamMemberships = (data: unknown, people: Person[], logins: string[], slugs: string[]): Membership[] => {
  const root = v.safeParse(v.object({ organization: v.record(v.string(), v.unknown()) }), data);
  const top = v.safeParse(v.record(v.string(), v.unknown()), data);
  if (!root.success || !top.success) {
    throw new BoardingError("INVALID_RESPONSE", "GitHub membership response is invalid");
  }

  if (root.output.organization.login !== "densanken") {
    throw new BoardingError("INVALID_RESPONSE", "GitHub organization is unavailable");
  }

  const resolved: Membership[] = logins.map((login, index) => {
    const parsed = v.safeParse(user, top.output[`u${String(index)}`]);
    if (!parsed.success || parsed.output.login.toLowerCase() !== login) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub person is unavailable");
    }

    const known = people.find((person) => person.login.toLowerCase() === login);
    if (known?.id !== parsed.output.databaseId) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub person identity changed");
    }

    return { person: known, orgRole: undefined, teams: {} };
  });

  for (const [index, slug] of slugs.entries()) {
    const teamData = v.safeParse(v.record(v.string(), v.unknown()), root.output.organization[`t${String(index)}`]);
    if (!teamData.success) throw new BoardingError("INVALID_RESPONSE", "GitHub team is unavailable");

    for (const [actor, person] of people.entries()) {
      const members = v.safeParse(teamMembers, teamData.output[`m${String(actor)}`]);
      if (!members.success || members.output.pageInfo.hasNextPage) {
        throw new BoardingError("INCOMPLETE_PAGINATION", "GitHub team membership is incomplete");
      }

      const match = members.output.edges.find((edge) => edge.node.databaseId === person.id);
      const target = resolved.find((entry) => entry.person.id === person.id);
      if (!target) throw new BoardingError("INVALID_RESPONSE", "GitHub person identity changed");
      target.teams[slug] = match ? (match.role === "MAINTAINER" ? "maintainer" : "member") : null;
    }
  }

  return resolved;
};

export class GitHubMemberships {
  constructor(private readonly input: { request: GitHubRequest; getToken: () => Promise<string> }) {}

  async validateEditors(editors: string[], teams: string[]): Promise<ResolvedUser[]> {
    const users = [...new Set(editors.map((login) => login.toLowerCase()))];
    const slugs = [...new Set(teams.map((slug) => slug.toLowerCase()))];
    if (users.length === 0 && slugs.length === 0) return [];

    const userQueries = userSelections(users);
    const teamQueries = editorTeamSelections(slugs);
    const data = await this.input.request.graphql(
      await this.input.getToken(),
      `query { ${userQueries} organization(login: "densanken") { login ${teamQueries} } }`,
      {},
      users.map((_, index) => `u${String(index)}`)
    );
    return validateEditorResponse(data, users, slugs);
  }

  async teamMemberships(people: Person[], teams: string[]): Promise<Membership[]> {
    const logins = [...new Set(people.map((person) => person.login.toLowerCase()))];
    const slugs = [...new Set(teams.map((slug) => slug.toLowerCase()))];
    if (people.length === 0 || slugs.length === 0) {
      return people.map((person) => ({ person, orgRole: undefined, teams: {} }));
    }

    if (slugs.length > 100) throw new BoardingError("SUBREQUEST_LIMIT", "Membership query is too large");
    if (people.length * slugs.length > 100) {
      const size = Math.floor(100 / slugs.length);
      const memberships: Membership[] = [];
      for (let offset = 0; offset < people.length; offset += size) {
        memberships.push(...(await this.teamMemberships(people.slice(offset, offset + size), slugs)));
      }

      return memberships;
    }

    const users = userSelections(logins);
    const teamQueries = membershipTeamSelections(slugs, people);
    const data = await this.input.request.graphql(
      await this.input.getToken(),
      `query { ${users} organization(login: "densanken") { login ${teamQueries} } }`,
      {}
    );

    return parseTeamMemberships(data, people, logins, slugs);
  }

  async orgMembership(person: Person): Promise<"admin" | "member" | null> {
    const response = await this.input.request.call({
      method: "GET",
      path: `/orgs/densanken/memberships/${encodeURIComponent(person.login)}`,
      token: await this.input.getToken(),
      allowNotFound: true,
    });
    if (response === undefined) return null;

    const membership = v.safeParse(
      v.object({
        state: v.picklist(["active", "pending"]),
        role: v.picklist(["admin", "member"]),
        user: v.object({ id: v.number() }),
        organization: v.object({ login: v.string() }),
      }),
      response
    );
    if (
      !membership.success ||
      membership.output.user.id !== person.id ||
      membership.output.organization.login.toLowerCase() !== "densanken"
    ) {
      throw new BoardingError("INVALID_RESPONSE", "GitHub organization membership is unavailable");
    }

    return membership.output.state === "active" ? membership.output.role : null;
  }
}
