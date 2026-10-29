# Contributing

## Required sequence

1. Open or reuse a GitHub Issue with scope and acceptance criteria.
2. Create an `issue-<number>/<description>` branch.
3. Open a draft PR linked with `Closes #<number>` before build/validation work.
4. Implement, test, and run CI on the PR. `main` requires both CI checks and PR-based changes.
5. Review the diff and merge only after successful CI. Do not bypass the required checks.
6. From a clean, current `main`, run `npm run deploy` locally. The deployment gate checks that HEAD belongs to a merged issue-linked PR, requires successful GitHub Actions for that exact commit, rebuilds/tests, validates local configuration, then installs the service and checks the deployed commit and Gateway status.
7. Record outcome and remaining live-validation risks on the PR/Issue. If credentials or platform permissions are missing, stop before service installation and report the blocker.

## Development

Node.js >=22.19.0 and npm are required. CI tests Node 22 on Linux and Node 24 on macOS.

```sh
npm ci
npm test
npm audit --omit=dev
```

No live QQ or model credentials are needed for tests. Test databases and profile files belong in OS temporary directories. `dist/` is generated and never committed.

Never commit `.env`, AppSecret, API keys, Pi user configuration, databases, chat text, logs, or private role files. Do not give QQ participants filesystem, shell, or deployment tools.

## Deployment boundary

CI uses GitHub-hosted runners with a read-only token, no application secrets, and no deployment steps. Do not attach a personal Mac as a self-hosted runner for public PRs. `npm run deploy` is an operator-run gate, not an OS security sandbox: it does not prevent an owner from manually running lower-level commands. Follow the repository policy rather than bypassing it.
