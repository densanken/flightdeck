import type { DeliveryRepository } from "../../repository/delivery/interface.js";
import type { GitHubAssignmentGateway } from "../assignment/dependencies.js";
import type { AssignPullRequestAuthorUseCase } from "../assignment/interface.js";
import type { TitleValidationGateway } from "../title-validation/dependencies.js";
import type { ValidatePullRequestTitleUseCase } from "../title-validation/interface.js";

export type PullRequestPolicyGateway = GitHubAssignmentGateway & TitleValidationGateway;

export interface PullRequestPolicyDependencies {
  deliveryRepository: DeliveryRepository;
  createGateway(installationId: number): PullRequestPolicyGateway;
  createAssignmentUseCase(gateway: GitHubAssignmentGateway): AssignPullRequestAuthorUseCase;
  createTitleValidationUseCase(gateway: TitleValidationGateway): ValidatePullRequestTitleUseCase;
  now?: () => Date;
}
