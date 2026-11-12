/** The GitLab forge provider: serves the configured GitLab hosts through `glab api` on the host. */

import {
  changeRequestKey,
  type ChangeRequestKey,
  type ChangeRequestRef,
  type ChangeRequestSnapshot,
  type ForgeActionFailure,
  type ForgeCommit,
  type ForgeCommitList,
  type ForgeFailure,
  type ForgeReadiness,
  type ForgeRepository,
  type ForgeProvider,
  type ForgeReviewerCandidate,
  type ForgeReviewersRequest,
  type ForgeRerunRequest,
  type MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import {
  failureForOutput,
  gitlabCommitToForge,
  isDraft,
  mergeRequestPath,
  projectPath,
  readyTitle,
  snapshotOf,
  countChanges,
  diffEntriesToPatch,
  type GitLabApprovals,
  type GitLabCommit,
  type GitLabDiffEntry,
  type GitLabMember,
  type GitLabMergeRequest,
  type GitLabPipeline,
  type GitLabProject,
} from './api.js'
import type { GlabOutput, GlabRunner } from './glab.js'
import { changeRequestFromUrl, changeRequestUrl, repositoryFromRemote } from './urls.js'

/** One REST call: an optional method, its typed and raw string parameters, and an optional JSON body. */
interface ApiCall {
  readonly method?: 'PUT' | 'POST'
  readonly fields?: Readonly<Record<string, string>>
  readonly rawFields?: Readonly<Record<string, string>>
  readonly body?: string
}

type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ForgeFailure }

/** Merge request read with its file changes, as the `changes` endpoint reports it. */
interface GitLabMergeRequestWithChanges extends GitLabMergeRequest {
  readonly changes?: readonly GitLabDiffEntry[]
}

/** Limits the provider honors beyond the runner's own. */
export interface ProviderLimits {
  /** Most commits one commit listing returns. */
  readonly maxCommits: number
}

/** Serve GitLab merge requests of the configured hosts through one `glab` runner. */
export class GitLabProvider implements ForgeProvider {
  readonly forge = 'gitlab'

  constructor(
    private readonly run: GlabRunner,
    private readonly hosts: readonly string[],
    private readonly limits: ProviderLimits,
  ) {}

  repositoryFromRemote(url: string): ForgeRepository | undefined {
    return repositoryFromRemote(url, this.hosts)
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    return changeRequestFromUrl(url, this.hosts)
  }

  changeRequestUrl(ref: ChangeRequestRef): string {
    return changeRequestUrl(ref)
  }

