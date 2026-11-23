import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { HookConfig } from "./schema.js";

const execFileAsync = promisify(execFile);

export type AiProviderName = "anthropic" | "openai" | "claude" | "codex";

export interface ConflictLiftRequest {
  cwd: string;
  filePath: string;
  hooks: HookConfig[];
  baseContent: string | null;
  oursContent: string;
  theirsContent: string | null;
  conflictContent: string;
  upstreamCommits: string[];
  upstreamDeleted: boolean;
}

export interface ConflictLiftResult {
  content: string | null; // null means delete file
  summary: string;
  provider: string;
}

export interface VerifyRepairRequest {
  cwd: string;
  gateName: string;
  command: string;
  output: string;
  changedFiles: string[];
}

export interface VerifyRepairResult {
  fixed: boolean;
  summary: string;
  provider: string;
}

export interface AiRunner {
  readonly name: string;
  resolveConflict(req: ConflictLiftRequest): Promise<ConflictLiftResult>;
  repairVerification(req: VerifyRepairRequest): Promise<VerifyRepairResult>;
}

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

export function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (match?.[1] !== undefined) {
    return match[1] + "\n";
  }
  return text;
}

async function buildConflictPrompt(req: ConflictLiftRequest): Promise<string> {
  const hookDetails = await Promise.all(
    req.hooks.map(async (h) => {
      let specText = "";
      if (h.spec) {
        try {
          specText = `\nAdditional spec (${h.spec}):\n${await fs.readFile(path.join(req.cwd, h.spec), "utf8")}`;
        } catch {
          specText = "";
        }
      }
      return `- Hook "${h.id}": ${h.intent}${h.anchors?.length ? `\n  Anchors: ${h.anchors.join(", ")}` : ""}${specText}`;
    }),
  );

  const intentSection =
    hookDetails.length > 0
      ? `Declared fork hook intent for this file:\n${hookDetails.join("\n")}`
      : "No explicit hook was declared for this file. Preserve the fork's intentional modifications while cleanly adopting upstream's changes.";

  return [
    `You are Forklift, an intent-aware upstream sync engine resolving a single file conflict.`,
    `File: ${req.filePath}`,
    req.upstreamDeleted
      ? `NOTE: Upstream DELETED this file, while the fork modified it. Keep the file with fork changes unless upstream intentionally replaced it.`
      : "",
    "",
    intentSection,
    "",
    req.upstreamCommits.length > 0
      ? `Upstream commits touching this file:\n${req.upstreamCommits.map((c) => `  - ${c}`).join("\n")}`
      : "",
    "",
    "=== UPSTREAM BASE (last synced) ===",
    req.baseContent ?? "(file did not exist)",
    "",
    "=== FORK CURRENT (ours) ===",
    req.oursContent,
    "",
    "=== UPSTREAM TARGET (theirs) ===",
    req.theirsContent ?? "(file deleted upstream)",
    "",
    "=== 3-WAY MERGE OUTPUT WITH CONFLICT MARKERS ===",
    req.conflictContent,
    "",
    "INSTRUCTIONS:",
    "1. Produce the complete, final, cleanly merged contents of this file.",
    "2. Adopt all upstream improvements/refactors while faithfully preserving the fork's documented intent.",
    "3. Do NOT leave any git conflict markers (<<<<<<<, =======, >>>>>>>).",
    "4. Output ONLY the raw file contents with no explanation or surrounding prose.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function callAnthropic(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = json.content
    ?.filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("");
  if (!text) throw new Error("Anthropic API returned an empty response.");
  return text;
}

async function callOpenAI(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI API returned an empty response.");
  return text;
}

async function callClaudeCli(
  prompt: string,
  cwd: string,
  allowTools = false,
): Promise<string> {
  const args = ["-p", prompt];
  if (!allowTools) {
    args.push("--tools", "");
  }
  const { stdout } = await execFileAsync("claude", args, {
    cwd,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

async function callCodexCli(prompt: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("codex", ["exec", prompt], {
    cwd,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

export async function resolveDefaultProvider(
  explicit?: AiProviderName,
): Promise<AiProviderName> {
  const envChoice = process.env.FORKLIFT_AI as AiProviderName | undefined;
  const chosen = explicit ?? envChoice;
  if (chosen) return chosen;

  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (await commandExists("claude")) return "claude";
  if (await commandExists("codex")) return "codex";

  throw new Error(
    "No AI provider available. Set ANTHROPIC_API_KEY / OPENAI_API_KEY or install `claude` / `codex` CLI.",
  );
}

export async function createAiRunner(options?: {
  provider?: AiProviderName;
  model?: string;
}): Promise<AiRunner> {
  const provider = await resolveDefaultProvider(options?.provider);
  const model =
    options?.model ??
    process.env.FORKLIFT_MODEL ??
    (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1");

  return {
    name: provider,

    async resolveConflict(req: ConflictLiftRequest): Promise<ConflictLiftResult> {
      const prompt = await buildConflictPrompt(req);
      let raw: string;

      switch (provider) {
        case "anthropic":
          raw = await callAnthropic(prompt, model);
          break;
        case "openai":
          raw = await callOpenAI(prompt, model);
          break;
        case "claude":
          raw = await callClaudeCli(prompt, req.cwd, false);
          break;
        case "codex":
          raw = await callCodexCli(prompt, req.cwd);
          break;
      }

      const cleaned = stripMarkdownCodeFence(raw);
      if (CONFLICT_MARKER_RE.test(cleaned)) {
        throw new Error(
          `AI runner (${provider}) left unresolved conflict markers in ${req.filePath}.`,
        );
      }

      return {
        content: cleaned,
        summary:
          req.hooks.length > 0
            ? `Lifted hook(s) ${req.hooks.map((h) => h.id).join(", ")} via ${provider}`
            : `Resolved conflict via ${provider}`,
        provider,
      };
    },

    async repairVerification(
      req: VerifyRepairRequest,
    ): Promise<VerifyRepairResult> {
      const prompt = [
        `Forklift just synced upstream commits and verification gate "${req.gateName}" failed.`,
        `Command: ${req.command}`,
        `Changed files: ${req.changedFiles.slice(0, 40).join(", ")}`,
        "",
        "Failure output:",
        req.output.slice(-8000),
        "",
        "Fix ONLY the broken integration/types caused by the upstream sync. Do not disable tests or weaken types.",
      ].join("\n");

      if (provider === "claude") {
        await callClaudeCli(prompt, req.cwd, true);
        return {
          fixed: true,
          summary: `Attempted repair for "${req.gateName}" via claude CLI`,
          provider,
        };
      }

      if (provider === "codex") {
        await callCodexCli(prompt, req.cwd);
        return {
          fixed: true,
          summary: `Attempted repair for "${req.gateName}" via codex CLI`,
          provider,
        };
      }

      return {
        fixed: false,
        summary: `Automatic multi-file agent_fix requires a tool-enabled CLI runner (claude/codex); ${provider} API handles single-file hook conflicts.`,
        provider,
      };
    },
  };
}
