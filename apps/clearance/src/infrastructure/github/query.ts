import { TIMELINE_EVENT_TYPES } from "./timeline-events.js";

// timelineItems は itemTypes で絞らない
// GitHub の schema は filteredCount を before / after 適用後の件数と定義しており、型で絞った件数とは明記していない
// https://docs.github.com/en/graphql/reference/pulls#pullrequesttimelineitemsconnection
const actor = `__typename login ... on User { databaseId } ... on Bot { databaseId }`;
const events = TIMELINE_EVENT_TYPES.map((type) => `... on ${type} { createdAt actor { ${actor} } }`).join("\n");
const contexts = `statusCheckRollup { contexts(first:100) { totalCount nodes { __typename
  ... on CheckRun { name status conclusion checkSuite { app { databaseId slug } } }
  ... on StatusContext { context state }
} } }`;
export const PR_QUERY = `query($owner:String!, $name:String!, $number:Int!, $cutoff:DateTime!) {
 repository(owner:$owner,name:$name) { databaseId pullRequest(number:$number) {
  state isDraft body createdAt headRefName headRefOid baseRefName
  author { ${actor} } editor { ${actor} } lastEditedAt
  headRepository { databaseId }
  labels(first:100) { totalCount nodes { name } }
  files(first:100) { totalCount nodes { path changeType } }
  latestOpinionatedReviews(first:100) { totalCount nodes { state author { ${actor} } } }
  latestReviews(first:100) { totalCount nodes { databaseId state author { ${actor} } commit { oid } } }
  commits(last:1) { nodes { commit { oid ${contexts} } } }
  potentialMergeCommit { oid ${contexts} }
  baseRef { target { ... on Commit { oid submodules(first:100) { nodes { path gitUrl } pageInfo { hasNextPage } } } } }
  # pageCount は since 適用後、last の上限を反映した件数
  # 実動作は手動試験で確認する
  recent: timelineItems(last:100, since:$cutoff) { pageCount }
  timelineItems(last:100) { pageCount pageInfo { hasPreviousPage } nodes { __typename
    ... on IssueComment { createdAt author { ${actor} } editor { ${actor} } lastEditedAt }
    ... on PullRequestReview { createdAt submittedAt author { ${actor} } }
    ... on PullRequestCommit { commit { committedDate author { email user { databaseId } } } }
    ${events}
  } }
 } } rateLimit { cost }
}`;

// Commit.file は不在時に NOT_FOUND を返すため、§8.2 の Q1 と分けて固定 base SHA から取得する
export const CONFIG_QUERY = `query($owner:String!, $name:String!, $yml:String!, $yaml:String!) {
 repository(owner:$owner,name:$name) {
  yml: object(expression:$yml) { ... on Blob { isBinary isTruncated text } }
  yaml: object(expression:$yaml) { ... on Blob { isBinary isTruncated text } }
 }
}`;

export const TREE_QUERY = `query($owner:String!, $name:String!, $base:String!, $head:String!) {
 repository(owner:$owner,name:$name) {
  base: object(expression:$base) { ... on Tree { entries { name type oid } } }
  head: object(expression:$head) { ... on Tree { entries { name type oid } } }
 }
}`;

export const SEARCH_QUERY = `query($query:String!) { search(query:$query,type:ISSUE,first:100) { nodes { ... on PullRequest {
 number headRefOid author { ${actor} } latestReviews(first:100) { totalCount nodes { state author { ${actor} } commit { oid } } }
} } } }`;

export const ASSOCIATED_QUERY = `query($owner:String!,$name:String!,$oid:GitObjectID!) { repository(owner:$owner,name:$name) {
 object(oid:$oid) { ... on Commit { associatedPullRequests(first:100) { totalCount nodes { number state headRefOid potentialMergeCommit { oid } repository { databaseId } } } } }
} }`;

export const COMPARE_QUERY = `query($owner:String!, $name:String!, $new:String!) {
 repository(owner:$owner,name:$name) { defaultBranchRef { compare(headRef:$new) { status } } }
}`;