  async readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness> {
    let output: GlabOutput
    try {
      output = await this.run(['auth', 'status', '--hostname', host], signal)
    } catch (error) {
      if (error === signal.reason) throw error
      return { state: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
    if (output.exitCode === 0) return { state: 'ready', message: null }
    const firstLine = [output.stderr, output.stdout]
      .flatMap((stream) => stream.split('\n'))
      .find((line) => line.trim().length > 0)
    return { state: 'unauthenticated', message: firstLine ?? `glab auth status exited with ${output.exitCode} for ${host}` }
  }

  async fetch(
    refs: readonly ChangeRequestRef[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    const results = new Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>()
    const projects = new Map<string, GitLabProject | undefined>()
    for (const ref of refs) {
      results.set(changeRequestKey(ref), await this.readSnapshot(ref, projects, signal, false))
    }
    return results
  }

  async fetchChecks(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure> {
    return this.readSnapshot(ref, new Map<string, GitLabProject | undefined>(), signal, true)
  }

  async requestReviews(ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const read = await this.readMergeRequest(ref, signal)
    if ('failure' in read) return actionFailureOf(read.failure)
    const ids = new Set<number>((read.mr.reviewers ?? []).map((account) => account.id))
    for (const reviewer of request.reviewers) {
      if (reviewer.kind !== 'user') {
        return { code: 'failed', message: `GitLab review requests serve user accounts; ${reviewer.login} is a ${reviewer.kind}` }
      }
      const member = await this.findMember(ref, reviewer.login, signal)
      if ('failure' in member) return member.failure
      ids.add(member.member.id)
    }
    const put = await this.api<unknown>(ref.repository.host, mergeRequestPath(ref), signal, {
      method: 'PUT',
      body: JSON.stringify({ reviewer_ids: [...ids] }),
    })
    return put.ok ? undefined : actionFailureOf(put.failure)
  }

  async reviewerCandidates(ref: ChangeRequestRef, query: string, signal: AbortSignal): Promise<readonly ForgeReviewerCandidate[] | ForgeFailure> {
    const read = await this.searchMembers(ref, query, 50, signal)
    if (!read.ok) return read.failure
    return read.value.map((member) => ({
      login: member.username,
      name: member.name ?? null,
      avatarUrl: member.avatar_url ?? null,
      suggested: false,
    }))
  }

  async rerunChecks(ref: ChangeRequestRef, request: ForgeRerunRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const read = await this.readMergeRequest(ref, signal)
    if ('failure' in read) return actionFailureOf(read.failure)
    if (read.mr.sha !== request.headSha) return staleHeadFailure(read.mr.sha, request.headSha)
    const pipelines = await this.api<readonly GitLabPipeline[]>(
      ref.repository.host,
      `${mergeRequestPath(ref)}/pipelines?per_page=100`,
      signal,
    )
    const failed = (pipelines.ok ? pipelines.value : []).filter((pipeline) => pipeline.status === 'failed')
    for (const pipeline of failed) {
      const retry = await this.api<unknown>(
        ref.repository.host,
        `${projectPath(ref.repository)}/pipelines/${pipeline.id}/retry`,
        signal,
        { method: 'POST' },
      )
      if (!retry.ok) return actionFailureOf(retry.failure)
    }
    return undefined
  }

  async findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]> {
    const query = new URLSearchParams({
      source_branch: branch,
      state: 'opened',
      order_by: 'updated_at',
      sort: 'desc',
      per_page: '20',
    })
    const project = await this.api<GitLabProject>(repository.host, projectPath(repository), signal)
    const list = await this.api<readonly GitLabMergeRequest[]>(
      repository.host,
      `${projectPath(repository)}/merge_requests?${query.toString()}`,
      signal,
    )
    if (!list.ok) throw new Error(list.failure.message)
    const defaultBranch = project.ok ? project.value.default_branch : null
    return list.value
      .filter((mr) => defaultBranch === null || mr.target_branch !== defaultBranch)
      .map((mr) => ({ repository, number: mr.iid }))
  }

  async markReady(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const read = await this.readMergeRequest(ref, signal)
    if ('failure' in read) return actionFailureOf(read.failure)
    if (!isDraft(read.mr)) return undefined
    const put = await this.api<unknown>(ref.repository.host, mergeRequestPath(ref), signal, {
      method: 'PUT',
      rawFields: { title: readyTitle(read.mr.title) },
    })
    return put.ok ? undefined : actionFailureOf(put.failure)
  }

  async merge(ref: ChangeRequestRef, request: MergeRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    if (request.method === 'rebase') {
      return { code: 'failed', message: 'forge-gitlab offers no rebase merges; use merge or squash' }
    }
    const read = await this.readMergeRequest(ref, signal)
    if ('failure' in read) return actionFailureOf(read.failure)
    if (read.mr.sha !== request.headSha) return staleHeadFailure(read.mr.sha, request.headSha)
    const put = await this.api<unknown>(ref.repository.host, `${mergeRequestPath(ref)}/merge`, signal, {
      method: 'PUT',
      fields: { squash: String(request.method === 'squash'), should_remove_source_branch: 'false' },
    })
    return put.ok ? undefined : actionFailureOf(put.failure)
  }

  async diff(
    ref: ChangeRequestRef,
    headSha: string,
    signal: AbortSignal,
    base?: string,
  ): Promise<string | ForgeFailure> {
    void base
    const read = await this.readMergeRequest(ref, signal)
    if ('failure' in read) return read.failure
    if (read.mr.sha !== headSha) {
      return { code: 'stale', message: `merge request head is ${read.mr.sha}, not the requested ${headSha}` }
    }
    const changes = await this.api<{ readonly changes?: readonly GitLabDiffEntry[] }>(
      ref.repository.host,
      `${mergeRequestPath(ref)}/changes`,
      signal,
    )
    if (!changes.ok) return changes.failure
    return diffEntriesToPatch(changes.value.changes ?? [])
  }

  async fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const read = await this.api<{ readonly content?: string; readonly encoding?: string }>(
      ref.repository.host,
      `${projectPath(ref.repository)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(commit)}`,
      signal,
    )
    if (!read.ok) return read.failure
    const value = read.value
    if (typeof value.content !== 'string') {
      return { code: 'not-found', message: `GitLab returned no content for ${path} at ${commit}` }
    }
    return value.encoding === 'base64' ? Buffer.from(value.content, 'base64').toString('utf8') : value.content
  }

  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string {
    const { host, owner, name } = ref.repository
    return `https://${host}/${owner}/${name}/-/blob/${commit}/${path}`
  }

  async commits(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeCommitList | ForgeFailure> {
    const read = await this.readMergeRequest(ref, signal)
    if ('failure' in read) return read.failure
    const commits: ForgeCommit[] = []
    let truncated = false
    for (let page = 1; ; page++) {
      const batch = await this.api<readonly GitLabCommit[]>(
        ref.repository.host,
        `${mergeRequestPath(ref)}/commits?per_page=100&page=${page}`,
        signal,
      )
      if (!batch.ok) return batch.failure
      for (const commit of batch.value) {
        if (commits.length >= this.limits.maxCommits) {
          truncated = true
          break
        }
        commits.push(gitlabCommitToForge(commit))
      }
      if (batch.value.length < 100 || truncated) break
    }
    return { headSha: read.mr.sha, commits, truncated }
  }

  async compare(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const query = new URLSearchParams({ from: base, to: head })
    const read = await this.api<{ readonly diffs?: readonly GitLabDiffEntry[] }>(
      ref.repository.host,
      `${projectPath(ref.repository)}/repository/compare?${query.toString()}`,
      signal,
    )
    if (!read.ok) return read.failure
    return diffEntriesToPatch(read.value.diffs ?? [])
  }

  /** Read one merge request without its changes listing. */
  private async readMergeRequest(
    ref: ChangeRequestRef,
    signal: AbortSignal,
  ): Promise<{ readonly mr: GitLabMergeRequest } | { readonly failure: ForgeFailure }> {
    const read = await this.api<GitLabMergeRequest>(ref.repository.host, mergeRequestPath(ref), signal)
    return read.ok ? { mr: read.value } : { failure: read.failure }
  }

  /**
   * Read the complete snapshot of one merge request. `fullPipelines` pages the
   * whole pipeline list; otherwise the first page serves the polling preview.
   */
  private async readSnapshot(
    ref: ChangeRequestRef,
    projects: Map<string, GitLabProject | undefined>,
    signal: AbortSignal,
    fullPipelines: boolean,
  ): Promise<ChangeRequestSnapshot | ForgeFailure> {
    const { host, owner, name } = ref.repository
    const projectKey = `${host}/${owner}/${name}`
    if (!projects.has(projectKey)) {
      const project = await this.api<GitLabProject>(host, projectPath(ref.repository), signal)
      projects.set(projectKey, project.ok ? project.value : undefined)
    }
    const mrRead = await this.api<GitLabMergeRequestWithChanges>(host, `${mergeRequestPath(ref)}/changes`, signal)
    let mr: GitLabMergeRequest
    let counts = { additions: 0, deletions: 0 }
    if (mrRead.ok) {
      mr = mrRead.value
      counts = countChanges(mrRead.value.changes ?? [])
    } else if (mrRead.failure.code === 'too-large') {
      // The changes listing alone was too large; serve the merge request without line counts.
      const plain = await this.readMergeRequest(ref, signal)
      if ('failure' in plain) return plain.failure
      mr = plain.mr
    } else {
      return mrRead.failure
    }
    const pipelines: GitLabPipeline[] = []
    let checksTruncated = false
    for (let page = 1; page <= 10; page++) {
      const read = await this.api<readonly GitLabPipeline[]>(
        host,
        `${mergeRequestPath(ref)}/pipelines?per_page=100&page=${page}`,
        signal,
      )
      if (!read.ok) break
      pipelines.push(...read.value)
      if (read.value.length < 100) break
      if (page === 10) {
        checksTruncated = true
        break
      }
      if (!fullPipelines) break
    }
    if (!fullPipelines) checksTruncated = pipelines.length >= 100
    const approvals = await this.api<GitLabApprovals>(host, `${mergeRequestPath(ref)}/approvals`, signal)
    return snapshotOf({
      ref,
      mr,
      pipelines,
      project: projects.get(projectKey),
      counts,
      approvals: approvals.ok ? approvals.value : undefined,
      checksTruncated,
    })
  }

  /** Find one project member by exact username. */
  private async findMember(
    ref: ChangeRequestRef,
    username: string,
    signal: AbortSignal,
  ): Promise<{ readonly member: GitLabMember } | { readonly failure: ForgeActionFailure }> {
    const search = await this.searchMembers(ref, username, 20, signal)
    if (!search.ok) return { failure: actionFailureOf(search.failure) }
    const member = search.value.find((candidate) => candidate.username === username)
    if (!member) {
      return { failure: { code: 'failed', message: `${username} is not a member of ${ref.repository.owner}/${ref.repository.name}` } }
    }
    return { member }
  }

  /** Search the project's members by query text, most relevant first. */
  private async searchMembers(
    ref: ChangeRequestRef,
    query: string,
    perPage: number,
    signal: AbortSignal,
  ): Promise<ApiResult<readonly GitLabMember[]>> {
    return this.api<readonly GitLabMember[]>(
      ref.repository.host,
      `${projectPath(ref.repository)}/members/all?query=${encodeURIComponent(query)}&per_page=${perPage}`,
      signal,
    )
  }

  /** Run one `glab api` call and parse its JSON answer. */
  private async api<T>(host: string, path: string, signal: AbortSignal, call: ApiCall = {}): Promise<ApiResult<T>> {
    const args = ['api', path, '--hostname', host]
    if (call.method) args.push('--method', call.method)
    for (const [key, value] of Object.entries(call.fields ?? {})) args.push('--field', `${key}=${value}`)
    for (const [key, value] of Object.entries(call.rawFields ?? {})) args.push('--raw-field', `${key}=${value}`)
    if (call.body !== undefined) args.push('--input', '-')
    let output: GlabOutput
    try {
      output = await this.run(args, signal, call.body)
    } catch (error) {
      if (error === signal.reason) throw error
      if (error instanceof Error && error.name === 'GlabOutputLimitError') {
        return { ok: false, failure: { code: 'too-large', message: error.message } }
      }
      return { ok: false, failure: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } }
    }
    if (output.exitCode !== 0) return { ok: false, failure: failureForOutput(output, path) }
    try {
      return { ok: true, value: JSON.parse(output.stdout) as T }
    } catch {
      return { ok: false, failure: { code: 'unavailable', message: `glab api returned invalid JSON for ${path}` } }
    }
  }
}

/** Map a read failure to the action failure vocabulary. */
function actionFailureOf(failure: ForgeFailure): ForgeActionFailure {
  if (failure.code === 'unauthenticated') return { code: 'unauthenticated', message: failure.message }
  return { code: 'failed', message: failure.message }
}

/** Refuse an action whose confirmed head commit is no longer the head. */
function staleHeadFailure(actual: string, confirmed: string): ForgeActionFailure {
  return { code: 'stale', message: `merge request head is ${actual}, not the confirmed ${confirmed}` }
}
