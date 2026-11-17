/** Maps Git remote URLs and merge request web URLs to forge references for the configured GitLab hosts. */

import type { ChangeRequestRef, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'

/** Matches the `.git` suffix of a repository URL path. */
const GIT_SUFFIX = /\.git$/

/** Matches a merge request path inside a GitLab project, after the `/-/` separator is stripped. */
const MERGE_REQUEST_PATH = /^\/(.+)\/merge_requests\/(\d+)(?:\/.*)?$/

/** Strip a leading protocol, user, and port from an SSH or Git transport URL, returning `[host, path]`. */
function splitTransport(url: string, prefix: string): [string, string] | undefined {
  const after = url.slice(prefix.length)
  const withoutUser = after.includes('@') ? after.slice(after.lastIndexOf('@') + 1) : after
  const slash = withoutUser.indexOf('/')
  if (slash <= 0) return undefined
  const host = withoutUser.slice(0, slash).replace(/:\d+$/, '')
  return [host, withoutUser.slice(slash + 1)]
}

/** Split a remote URL into a host and repository path, or undefined for an unrecognized form. */
function splitRemote(url: string): [string, string] | undefined {
  if (url.startsWith('https://') || url.startsWith('http://')) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (parsed.pathname.length <= 1) return undefined
    return [parsed.host, parsed.pathname.slice(1)]
  }
  if (url.startsWith('ssh://')) return splitTransport(url, 'ssh://')
  if (url.startsWith('git://')) return splitTransport(url, 'git://')
  const scp = /^[^@/]+@([^@/:]+):(.+)$/.exec(url)
  if (scp) return [scp[1] as string, scp[2] as string]
  return undefined
}

/** Map a Git remote URL to its repository when one of `hosts` serves it. */
export function repositoryFromRemote(url: string, hosts: readonly string[]): ForgeRepository | undefined {
  const split = splitRemote(url)
  if (!split) return undefined
  const [rawHost, rawPath] = split
  const host = rawHost.toLowerCase()
  if (!hosts.includes(host)) return undefined
  const segments = rawPath.replace(/\/+$/, '').replace(GIT_SUFFIX, '').split('/')
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) return undefined
  return { forge: 'gitlab', host, owner: segments.slice(0, -1).join('/'), name: segments.at(-1) as string }
}

/** Map a merge request web URL to its reference when one of `hosts` serves it. */
export function changeRequestFromUrl(url: string, hosts: readonly string[]): ChangeRequestRef | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const host = parsed.hostname.toLowerCase() + (parsed.port ? `:${parsed.port}` : '')
  if (!hosts.includes(host)) return undefined
  const pathname = parsed.pathname.replace('/-/', '/')
  const match = MERGE_REQUEST_PATH.exec(pathname)
  if (!match) return undefined
  const segments = (match[1] as string).split('/')
  if (segments.length < 2) return undefined
  return {
    repository: { forge: 'gitlab', host, owner: segments.slice(0, -1).join('/'), name: segments.at(-1) as string },
    number: Number(match[2]),
  }
}

/** Build the canonical web URL of a merge request. */
export function changeRequestUrl(ref: ChangeRequestRef): string {
  const { host, owner, name } = ref.repository
  return `https://${host}/${owner}/${name}/-/merge_requests/${ref.number}`
}
