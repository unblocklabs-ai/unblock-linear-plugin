import { z } from "zod";

export type LinearJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: LinearJsonValue }
  | LinearJsonValue[];

const identifier = z.string().trim().min(1).max(128);
const cursor = z.string().trim().min(1).max(1_024);
const entityId = z.string().uuid();
const pageSize = z.number().int().min(1).max(50).default(20);
const searchPageSize = z.number().int().min(1).max(20).default(10);
const humanIssueIdentifierPattern = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/u;

function parseHumanIssueIdentifier(value: string): { teamKey: string; issueNumber: number } | undefined {
  const match = humanIssueIdentifierPattern.exec(value);
  if (match === null) return undefined;
  const issueNumber = Number(match[2]);
  if (!Number.isSafeInteger(issueNumber)) return undefined;
  return { teamKey: match[1], issueNumber };
}

const issueReference = z.union([
  entityId,
  z.string().trim().min(1).max(128).refine(
    (value) => parseHumanIssueIdentifier(value) !== undefined,
    { message: "Expected a Linear issue UUID or identifier such as ULD-8." },
  ),
]);

const issueSummaryFields = {
  id: entityId,
  identifier,
  title: z.string(),
  priority: z.number().int(),
  url: z.string().url(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  archivedAt: z.string().datetime({ offset: true }).nullable(),
  team: z.strictObject({ id: entityId, key: identifier, name: z.string() }),
  state: z.strictObject({ id: entityId, name: z.string(), type: z.string() }).nullable(),
  assignee: z.strictObject({ id: entityId, name: z.string() }).nullable(),
};

const issueSummarySchema = z.strictObject(issueSummaryFields);
const issueDetailSchema = z.strictObject({
  ...issueSummaryFields,
  description: z.string().nullable(),
});
const pageInfoSchema = z.strictObject({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const issueConnectionSchema = z.strictObject({
  nodes: z.array(issueSummarySchema),
  pageInfo: pageInfoSchema,
});
const issueSearchPayloadSchema = issueConnectionSchema.extend({
  totalCount: z.number().finite().nonnegative(),
});
const issueDetailConnectionSchema = z.strictObject({
  nodes: z.array(issueDetailSchema),
});

export const LINEAR_OPERATION_ACTIONS = [
  "issues.list",
  "issues.search",
  "issues.get",
  "issues.create",
  "issues.update",
  "comments.create",
  "teams.list",
  "states.list",
] as const;
const teamSchema = z.strictObject({
  id: entityId,
  key: identifier,
  name: z.string(),
  description: z.string().nullable(),
});
const stateSchema = z.strictObject({
  id: entityId,
  name: z.string(),
  type: z.string(),
  color: z.string(),
  position: z.number(),
  team: z.strictObject({ id: entityId, key: identifier, name: z.string() }),
});

export const issuesListInputSchema = z.strictObject({
  action: z.literal(LINEAR_OPERATION_ACTIONS[0]),
  first: pageSize.optional(),
  after: cursor.optional(),
  teamId: entityId.optional(),
  stateId: entityId.optional(),
  assigneeId: entityId.optional(),
  includeArchived: z.boolean().optional(),
});

export const issuesSearchInputSchema = z.strictObject({
  action: z.literal(LINEAR_OPERATION_ACTIONS[1]),
  query: z.string().trim().min(1).max(256),
  first: searchPageSize.optional(),
  after: cursor.optional(),
  teamId: entityId.optional(),
  includeArchived: z.boolean().optional(),
});

export const issuesGetInputSchema = z.strictObject({
  action: z.literal(LINEAR_OPERATION_ACTIONS[2]),
  id: issueReference,
});

export const issuesCreateInputSchema = z.strictObject({
  action: z.literal(LINEAR_OPERATION_ACTIONS[3]),
  teamId: entityId,
  title: z.string().trim().min(1).max(512),
  description: z.string().max(32_000).optional(),
  stateId: entityId.optional(),
  assigneeId: entityId.optional(),
  priority: z.number().int().min(0).max(4).optional(),
});

const issuePatch = {
  title: z.string().trim().min(1).max(512).optional(),
  description: z.string().max(32_000).nullable().optional(),
  stateId: entityId.optional(),
  assigneeId: entityId.nullable().optional(),
  priority: z.number().int().min(0).max(4).optional(),
};

export const issuesUpdateInputSchema = z.strictObject({
  action: z.literal(LINEAR_OPERATION_ACTIONS[4]),
  id: identifier,
  ...issuePatch,
}).refine(
  ({ action: _action, id: _id, ...patch }) => Object.values(patch).some((value) => value !== undefined),
  { message: "At least one issue field must be provided." },
);

export const commentsCreateInputSchema = z.strictObject({
  action: z.literal(LINEAR_OPERATION_ACTIONS[5]),
  issueId: identifier,
  body: z.string().min(1).max(32_000).refine((body) => body.trim().length > 0, {
    message: "Comment body must contain non-whitespace text.",
  }),
});

export const teamsListInputSchema = z.strictObject({
  action: z.literal(LINEAR_OPERATION_ACTIONS[6]),
  first: pageSize.optional(),
  after: cursor.optional(),
  includeArchived: z.boolean().optional(),
});

export const statesListInputSchema = z.strictObject({
  action: z.literal(LINEAR_OPERATION_ACTIONS[7]),
  teamId: entityId,
  first: pageSize.optional(),
  after: cursor.optional(),
});

export const linearOperationInputSchemas = [
  issuesListInputSchema,
  issuesSearchInputSchema,
  issuesGetInputSchema,
  issuesCreateInputSchema,
  issuesUpdateInputSchema,
  commentsCreateInputSchema,
  teamsListInputSchema,
  statesListInputSchema,
] as const;

export const linearOperationInputSchema = z.discriminatedUnion("action", linearOperationInputSchemas);
export type LinearOperationInput = z.infer<typeof linearOperationInputSchema>;

export type LinearMutationReconciliation = {
  entityType: "issue" | "comment";
  entityId: string;
};

export class LinearOperationNotFoundError extends Error {
  constructor() {
    super("The requested Linear entity was not found.");
    this.name = "LinearOperationNotFoundError";
  }
}

export type CompiledLinearOperation = {
  action: LinearOperationInput["action"];
  graphql: {
    action: "graphql";
    document: string;
    variables: Record<string, LinearJsonValue>;
    operationName: string;
  };
  parseResult(value: unknown): unknown;
  reconciliation?: LinearMutationReconciliation;
};

const ISSUE_SUMMARY_PROJECTION = `
  id
  identifier
  title
  priority
  url
  createdAt
  updatedAt
  archivedAt
  team { id key name }
  state { id name type }
  assignee { id name }
`;

const ISSUE_DETAIL_PROJECTION = `${ISSUE_SUMMARY_PROJECTION}
  description
`;

const ISSUES_LIST = `query UnblockLinearIssuesList($first: Int!, $after: String, $filter: IssueFilter, $includeArchived: Boolean!) {
  issues(first: $first, after: $after, filter: $filter, includeArchived: $includeArchived, orderBy: updatedAt) {
    nodes { ${ISSUE_SUMMARY_PROJECTION} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUES_SEARCH = `query UnblockLinearIssuesSearch($term: String!, $first: Int!, $after: String, $filter: IssueFilter, $includeArchived: Boolean!) {
  searchIssues(term: $term, first: $first, after: $after, filter: $filter, includeArchived: $includeArchived) {
    totalCount
    nodes { ${ISSUE_SUMMARY_PROJECTION} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_GET = `query UnblockLinearIssueGet($first: Int!, $filter: IssueFilter!, $includeArchived: Boolean!) {
  issues(first: $first, filter: $filter, includeArchived: $includeArchived) {
    nodes { ${ISSUE_DETAIL_PROJECTION} }
  }
}`;

const ISSUE_CREATE = `mutation UnblockLinearIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { ${ISSUE_SUMMARY_PROJECTION} }
  }
}`;

const ISSUE_UPDATE = `mutation UnblockLinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { ${ISSUE_SUMMARY_PROJECTION} }
  }
}`;

const COMMENT_CREATE = `mutation UnblockLinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body createdAt updatedAt issue { id identifier } user { id name } }
  }
}`;

const TEAMS_LIST = `query UnblockLinearTeamsList($first: Int!, $after: String, $includeArchived: Boolean!) {
  teams(first: $first, after: $after, includeArchived: $includeArchived) {
    nodes { id key name description }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STATES_LIST = `query UnblockLinearStatesList($first: Int!, $after: String, $filter: WorkflowStateFilter!) {
  workflowStates(first: $first, after: $after, filter: $filter) {
    nodes { id name type color position team { id key name } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const graphqlErrorSchema = z.object({ message: z.string() }).passthrough();

function parseEnvelope<T extends z.ZodType>(value: unknown, dataSchema: T): z.output<T> {
  const envelope = z.object({
    data: z.unknown(),
    errors: z.array(graphqlErrorSchema).optional(),
  }).passthrough().safeParse(value);
  if (!envelope.success || (envelope.data.errors?.length ?? 0) > 0) {
    throw new Error("Linear returned an invalid typed operation result.");
  }
  const data = dataSchema.safeParse(envelope.data.data);
  if (!data.success) throw new Error("Linear returned an invalid typed operation result.");
  return data.data;
}

const issueMutationSchema = z.strictObject({ success: z.boolean(), issue: issueSummarySchema.nullable() });
const commentMutationSchema = z.strictObject({
  success: z.boolean(),
  comment: z.strictObject({
    id: entityId,
    body: z.string(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    issue: z.strictObject({ id: entityId, identifier }),
    user: z.strictObject({ id: entityId, name: z.string() }).nullable(),
  }).nullable(),
});

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function issueFilter(input: z.infer<typeof issuesListInputSchema>): LinearJsonValue | undefined {
  const filter = compact({
    team: input.teamId === undefined ? undefined : { id: { eq: input.teamId } },
    state: input.stateId === undefined ? undefined : { id: { eq: input.stateId } },
    assignee: input.assigneeId === undefined ? undefined : { id: { eq: input.assigneeId } },
  });
  return Object.keys(filter).length === 0 ? undefined : filter as LinearJsonValue;
}

function issueReferenceFilter(reference: string): LinearJsonValue {
  const parsedId = entityId.safeParse(reference);
  if (parsedId.success) return { id: { eq: parsedId.data } };

  const parsedIdentifier = parseHumanIssueIdentifier(reference);
  if (parsedIdentifier === undefined) {
    throw new Error("Linear issue reference failed validation.");
  }
  return {
    team: { key: { eq: parsedIdentifier.teamKey } },
    number: { eq: parsedIdentifier.issueNumber },
  };
}

function parseIssueDetailLookup(value: unknown) {
  const nodes = parseEnvelope(
    value,
    z.strictObject({ issues: issueDetailConnectionSchema }),
  ).issues.nodes;
  if (nodes.length === 0) throw new LinearOperationNotFoundError();
  if (nodes.length !== 1) throw new Error("Linear returned an invalid typed operation result.");
  return nodes[0];
}

export function compileLinearOperation(
  input: LinearOperationInput,
  uuid: () => string,
): CompiledLinearOperation {
  switch (input.action) {
    case "issues.list":
      return {
        action: input.action,
        graphql: {
          action: "graphql",
          document: ISSUES_LIST,
          operationName: "UnblockLinearIssuesList",
          variables: compact({
            first: input.first ?? 20,
            after: input.after,
            filter: issueFilter(input),
            includeArchived: input.includeArchived ?? false,
          }) as Record<string, LinearJsonValue>,
        },
        parseResult: (value) => parseEnvelope(value, z.strictObject({ issues: issueConnectionSchema })).issues,
      };
    case "issues.search":
      return {
        action: input.action,
        graphql: {
          action: "graphql",
          document: ISSUES_SEARCH,
          operationName: "UnblockLinearIssuesSearch",
          variables: compact({
            term: input.query,
            first: input.first ?? 10,
            after: input.after,
            filter: input.teamId === undefined ? undefined : { team: { id: { eq: input.teamId } } },
            includeArchived: input.includeArchived ?? false,
          }) as Record<string, LinearJsonValue>,
        },
        parseResult: (value) => parseEnvelope(
          value,
          z.strictObject({ searchIssues: issueSearchPayloadSchema }),
        ).searchIssues,
      };
    case "issues.get":
      return {
        action: input.action,
        graphql: {
          action: "graphql",
          document: ISSUE_GET,
          operationName: "UnblockLinearIssueGet",
          variables: {
            first: 2,
            filter: issueReferenceFilter(input.id),
            includeArchived: true,
          },
        },
        parseResult: parseIssueDetailLookup,
      };
    case "issues.create": {
      const id = uuid();
      const fields = compact({
        id,
        teamId: input.teamId,
        title: input.title,
        description: input.description,
        stateId: input.stateId,
        assigneeId: input.assigneeId,
        priority: input.priority,
      }) as Record<string, LinearJsonValue>;
      return {
        action: input.action,
        graphql: { action: "graphql", document: ISSUE_CREATE, operationName: "UnblockLinearIssueCreate", variables: { input: fields } },
        parseResult: (value) => parseEnvelope(value, z.strictObject({ issueCreate: issueMutationSchema })).issueCreate,
        reconciliation: { entityType: "issue", entityId: id },
      };
    }
    case "issues.update": {
      const { action: _action, id, ...fields } = input;
      return {
        action: input.action,
        graphql: { action: "graphql", document: ISSUE_UPDATE, operationName: "UnblockLinearIssueUpdate", variables: { id, input: compact(fields) as Record<string, LinearJsonValue> } },
        parseResult: (value) => parseEnvelope(value, z.strictObject({ issueUpdate: issueMutationSchema })).issueUpdate,
      };
    }
    case "comments.create": {
      const id = uuid();
      return {
        action: input.action,
        graphql: {
          action: "graphql",
          document: COMMENT_CREATE,
          operationName: "UnblockLinearCommentCreate",
          variables: { input: { id, issueId: input.issueId, body: input.body } },
        },
        parseResult: (value) => parseEnvelope(value, z.strictObject({ commentCreate: commentMutationSchema })).commentCreate,
        reconciliation: { entityType: "comment", entityId: id },
      };
    }
    case "teams.list":
      return {
        action: input.action,
        graphql: {
          action: "graphql",
          document: TEAMS_LIST,
          operationName: "UnblockLinearTeamsList",
          variables: compact({ first: input.first ?? 20, after: input.after, includeArchived: input.includeArchived ?? false }) as Record<string, LinearJsonValue>,
        },
        parseResult: (value) => parseEnvelope(value, z.strictObject({
          teams: z.strictObject({ nodes: z.array(teamSchema), pageInfo: pageInfoSchema }),
        })).teams,
      };
    case "states.list":
      return {
        action: input.action,
        graphql: {
          action: "graphql",
          document: STATES_LIST,
          operationName: "UnblockLinearStatesList",
          variables: compact({
            first: input.first ?? 20,
            after: input.after,
            filter: { team: { id: { eq: input.teamId } } },
          }) as Record<string, LinearJsonValue>,
        },
        parseResult: (value) => parseEnvelope(value, z.strictObject({
          workflowStates: z.strictObject({ nodes: z.array(stateSchema), pageInfo: pageInfoSchema }),
        })).workflowStates,
      };
  }
}
