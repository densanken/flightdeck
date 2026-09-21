export interface AssignmentCandidate {
  action: string;
  author: string;
  authorType: string;
  assignees: string[];
}

type AssignmentNoOpResult = "skipped_bot" | "already_assigned";

export const classifyAssignmentNoOp = (
  candidate: AssignmentCandidate,
  skipBots: boolean
): AssignmentNoOpResult | null => {
  const normalizedAuthor = candidate.author.toLowerCase();
  const isBot = candidate.authorType === "Bot" || normalizedAuthor.endsWith("[bot]");
  if (skipBots && isBot) return "skipped_bot";

  const alreadyAssigned = candidate.assignees.some((login) => login.toLowerCase() === normalizedAuthor);
  return alreadyAssigned ? "already_assigned" : null;
};
