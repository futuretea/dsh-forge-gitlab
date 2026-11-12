import { describe, expect, it } from 'vitest'
import { changeRequestFromUrl, changeRequestUrl, repositoryFromRemote } from '../src/urls.ts'

const HOSTS = ['gitlab.com', 'gitlab.example.com', 'gitlab.example.com:8080']

describe('repositoryFromRemote', () => {
  it.each([
    ['https://gitlab.com/owner/name.git', { forge: 'gitlab', host: 'gitlab.com', owner: 'owner', name: 'name' }],
    ['https://gitlab.com/owner/name', { forge: 'gitlab', host: 'gitlab.com', owner: 'owner', name: 'name' }],
    ['https://gitlab.com/group/sub/owner/name.git', { forge: 'gitlab', host: 'gitlab.com', owner: 'group/sub/owner', name: 'name' }],
    ['http://gitlab.example.com:8080/owner/name.git', { forge: 'gitlab', host: 'gitlab.example.com:8080', owner: 'owner', name: 'name' }],
    ['ssh://git@gitlab.com:22/owner/name.git', { forge: 'gitlab', host: 'gitlab.com', owner: 'owner', name: 'name' }],
    ['git://gitlab.com/owner/name.git', { forge: 'gitlab', host: 'gitlab.com', owner: 'owner', name: 'name' }],
    ['git@gitlab.com:owner/name.git', { forge: 'gitlab', host: 'gitlab.com', owner: 'owner', name: 'name' }],
    ['git@gitlab.example.com:group/name/', { forge: 'gitlab', host: 'gitlab.example.com', owner: 'group', name: 'name' }],
  ])('maps %s', (url, expected) => {
    expect(repositoryFromRemote(url, HOSTS)).toEqual(expected)
  })

  it.each([
    'https://github.com/owner/name.git',
    'https://gitlab.com/owner',
    'https://gitlab.com/',
    'file:///srv/git/name.git',
    'owner/name',
    '',
  ])('rejects %s', (url) => {
    expect(repositoryFromRemote(url, HOSTS)).toBeUndefined()
  })
})

describe('changeRequestFromUrl', () => {
  const repository = { forge: 'gitlab', host: 'gitlab.com', owner: 'group/sub', name: 'project' }

  it.each([
    ['https://gitlab.com/group/sub/project/-/merge_requests/42', 42],
    ['https://gitlab.com/group/sub/project/-/merge_requests/42/diffs', 42],
    ['https://gitlab.com/group/sub/project/-/merge_requests/42#note_1', 42],
    ['https://gitlab.com/group/sub/project/-/merge_requests/42?diff_head=abc', 42],
    ['https://gitlab.com/group/sub/project/merge_requests/42', 42],
  ])('maps %s', (url, number) => {
    expect(changeRequestFromUrl(url, HOSTS)).toEqual({ repository, number })
  })

  it.each([
    'https://gitlab.com/group/sub/project/-/issues/42',
    'https://gitlab.com/group/sub/project/-/merge_requests/abc',
    'https://gitlab.com/project/-/merge_requests/42',
    'https://github.com/group/sub/project/-/merge_requests/42',
    'git@gitlab.com:group/sub/project/-/merge_requests/42',
  ])('rejects %s', (url) => {
    expect(changeRequestFromUrl(url, HOSTS)).toBeUndefined()
  })
})

describe('changeRequestUrl', () => {
  it('builds the canonical form and round-trips', () => {
    const ref = { repository: { forge: 'gitlab', host: 'gitlab.com', owner: 'group/sub', name: 'project' }, number: 7 }
    const url = changeRequestUrl(ref)
    expect(url).toBe('https://gitlab.com/group/sub/project/-/merge_requests/7')
    expect(changeRequestFromUrl(url, HOSTS)).toEqual(ref)
  })
})
