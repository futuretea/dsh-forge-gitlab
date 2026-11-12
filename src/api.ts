/** Pure mapping between GitLab REST payloads and the forge vocabulary; no process or network access. */

import type {
  ChangeRequestCheck,
  ChangeRequestRef,
  ChangeRequestReviewer,
  ChangeRequestSnapshot,
  CheckState,
  ChecksRollup,
  ForgeCheckId,
  ForgeCommit,
  ForgeFailure,
  ForgeRepository,
  Mergeability,
  MergeMethod,
  ReviewDecision,
} from '@deepseek-ai/dsh-experimental-forge'
import type { GlabOutput } from './glab.js'
import { changeRequestUrl } from './urls.js'

/** Project fields the provider reads. */
export interface GitLabProject {
  readonly default_branch: string | null
  readonly merge_method?: string
  readonly squash_option?: string
}

/** Merge request fields the provider reads, as `merge_requests/:iid` and `merge_requests/:iid/changes` report them. */
export interface GitLabMergeRequest {
  readonly iid: number
  readonly title: string
  readonly state: 'opened' | 'closed' | 'merged' | 'locked'
  readonly draft?: boolean
  readonly work_in_progress?: boolean
  readonly author?: { readonly username?: string } | null
  readonly source_branch: string
  readonly sha: string
  readonly target_branch: string
  readonly diff_refs?: { readonly base_sha?: string; readonly head_sha?: string } | null
  readonly detailed_merge_status?: string
  readonly has_conflicts?: boolean | null
  readonly updated_at: string
  readonly closed_at?: string | null
  readonly merged_at?: string | null
  readonly reviewers?: readonly GitLabAccount[] | null
}

/** One account on GitLab, as merge request reviewers and approvals report it. */
export interface GitLabAccount {
  readonly id: number
  readonly username: string
  readonly avatar_url?: string | null
  readonly state?: string
}

/** Approval state of a merge request, as the premium approvals endpoint reports it; absent on core editions. */
export interface GitLabApprovals {
  readonly approved?: boolean
  readonly approved_by?: readonly { readonly user: GitLabAccount }[] | null
  readonly approvals_required?: number
}

/** One project member, as the members endpoint reports it. */
export interface GitLabMember {
  readonly id: number
  readonly username: string
  readonly name?: string | null
  readonly avatar_url?: string | null
}

/** Pipeline of a merge request. */
export interface GitLabPipeline {
  readonly id: number
  readonly status: string | null
  readonly web_url?: string
  readonly created_at?: string | null
  readonly updated_at?: string | null
}

/** One file change of a merge request or comparison. */
export interface GitLabDiffEntry {
  readonly old_path: string
  readonly new_path: string
  readonly diff?: string | null
}

/** One commit of a merge request or comparison. */
export interface GitLabCommit {
  readonly id: string
  readonly parent_ids?: readonly string[] | null
  readonly title: string
  readonly author_name?: string | null
  readonly authored_date: string
}

/** URL-encoded project path the REST API addresses a repository by. */
export function projectPath(repository: ForgeRepository): string {
  return `projects/${encodeURIComponent(`${repository.owner}/${repository.name}`)}`
}

/** URL-encoded merge request path of one change request. */
export function mergeRequestPath(ref: ChangeRequestRef): string {
  return `${projectPath(ref.repository)}/merge_requests/${ref.number}`
}

/** Map one pipeline status to a normalized check state. */
export function pipelineCheckState(status: string | null): CheckState {
  switch (status) {
    case 'success': return 'success'
    case 'failed': return 'failure'
    case 'canceled': return 'cancelled'
    case 'skipped': return 'skipped'
    case 'manual': return 'neutral'
    default: return 'pending'
  }
}

