import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import { requireApiKey, resolveAwsSdkEnvVarName, resolveModelAuthMode } from "./model-auth.js";

describe("resolveAwsSdkEnvVarName", () => {
  it("prefers bearer token over access keys and profile", () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("uses access keys when bearer token is missing", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_ACCESS_KEY_ID");
  });

  it("uses profile when no bearer token or access keys exist", () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_PROFILE");
  });

  it("returns undefined when no AWS auth env is set", () => {
    expect(resolveAwsSdkEnvVarName({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("resolveApiKeyForProvider", () => {
  it("reads Codex API key for openai-codex-apikey", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-"));

    try {
      process.env.CODEX_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, "auth.json"),
        `${JSON.stringify({ OPENAI_API_KEY: "sk-test-codex" }, null, 2)}
`,
        "utf8",
      );

      vi.resetModules();
      const { resolveEnvApiKey } = await import("./model-auth.js");

      const resolved = resolveEnvApiKey("openai-codex-apikey");
      expect(resolved?.apiKey).toBe("sk-test-codex");
      expect(resolved?.source).toContain("codex:");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts legacy Z_AI_API_KEY for zai", async () => {
    const previousZai = process.env.ZAI_API_KEY;
    const previousLegacy = process.env.Z_AI_API_KEY;

    try {
      delete process.env.ZAI_API_KEY;
      process.env.Z_AI_API_KEY = "zai-test-key";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const resolved = await resolveApiKeyForProvider({
        provider: "zai",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("zai-test-key");
      expect(resolved.source).toContain("Z_AI_API_KEY");
    } finally {
      if (previousZai === undefined) {
        delete process.env.ZAI_API_KEY;
      } else {
        process.env.ZAI_API_KEY = previousZai;
      }
      if (previousLegacy === undefined) {
        delete process.env.Z_AI_API_KEY;
      } else {
        process.env.Z_AI_API_KEY = previousLegacy;
      }
    }
  });

  it("resolves Synthetic API key from env", async () => {
    const previousSynthetic = process.env.SYNTHETIC_API_KEY;

    try {
      process.env.SYNTHETIC_API_KEY = "synthetic-test-key";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const resolved = await resolveApiKeyForProvider({
        provider: "synthetic",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("synthetic-test-key");
      expect(resolved.source).toContain("SYNTHETIC_API_KEY");
    } finally {
      if (previousSynthetic === undefined) {
        delete process.env.SYNTHETIC_API_KEY;
      } else {
        process.env.SYNTHETIC_API_KEY = previousSynthetic;
      }
    }
  });

  it("resolves Vercel AI Gateway API key from env", async () => {
    const previousGatewayKey = process.env.AI_GATEWAY_API_KEY;

    try {
      process.env.AI_GATEWAY_API_KEY = "gateway-test-key";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const resolved = await resolveApiKeyForProvider({
        provider: "vercel-ai-gateway",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("gateway-test-key");
      expect(resolved.source).toContain("AI_GATEWAY_API_KEY");
    } finally {
      if (previousGatewayKey === undefined) {
        delete process.env.AI_GATEWAY_API_KEY;
      } else {
        process.env.AI_GATEWAY_API_KEY = previousGatewayKey;
      }
    }
  });

  it("prefers Bedrock bearer token over access keys and profile", async () => {
    const previous = {
      bearer: process.env.AWS_BEARER_TOKEN_BEDROCK,
      access: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
      profile: process.env.AWS_PROFILE,
    };

    try {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.AWS_ACCESS_KEY_ID = "access-key";
      process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
      process.env.AWS_PROFILE = "profile";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const resolved = await resolveApiKeyForProvider({
        provider: "amazon-bedrock",
        store: { version: 1, profiles: {} },
        cfg: {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                auth: "aws-sdk",
                models: [],
              },
            },
          },
        } as never,
      });

      expect(resolved.mode).toBe("aws-sdk");
      expect(resolved.apiKey).toBeUndefined();
      expect(resolved.source).toContain("AWS_BEARER_TOKEN_BEDROCK");
    } finally {
      if (previous.bearer === undefined) {
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      } else {
        process.env.AWS_BEARER_TOKEN_BEDROCK = previous.bearer;
      }
      if (previous.access === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = previous.access;
      }
      if (previous.secret === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
      }
      if (previous.profile === undefined) {
        delete process.env.AWS_PROFILE;
      } else {
        process.env.AWS_PROFILE = previous.profile;
      }
    }
  });

  it("prefers Bedrock access keys over profile", async () => {
    const previous = {
      bearer: process.env.AWS_BEARER_TOKEN_BEDROCK,
      access: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
      profile: process.env.AWS_PROFILE,
    };

    try {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      process.env.AWS_ACCESS_KEY_ID = "access-key";
      process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
      process.env.AWS_PROFILE = "profile";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const resolved = await resolveApiKeyForProvider({
        provider: "amazon-bedrock",
        store: { version: 1, profiles: {} },
        cfg: {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                auth: "aws-sdk",
                models: [],
              },
            },
          },
        } as never,
      });

      expect(resolved.mode).toBe("aws-sdk");
      expect(resolved.apiKey).toBeUndefined();
      expect(resolved.source).toContain("AWS_ACCESS_KEY_ID");
    } finally {
      if (previous.bearer === undefined) {
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      } else {
        process.env.AWS_BEARER_TOKEN_BEDROCK = previous.bearer;
      }
      if (previous.access === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = previous.access;
      }
      if (previous.secret === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
      }
      if (previous.profile === undefined) {
        delete process.env.AWS_PROFILE;
      } else {
        process.env.AWS_PROFILE = previous.profile;
      }
    }
  });

  it("uses Bedrock profile when access keys are missing", async () => {
    const previous = {
      bearer: process.env.AWS_BEARER_TOKEN_BEDROCK,
      access: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
      profile: process.env.AWS_PROFILE,
    };

    try {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      process.env.AWS_PROFILE = "profile";

      vi.resetModules();
      const { resolveApiKeyForProvider } = await import("./model-auth.js");

      const resolved = await resolveApiKeyForProvider({
        provider: "amazon-bedrock",
        store: { version: 1, profiles: {} },
        cfg: {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                auth: "aws-sdk",
                models: [],
              },
            },
          },
        } as never,
      });

      expect(resolved.mode).toBe("aws-sdk");
      expect(resolved.apiKey).toBeUndefined();
      expect(resolved.source).toContain("AWS_PROFILE");
    } finally {
      if (previous.bearer === undefined) {
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      } else {
        process.env.AWS_BEARER_TOKEN_BEDROCK = previous.bearer;
      }
      if (previous.access === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = previous.access;
      }
      if (previous.secret === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
      }
      if (previous.profile === undefined) {
        delete process.env.AWS_PROFILE;
      } else {
        process.env.AWS_PROFILE = previous.profile;
      }
    }
  });
});

describe("resolveModelAuthMode", () => {
  it("returns mixed when provider has both token and api key profiles", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:token": {
          type: "token",
          provider: "openai",
          token: "token-value",
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "api-key",
        },
      },
    };

    expect(resolveModelAuthMode("openai", undefined, store)).toBe("mixed");
  });

  it("returns aws-sdk when provider auth is overridden", () => {
    expect(
      resolveModelAuthMode(
        "amazon-bedrock",
        {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                models: [],
                auth: "aws-sdk",
              },
            },
          },
        },
        { version: 1, profiles: {} },
      ),
    ).toBe("aws-sdk");
  });

  it("returns aws-sdk for bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "aws-sdk",
    );
  });

  it("returns aws-sdk for aws-bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("aws-bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "aws-sdk",
    );
  });
});

describe("requireApiKey", () => {
  it("normalizes line breaks in resolved API keys", () => {
    const key = requireApiKey(
      {
        apiKey: "
 sk-test-abc
",
        source: "env: OPENAI_API_KEY",
        mode: "api-key",
      },
      "openai",
    );

    expect(key).toBe("sk-test-abc");
  });

  it("throws when no API key is present", () => {
    expect(() =>
      requireApiKey(
        {
          source: "env: OPENAI_API_KEY",
          mode: "api-key",
        },
        "openai",
      ),
    ).toThrow('No API key resolved for provider "openai"');
  });
});
