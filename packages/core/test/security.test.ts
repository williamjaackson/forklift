import { generateKeyPairSync, createVerify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appJwt, credentialArgs } from "../src/auth.js";
import { loadContext } from "../src/context.js";
import { git } from "../src/git.js";
import { readHandoff } from "../src/handoff.js";
import { publish } from "../src/publish.js";
import { runBuildOnly, runPublishOnly, runSync } from "../src/sync.js";
import { makeFixture, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(async () => {
  await fx?.cleanup();
  delete process.env.GH_TOKEN;
});

const sync = () => runSync({ cwd: fx.fork });

/** A copy of `tree` with one file added or replaced, made without a checkout. */
async function treeWith(cwd: string, tree: string, file: string, content: string): Promise<string> {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(fx.root, `index-${Math.random()}`) };
  const blob = (await git(cwd, ["hash-object", "-w", "--stdin"], { input: content })).stdout.trim();
  await git(cwd, ["read-tree", tree], { env });
  await git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env });
  return (await git(cwd, ["write-tree"], { env })).stdout.trim();
}

describe("what the agent and the fork's commands cannot do to a merge", () => {
  it("a check cannot change the merge, even by staging its changes", async () => {
    fx = await makeFixture({ "app.txt": "one\n", "ci/build.yml": "v1\n" });
    await fx.configure(
      "drop: [ci/**]\nverify:\n  - 'mkdir -p ci && echo evil > ci/evil.yml && echo junk >> app.txt && rm new.txt && git add -A'\n",
    );
    await fx.forkCommit({ "ci/build.yml": null }, "fork: remove CI");
    await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");

    const result = await sync();

    expect(result.outcome).toBe("landed");
    expect(await fx.files()).toEqual(["app.txt", "forklift.yaml", "new.txt"]);
    expect(await fx.read("app.txt")).toBe("one\n");
  });

  it("a regenerate command can change the file it regenerates and nothing else", async () => {
    fx = await makeFixture({ "deps.txt": "a\n", "deps.lock": "v1\n" });
    await fx.configure(
      "regenerate:\n  deps.lock: 'echo regenerated > deps.lock; echo sneaky > extra.txt; echo tampered >> deps.txt'\n",
    );
    await fx.forkCommit({ "deps.lock": "fork\n" }, "fork: lock");
    await fx.commit(fx.upstream, { "deps.lock": "upstream\n" }, "upstream: lock");

    const result = await sync();

    expect(result.outcome).toBe("proposed");
    expect(await fx.read("deps.lock", "forklift/sync")).toBe("regenerated\n");
    expect(await fx.read("extra.txt", "forklift/sync")).toBeNull();
    expect(await fx.read("deps.txt", "forklift/sync")).toBe("a\n");
  });

  it("the agent cannot bring back a dropped path, change an owned file, or edit the rules", async () => {
    fx = await makeFixture({ "greeting.txt": "hello\n", "README.md": "Upstream\n", "ci/build.yml": "v1\n" });
    const agent = await fx.agent(
      "overreach",
      `fs.writeFileSync("greeting.txt", "resolved\\n");
       fs.mkdirSync("ci", { recursive: true });
       fs.writeFileSync("ci/evil.yml", "on: push\\n");
       fs.writeFileSync("README.md", "Rewritten by the agent\\n");
       fs.writeFileSync("forklift.yaml", "upstream: attacker/repo\\n");`,
    );
    await fx.forkCommit({ "greeting.txt": "hello from the fork\n", "README.md": "My Fork\n", "ci/build.yml": null }, "fork: changes");
    await fx.configure(`drop: [ci/**]\nours: [README.md]\nagent: ${agent}\n`);
    const rules = await fx.read("forklift.yaml");
    await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");

    const result = await sync();

    expect(result.outcome).toBe("proposed");
    expect(await fx.read("greeting.txt", "forklift/sync")).toBe("resolved\n");
    expect(await fx.read("ci/evil.yml", "forklift/sync")).toBeNull();
    expect(await fx.read("README.md", "forklift/sync")).toBe("My Fork\n");
    expect(await fx.read("forklift.yaml", "forklift/sync")).toBe(rules);
  });

  it("git settings planted by a command never run with the push token", async () => {
    fx = await makeFixture({ "app.txt": "one\n" });
    const seen = path.join(fx.root, "seen.txt");
    const hook = path.join(fx.root, "hook.sh");
    await fs.writeFile(hook, `#!/bin/sh\necho "token=[$GH_TOKEN]" >> ${seen}\n`, { mode: 0o755 });
    // The command makes git run a program of its choosing on later git calls.
    await fx.configure(`verify:\n  - git config core.fsmonitor ${hook}\n`);
    await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");
    process.env.GH_TOKEN = "push-secret";

    const result = await sync();

    expect(result.outcome).toBe("landed");
    const calls = await fs.readFile(seen, "utf8");
    // The planted program did run (so this test means something)…
    expect(calls).toContain("token=[]");
    // …and never where the token was.
    expect(calls).not.toContain("push-secret");
  });
});

