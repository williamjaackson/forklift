import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { runStatus } from "../src/status.js";
import { runSync } from "../src/sync.js";
import { makeFixture, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(async () => {
  await fx?.cleanup();
});

const sync = (extra: Parameters<typeof runSync>[0] | object = {}) => runSync({ cwd: fx.fork, ...extra });
const parents = async (ref: string) =>
  (await git(fx.origin, ["log", "-1", "--format=%P", ref])).stdout.trim().split(" ").filter(Boolean);

describe("a merge with no conflicts", () => {
  it("lands on the fork's branch as a real merge commit", async () => {
    fx = await makeFixture({ "app.txt": "one\n" });
    await fx.configure("");
    const forkHead = await fx.forkCommit({ "fork.txt": "mine\n" }, "fork: add fork.txt");
    const upstreamHead = await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");

    const result = await sync();

    expect(result.outcome).toBe("landed");
    expect(result.behind).toBe(1);
    expect(await parents("main")).toEqual([forkHead, upstreamHead]);
    // From the bot, never from whoever's machine or token ran it.
    expect((await git(fx.origin, ["log", "-1", "--format=%an <%ae> / %cn", "main"])).stdout.trim()).toBe(
      "forklift[bot] <bot@forklift.invalid> / forklift[bot]",
    );
    expect(await fx.read("new.txt")).toBe("theirs\n");
    expect(await fx.read("fork.txt")).toBe("mine\n");
  });

  it("is a no-op the second time", async () => {
    fx = await makeFixture({ "app.txt": "one\n" });
    await fx.configure("");
    await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");
    await sync();
    const head = await fx.remoteHead();

    const again = await sync();

    expect(again.outcome).toBe("up-to-date");
    expect(await fx.remoteHead()).toBe(head);
  });

  it("opens a proposal instead when asked to", async () => {
    fx = await makeFixture({ "app.txt": "one\n" });
    await fx.configure("land:\n  clean: pr\n");
    const forkHead = await fx.remoteHead();
    await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");

    const result = await sync();

    expect(result.outcome).toBe("proposed");
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.read("new.txt", "forklift/sync")).toBe("theirs\n");
    expect((await sync()).outcome).toBe("pending");
  });

  it("pushes nothing on a dry run", async () => {
    fx = await makeFixture({ "app.txt": "one\n" });
    await fx.configure("");
    const forkHead = await fx.remoteHead();
    await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");

    const result = await sync({ dryRun: true });

    expect(result.outcome).toBe("dry-run");
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.remoteHead("forklift/sync")).toBeNull();
    const built = (await git(fx.fork, ["rev-parse", "refs/forklift/dry-run"])).stdout.trim();
    expect(built).toBe(result.commit);
  });

  it("leaves the developer's checkout alone", async () => {
    fx = await makeFixture({ "app.txt": "one\n" });
    await fx.configure("");
    await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");
    await fs.writeFile(path.join(fx.fork, "scratch.txt"), "work in progress\n");
    const before = (await git(fx.fork, ["rev-parse", "HEAD"])).stdout;

    await sync();

    expect((await git(fx.fork, ["rev-parse", "HEAD"])).stdout).toBe(before);
    expect(await fs.readFile(path.join(fx.fork, "scratch.txt"), "utf8")).toBe("work in progress\n");
    expect((await git(fx.fork, ["status", "--porcelain"])).stdout.trim()).toBe("?? scratch.txt");
  });
});

