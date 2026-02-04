import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCodexConfig, resolveCodexModelApi } from "./codex-config.js";

function writeCodexConfig(baseDir: string, content: string): void {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(baseDir, "config.toml"), content, "utf8");
}

function writeCodexAuth(baseDir: string, auth: Record<string, string>): void {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(baseDir, "auth.json"), JSON.stringify(auth, null, 2), "utf8");
}

describe("loadCodexConfig", () => {
  it("returns null when no codex files exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      expect(loadCodexConfig()).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previous;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads config, api key, and wire api from codex config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      writeCodexConfig(
        dir,
        [
          'model_provider = "tabcode"',
          'model = "gpt-5.2-codex"',
          "",
          "[model_providers.tabcode]",
          'name = "openai"',
          'base_url = "https://api.example.com/v1"',
          'wire_api = "responses"',
          "requires_openai_auth = true",
        ].join("\n"),
      );
      writeCodexAuth(dir, { OPENAI_API_KEY: "sk-test" });

      const cfg = loadCodexConfig();
      expect(cfg).not.toBeNull();
      expect(cfg?.providerId).toBe("tabcode");
      expect(cfg?.model).toBe("gpt-5.2-codex");
      expect(cfg?.baseUrl).toBe("https://api.example.com/v1");
      expect(cfg?.apiKey).toBe("sk-test");
      expect(resolveCodexModelApi(cfg!)).toBe("openai-responses-instructions");
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previous;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
