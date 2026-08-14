import { describe, expect, it } from "vitest";
import {
  LINEAR_OPERATION_ACTIONS,
  compileLinearOperation,
  linearOperationInputSchema,
  linearOperationInputSchemas,
} from "../src/linear/operations.js";

const ids = {
  team: "10000000-0000-4000-8000-000000000001",
  state: "10000000-0000-4000-8000-000000000002",
  assignee: "10000000-0000-4000-8000-000000000003",
  issue: "10000000-0000-4000-8000-000000000004",
  created: "10000000-0000-4000-8000-000000000005",
};

const pageInfo = { hasNextPage: false, endCursor: null };
const issue = {
  id: ids.issue,
  identifier: "ENG-123",
  title: "Typed operations",
  priority: 2,
  url: "https://linear.app/acme/issue/ENG-123/typed-operations",
  createdAt: "2026-08-13T12:00:00.000Z",
  updatedAt: "2026-08-13T13:00:00.000Z",
  archivedAt: null,
  team: { id: ids.team, key: "ENG", name: "Engineering" },
  state: { id: ids.state, name: "In Progress", type: "started" },
  assignee: { id: ids.assignee, name: "Bill" },
};
const issueDetail = { ...issue, description: null };

describe("typed Linear operations", () => {
  it("keeps its exported action tuple aligned with the runtime schemas", () => {
    expect(linearOperationInputSchemas.map((schema) => schema.shape.action.value))
      .toEqual(LINEAR_OPERATION_ACTIONS);
  });

  it("accepts only bounded strict action inputs", () => {
    expect(linearOperationInputSchema.safeParse({ action: "issues.list", first: 50 }).success).toBe(true);
    expect(linearOperationInputSchema.safeParse({ action: "issues.list", first: 51 }).success).toBe(false);
    expect(linearOperationInputSchema.safeParse({ action: "issues.search", query: "bug", first: 20 }).success).toBe(true);
    expect(linearOperationInputSchema.safeParse({ action: "issues.search", query: "bug", first: 21 }).success).toBe(false);
    expect(linearOperationInputSchema.safeParse({ action: "issues.get", id: "ENG-123", extra: true }).success).toBe(false);
    expect(linearOperationInputSchema.safeParse({ action: "issues.update", id: "ENG-123" }).success).toBe(false);
    expect(linearOperationInputSchema.safeParse({
      action: "issues.create",
      teamId: "Engineering",
      title: "No fuzzy team names",
    }).success).toBe(false);
  });

  it("compiles list filters and bounded cursor pagination into a fixed query", () => {
    const operation = compileLinearOperation({
      action: "issues.list",
      first: 25,
      after: "cursor-1",
      teamId: ids.team,
      stateId: ids.state,
      assigneeId: ids.assignee,
      includeArchived: true,
    }, () => ids.created);

    expect(operation.graphql).toMatchObject({
      operationName: "UnblockLinearIssuesList",
      variables: {
        first: 25,
        after: "cursor-1",
        includeArchived: true,
        filter: {
          team: { id: { eq: ids.team } },
          state: { id: { eq: ids.state } },
          assignee: { id: { eq: ids.assignee } },
        },
      },
    });
    expect(operation.graphql.document).toContain("issues(first:");
    expect(operation.graphql.document).toContain("pageInfo { hasNextPage endCursor }");
    expect(operation.graphql.document).not.toMatch(/\bdescription\b/u);
  });

  it("uses searchIssues with its smaller default page and never issueSearch", () => {
    const operation = compileLinearOperation({ action: "issues.search", query: "relay bug" }, () => ids.created);

    expect(operation.graphql.variables).toEqual({
      term: "relay bug",
      first: 10,
      includeArchived: false,
    });
    expect(operation.graphql.document).toContain("searchIssues(");
    expect(operation.graphql.document).not.toMatch(/\bissueSearch\b/u);
  });

  it("constrains issue search by team through IssueFilter instead of the ranking hint", () => {
    const operation = compileLinearOperation({
      action: "issues.search",
      query: "relay bug",
      teamId: ids.team,
    }, () => ids.created);

    expect(operation.graphql.variables).toMatchObject({
      filter: { team: { id: { eq: ids.team } } },
    });
    expect(operation.graphql.variables).not.toHaveProperty("teamId");
    expect(operation.graphql.document).toContain("$filter: IssueFilter");
    expect(operation.graphql.document).toContain("filter: $filter");
    expect(operation.graphql.document).not.toContain("teamId: $teamId");
    expect(operation.graphql.document).not.toMatch(/\bdescription\b/u);
  });

  it("generates the issue ID before dispatch and returns content-free reconciliation metadata", () => {
    const operation = compileLinearOperation({
      action: "issues.create",
      teamId: ids.team,
      title: "Secret customer title",
      description: "Secret customer description",
      stateId: ids.state,
    }, () => ids.created);

    expect(operation.graphql.variables).toEqual({
      input: {
        id: ids.created,
        teamId: ids.team,
        title: "Secret customer title",
        description: "Secret customer description",
        stateId: ids.state,
      },
    });
    expect(operation.reconciliation).toEqual({
      entityType: "issue",
      entityId: ids.created,
    });
    expect(JSON.stringify(operation.reconciliation)).not.toContain("Secret customer");
  });

  it("generates comment IDs and compiles updates without undefined fields", () => {
    const comment = compileLinearOperation({
      action: "comments.create",
      issueId: "ENG-123",
      body: "A comment",
    }, () => ids.created);
    const update = compileLinearOperation({
      action: "issues.update",
      id: "ENG-123",
      description: null,
      assigneeId: null,
    }, () => ids.created);

    expect(comment.graphql.variables).toEqual({
      input: { id: ids.created, issueId: "ENG-123", body: "A comment" },
    });
    expect(comment.reconciliation).toEqual({
      entityType: "comment",
      entityId: ids.created,
    });
    expect(update.graphql.variables).toEqual({
      id: "ENG-123",
      input: { description: null, assigneeId: null },
    });
  });

  it("preserves exact comment whitespace while rejecting all-whitespace bodies", () => {
    const body = "\n  Keep this formatting.  \n";
    const parsed = linearOperationInputSchema.parse({
      action: "comments.create",
      issueId: "ENG-123",
      body,
    });
    expect(parsed).toMatchObject({ body });
    expect(linearOperationInputSchema.safeParse({
      action: "comments.create",
      issueId: "ENG-123",
      body: " \n\t ",
    }).success).toBe(false);
  });

  it("compiles discovery queries with explicit IDs and small pagination", () => {
    const teams = compileLinearOperation({ action: "teams.list" }, () => ids.created);
    const states = compileLinearOperation({ action: "states.list", teamId: ids.team }, () => ids.created);
    const get = compileLinearOperation({ action: "issues.get", id: "ENG-123" }, () => ids.created);

    expect(teams.graphql.variables).toEqual({ first: 20, includeArchived: false });
    expect(states.graphql.variables).toEqual({
      first: 20,
      filter: { team: { id: { eq: ids.team } } },
    });
    expect(get.graphql.variables).toEqual({ id: "ENG-123" });
  });

  it("returns only runtime-validated fixed projections", () => {
    const operation = compileLinearOperation({ action: "issues.list" }, () => ids.created);

    expect(operation.parseResult({ data: { issues: { nodes: [issue], pageInfo } } })).toEqual({
      nodes: [issue],
      pageInfo,
    });
  });

  it("returns descriptions only for an individual issue read", () => {
    const operation = compileLinearOperation({ action: "issues.get", id: "ENG-123" }, () => ids.created);

    expect(operation.graphql.document).toMatch(/\bdescription\b/u);
    expect(operation.parseResult({ data: { issue: issueDetail } })).toEqual(issueDetail);
  });

  it.each([
    {},
    { data: null },
    { data: { issues: { nodes: [{ id: ids.issue }], pageInfo } } },
    { data: { issues: { nodes: [issue], pageInfo } }, errors: [{ message: "partial failure" }] },
  ])("fails closed on malformed or errored typed envelopes", (envelope) => {
    const operation = compileLinearOperation({ action: "issues.list" }, () => ids.created);
    expect(() => operation.parseResult(envelope)).toThrow("Linear returned an invalid typed operation result.");
  });
});
