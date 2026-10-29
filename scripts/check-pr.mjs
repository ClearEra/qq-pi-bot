import { readFile } from "node:fs/promises";

if (process.env.GITHUB_EVENT_NAME !== "pull_request") process.exit(0);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
const pr = event.pull_request;
if (!/^issue-\d+\//.test(pr.head.ref)) throw new Error("PR branch must use issue-<number>/<description>");
const match = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(pr.body ?? "");
if (!match) throw new Error("PR must link an issue with Closes #<number>");
const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues/${match[1]}`, {
  headers: { Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error("Linked issue does not exist or cannot be read");
const issue = await response.json();
if (issue.pull_request) throw new Error("Link a real issue, not another pull request");
if (pr.head.ref.split("/")[0] !== `issue-${match[1]}`) throw new Error("Branch number must match the linked issue");
console.log(`Issue-first policy verified: #${match[1]}`);
