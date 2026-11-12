# dsh-forge-gitlab

GitLab merge request provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) forge panel. It registers a `gitlab` provider into `ctx.forge` and reads merge requests through the `glab` CLI that is already signed in on the host, the same way the shipped GitHub provider reads pull requests through `gh`. Maintained outside the harness repository as a third-party plugin.

## Use

1. Enable **Change requests & worktrees** (the forge bundle) on the Plugins page; this plugin needs the `forge` registry it mounts and fails loudly when it is missing.
2. Sign in once per host: `glab auth login --hostname gitlab.com`.
3. Install this package on the Plugins page (npm name `dsh-forge-gitlab`, or a Git source), then open a session inside a GitLab checkout. The panel recognizes the remote, probes sign-in, and lists merge requests the session creates, references, or tracks by URL.

Self-hosted GitLab: list every host in the plugin row's config.

```yaml
- id: forge-gitlab
  name: dsh-forge-gitlab
  config:
    hosts: [gitlab.com, gitlab.example.com]
```

| Field | Default | Meaning |
|---|---|---|
| `glabCommand` | `glab` | GitLab CLI executable name or absolute host path |
| `hosts` | `['gitlab.com']` | Host names this provider serves; list self-hosted hosts explicitly |
| `timeoutMs` | `30000` | Deadline in milliseconds for one `glab` invocation |
| `maxOutputBytes` | `8388608` | Maximum captured bytes per `glab` output stream |
| `maxCommits` | `250` | Most commits one merge request commit listing returns |

Do not list one host in both this provider and the GitHub provider; the registry lets the first registered provider claim a host.

The child process receives a scrubbed environment: variables whose names contain KEY, PASSWORD, SECRET, or TOKEN never reach `glab`, which uses its own credential store.

## Capabilities

Served: repository and merge request URL recognition (nested groups, `/-/merge_requests/N` and the legacy form), status polling (state, draft, branches, head, line counts, pipelines as checks, mergeability, reviewers, approval state), full checks reads with pagination, `findByHead` discovery, readiness probe, mark-ready, merge and squash, whole-diff, per-file text at a commit, commit listing, base-to-head comparison, review requests with member search, and reruns of failed pipelines. Optional provider capabilities that are not implemented are omitted, so the panel hides their controls.

Reviewers come from the merge request's reviewer list; the aggregate approval state is read from the approvals endpoint, which Premium and Ultimate editions serve — on a core edition the read fails and the snapshot reports no decision, while review requests still work.

## Known limitations

- Review threads, inline review submission, branch updates, and viewed marks are not served; the snapshot reports no unresolved-thread count (a lower bound of zero with a truncation flag) and no closing issues. Mapping GitLab discussions onto the forge thread vocabulary needs verification against real payloads and is the next planned step.
- `glab mr` commands in a session are not recognized by the harness's session bindings; bindings come from the remote, `findByHead` after a push, or tracking a URL in the panel.
- Line counts come from the merge request changes listing; when that listing exceeds `maxOutputBytes` the snapshot is served without counts.
- Fast-forward-only and rebase merge strategies are not offered; merge and squash only.
- The exact `glab api` error wording is parsed for HTTP statuses; unmapped failures surface as `unavailable` with the CLI's first diagnostic line.
- Every poll of every merge request also asks the approvals endpoint once; on core editions that read always fails and is ignored.

## Development

```sh
pnpm install
pnpm run lint && pnpm run typecheck && pnpm run build && pnpm test
node tests/smoke.mjs   # mounts the real forge registry plus this plugin
```

CI runs the same chain on pushes to `main` and on pull requests (`.github/workflows/pr-checks.yml`). Pushing a `vX.Y.Z` tag whose version matches `package.json` builds, checks, and publishes the package to npm via Trusted Publishing (`.github/workflows/release.yml`).
