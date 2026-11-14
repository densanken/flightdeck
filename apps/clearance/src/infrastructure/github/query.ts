const actor = `__typename login ... on User { databaseId } ... on Bot { databaseId }`;

export const SEARCH_QUERY = `query($query:String!) { search(query:$query,type:ISSUE,first:100) { nodes { ... on PullRequest {
 number headRefOid author { ${actor} } latestReviews(first:100) { totalCount nodes { state author { ${actor} } commit { oid } } }
} } } }`;
