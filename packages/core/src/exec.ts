import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Standard output as bytes, for callers that parse binary data. */
  stdoutBytes: Buffer;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  timeoutMs?: number;
  /** Keep at most this many bytes of each stream (the tail). Default 20 MB. */
  maxBuffer?: number;
  /** Called with each chunk as it arrives, for live progress. */
  onOutput?: (chunk: string) => void;
}

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  toString(): string {
    return this.bytes().toString("utf8");
  }
}

/**
 * Run a program without a shell. Never rejects on a non-zero exit: callers
 * read `code`. Rejects only when the program cannot be started.
 */
export function run(cmd: string, args: string[], options: RunOptions): Promise<RunResult> {
  return spawnAndCollect(cmd, args, false, options);
}

/** Run a command line through `sh -c`. */
export function sh(command: string, options: RunOptions): Promise<RunResult> {
  return spawnAndCollect("sh", ["-c", command], true, options);
}

function spawnAndCollect(
  cmd: string,
  args: string[],
  ownGroup: boolean,
  options: RunOptions,
): Promise<RunResult> {
  const started = Date.now();
  const limit = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // Shell commands get their own process group so a timeout can stop
      // everything they started, not just the shell.
      detached: ownGroup,
    });

    const out = new TailBuffer(limit);
    const err = new TailBuffer(limit);
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (ownGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone.
      }
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 5000).unref();
      }, options.timeoutMs);
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      out.push(chunk);
      options.onOutput?.(chunk.toString("utf8"));
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      err.push(chunk);
      options.onOutput?.(chunk.toString("utf8"));
    });

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });

    // When a shell command finishes, nothing it started may keep running:
    // a process left behind would outlive the step it belonged to, and could
    // hold the output pipes open so the step never appears to end.
    if (ownGroup) child.on("exit", () => kill("SIGKILL"));

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const bytes = out.bytes();
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout: bytes.toString("utf8"),
        stdoutBytes: bytes,
        stderr: err.toString(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    if (options.input !== undefined && child.stdin) {
      // A child that exits without reading its stdin is not an error.
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });
}

/** Credentials that let a process push to the fork or call GitHub. */
const PUSH_CREDENTIALS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "FORKLIFT_APP_ID",
  "FORKLIFT_APP_PRIVATE_KEY",
  "FORKLIFT_APP_PRIVATE_KEY_FILE",
  "FORKLIFT_APP_INSTALLATION_ID",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
];

/** Credentials an agent needs, but the fork's own build and tests never do. */
const AGENT_CREDENTIALS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
];

function without(env: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of names) delete copy[name];
  // No credential helper and no prompts: git inside this process cannot push.
  copy.GIT_TERMINAL_PROMPT = "0";
  copy.GIT_CONFIG_COUNT = "1";
  copy.GIT_CONFIG_KEY_0 = "credential.helper";
  copy.GIT_CONFIG_VALUE_0 = "";
  return copy;
}

/*
 * The three environments below keep credentials out of the processes that
 * have no use for them. That stops a token from being handed to upstream's
 * code, logged by it, or picked up by a tool that looks for one.
 *
 * It is not isolation. Everything Forklift starts runs as the same user as
 * Forklift, and a program that sets out to find that user's credentials can
 * (through /proc, through files, through a git setting that runs later). The
 * boundary that holds is a separate machine or container for the step that
 * has the push credentials: see `forklift build` and `forklift publish`.
 */

/** For the agent: its own model credentials, and nothing that can push. */
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...without(process.env, PUSH_CREDENTIALS), ...extra };
}

/**
 * For the fork's own commands (regenerate, verify), and for every git
 * command Forklift runs in the directory where those commands and the agent
 * have been: no credentials of any kind.
 */
export function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...without(process.env, [...PUSH_CREDENTIALS, ...AGENT_CREDENTIALS]),
    CI: process.env.CI ?? "true",
    ...extra,
  };
}

/** Last `maxChars` of a command's output, cut at a line boundary. */
export function tail(text: string, maxChars: number): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(trimmed.length - maxChars);
  const newline = cut.indexOf("\n");
  return `… (earlier output cut)\n${newline >= 0 ? cut.slice(newline + 1) : cut}`;
}