describe("rules", () => {
  it("drop: keeps deleted paths deleted and removes what upstream adds there", async () => {
    fx = await makeFixture({ "app.txt": "one\n", "ci/build.yml": "v1\n", "ci/test.yml": "v1\n" });
    await fx.configure("drop: [ci/**]\n");
    await fx.forkCommit({ "ci/build.yml": null, "ci/test.yml": null }, "fork: remove upstream CI");
    await fx.commit(
      fx.upstream,
      { "ci/build.yml": "v2\n", "ci/release.yml": "new\n", "app.txt": "two\n" },
      "upstream: change CI",
    );

    const result = await sync();

    expect(result.outcome).toBe("landed");
    expect(await fx.files()).toEqual(["app.txt", "forklift.yaml"]);
    expect(await fx.read("app.txt")).toBe("two\n");
    expect(result.build?.settled).toEqual([{ path: "ci/build.yml", kind: "deleted-by-fork", by: "drop" }]);
    expect(result.build?.dropped).toEqual(["ci/release.yml"]);
  });

  it("ours: never takes upstream's changes to files the fork owns", async () => {
    fx = await makeFixture({ "README.md": "Upstream\n", "LICENSE": "MIT\n", "app.txt": "one\n" });
    await fx.configure("ours: [README.md, LICENSE]\n");
    await fx.forkCommit({ "README.md": "My Fork\n" }, "fork: own README");
    // README conflicts; LICENSE would merge cleanly, but the fork owns it.
    await fx.commit(
      fx.upstream,
      { "README.md": "Upstream v2\n", "LICENSE": "Apache\n", "app.txt": "two\n" },
      "upstream: docs",
    );

    const result = await sync();

    expect(result.outcome).toBe("landed");
    expect(await fx.read("README.md")).toBe("My Fork\n");
    expect(await fx.read("LICENSE")).toBe("MIT\n");
    expect(await fx.read("app.txt")).toBe("two\n");
  });

  it("regenerate: rebuilds a conflicted file instead of merging it", async () => {
    fx = await makeFixture({ "deps.txt": "a\n", "deps.lock": "lock(a)\n" });
    await fx.configure(`regenerate:\n  deps.lock: 'printf "lock(%s)\\n" "$(tr "\\n" "," < deps.txt)" > deps.lock'\n`);
    await fx.forkCommit({ "deps.txt": "a\nfork\n", "deps.lock": "lock(a,fork)\n" }, "fork: add dep");
    await fx.commit(fx.upstream, { "deps.txt": "up\na\n", "deps.lock": "lock(up,a)\n" }, "upstream: add dep");

    const forkHead = await fx.remoteHead();

    const result = await sync();

    // A regenerated file is whatever the command wrote, which nobody can
    // check from the outside: it goes to review instead of straight in.
    expect(result.outcome).toBe("proposed");
    expect(result.judged).toEqual(["deps.lock"]);
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.read("deps.txt", "forklift/sync")).toBe("up\na\nfork\n");
    expect(await fx.read("deps.lock", "forklift/sync")).toBe("lock(up,a,fork,)\n");
    expect(result.build?.regenerated).toEqual([{ command: expect.stringContaining("printf"), ok: true }]);
  });

  it("forbid + replace: rewrites text upstream brings in, and only that", async () => {
    fx = await makeFixture({ "ui/title.txt": "Welcome to T3 Code\n", "docs/about.txt": "T3 Code docs\n" });
    await fx.configure("forbid:\n  - pattern: 'T3 Code'\n    in: ui/**\n    replace: Bonfire\n");
    await fx.forkCommit({ "ui/title.txt": "Welcome to Bonfire\n" }, "fork: rebrand");
    await fx.commit(
      fx.upstream,
      { "ui/menu.txt": "About T3 Code\nQuit\n", "docs/about.txt": "T3 Code documentation\n" },
      "upstream: add menu",
    );

    const result = await sync();

    expect(result.outcome).toBe("landed");
    expect(await fx.read("ui/menu.txt")).toBe("About Bonfire\nQuit\n");
    expect(await fx.read("docs/about.txt")).toBe("T3 Code documentation\n");
    expect(result.build?.replaced).toEqual([{ file: "ui/menu.txt", lines: 1 }]);
  });

  it("forbid without replace: holds the merge for review when nobody can fix it", async () => {
    fx = await makeFixture({ "app.txt": "one\n" });
    await fx.configure("forbid:\n  - pattern: 'ping\\.gg'\n");
    const forkHead = await fx.remoteHead();
    await fx.commit(fx.upstream, { "app.txt": "one\nhttps://ping.gg/telemetry\n" }, "upstream: telemetry");

    const result = await sync();

    expect(result.outcome).toBe("needs-review");
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(result.report).toContain("Needs review");
    expect(result.report).toContain("app.txt:2: /ping\\.gg/");
    // Left alone until retry_after passes or the fork changes.
    expect((await sync()).outcome).toBe("waiting");
  });
});

