import { describe, expect, it } from 'vitest'
import {
  checksRollup,
  countChanges,
  diffEntriesToPatch,
  failureForOutput,
  isDraft,
  mergeabilityOf,
  mergeMethodsOf,
  pipelineCheckState,
  pipelineToCheck,
  readyTitle,
  reviewDecisionOf,
  reviewersOf,
  snapshotOf,
} from '../src/api.ts'

describe('pipeline mapping', () => {
  it.each([
    ['success', 'success'],
    ['failed', 'failure'],
    ['canceled', 'cancelled'],
    ['skipped', 'skipped'],
    ['manual', 'neutral'],
    ['created', 'pending'],
    ['running', 'pending'],
    [null, 'pending'],
  ])('maps status %s to %s', (status, state) => {
    expect(pipelineCheckState(status)).toBe(state)
  })

  it('builds a check with completion only on terminal statuses, and a rerun id when failed', () => {
    const running = pipelineToCheck({ id: 5, status: 'running', web_url: 'https://gitlab.com/p/1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z' })
    expect(running).toEqual({
      name: 'pipeline #5', state: 'pending', url: 'https://gitlab.com/p/1', workflow: null,
      startedAt: '2026-01-01T00:00:00Z', completedAt: null, rerun: null,
    })
    const done = pipelineToCheck({ id: 6, status: 'success', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:02:00Z' })
    expect(done.completedAt).toBe('2026-01-01T00:02:00Z')
    expect(done.rerun).toBeNull()
    const failed = pipelineToCheck({ id: 7, status: 'failed' })
    expect(failed.rerun).toBe('7')
  })

  it('rolls up checks', () => {
    const state = (s: 'pending' | 'success' | 'failure') => ({ name: s, state: s, url: null, workflow: null, startedAt: null, completedAt: null, rerun: null })
    expect(checksRollup([])).toBe('none')
    expect(checksRollup([state('success')])).toBe('success')
    expect(checksRollup([state('success'), state('pending')])).toBe('pending')
    expect(checksRollup([state('success'), state('failure')])).toBe('failure')
    expect(checksRollup([state('pending'), state('failure')])).toBe('pending')
  })
})

describe('draft and merge readiness', () => {
  const mr = (fields: Partial<Parameters<typeof isDraft>[0]>) => fields as Parameters<typeof isDraft>[0]

  it('detects drafts by flag and title prefix', () => {
    expect(isDraft(mr({ iid: 1, title: 'Normal', state: 'opened', source_branch: 'b', sha: 'a', target_branch: 'm', updated_at: 't' }))).toBe(false)
    expect(isDraft(mr({ iid: 1, title: 'Normal', state: 'opened', draft: true, source_branch: 'b', sha: 'a', target_branch: 'm', updated_at: 't' }))).toBe(true)
    expect(isDraft(mr({ iid: 1, title: 'WIP: fix', state: 'opened', source_branch: 'b', sha: 'a', target_branch: 'm', updated_at: 't' }))).toBe(true)
    expect(isDraft(mr({ iid: 1, title: 'Draft: fix', state: 'opened', source_branch: 'b', sha: 'a', target_branch: 'm', updated_at: 't' }))).toBe(true)
  })

  it('strips the draft prefix once', () => {
    expect(readyTitle('Draft: Draft: keep')).toBe('Draft: keep')
    expect(readyTitle('WIP: fix')).toBe('fix')
    expect(readyTitle('WIP - not a prefix')).toBe('WIP - not a prefix')
    expect(readyTitle('Normal')).toBe('Normal')
  })

  it('maps mergeability', () => {
    const base = { iid: 1, title: 't', state: 'opened' as const, source_branch: 'b', sha: 'a', target_branch: 'm', updated_at: 't' }
    expect(mergeabilityOf({ ...base, has_conflicts: true })).toBe('conflicting')
    expect(mergeabilityOf({ ...base, detailed_merge_status: 'conflicts' })).toBe('conflicting')
    expect(mergeabilityOf({ ...base, detailed_merge_status: 'mergeable' })).toBe('mergeable')
    expect(mergeabilityOf({ ...base, detailed_merge_status: 'draft_status' })).toBe('mergeable')
    expect(mergeabilityOf({ ...base, detailed_merge_status: 'checking' })).toBe('unknown')
    expect(mergeabilityOf(base)).toBe('unknown')
  })

  it('offers squash only when the project allows it', () => {
    expect(mergeMethodsOf(undefined)).toEqual(['merge', 'squash'])
    expect(mergeMethodsOf({ default_branch: 'main' })).toEqual(['merge', 'squash'])
    expect(mergeMethodsOf({ default_branch: 'main', squash_option: 'never' })).toEqual(['merge'])
  })
})

describe('diff mapping', () => {
  const diff = '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+added'

  it('counts added and deleted lines', () => {
    expect(countChanges([{ old_path: 'a', new_path: 'a', diff }])).toEqual({ additions: 2, deletions: 1 })
    expect(countChanges([{ old_path: 'a', new_path: 'b', diff: null }])).toEqual({ additions: 0, deletions: 0 })
    expect(countChanges([])).toEqual({ additions: 0, deletions: 0 })
  })

  it('builds a unified patch with a/ and b/ prefixes', () => {
    expect(diffEntriesToPatch([{ old_path: 'old.ts', new_path: 'new.ts', diff }])).toBe(
      `--- a/old.ts\n+++ b/new.ts\n${diff}`,
    )
    expect(diffEntriesToPatch([
      { old_path: 'x', new_path: 'x', diff },
      { old_path: 'y', new_path: 'y', diff: '' },
    ])).toBe(`--- a/x\n+++ b/x\n${diff}`)
  })
})

describe('failure mapping', () => {
  it('maps HTTP statuses', () => {
    expect(failureForOutput({ exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' }, 'ctx')).toEqual({ code: 'not-found', message: 'HTTP 404: Not Found' })
    expect(failureForOutput({ exitCode: 1, stdout: '', stderr: 'HTTP 401: unauthorized' }, 'ctx')).toEqual({ code: 'unauthenticated', message: 'HTTP 401: unauthorized' })
    expect(failureForOutput({ exitCode: 1, stdout: '', stderr: 'dial tcp: refused' }, 'ctx')).toEqual({ code: 'unavailable', message: 'dial tcp: refused' })
    expect(failureForOutput({ exitCode: 1, stdout: '', stderr: '' }, 'the path')).toEqual({ code: 'unavailable', message: 'the path' })
  })
})

describe('reviewers and approvals', () => {
  const mr = (reviewers?: readonly { id: number; username: string }[]) =>
    ({ iid: 1, title: 't', state: 'opened' as const, source_branch: 'b', sha: 'a', target_branch: 'm', updated_at: 't', reviewers })

  it('lists requested reviewers first, then approvers once', () => {
    const reviewers = reviewersOf(mr([{ id: 1, username: 'jane' }, { id: 2, username: 'bob' }]), {
      approved: true,
      approved_by: [{ user: { id: 1, username: 'jane' } }, { user: { id: 3, username: 'kim' } }],
    })
    expect(reviewers).toEqual([
      { kind: 'user', login: 'jane', avatarUrl: null, requested: true, codeOwner: false, verdict: null, reviewedSha: null },
      { kind: 'user', login: 'bob', avatarUrl: null, requested: true, codeOwner: false, verdict: null, reviewedSha: null },
      { kind: 'user', login: 'kim', avatarUrl: null, requested: false, codeOwner: false, verdict: 'approved', reviewedSha: null },
    ])
  })

  it('maps the aggregate review decision from approvals', () => {
    expect(reviewDecisionOf(undefined)).toBe('none')
    expect(reviewDecisionOf({ approved: true })).toBe('approved')
    expect(reviewDecisionOf({ approved: false, approvals_required: 1 })).toBe('review-required')
  })
})

describe('snapshotOf', () => {
  it('maps a full merge request', () => {
    const ref = { repository: { forge: 'gitlab', host: 'gitlab.com', owner: 'o', name: 'n' }, number: 3 }
    const mr = {
      iid: 3, title: 'Draft: Add feature', state: 'opened' as const, draft: true,
      author: { username: 'jane' }, source_branch: 'feature', sha: 'abc123', target_branch: 'main',
      diff_refs: { base_sha: 'def456' }, detailed_merge_status: 'draft_status', updated_at: '2026-01-02T00:00:00Z',
    }
    const snapshot = snapshotOf({
      ref, mr,
      pipelines: [{ id: 9, status: 'success', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z' }],
      project: { default_branch: 'main' },
      counts: { additions: 2, deletions: 1 },
      approvals: { approved: false, approvals_required: 1 },
      checksTruncated: false,
    })
    expect(snapshot).toMatchObject({
      ref, url: 'https://gitlab.com/o/n/-/merge_requests/3', title: 'Draft: Add feature', state: 'open', draft: true,
      author: 'jane', headBranch: 'feature', headSha: 'abc123', baseBranch: 'main', baseSha: 'def456',
      additions: 2, deletions: 1, mergeability: 'mergeable', mergeReady: false, mergeMethods: ['merge', 'squash'],
      reviewDecision: 'review-required', canRequestReviews: true, canRerunChecks: true,
      checksRollup: 'success', unresolvedThreads: 0, threadsTruncated: true, closedAt: null,
    })
  })

  it('maps merged state and omitted base sha', () => {
    const ref = { repository: { forge: 'gitlab', host: 'gitlab.com', owner: 'o', name: 'n' }, number: 4 }
    const mr = {
      iid: 4, title: 'Done', state: 'merged' as const, source_branch: 'b', sha: 'ff', target_branch: 'main',
      updated_at: '2026-01-02T00:00:00Z', merged_at: '2026-01-03T00:00:00Z', closed_at: '2026-01-03T00:00:00Z',
    }
    const snapshot = snapshotOf({
      ref, mr, pipelines: [], project: undefined,
      counts: { additions: 0, deletions: 0 }, approvals: undefined, checksTruncated: false,
    })
    expect(snapshot.state).toBe('merged')
    expect(snapshot.closedAt).toBe('2026-01-03T00:00:00Z')
    expect(snapshot.baseSha).toBeUndefined()
    expect(snapshot.checksRollup).toBe('none')
  })
})
