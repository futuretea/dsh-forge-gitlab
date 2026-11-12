/** Registers the GitLab provider of `ctx.forge`, which reads merge requests through the GitLab CLI on the host. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import { glabRunner } from './glab.js'
import { GitLabProvider } from './provider.js'

/** Stable Loader identity. */
export const name = 'forge-gitlab'

/** The forge registry this provider registers into. */
export const inject = ['forge']

/** GitLab CLI executable, served hosts, and invocation limits. */
export interface Config {
  /** GitLab CLI executable name or absolute host path. */
  glabCommand?: string
  /** Host names this provider serves; list self-hosted GitLab hosts explicitly. */
  hosts?: string[]
  /** Deadline in milliseconds for one `glab` invocation. */
  timeoutMs?: number
  /** Maximum captured bytes per `glab` output stream. */
  maxOutputBytes?: number
  /** Most commits one merge request commit listing returns. */
  maxCommits?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  glabCommand: z.string().default('glab'),
  hosts: z.array(z.string()).default(['gitlab.com']),
  timeoutMs: z.number().default(30_000),
  maxOutputBytes: z.number().default(8_388_608),
  maxCommits: z.number().default(250),
})

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (resolved.glabCommand.trim().length === 0) throw new Error('forge-gitlab: glabCommand must not be empty')
  if (resolved.hosts.length === 0) throw new Error('forge-gitlab: hosts must list at least one host')
  for (const host of resolved.hosts) {
    if (!HOST.test(host)) throw new Error(`forge-gitlab: invalid host ${JSON.stringify(host)}`)
  }
  for (const key of ['timeoutMs', 'maxOutputBytes', 'maxCommits'] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) {
      throw new Error(`forge-gitlab: ${key} must be a positive safe integer`)
    }
  }
  ctx.forge.register(new GitLabProvider(
    glabRunner({
      glabCommand: resolved.glabCommand,
      timeoutMs: resolved.timeoutMs,
      maxOutputBytes: resolved.maxOutputBytes,
    }),
    resolved.hosts,
    { maxCommits: resolved.maxCommits },
  ))
}