/** Map one pipeline to a check; a failed pipeline names itself as its rerun identity. */
export function pipelineToCheck(pipeline: GitLabPipeline): ChangeRequestCheck {
  const terminal = pipeline.status === 'success' || pipeline.status === 'failed' || pipeline.status === 'canceled' || pipeline.status === 'skipped'
  return {
    name: `pipeline #${pipeline.id}`,
    state: pipelineCheckState(pipeline.status),
    url: pipeline.web_url ?? null,
    workflow: null,
    startedAt: pipeline.created_at ?? null,
    completedAt: terminal ? pipeline.updated_at ?? null : null,
    rerun: pipeline.status === 'failed' ? String(pipeline.id) as ForgeCheckId : null,
  }
}

/** Combine check states into the rollup the snapshot carries. */
export function checksRollup(checks: readonly ChangeRequestCheck[]): ChecksRollup {
  if (checks.length === 0) return 'none'
  if (checks.some((check) => check.state === 'pending')) return 'pending'
  if (checks.some((check) => check.state === 'failure')) return 'failure'
  return 'success'
}

/** List the reviewers of a merge request: requested reviewers first, then accounts whose approval was read. */
export function reviewersOf(mr: GitLabMergeRequest, approvals: GitLabApprovals | undefined): readonly ChangeRequestReviewer[] {
  const reviewers: ChangeRequestReviewer[] = (mr.reviewers ?? [])
    .filter((account) => account.state !== 'blocked')
    .map((account) => ({
      kind: 'user' as const,
      login: account.username,
      avatarUrl: account.avatar_url ?? null,
      requested: true,
      codeOwner: false,
      verdict: null,
      reviewedSha: null,
    }))
  for (const approval of approvals?.approved_by ?? []) {
    if (reviewers.some((reviewer) => reviewer.login === approval.user.username)) continue
    reviewers.push({
      kind: 'user',
      login: approval.user.username,
      avatarUrl: approval.user.avatar_url ?? null,
      requested: false,
      codeOwner: false,
      verdict: 'approved',
      reviewedSha: null,
    })
  }
  return reviewers
}

/** Map approval state to the aggregate review decision; a missing read reports none. */
export function reviewDecisionOf(approvals: GitLabApprovals | undefined): ReviewDecision {
  if (approvals === undefined) return 'none'
  if (approvals.approved === true) return 'approved'
  return 'review-required'
}

/** Whether the author marked the merge request as a draft, by flag or title prefix. */
export function isDraft(mr: GitLabMergeRequest): boolean {
  return mr.draft === true || mr.work_in_progress === true || /^(?:draft|wip)[:-]/i.test(mr.title)
}

/** The title that marks a draft ready for review. */
export function readyTitle(title: string): string {
  return title.replace(/^(?:draft|wip)[:-]\s*/i, '')
}

/** Map GitLab's detailed merge status to the snapshot's mergeability. */
export function mergeabilityOf(mr: GitLabMergeRequest): Mergeability {
  if (mr.has_conflicts === true) return 'conflicting'
  switch (mr.detailed_merge_status) {
    case 'conflicts': return 'conflicting'
    case 'mergeable':
    case 'ci_still_passing':
    case 'not_open':
    case 'draft_status':
    case 'broken_status':
    case 'discussion_status':
    case 'approvals_sync': return 'mergeable'
    case 'checking':
    case 'unchecked': return 'unknown'
    default: return 'unknown'
  }
}

/** Whether GitLab would merge the merge request now for the signed-in user. */
export function mergeReadyOf(mr: GitLabMergeRequest): boolean {
  return mr.state === 'opened' && !isDraft(mr)
    && (mr.detailed_merge_status === 'mergeable' || mr.detailed_merge_status === 'ci_still_passing')
}

/** Merge methods the snapshot offers: a merge commit, plus squash when the project allows it. */
export function mergeMethodsOf(project: GitLabProject | undefined): readonly MergeMethod[] {
  return project?.squash_option === 'never' ? ['merge'] : ['merge', 'squash']
}

