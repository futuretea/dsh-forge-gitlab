import { describe, expect, it } from 'vitest'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import { GitLabProvider } from '../src/provider.ts'
import type { GlabOutput, GlabRunner } from '../src/glab.ts'

const ref = { repository: { forge: 'gitlab' as const, host: 'gitlab.com', owner: 'o', name: 'n' }, number: 3 }

const MR = {
  iid: 3, title: 'Add feature', state: 'opened', author: { username: 'jane' },
  source_branch: 'feature', sha: 'abc123', target_branch: 'main',
  diff_refs: { base_sha: 'def456' }, detailed_merge_status: 'mergeable', updated_at: '2026-01-02T00:00:00Z',
}
const PROJECT = { default_branch: 'main' }

function ok(value: unknown): GlabOutput {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' }
}

/** Script a runner by the `glab api` path or first arguments. */
function runner(script: (args: readonly string[], input?: string) => GlabOutput): GlabRunner {
  return async (args, signal, input) => {
    if (signal.aborted) throw signal.reason
    return script(args, input)
  }
}

function provider(run: GlabRunner): GitLabProvider {
  return new GitLabProvider(run, ['gitlab.com'], { maxCommits: 250 })
}

const never = runner(() => ({ exitCode: 1, stdout: '', stderr: 'unexpected call' }))

describe('readiness', () => {
  it('is ready on exit 0', async () => {
    const p = provider(runner((args) => {
      expect(args).toEqual(['auth', 'status', '--hostname', 'gitlab.com'])
      return { exitCode: 0, stdout: '', stderr: '' }
    }))
    await expect(p.readiness('gitlab.com', new AbortController().signal)).resolves.toEqual({ state: 'ready', message: null })
  })

  it('is unauthenticated with the first diagnostic line', async () => {
    const p = provider(runner(() => ({ exitCode: 1, stdout: '', stderr: 'not logged in to gitlab.com' })))
    await expect(p.readiness('gitlab.com', new AbortController().signal)).resolves.toEqual({
      state: 'unauthenticated', message: 'not logged in to gitlab.com',
    })
  })

  it('is unavailable when glab cannot start', async () => {
    const p = provider(runner(() => {
      throw new Error('glab could not start: ENOENT')
    }))
    await expect(p.readiness('gitlab.com', new AbortController().signal)).resolves.toEqual({
      state: 'unavailable', message: 'glab could not start: ENOENT',
    })
  })
})

