# AI 网关代理配置

支持CC Switch ，同理 应该也支持CC GUI。

代理地址：http://127.0.0.1:9000

## 本地代理ollama服务

```{
  "codemossProviderId": "363b6fc7-5507-474c-b11c-92ea50694387",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-vTQu4HfpLWOQFOUly3Oy_arRMj7jQAEK",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9000",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen3:8b-nothink",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen3:8b-nothink",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3:8b-nothink",
    "ANTHROPIC_MODEL": "qwen3:8b",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "extraKnownMarketplaces": {
    "anthropic-agent-skills": {
      "source": {
        "repo": "anthropics/skills",
        "source": "github"
      }
    }
  },
  "theme": "dark"
}
```

## 本地代理deepseek服务

```{
  "codemossProviderId": "363b6fc7-5507-474c-b11c-92ea50694388",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-vTQu4HfpLWOQFOUly3Oy_arRMj7jQAEK",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9000",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "extraKnownMarketplaces": {
    "anthropic-agent-skills": {
      "source": {
        "repo": "anthropics/skills",
        "source": "github"
      }
    }
  },
  "theme": "dark"
}
```