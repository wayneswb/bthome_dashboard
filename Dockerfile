# syntax=docker/dockerfile:1

# ---- 构建阶段：只在这里保留编译工具 ----
FROM python:3.12-alpine AS builder

RUN apk add --no-cache build-base

WORKDIR /build
COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir=/wheels -r requirements.txt

# ---- 运行阶段：只保留 Python 运行时和依赖 ----
FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --no-compile \
        --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels \
    && python -m pip uninstall -y pip \
    && rm -rf /usr/local/lib/python3.12/ensurepip

COPY server.py ./
COPY public ./public
RUN mkdir -p /app/data

EXPOSE 8000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"

CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8000"]
