import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = "ClearEra/qq-pi-bot";
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const execute = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

try {
  if (process.platform !== "darwin") throw new Error("Local deployment currently requires macOS");
  if (run("git", ["branch", "--show-current"]) !== "main") throw new Error("Deployment requires merged main, not a PR branch");
  if (run("git", ["status", "--porcelain"])) throw new Error("Deployment requires a clean checkout");
  const origin = run("git", ["remote", "get-url", "origin"]);
  if (!/^git@github\.com:ClearEra\/qq-pi-bot(?:\.git)?$|^https:\/\/github\.com\/ClearEra\/qq-pi-bot(?:\.git)?$/.test(origin)) throw new Error("Unexpected deployment repository");
  run("git", ["fetch", "origin", "main"]);
  const sha = run("git", ["rev-parse", "HEAD"]);
  if (sha !== run("git", ["rev-parse", "origin/main"])) throw new Error("Checkout must match latest origin/main");
  const prs = JSON.parse(run("gh", ["api", `repos/${repo}/commits/${sha}/pulls`]));
  const pr = prs.find((item) => item.merged_at && item.base.ref === "main" && item.base.repo.full_name === repo);
  if (!pr || !/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+/i.test(pr.body ?? "")) throw new Error("Commit must belong to a merged PR linked to an issue");
  const checks = JSON.parse(run("gh", ["api", `repos/${repo}/commits/${sha}/check-runs`]));
  for (const name of ["test (ubuntu-latest, 22)", "test (macos-latest, 24)"]) {
    const check = checks.check_runs.find((item) => item.name === name && item.app?.slug === "github-actions");
    if (!check || check.status !== "completed" || check.conclusion !== "success") throw new Error(`Required CI check not successful: ${name}`);
  }
  const releases = path.join(os.homedir(), ".local", "share", "qq-pi-bot", "releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const release = await mkdtemp(path.join(releases, `${sha}-`));
  // Export committed files only. Never run LaunchAgent from the mutable development checkout.
  const archive = execFileSync("git", ["archive", "--format=tar", sha], { cwd: root });
  execFileSync("tar", ["-xf", "-", "-C", release], { input: archive });
  for (const args of [["ci"], ["test"], ["audit", "--omit=dev"]]) {
    execFileSync("npm", args, { cwd: release, stdio: "inherit" });
  }
  const { readConfig, APP_DIR } = await import(path.join(release, "dist/config.js"));
  const { loadPiModels } = await import(path.join(release, "dist/models.js"));
  await loadPiModels(await readConfig());
  // Check existence only. Never put the secret in stdout, arguments, or deployment receipts.
  run("security", ["find-generic-password", "-s", "pi-qq-bot", "-a", "qq-bot-app-secret"]);
  const manifest = { commit: sha, mainSha256: createHash("sha256").update(await readFile(path.join(release, "dist/main.js"))).digest("hex") };
  await writeFile(path.join(release, "release.json"), JSON.stringify(manifest) + "\n", { mode: 0o600 });
  execFileSync(process.execPath, ["dist/service.js", "install"], { cwd: release, stdio: "inherit" });
  let online = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await fetch("http://127.0.0.1:18797/api/status", { signal: AbortSignal.timeout(2000) });
      const status = await response.json();
      if (status.gateway === "fatal") throw new Error("QQ platform rejected the connection; check platform permissions");
      if (status.gateway === "online" && status.commit === sha) { online = true; break; }
    } catch (error) {
      if (error.message?.includes("QQ platform rejected")) throw error;
    }
  }
  if (!online) throw new Error("Service installed but did not become online at the requested commit within 30 seconds; inspect logs");
  const receipt = { commit: sha, release, pullRequest: pr.html_url, deployedAt: new Date().toISOString(), gateway: "online" };
  await writeFile(path.join(APP_DIR, "deployment.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  execute("gh", ["pr", "comment", String(pr.number), "--repo", repo, "--body", `Local macOS deployment verified: ${sha}. QQ Gateway online. This does not yet attest live chat send/receive.`]);
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error(`Deployment stopped: ${error.message}`);
  process.exitCode = 1;
}
