import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Codex API key provider", () => {
  it("injects openai-codex-apikey when codex config is present", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-"));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      fs.writeFileSync(
        path.join(codexHome, "config.toml"),
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
        "utf8",
      );
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "sk-test" }, null, 2),
        "utf8",
      );

      const providers = await resolveImplicitProviders({ agentDir });
      const codex = providers["openai-codex-apikey"];
      expect(codex).toBeDefined();
      expect(codex?.baseUrl).toBe("https://api.example.com/v1");
      expect(codex?.apiKey).toBe("sk-test");
      expect(codex?.api).toBe("openai-responses-instructions");
      expect(codex?.models?.[0]?.id).toBe("gpt-5.2-codex");
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previous;
      }
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
