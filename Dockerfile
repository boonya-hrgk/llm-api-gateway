FROM python:3.11-slim

WORKDIR /app

# 安装依赖（单独一层利用缓存）
COPY proxy/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝代理代码
COPY proxy/ .

# 数据目录（SQLite 持久化）
RUN mkdir -p /app/data

ENV PROXY_HOST=0.0.0.0 \
    PROXY_PORT=9000 \
    DB_PATH=/app/data/keys.db

EXPOSE 9000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9000"]
