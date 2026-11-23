import { z } from "zod";

export const UpstreamStrategySchema = z.enum(["squash", "merge"]).default("squash");

export const UpstreamSchema = z.object({
  repo: z
    .string()
    .min(1, "upstream.repo is required (e.g. 'pingdotgg/t3code' or a git URL)"),
  ref: z.string().min(1).default("main"),
  remote: z.string().min(1).default("upstream"),
  strategy: UpstreamStrategySchema,
});

export const SyncPrSchema = z
  .object({
    title: z.string().default("[Forklift] Sync upstream → {{target}}"),
    labels: z.array(z.string()).default(["forklift", "upstream-sync"]),
    draft_on_issue: z.boolean().default(true),
  })
  .default({});

export const SyncConfigSchema = z
  .object({
    schedule: z.enum(["manual", "daily", "weekly", "on-release"]).default("daily"),
    branch_prefix: z.string().default("forklift/sync/"),
    pr: SyncPrSchema,
  })
  .default({});

export const GeneratedPathRuleSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  run: z.string().min(1),
  triggers: z.array(z.string().min(1)).optional(),
});

export const PathsPolicySchema = z
  .object({
    owned: z.array(z.string().min(1)).default([]),
    dropped: z.array(z.string().min(1)).default([]),
    generated: z.array(GeneratedPathRuleSchema).default([]),
  })
  .default({});

export const HookSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "hook.id must be lowercase kebab/snake-case"),
  paths: z.array(z.string().min(1)).min(1),
  anchors: z.array(z.string().min(1)).optional(),
  intent: z.string().min(1, "hook.intent must describe what this fork change does"),
  spec: z.string().min(1).optional(),
  review: z.enum(["auto", "always"]).default("auto"),
});

export const BrandLeakRuleSchema = z
  .object({
    id: z.string().min(1),
    literal: z.string().min(1).optional(),
    match: z.string().min(1).optional(),
    case_sensitive: z.boolean().default(false),
    replace: z.string().optional(),
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
    mode: z.enum(["autofix", "error", "warn"]).default("error"),
  })
  .superRefine((rule, ctx) => {
    if (!rule.literal && !rule.match) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `brand_leaks rule "${rule.id}" must specify either "literal" or "match"`,
      });
    }
    if (rule.literal && rule.match) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `brand_leaks rule "${rule.id}" cannot specify both "literal" and "match"`,
      });
    }
    if (rule.mode === "autofix" && rule.replace === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `brand_leaks rule "${rule.id}" has mode "autofix" and requires a "replace" value`,
      });
    }
    if (rule.match) {
      try {
        new RegExp(rule.match, rule.case_sensitive ? "g" : "gi");
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `brand_leaks rule "${rule.id}" has invalid regex: ${(err as Error).message}`,
        });
      }
    }
  });

export const BrandLeaksConfigSchema = z
  .object({
    exclude: z
      .array(z.string().min(1))
      .default([
        "forklift.yaml",
        "forklift.lock",
        "**/*.lock",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
      ]),
    rules: z.array(BrandLeakRuleSchema).default([]),
  })
  .default({});

export const GuardrailsSchema = z
  .object({
    touchpoints: z
      .object({
        mode: z.enum(["off", "warn", "error"]).default("warn"),
      })
      .default({}),
    brand_leaks: BrandLeaksConfigSchema,
  })
  .default({});

export const VerifyGateSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  agent_fix: z.boolean().default(false),
});

export const ForkliftManifestSchema = z
  .object({
    version: z.literal(1),
    upstream: UpstreamSchema,
    sync: SyncConfigSchema,
    paths: PathsPolicySchema,
    hooks: z.array(HookSchema).default([]),
    guardrails: GuardrailsSchema,
    verify: z.array(VerifyGateSchema).default([]),
  })
  .superRefine((manifest, ctx) => {
    const seenHookIds = new Set<string>();
    for (const hook of manifest.hooks) {
      if (seenHookIds.has(hook.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate hook id "${hook.id}"`,
        });
      }
      seenHookIds.add(hook.id);
    }

    const seenRuleIds = new Set<string>();
    for (const rule of manifest.guardrails.brand_leaks.rules) {
      if (seenRuleIds.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate brand_leaks rule id "${rule.id}"`,
        });
      }
      seenRuleIds.add(rule.id);
    }
  });

export const ForkliftLockSchema = z.object({
  version: z.literal(1),
  upstream: z.object({
    repo: z.string().min(1),
    ref: z.string().min(1),
    sha: z.string().min(7, "upstream.sha must be a valid git commit SHA"),
    synced_at: z.string().min(1),
  }),
});

export type ForkliftManifest = z.infer<typeof ForkliftManifestSchema>;
export type ForkliftLock = z.infer<typeof ForkliftLockSchema>;
export type HookConfig = z.infer<typeof HookSchema>;
export type BrandLeakRule = z.infer<typeof BrandLeakRuleSchema>;
export type GeneratedPathRule = z.infer<typeof GeneratedPathRuleSchema>;
export type VerifyGate = z.infer<typeof VerifyGateSchema>;