describe("conflicts that need judgement", () => {
  const conflicted = async () => {
    fx = await makeFixture({ "greeting.txt": "hello\n", "app.txt": "one\n" });
    await fx.forkCommit({ "greeting.txt": "hello from the fork\n" }, "fork: personalise greeting");
  };

  it("are resolved by the agent and proposed for review, never landed directly", async () => {
    await conflicted();
    const agent = await fx.agent(
      "resolver",
      `fs.writeFileSync("greeting.txt", "hello, world, from the fork\\n"); console.log("greeting.txt: kept the fork's sign-off on upstream's new wording");`,
    );
    await fx.configure(`agent: ${agent}\n`);
    const forkHead = await fx.remoteHead();
    await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");

    const result = await sync();

    expect(result.outcome).toBe("proposed");
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.read("greeting.txt", "forklift/sync")).toBe("hello, world, from the fork\n");
    expect(result.build?.settled).toEqual([{ path: "greeting.txt", kind: "both-changed", by: "agent" }]);
    expect(result.judged).toEqual(["greeting.txt"]);
    expect(result.report).toContain("+hello, world, from the fork");
    expect(result.report).toContain("kept the fork's sign-off");
    expect(result.report).toContain("Create a merge commit");
  });

  it("give the agent both sides' history and the fork's notes", async () => {
    await conflicted();
    const agent = await fx.agent(
      "recorder",
      `fs.writeFileSync(process.env.FORKLIFT_PROMPT_FILE + ".seen", prompt); fs.writeFileSync("greeting.txt", "resolved\\n");`,
    );
    await fx.configure(`agent: ${agent}\nnotes: The greeting must always mention the fork.\n`);
    await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");

    await sync();

    const [workspace] = await fs.readdir(path.join(fx.root, "home/worktrees"));
    const seen = await fs.readFile(
      path.join(fx.root, "home/worktrees", workspace!, ".git/forklift/prompt.md.seen"),
      "utf8",
    );
    expect(seen).toContain("`greeting.txt`");
    expect(seen).toContain("fork: personalise greeting");
    expect(seen).toContain("upstream: reword greeting");
    expect(seen).toContain("The greeting must always mention the fork.");
  });

  it("do not give the agent credentials that can push", async () => {
    await conflicted();
    const agent = await fx.agent(
      "snoop",
      `fs.writeFileSync("greeting.txt", JSON.stringify([process.env.GH_TOKEN ?? null, process.env.ANTHROPIC_API_KEY ?? null]) + "\\n");`,
    );
    await fx.configure(`agent: ${agent}\n`);
    await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");
    process.env.GH_TOKEN = "push-secret";
    process.env.ANTHROPIC_API_KEY = "model-key";
    try {
      await sync();
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }

    expect(await fx.read("greeting.txt", "forklift/sync")).toBe('[null,"model-key"]\n');
  });

  it("stop the sync when the agent leaves conflict markers behind", async () => {
    await conflicted();
    const agent = await fx.agent("lazy", `console.log("done!");`);
    await fx.configure(`agent: ${agent}\n`);
    const forkHead = await fx.remoteHead();
    await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");

    const result = await sync();

    expect(result.outcome).toBe("blocked");
    expect(result.agentRuns).toHaveLength(2);
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.remoteHead("forklift/sync")).toBeNull();
  });

  it("without an agent: land everything before the conflict and name the commit that caused it", async () => {
    await conflicted();
    await fx.configure("");
    await fx.commit(fx.upstream, { "app.txt": "two\n" }, "upstream: safe change");
    const culprit = await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");
    await fx.commit(fx.upstream, { "later.txt": "later\n" }, "upstream: after the conflict");

    const result = await sync();

    expect(result.outcome).toBe("blocked");
    expect(result.blocker?.commit.sha).toBe(culprit);
    expect(result.blocker?.commit.subject).toBe("upstream: reword greeting");
    expect(result.blocker?.cleanBefore).toBe(1);
    expect(result.merged).toBe(1);
    expect(await fx.read("app.txt")).toBe("two\n");
    expect(await fx.read("greeting.txt")).toBe("hello from the fork\n");
    expect(await fx.read("later.txt")).toBeNull();
    expect(result.report).toContain("upstream: reword greeting");

    // The same conflict is not attempted again on every tick…
    expect((await sync()).outcome).toBe("waiting");
    // …until someone asks, or fixes the fork.
    expect((await sync({ retry: true })).outcome).toBe("blocked");
    await git(fx.fork, ["pull", "--quiet", "origin", "main"]);
    await git(fx.fork, ["fetch", "--quiet", fx.upstream, "main"]);
    await git(fx.fork, ["merge", "--quiet", "FETCH_HEAD"], { allowFailure: true });
    await fx.forkCommit({ "greeting.txt": "hello, world, from the fork\n" }, "fork: merge upstream by hand");
    expect((await sync()).outcome).toBe("up-to-date");
  });

  it("replay a resolution made on an earlier run", async () => {
    await conflicted();
    const agent = await fx.agent(
      "once",
      `const used = process.env.FORKLIFT_PROMPT_FILE + ".used";
       if (fs.existsSync(used)) process.exit(1);
       fs.writeFileSync(used, "");
       fs.writeFileSync("greeting.txt", "hello, world, from the fork\\n");`,
    );
    await fx.configure(`agent: ${agent}\n`);
    await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");
    expect((await sync()).outcome).toBe("proposed");

    // Upstream moves on; the proposal is rebuilt without calling the agent
    // again, and still goes to review: nobody has approved that resolution.
    const forkHead = await fx.remoteHead();
    await fx.commit(fx.upstream, { "later.txt": "later\n" }, "upstream: more work");
    const result = await sync({ retry: true });

    expect(result.outcome).toBe("proposed");
    expect(result.agentRuns).toHaveLength(0);
    expect(result.build?.replayed).toEqual(["greeting.txt"]);
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.read("greeting.txt", "forklift/sync")).toBe("hello, world, from the fork\n");
    expect(await fx.read("later.txt", "forklift/sync")).toBe("later\n");
  });
});

