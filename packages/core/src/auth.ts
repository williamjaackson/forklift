import { createSign } from "node:crypto";
import fs from "node:fs/promises";
import { defaultIdentity, type Identity } from "./git.js";

/**
 * How Forklift reaches the fork's remote and GitHub, and who its commits and
 * pull requests are from.
 */
export interface Credentials {
  /**
   * `app`: a GitHub App installation. Pull requests and commits come from the
   *   App's own bot account, and the token expires within the hour.
   * `token`: a token from GH_TOKEN or GITHUB_TOKEN. Pull requests come from
   *   whoever owns the token.
   * `ambient`: whatever git and gh are already set up with on this machine.
   */
  kind: "app" | "token" | "ambient";
  token?: string;
  identity: Identity;
}

const API = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

const base64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** A short-lived token that proves "I am this GitHub App", signed with the App's private key. */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdated a minute to allow for clock drift; GitHub accepts at most ten minutes.
  const body = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${base64url(signature)}`;
}

async function api<T>(path: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${auth}`,
      "user-agent": "forklift",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as T;
}

async function appPrivateKey(): Promise<string | null> {
  const file = process.env.FORKLIFT_APP_PRIVATE_KEY_FILE;
  if (file) return fs.readFile(file, "utf8");
  // Environment files often cannot hold real newlines.
  return process.env.FORKLIFT_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? null;
}

const cache = new Map<string, { credentials: Credentials; expires: number }>();

async function appCredentials(appId: string, key: string, slug: string): Promise<Credentials> {
  const cached = cache.get(slug);
  // Leave enough life in the token for a long sync.
  if (cached && cached.expires - Date.now() > 20 * 60_000) return cached.credentials;

  const jwt = appJwt(appId, key);
  const installation =
    process.env.FORKLIFT_APP_INSTALLATION_ID ??
    String(
      (
        await api<{ id: number }>(`/repos/${slug}/installation`, jwt).catch((err: Error) => {
          throw new Error(`The GitHub App (id ${appId}) is not installed on ${slug}. ${err.message}`);
        })
      ).id,
    );
  const granted = await api<{ token: string; expires_at: string }>(
    `/app/installations/${installation}/access_tokens`,
    jwt,
    { method: "POST", body: { repositories: [slug.split("/")[1]] } },
  );

  let identity = defaultIdentity();
  if (!process.env.FORKLIFT_GIT_NAME && !process.env.FORKLIFT_GIT_EMAIL) {
    // The App's bot account, so GitHub shows its commits with the App's name and picture.
    const app = await api<{ slug: string }>("/app", jwt);
    const login = `${app.slug}[bot]`;
    const bot = await api<{ id: number }>(`/users/${encodeURIComponent(login)}`, granted.token);
    identity = { name: login, email: `${bot.id}+${login}@users.noreply.github.com` };
  }

  const credentials: Credentials = { kind: "app", token: granted.token, identity };
  cache.set(slug, { credentials, expires: Date.parse(granted.expires_at) });
  return credentials;
}

/** Work out how to act on `slug` ("owner/repo", or null when the fork is not on GitHub). */
export async function resolveCredentials(slug: string | null): Promise<Credentials> {
  const appId = process.env.FORKLIFT_APP_ID;
  if (appId && slug) {
    const key = await appPrivateKey();
    if (!key) {
      throw new Error("FORKLIFT_APP_ID is set, but neither FORKLIFT_APP_PRIVATE_KEY nor FORKLIFT_APP_PRIVATE_KEY_FILE is.");
    }
    return appCredentials(appId, key, slug);
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  return { kind: token ? "token" : "ambient", token, identity: defaultIdentity() };
}

/** Environment for the git and gh commands that reach the fork's remote. */
export function credentialEnv(credentials: Credentials): NodeJS.ProcessEnv {
  return credentials.token ? { ...process.env, GH_TOKEN: credentials.token } : process.env;
}

/**
 * git options that hand `credentials.token` to the fork's host, and to no
 * other. Empty when the machine's own git setup is used.
 */
export function credentialArgs(credentials: Credentials, remoteUrl: string | null): string[] {
  if (!credentials.token || !remoteUrl) return [];
  let origin: string;
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== "https:") return [];
    origin = url.origin;
  } catch {
    return [];
  }
  const helper = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; }; f`;
  // The empty value first drops any helper configured elsewhere for this host.
  return ["-c", `credential.${origin}.helper=`, "-c", `credential.${origin}.helper=${helper}`];
}
