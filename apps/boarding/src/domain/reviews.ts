export interface Review {
  reviewerId: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED" | "PENDING";
  commitSha: string | null;
  submittedAt: string;
}

export const approvedReviewers = (reviews: Review[], headSha: string, authorId: number): number[] => {
  const latest = new Map<number, Review>();
  const invalidDates = new Set<number>();

  for (const review of reviews) {
    if (review.reviewerId === authorId || review.state === "PENDING" || review.state === "COMMENTED") continue;

    const time = Date.parse(review.submittedAt);
    if (!Number.isFinite(time)) {
      invalidDates.add(review.reviewerId);
      continue;
    }

    const previous = latest.get(review.reviewerId);
    if (!previous || time > Date.parse(previous.submittedAt)) latest.set(review.reviewerId, review);
    else if (time === Date.parse(previous.submittedAt)) {
      latest.set(review.reviewerId, { ...review, state: "DISMISSED" });
    }
  }

  return [...latest.values()]
    .filter(
      (review) => !invalidDates.has(review.reviewerId) && review.state === "APPROVED" && review.commitSha === headSha
    )
    .map((review) => review.reviewerId);
};