describe("checks", () => {
  it("hold a merge that fails verify, without landing it", async () => {
    fx = await makeFixture({ "value.txt": "1\n" });
    await fx.configure(`verify:\n  - name: value is small\n    run: test "$(cat value.txt)" -lt 5\n`);
    const forkHead = await fx.remoteHead();
    await fx.commit(fx.upstream, { "value.txt": "9\n" }, "upstream: raise value");

    const result = await sync();

    expect(result.outcome).toBe("needs-review");
    expect(result.build?.gates).toMatchObject([{ name: "value is small", ok: false }]);
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.read("value.txt", "forklift/sync")).toBe("9\n");
  });

  it("let the agent repair a failing check, then propose the result", async () => {
    fx = await makeFixture({ "value.txt": "1\n", "limit.txt": "5\n" });
    const agent = await fx.agent("fixer", `fs.writeFileSync("limit.txt", "10\\n"); console.log("raised the limit to fit upstream's value");`);
    await fx.configure(
      `agent: ${agent}\nverify:\n  - name: value under limit\n    run: test "$(cat value.txt)" -lt "$(cat limit.txt)"\n`,
    );
    await fx.commit(fx.upstream, { "value.txt": "9\n" }, "upstream: raise value");

    const result = await sync();

    expect(result.outcome).toBe("proposed");
    expect(result.build?.gates).toMatchObject([{ name: "value under limit", ok: true, repaired: true }]);
    expect(result.judged).toEqual(["limit.txt"]);
    expect(result.report).toContain("+10");
    expect(await fx.read("limit.txt", "forklift/sync")).toBe("10\n");
  });

  it("do not let a check change the merge, or see any credentials", async () => {
    fx = await makeFixture({ "app.txt": "one\n" });
    await fx.configure(`verify:\n  - 'echo junk > app.txt; echo "$GH_TOKEN$ANTHROPIC_API_KEY" > leak.txt; test -z "$GH_TOKEN$ANTHROPIC_API_KEY"'\n`);
    await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");
    process.env.GH_TOKEN = "push-secret";
    process.env.ANTHROPIC_API_KEY = "model-key";
    let result;
    try {
      result = await sync();
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }

    expect(result.outcome).toBe("landed");
    expect(await fx.read("app.txt")).toBe("one\n");
    expect(await fx.read("leak.txt")).toBeNull();
  });
});

describe("status", () => {
  it("predicts what a sync would hit without touching anything", async () => {
    fx = await makeFixture({ "greeting.txt": "hello\n", "ci/build.yml": "v1\n", "app.txt": "one\n" });
    await fx.configure("drop: [ci/**]\n");
    await fx.forkCommit({ "greeting.txt": "hello from the fork\n", "ci/build.yml": null }, "fork: changes");
    await fx.commit(fx.upstream, { "app.txt": "two\n", "ci/build.yml": "v2\n" }, "upstream: safe");
    const culprit = await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");
    const head = await fx.remoteHead();

    const status = await runStatus({ cwd: fx.fork });

    expect(status.behind).toBe(2);
    expect(status.ahead).toBe(2);
    expect(status.prediction.byRule.drop.map((c) => c.path)).toEqual(["ci/build.yml"]);
    expect(status.prediction.open).toEqual([{ path: "greeting.txt", kind: "both-changed", stages: [1, 2, 3] }]);
    expect(status.blocker?.commit.sha).toBe(culprit);
    expect(status.hotFiles).toEqual([{ path: "greeting.txt", upstreamCommits: 1 }]);
    expect(await fx.remoteHead()).toBe(head);
  });
});