describe('fetch', () => {
  it('builds a snapshot from project, changes, and pipelines reads', async () => {
    const p = provider(runner((args) => {
      const path = args[1] as string
      if (path === 'projects/o%2Fn') return ok(PROJECT)
      if (path === 'projects/o%2Fn/merge_requests/3/changes') {
        return ok({ ...MR, changes: [{ old_path: 'a', new_path: 'a', diff: '@@ -1 +1 @@\n-x\n+y' }] })
      }
      if (path === 'projects/o%2Fn/merge_requests/3/pipelines?per_page=100&page=1') {
        return ok([{ id: 9, status: 'success', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z' }])
      }
      if (path === 'projects/o%2Fn/merge_requests/3/approvals') return ok({ approved: false })
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    const results = await p.fetch([ref], new AbortController().signal)
    expect(results.get(changeRequestKey(ref))).toMatchObject({
      state: 'open', headSha: 'abc123', additions: 1, deletions: 1, checksRollup: 'success', mergeReady: true,
      reviewDecision: 'review-required',
    })
  })

  it('serves the merge request without counts when the changes listing is too large', async () => {
    const p = provider(runner((args) => {
      const path = args[1] as string
      if (path === 'projects/o%2Fn') return ok(PROJECT)
      if (path === 'projects/o%2Fn/merge_requests/3/changes') {
        const error = new Error('glab api output exceeds maxOutputBytes')
        error.name = 'GlabOutputLimitError'
        throw error
      }
      if (path === 'projects/o%2Fn/merge_requests/3') return ok(MR)
      if (path === 'projects/o%2Fn/merge_requests/3/pipelines?per_page=100&page=1') return ok([])
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    const results = await p.fetch([ref], new AbortController().signal)
    expect(results.get(changeRequestKey(ref))).toMatchObject({ headSha: 'abc123', additions: 0, deletions: 0 })
  })

  it('reports a missing merge request', async () => {
    const p = provider(runner((args) => {
      const path = args[1] as string
      if (path === 'projects/o%2Fn') return ok(PROJECT)
      if (path === 'projects/o%2Fn/merge_requests/3/changes') {
        return { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    const results = await p.fetch([ref], new AbortController().signal)
    expect(results.get(changeRequestKey(ref))).toEqual({ code: 'not-found', message: 'HTTP 404: Not Found' })
  })
})

describe('merge', () => {
  it('refuses a moved head as stale', async () => {
    const p = provider(runner((args) => {
      expect(args[1]).toBe('projects/o%2Fn/merge_requests/3')
      return ok({ ...MR, sha: 'moved789' })
    }))
    await expect(p.merge(ref, { method: 'merge', headSha: 'abc123' }, new AbortController().signal)).resolves.toEqual({
      code: 'stale', message: 'merge request head is moved789, not the confirmed abc123',
    })
  })

  it('merges with squash and source branch kept', async () => {
    const seen: string[][] = []
    const p = provider(runner((args) => {
      seen.push([...args])
      const path = args[1] as string
      if (path === 'projects/o%2Fn/merge_requests/3') return ok(MR)
      if (path === 'projects/o%2Fn/merge_requests/3/merge') return ok({ state: 'merged' })
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    await expect(p.merge(ref, { method: 'squash', headSha: 'abc123' }, new AbortController().signal)).resolves.toBeUndefined()
    expect(seen.at(-1)).toEqual([
      'api', 'projects/o%2Fn/merge_requests/3/merge', '--hostname', 'gitlab.com',
      '--method', 'PUT', '--field', 'squash=true', '--field', 'should_remove_source_branch=false',
    ])
  })

  it('does not offer rebase merges', async () => {
    const p = provider(never)
    await expect(p.merge(ref, { method: 'rebase', headSha: 'abc123' }, new AbortController().signal)).resolves.toMatchObject({
      code: 'failed',
    })
  })
})

describe('markReady', () => {
  it('strips the draft prefix onto the title only when the merge request is a draft', async () => {
    const seen: string[][] = []
    const p = provider(runner((args) => {
      seen.push([...args])
      const path = args[1] as string
      if (path === 'projects/o%2Fn/merge_requests/3') return ok({ ...MR, title: 'Draft: Add feature', draft: true })
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    await expect(p.markReady(ref, new AbortController().signal)).resolves.toBeUndefined()
    expect(seen.at(-1)).toEqual([
      'api', 'projects/o%2Fn/merge_requests/3', '--hostname', 'gitlab.com',
      '--method', 'PUT', '--raw-field', 'title=Add feature',
    ])
  })

  it('leaves a merge request that is not a draft untouched', async () => {
    const seen: string[][] = []
    const p = provider(runner((args) => {
      seen.push([...args])
      expect(args[1]).toBe('projects/o%2Fn/merge_requests/3')
      return ok(MR)
    }))
    await expect(p.markReady(ref, new AbortController().signal)).resolves.toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toContain('PUT')
  })

  it('maps a failed read to an action failure', async () => {
    const p = provider(runner(() => ({ exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' })))
    await expect(p.markReady(ref, new AbortController().signal)).resolves.toEqual({
      code: 'failed', message: 'HTTP 404: Not Found',
    })
  })
})

describe('diff and fileText', () => {
  it('returns a stale failure when the head moved', async () => {
    const p = provider(runner(() => ok({ ...MR, sha: 'moved789' })))
    await expect(p.diff(ref, 'abc123', new AbortController().signal)).resolves.toEqual({
      code: 'stale', message: 'merge request head is moved789, not the requested abc123',
    })
  })

  it('builds the patch from the changes listing', async () => {
    const p = provider(runner((args) => {
      const path = args[1] as string
      if (path === 'projects/o%2Fn/merge_requests/3') return ok(MR)
      if (path === 'projects/o%2Fn/merge_requests/3/changes') {
        return ok({ changes: [{ old_path: 'old.ts', new_path: 'new.ts', diff: '@@ -1 +1 @@\n-a\n+b' }] })
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    await expect(p.diff(ref, 'abc123', new AbortController().signal)).resolves.toBe('--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b')
  })

  it('decodes base64 file content', async () => {
    const p = provider(runner(() => ok({ content: Buffer.from('hello\n', 'utf8').toString('base64'), encoding: 'base64' })))
    await expect(p.fileText(ref, 'abc123', 'src/a.ts', new AbortController().signal)).resolves.toBe('hello\n')
  })
})

describe('findByHead', () => {
  it('lists open merge requests of the branch, excluding the default branch', async () => {
    const p = provider(runner((args) => {
      const path = args[1] as string
      if (path === 'projects/o%2Fn') return ok(PROJECT)
      if (path.startsWith('projects/o%2Fn/merge_requests?')) {
        expect(path).toContain('source_branch=feature')
        return ok([
          { ...MR, iid: 3, target_branch: 'main' },
          { ...MR, iid: 4, target_branch: 'other' },
        ])
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    await expect(p.findByHead(ref.repository, 'feature', new AbortController().signal)).resolves.toEqual([
      { repository: ref.repository, number: 4 },
    ])
  })
})

describe('commits', () => {
  it('pages the listing and truncates at maxCommits', async () => {
    const page = (pageNumber: number, items: number) => Array.from({ length: items }, (_, i) => {
      const index = (pageNumber - 1) * 100 + i
      return {
        id: `c${index}`,
        parent_ids: index === 0 ? null : [`c${index - 1}`],
        title: `commit ${index}`,
        authored_date: '2026-01-01T00:00:00Z',
      }
    })
    const p = new GitLabProvider(runner((args) => {
      const path = args[1] as string
      if (path === 'projects/o%2Fn/merge_requests/3') return ok(MR)
      if (path.includes('/commits?per_page=100&page=1')) return ok(page(1, 100))
      if (path.includes('/commits?per_page=100&page=2')) return ok(page(2, 2))
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }), ['gitlab.com'], { maxCommits: 101 })
    const list = await p.commits(ref, new AbortController().signal)
    expect(list).toEqual({
      headSha: 'abc123',
      truncated: true,
      commits: [
        { sha: 'c0', parent: null, title: 'commit 0', author: null, authoredAt: '2026-01-01T00:00:00Z' },
        ...Array.from({ length: 100 }, (_, i) => ({
          sha: `c${i + 1}`, parent: `c${i}`, title: `commit ${i + 1}`, author: null, authoredAt: '2026-01-01T00:00:00Z',
        })),
      ],
    })
  })
})

describe('fetchChecks', () => {
  it('pages the whole pipeline list', async () => {
    const pipelines = (page: number) => Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({ id: page * 100 + i, status: 'success' }))
    const p = provider(runner((args) => {
      const path = args[1] as string
      if (path === 'projects/o%2Fn') return ok(PROJECT)
      if (path === 'projects/o%2Fn/merge_requests/3/changes') return ok({ ...MR, changes: [] })
      if (path === 'projects/o%2Fn/merge_requests/3/pipelines?per_page=100&page=1') return ok(pipelines(1))
      if (path === 'projects/o%2Fn/merge_requests/3/pipelines?per_page=100&page=2') return ok(pipelines(2))
      if (path === 'projects/o%2Fn/merge_requests/3/approvals') return { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    const snapshot = await p.fetchChecks(ref, new AbortController().signal)
    expect(snapshot).toMatchObject({ checksTruncated: false, reviewDecision: 'none' })
    if (!('checks' in snapshot)) throw new Error('expected a snapshot')
    expect(snapshot.checks).toHaveLength(103)
  })
})

describe('rerunChecks', () => {
  it('refuses a moved head as stale', async () => {
    const p = provider(runner(() => ok({ ...MR, sha: 'moved789' })))
    await expect(p.rerunChecks(ref, { headSha: 'abc123' }, new AbortController().signal)).resolves.toEqual({
      code: 'stale', message: 'merge request head is moved789, not the confirmed abc123',
    })
  })

  it('retries every failed pipeline', async () => {
    const seen: string[][] = []
    const p = provider(runner((args) => {
      seen.push([...args])
      const path = args[1] as string
      if (path === 'projects/o%2Fn/merge_requests/3') return ok(MR)
      if (path === 'projects/o%2Fn/merge_requests/3/pipelines?per_page=100') {
        return ok([{ id: 1, status: 'success' }, { id: 2, status: 'failed' }, { id: 3, status: 'failed' }])
      }
      if (path === 'projects/o%2Fn/pipelines/2/retry') return ok({ id: 21 })
      if (path === 'projects/o%2Fn/pipelines/3/retry') return ok({ id: 31 })
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    await expect(p.rerunChecks(ref, { headSha: 'abc123' }, new AbortController().signal)).resolves.toBeUndefined()
    expect(seen.some((argv) => argv[1] === 'projects/o%2Fn/pipelines/2/retry')).toBe(true)
    expect(seen.some((argv) => argv[1] === 'projects/o%2Fn/pipelines/3/retry')).toBe(true)
  })
})

describe('requestReviews', () => {
  const MR_WITH_REVIEWERS = { ...MR, reviewers: [{ id: 7, username: 'jane' }] }

  it('merges requested reviewers into reviewer ids by exact username', async () => {
    const seen: string[][] = []
    const bodies: (string | undefined)[] = []
    const p = provider(runner((args, input) => {
      seen.push([...args])
      bodies.push(input)
      const path = args[1] as string
      if (path === 'projects/o%2Fn/merge_requests/3') return ok(MR_WITH_REVIEWERS)
      if (path === 'projects/o%2Fn/members/all?query=bob&per_page=20') {
        return ok([{ id: 9, username: 'bobby' }, { id: 12, username: 'bob' }])
      }
      if (args.includes('PUT')) return ok(MR_WITH_REVIEWERS)
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    await expect(p.requestReviews(ref, { reviewers: [{ kind: 'user', login: 'bob' }] }, new AbortController().signal)).resolves.toBeUndefined()
    const put = seen.at(-1) as string[]
    expect(put).toContain('--input')
    expect(put).toContain('-')
    expect(JSON.parse(bodies.at(-1) as string)).toEqual({ reviewer_ids: [7, 12] })
  })

  it('fails for an account that is not a project member', async () => {
    const p = provider(runner((args) => {
      const path = args[1] as string
      if (path === 'projects/o%2Fn/merge_requests/3') return ok(MR_WITH_REVIEWERS)
      if (path.startsWith('projects/o%2Fn/members/all')) return ok([])
      return { exitCode: 1, stdout: '', stderr: `unexpected path ${path}` }
    }))
    await expect(p.requestReviews(ref, { reviewers: [{ kind: 'user', login: 'nobody' }] }, new AbortController().signal)).resolves.toEqual({
      code: 'failed', message: 'nobody is not a member of o/n',
    })
  })

  it('rejects team reviewers GitLab cannot serve', async () => {
    const p = provider(never)
    await expect(p.requestReviews(ref, { reviewers: [{ kind: 'team', login: 'org/team' }] }, new AbortController().signal)).resolves.toMatchObject({
      code: 'failed',
    })
  })
})

describe('reviewerCandidates', () => {
  it('maps project members with the host order', async () => {
    const p = provider(runner((args) => {
      expect(args[1]).toBe('projects/o%2Fn/members/all?query=jo&per_page=50')
      return ok([{ id: 1, username: 'john', name: 'John Doe', avatar_url: 'https://gitlab.com/a.png' }])
    }))
    await expect(p.reviewerCandidates(ref, 'jo', new AbortController().signal)).resolves.toEqual([
      { login: 'john', name: 'John Doe', avatarUrl: 'https://gitlab.com/a.png', suggested: false },
    ])
  })
})
