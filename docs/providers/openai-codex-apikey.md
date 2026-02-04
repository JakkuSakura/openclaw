---
summary: "Use Codex API keys from ~/.codex with OpenClaw"
title: "OpenAI Codex (API key)"
---

# OpenAI Codex (API key)

OpenClaw can read the Codex CLI config and API key from `~/.codex` and expose it
as the `openai-codex-apikey` provider. This is separate from the **OAuth**
`openai-codex` provider.

## Requirements

- Codex CLI configured with `~/.codex/config.toml`
- An API key stored in `~/.codex/auth.json` (from `codex login`)

## How it works

OpenClaw reads:

- `model_provider` + `model` from `~/.codex/config.toml`
- `model_providers.<name>.base_url` and `wire_api` (if present)
- API key from `~/.codex/auth.json` (or the env key specified in the config)

It then registers a provider:

- Provider: `openai-codex-apikey`
- Model ref: `openai-codex-apikey/<model>`

## Example

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex-apikey/gpt-5.2-codex" },
    },
  },
}
```

## Differences from OAuth Codex

| Feature       | `openai-codex` (OAuth)                               | `openai-codex-apikey`           |
| ------------- | ---------------------------------------------------- | ------------------------------- |
| Auth          | ChatGPT OAuth                                        | API key in `~/.codex/auth.json` |
| Setup         | `openclaw models auth login --provider openai-codex` | `codex login`                   |
| Token refresh | Automatic                                            | Manual (update the auth file)   |

## Troubleshooting

### API key not found

Check that `~/.codex/auth.json` includes an API key:

```bash
codex auth status
```

### Model not recognized

Verify the configured model exists in Codex:

```bash
codex models list
```

### Restart required

If you update `~/.codex/config.toml` or `~/.codex/auth.json`, restart the gateway:

```bash
openclaw gateway restart
```
