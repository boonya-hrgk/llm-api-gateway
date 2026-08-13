#!/usr/bin/env bash
# LLM API Gateway 启动示例
#
# 环境变量说明：
#   MASTER_KEY        必填，保护 /admin/* 与 Web 登录
#   VLLM_TARGET_URL   上游大模型服务地址（已运行的 vLLM OpenAI 兼容服务）
#   UPSTREAM_API_KEY  可选，若上游自身开启 api-key 鉴权则填此
#   DB_PATH           SQLite 路径（默认 /app/data/keys.db）
set -e

docker build -t llm-api-gateway .

docker run -d \
  --name llm-api-gateway \
  -p 9000:9000 \
  -e MASTER_KEY=change-me-master \
  -e VLLM_TARGET_URL=http://host.docker.internal:8000 \
  -e UPSTREAM_API_KEY=optional-upstream-key \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  llm-api-gateway

echo "网关已启动: http://localhost:9000  (管理界面)"
echo "查看日志: docker logs -f llm-api-gateway"
