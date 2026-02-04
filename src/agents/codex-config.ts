import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelApi } from "../config/types.models.js";
import { resolveUserPath } from "../utils.js";

export type CodexProviderConfig = {
  name?: string;
  base_url?: string;
  env_key?: string;
  query_params?: Record<string, string | number | boolean>;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  requires_openai_auth?: boolean;
  wire_api?: "responses" | "completions";
};

export type CodexConfig = {
  codexHome: string;
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey?: string | null;
  headers: Record<string, string>;
  queryParams?: Record<string, string | number | boolean> | null;
  wireApi?: "responses" | "completions";
};

type TomlValue = string | number | boolean | TomlTable;
type TomlTable = { [key: string]: TomlValue };

function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseInlineTable(value: string): TomlTable {
  const result: TomlTable = {};
  const inner = value.trim().slice(1, -1).trim();
  if (!inner) return result;

  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "," && !inSingle && !inDouble) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);

  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const rawKey = part.slice(0, idx).trim();
    const key = unquote(rawKey);
    const val = part.slice(idx + 1).trim();
    result[key] = parseValue(val);
  }

  return result;
}

function parseValue(value: string): TomlValue {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseInlineTable(trimmed);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseToml(input: string): TomlTable {
  const result: TomlTable = { model_providers: {} };
  let currentProvider: string | null = null;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const section = line.slice(1, -1).trim();
      if (section.startsWith("model_providers.")) {
        const providerId = section.slice("model_providers.".length);
        currentProvider = providerId;
        const providers = result.model_providers as TomlTable;
        if (!providers[providerId]) providers[providerId] = {};
      } else {
        currentProvider = null;
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = parseValue(line.slice(eq + 1));

    if (currentProvider) {
      const providers = result.model_providers as TomlTable;
      const provider = providers[currentProvider] as TomlTable;
      provider[key] = value;
    } else {
      result[key] = value;
    }
  }

  return result;
}

function readJsonIfExists(filePath: string): Record<string, string> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME;
  if (configured?.trim()) {
    return resolveUserPath(configured);
  }
  return resolveUserPath(path.join(os.homedir(), ".codex"));
}

function resolveBaseUrl(
  providerId: string,
  providerConfig: CodexProviderConfig,
): string | undefined {
  if (providerConfig.base_url) return providerConfig.base_url;
  if (providerId === "openai") return "https://api.openai.com/v1";
  return undefined;
}

function resolveRequiresOpenaiAuth(
  providerId: string,
  providerConfig: CodexProviderConfig,
): boolean {
  if (typeof providerConfig.requires_openai_auth === "boolean") {
    return providerConfig.requires_openai_auth;
  }
  return providerId === "openai";
}

function resolveApiKey(
  requiresOpenaiAuth: boolean,
  envKey: string | null,
  auth: Record<string, string>,
): string | null {
  if (envKey) {
    return process.env[envKey] || auth[envKey] || null;
  }
  if (requiresOpenaiAuth) {
    return process.env.OPENAI_API_KEY || auth.OPENAI_API_KEY || auth._OPENAI_API_KEY || null;
  }
  return process.env.OPENAI_API_KEY || auth.OPENAI_API_KEY || auth._OPENAI_API_KEY || null;
}

function applyQueryParams(
  baseUrl: string,
  queryParams?: Record<string, string | number | boolean> | null,
): string {
  if (!queryParams || Object.keys(queryParams).length === 0) return baseUrl;
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function loadCodexConfig(): CodexConfig | null {
  const codexHome = resolveCodexHome();
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const hasConfig = fs.existsSync(configPath);
  const hasAuth = fs.existsSync(authPath);
  if (!hasConfig && !hasAuth) {
    return null;
  }

  const auth = readJsonIfExists(authPath) ?? {};
  const config: TomlTable = hasConfig
    ? parseToml(fs.readFileSync(configPath, "utf8"))
    : { model_providers: {} };

  const providerId = (config.model_provider as string | undefined) ?? "openai";
  const model = (config.model as string | undefined) ?? "gpt-5-codex";
  const providerTable = (config.model_providers as TomlTable | undefined) ?? {};
  const providerConfig = providerTable[providerId] as CodexProviderConfig | undefined;
  const selectedProvider = providerConfig ?? {};

  const baseUrl = resolveBaseUrl(providerId, selectedProvider);
  const requiresOpenaiAuth = resolveRequiresOpenaiAuth(providerId, selectedProvider);
  const envKey = selectedProvider.env_key ?? (requiresOpenaiAuth ? "OPENAI_API_KEY" : null);
  const apiKey = resolveApiKey(requiresOpenaiAuth, envKey, auth);

  const headers: Record<string, string> = { ...(selectedProvider.http_headers ?? {}) };
  const envHeaders = selectedProvider.env_http_headers ?? {};
  for (const [header, envVar] of Object.entries(envHeaders)) {
    const value = process.env[envVar];
    if (value && value.trim()) headers[header] = value;
  }

  return {
    codexHome,
    providerId,
    model,
    baseUrl: baseUrl ? applyQueryParams(baseUrl, selectedProvider.query_params ?? null) : undefined,
    apiKey,
    headers,
    queryParams: selectedProvider.query_params ?? null,
    wireApi: selectedProvider.wire_api,
  };
}

export function resolveCodexModelApi(config: CodexConfig): ModelApi {
  if (config.wireApi === "responses") {
    return "openai-responses-instructions";
  }
  if (config.wireApi === "completions") {
    return "openai-completions";
  }
  return config.model.toLowerCase().includes("codex") ? "openai-responses" : "openai-completions";
}
