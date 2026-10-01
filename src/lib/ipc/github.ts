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

/** GitHub Personal Access Token fallback (§4.4.6): used when the OAuth
 *  connector isn't connected. Value never returns to the frontend — the OS
 *  keychain holds it; `githubHasPat` only reports presence. */
export const githubSetPat = (pat: string) => safeInvoke<void>("github_set_pat", { pat });
export const githubClearPat = () => safeInvoke<void>("github_clear_pat");
export const githubHasPat = () => safeInvoke<boolean>("github_has_pat");

/** Issues surface (§4.4.6): list/get/create/comment/close — mirrors the
 *  backend types in types.rs (camelCase). */
export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  comments: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}
export interface GitHubIssueDetail extends GitHubIssueSummary {
  body: string;
}
export interface GitHubIssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}
export const githubListIssues = (projectId: string, state: "open" | "closed" | "all" = "open") =>
  safeInvoke<GitHubIssueSummary[]>("github_list_issues", { projectId, state });
export const githubGetIssue = (projectId: string, number: number) =>
  safeInvoke<GitHubIssueDetail>("github_get_issue", { projectId, number });
export const githubCreateIssue = (projectId: string, title: string, body: string, labels?: string[]) =>
  safeInvoke<GitHubIssueSummary>("github_create_issue", { projectId, title, body, labels: labels ?? null });
export const githubAddIssueComment = (projectId: string, number: number, body: string) =>
  safeInvoke<GitHubIssueComment>("github_add_issue_comment", { projectId, number, body });
export const githubSetIssueState = (projectId: string, number: number, state: "open" | "closed") =>
  safeInvoke<GitHubIssueSummary>("github_set_issue_state", { projectId, number, state });
export const githubListIssueComments = (projectId: string, number: number) =>
  safeInvoke<GitHubIssueComment[]>("github_list_issue_comments", { projectId, number });
