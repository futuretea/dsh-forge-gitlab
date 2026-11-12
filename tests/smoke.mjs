/**
 * Smoke check: mount the real forge registry and this plugin in one Cordis
 * context and exercise the registered provider without touching any host.
 * Run with `node tests/smoke.mjs` after `pnpm run build`.
 */
import { Context } from '@deepseek-ai/cordis'
import ForgeService from '@deepseek-ai/dsh-experimental-forge'
import * as forgeGitlab from '../lib/index.js'

const ctx = new Context()
await ctx.plugin(ForgeService)
await ctx.plugin(forgeGitlab)

const remote = ctx.forge.repositoryFromRemote('git@gitlab.com:group/sub/project.git')
console.log('remote:', remote)
if (remote?.forge !== 'gitlab' || remote.name !== 'project') throw new Error('remote recognition failed')

const ref = ctx.forge.changeRequestFromUrl('https://gitlab.com/group/sub/project/-/merge_requests/7')
console.log('change request:', ref)
if (ref?.number !== 7) throw new Error('change request recognition failed')

console.log('canonical url:', ctx.forge.changeRequestUrl(ref))
const readiness = await ctx.forge.readiness(ref.repository, AbortSignal.timeout(15_000))
console.log('readiness:', readiness)

console.log('smoke ok')
process.exit(0)
