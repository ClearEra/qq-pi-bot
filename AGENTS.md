# Repository workflow

- Use Pi / Pi Durable for the agent runtime. Do not substitute OpenClaw.
- Before changing code or deployment configuration, create or reuse a GitHub Issue with scope and acceptance criteria.
- Work on an `issue-<number>/<description>` branch, never directly on `main`.
- Open a linked draft PR before validation/build work. Every PR must reference its issue (e.g. `Closes #1`).
- Run build/tests in the PR and require passing CI before merging. Never deploy code from a PR or an unmerged branch.
- Deploy only a clean, merged `main` commit with successful CI, via `npm run deploy`. Record the deployed commit and verification in the issue/PR.
- If credentials or platform permissions are missing, report the blocker; do not claim deployment succeeded.
- Never commit QQ AppSecret, model keys, local Pi settings, chat data, logs, database files, or generated artifacts. Keep credentials in macOS Keychain and local configuration outside the repository.
- Tests must use temporary directories and mock credentials, never real QQ users or live model calls by default.
- Do not enable file or shell tools for QQ participants. Document privacy, delivery guarantees, and uptime limitations honestly.
- Keep this development checkout outside Obsidian/iCloud Vault directories.