/** Count added and deleted lines of one unified diff, ignoring the file headers. */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** Count the added and deleted lines of every file change. */
export function countChanges(changes: readonly GitLabDiffEntry[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const change of changes) {
    if (typeof change.diff !== 'string') continue
    const counted = countDiffLines(change.diff)
    additions += counted.additions
    deletions += counted.deletions
  }
  return { additions, deletions }
}

/** Build one unified patch with `a/` and `b/` path prefixes from GitLab diff entries. */
export function diffEntriesToPatch(entries: readonly GitLabDiffEntry[]): string {
  return entries
    .filter((entry) => typeof entry.diff === 'string' && entry.diff.length > 0)
    .map((entry) => `--- a/${entry.old_path}\n+++ b/${entry.new_path}\n${entry.diff as string}`)
    .join('\n')
}

/** Map one GitLab commit to the forge vocabulary. */
export function gitlabCommitToForge(commit: GitLabCommit): ForgeCommit {
  return {
    sha: commit.id,
    parent: commit.parent_ids?.[0] ?? null,
    title: commit.title,
    author: commit.author_name ?? null,
    authoredAt: commit.authored_date,
  }
}

/** Turn a failed `glab` invocation into a forge failure by its reported HTTP status. */
export function failureForOutput(output: GlabOutput, context: string): ForgeFailure {
  const text = `${output.stderr}\n${output.stdout}`
  const status = /HTTP (\d{3})/.exec(text)
  const firstLine = output.stderr.split('\n').find((line) => line.trim().length > 0)
    ?? output.stdout.split('\n').find((line) => line.trim().length > 0)
    ?? context
  if (status) {
    const code = Number(status[1])
    if (code === 401 || code === 403) return { code: 'unauthenticated', message: firstLine }
    if (code === 404 || code === 410) return { code: 'not-found', message: firstLine }
  }
  return { code: 'unavailable', message: firstLine }
}

/** Build the snapshot of one merge request from the reads `fetch` completed. */
export function snapshotOf(reads: {
  /** Change request the snapshot describes. */
  readonly ref: ChangeRequestRef
  /** Merge request read, with or without its changes listing. */
  readonly mr: GitLabMergeRequest
  /** Pipelines read for the head commit. */
  readonly pipelines: readonly GitLabPipeline[]
  /** Project read, when it answered. */
  readonly project: GitLabProject | undefined
  /** Line counts from the changes listing. */
  readonly counts: { additions: number; deletions: number }
  /** Approval state read, when the edition serves it. */
  readonly approvals: GitLabApprovals | undefined
  /** Whether more pipelines exist than `pipelines` holds. */
  readonly checksTruncated: boolean
}): ChangeRequestSnapshot {
  const { ref, mr, pipelines, project, counts, approvals, checksTruncated } = reads
  const checks = pipelines.map(pipelineToCheck)
  const state = mr.state === 'merged' ? 'merged' : mr.state === 'opened' ? 'open' : 'closed'
  return {
    ref,
    url: changeRequestUrl(ref),
    title: mr.title,
    state,
    draft: isDraft(mr),
    author: mr.author?.username ?? null,
    headBranch: mr.source_branch,
    headSha: mr.sha,
    baseBranch: mr.target_branch,
    ...mr.diff_refs?.base_sha !== undefined ? { baseSha: mr.diff_refs.base_sha } : {},
    additions: counts.additions,
    deletions: counts.deletions,
    mergeability: mergeabilityOf(mr),
    mergeReady: mergeReadyOf(mr),
    mergeMethods: mergeMethodsOf(project),
    branchUpdates: [],
    reviewDecision: reviewDecisionOf(approvals),
    reviewers: reviewersOf(mr, approvals),
    reviewersTruncated: false,
    canRequestReviews: true,
    checks,
    checksRollup: checksRollup(checks),
    checksTruncated,
    canRerunChecks: true,
    unresolvedThreads: 0,
    threadsTruncated: true,
    closingIssues: [],
    closingIssuesTruncated: false,
    updatedAt: mr.updated_at,
    closedAt: mr.merged_at ?? mr.closed_at ?? null,
  }
}
