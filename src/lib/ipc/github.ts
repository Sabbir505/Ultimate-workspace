// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";

// ---- GitHub Pulls tab ----

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string;
  authorAvatar: string | null;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  state: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean | null;
}

export interface PullRequestFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PullRequestChecks {
  state: string; // "success" | "failure" | "pending" | "none"
  total: number;
  failing: number;
  pending: number;
}

export interface PullRequestDraft {
  title: string;
  body: string;
}

export const githubListPrs = (projectId: string, state: "open" | "closed" | "all" = "open") =>
  safeInvoke<PullRequestSummary[]>("github_list_prs", { projectId, state });
export const githubCreatePr = (
  projectId: string,
  title: string,
  body: string,
  head: string,
  base: string,
  draft: boolean,
) => safeInvoke<PullRequestSummary>("github_create_pr", { projectId, title, body, head, base, draft });
export const githubGetPr = (projectId: string, number: number) =>
  safeInvoke<PullRequestDetail>("github_get_pr", { projectId, number });
export const githubPrFiles = (projectId: string, number: number) =>
  safeInvoke<PullRequestFile[]>("github_pr_files", { projectId, number });
export const githubSubmitReview = (
  projectId: string,
  number: number,
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
  body: string,
) => safeInvoke<void>("github_submit_review", { projectId, number, event, body });
export const githubPrChecks = (projectId: string, number: number) =>
  safeInvoke<PullRequestChecks>("github_pr_checks", { projectId, number });
/** Agent-drafted PR title+body from the branch diff. null = no model
 *  configured or the branch has no diff vs base. */
export const githubDraftPrText = (projectId: string, base: string, chatSessionId: string) =>
  safeInvoke<PullRequestDraft | null>("github_draft_pr_text", { projectId, base, chatSessionId });

export interface BranchOption {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

/** Local + remote branches of the project's repo (create-form pickers). */
export const githubLocalBranches = (projectId: string) =>
  safeInvoke<BranchOption[]>("github_local_branches", { projectId });