describe("the publisher does not take the build's word for it", () => {
  const built = async () => {
    fx = await makeFixture({ "app.txt": "one\n", "ci/build.yml": "v1\n" });
    await fx.configure("drop: [ci/**]\n");
    await fx.forkCommit({ "ci/build.yml": null }, "fork: remove CI");
    await fx.commit(fx.upstream, { "new.txt": "theirs\n" }, "upstream: add new.txt");
    const out = path.join(fx.root, "build.bundle");
    await runBuildOnly({ cwd: fx.fork, out });
    const context = await loadContext({ cwd: fx.fork });
    const report = await readHandoff(fx.fork, out);
    return { context, report, forkHead: await fx.remoteHead() };
  };

  it("refuses to publish a build that breaks a rule", async () => {
    const { context, report, forkHead } = await built();
    report.merge!.build.tree = await treeWith(fx.fork, report.merge!.build.tree, "ci/evil.yml", "on: push\n");

    const result = await publish(context, report);

    expect(result.outcome).toBe("rejected");
    expect(result.breaches).toEqual(["ci/evil.yml was added, but matches `drop`."]);
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.remoteHead("forklift/sync")).toBeNull();
  });

  it("refuses a build that rewrites the fork's rules", async () => {
    const { context, report, forkHead } = await built();
    report.merge!.build.tree = await treeWith(fx.fork, report.merge!.build.tree, "forklift.yaml", "upstream: attacker/repo\n");

    const result = await publish(context, report);

    expect(result.outcome).toBe("rejected");
    expect(result.breaches).toEqual(["forklift.yaml was changed by the merge."]);
    expect(await fx.remoteHead()).toBe(forkHead);
  });

  it("sends a build to review when it contains a change git and the rules do not explain", async () => {
    const { context, report, forkHead } = await built();
    // The build says nothing needed judgement. Its tree says otherwise.
    report.merge!.build.tree = await treeWith(fx.fork, report.merge!.build.tree, "app.txt", "one\nslipped in\n");

    const result = await publish(context, report);

    expect(result.outcome).toBe("proposed");
    expect(result.judged).toEqual(["app.txt"]);
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(result.report).toContain("+slipped in");
  });

  it("refuses a build of something that is not upstream", async () => {
    const { context, report, forkHead } = await built();
    report.merge!.target = await fx.commit(fx.fork, { "rogue.txt": "x\n" }, "not upstream");

    const result = await publish(context, report);

    expect(result.outcome).toBe("rejected");
    expect(await fx.remoteHead()).toBe(forkHead);
  });
});

describe("building and publishing in separate places", () => {
  it("hands the build over as one file; only the publisher pushes", async () => {
    fx = await makeFixture({ "greeting.txt": "hello\n", "app.txt": "one\n" });
    const agent = await fx.agent("resolver", `fs.writeFileSync("greeting.txt", "hello, world, from the fork\\n"); console.log("merged both");`);
    await fx.forkCommit({ "greeting.txt": "hello from the fork\n" }, "fork: personalise greeting");
    await fx.configure(`agent: ${agent}\nland:\n  resolved: push\n`);
    const forkHead = await fx.remoteHead();
    const upstreamHead = await fx.commit(fx.upstream, { "greeting.txt": "hello, world\n" }, "upstream: reword greeting");
    const handoff = path.join(fx.root, "handoff", "fork.bundle");

    // The builder: its own clone, the agent, no part in publishing.
    const builder = path.join(fx.root, "builder");
    await git(fx.root, ["clone", "--quiet", fx.origin, builder]);
    await runBuildOnly({ cwd: builder, out: handoff });
    expect(await fx.remoteHead()).toBe(forkHead);
    expect(await fx.remoteHead("forklift/sync")).toBeNull();

    // The publisher: another clone that has never run the agent or the fork's code.
    const publisher = path.join(fx.root, "publisher");
    await git(fx.root, ["clone", "--quiet", "--bare", fx.origin, publisher]);
    const result = await runPublishOnly({ cwd: publisher, file: handoff });

    expect(result.outcome).toBe("landed");
    expect(result.judged).toEqual(["greeting.txt"]);
    expect(await fx.read("greeting.txt")).toBe("hello, world, from the fork\n");
    const head = (await git(fx.origin, ["log", "-1", "--format=%P|%an", "main"])).stdout.trim();
    expect(head).toBe(`${forkHead} ${upstreamHead}|forklift[bot]`);

    // Publishing the same file again changes nothing.
    const landed = await fx.remoteHead();
    const again = await runPublishOnly({ cwd: publisher, file: handoff });
    expect(again.outcome).toBe("waiting");
    expect(await fx.remoteHead()).toBe(landed);
  });
});

describe("acting as a GitHub App", () => {
  it("signs a token GitHub can verify with the App's public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const now = Date.UTC(2026, 0, 1);

    const [head, body, signature] = appJwt("12345", pem, now).split(".");

    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
    expect(claims.iss).toBe("12345");
    // GitHub rejects tokens valid for more than ten minutes.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBeLessThan(now / 1000);
    const valid = createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(valid).toBe(true);
  });

  it("offers a token to the fork's host and to no other", () => {
    const credentials = { kind: "app" as const, token: "ghs_secret123", identity: { name: "n", email: "e" } };
    const args = credentialArgs(credentials, "https://github.com/owner/fork.git");
    expect(args[1]).toBe("credential.https://github.com.helper=");
    expect(args[3]).toMatch(/^credential\.https:\/\/github\.com\.helper=!/);
    // The token itself is read from the environment, never put on a command line.
    expect(args.join(" ")).not.toContain(credentials.token);
    expect(credentialArgs(credentials, "git@github.com:owner/fork.git")).toEqual([]);
    expect(credentialArgs({ ...credentials, kind: "ambient", token: undefined }, "https://github.com/o/f.git")).toEqual([]);
  });
});
