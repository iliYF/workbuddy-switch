#!/bin/bash
# 启动本地后端(wb-switch-server) + vite 前端,供开发调试。
# 用法: make dev(或直接 bash scripts/dev-web.sh)
# vite 退出(如 Ctrl+C)时自动清理后端进程。
set -u

PORT="${WB_SERVER_PORT:-57890}"

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

echo "启动后端 wb-switch-server(端口 $PORT)..."
# debug 构建自动启用 CORS(vite 1420 跨域),release 不带。
cargo run -p wb-switch-server -- --port "$PORT" &
SERVER_PID=$!

echo "等待后端就绪..."
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "错误: 后端进程异常退出" >&2
    exit 1
  fi
  if curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "错误: 后端未在 $PORT 就绪(编译可能超时,重试或检查输出)" >&2
  exit 1
fi
echo "后端就绪: http://127.0.0.1:$PORT"

echo "启动前端 vite(HMR)..."
npm run dev
