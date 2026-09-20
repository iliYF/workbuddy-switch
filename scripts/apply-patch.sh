#!/bin/bash
# apply-patch.sh — 构建前把上游仓库身份替换为 fork 身份(零侵入:只改临时工作区,不落库)。
#
# 用法: sh scripts/apply-patch.sh
# 幂等:已应用过的目标打印 skip 并正常退出;重复运行安全。
# 还原: git checkout -- src-tauri/tauri.conf.json crates/wb-switch-core/src/modules/update.rs src/lib/update.ts package.json src/lib/server-base.ts crates/wb-switch-server/src/main.rs
#
# 变更内容(与 fork 仓库 iliYF/workbuddy-switch 配套):
#   src-tauri/tauri.conf.json        identifier → FORK_IDENTIFIER;更新源 → FORK_OWNER;pubkey → FORK_PUBKEY
#   crates/.../modules/update.rs     GITHUB_OWNER 常量 → FORK_OWNER(不碰旧 changexbc 迁移逻辑)
#   src/lib/update.ts                GITHUB_OWNER → FORK_OWNER
#   package.json                     build:app 密钥文件 → FORK_KEY_FILE;密码 → 读 $TAURI_SIGNING_PRIVATE_KEY_PASSWORD 环境变量(密码不落库)
#   src/lib/server-base.ts           API_BASE 端口 57890 → FORK_PORT(源码保持上游默认,构建产物用 fork 端口)
#   crates/.../main.rs               default_port() 57890 → FORK_PORT
set -euo pipefail

# fork 身份(保持与 fork 仓库一致)
FORK_IDENTIFIER="com.xstart.wbswitch"
FORK_OWNER="iliYF"
FORK_REPO="workbuddy-switch"
FORK_PUBKEY="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQzNEVGMDQwMDQyQjlCNUEKUldSYW15c0VRUEJPMCtLdytNSUYzOFYrTXVGS0lsOGV3R1E2T1hoWVp1TnJFVGYyblZtdTNFaHoK"
# 签名密钥文件名(与 ~/.wb-switch 下生成的密钥对配套;密码只在环境变量/Secret,不写进仓库)
FORK_KEY_FILE="wb-switch-gw.key"
# fork 端口:与网关默认端口 54321 相邻,避免与上游默认 57890 撞端口。
FORK_PORT="54320"

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

# 幂等替换: $1=文件 $2=旧值 $3=新值
# grep 用固定字符串探测;perl 用 \Q\E 转义 + {} 定界(base64 含 /)。
replace() {
  local file="$1" from="$2" to="$3"
  if [ ! -f "$file" ]; then
    echo "skip: 文件不存在 $file"
    return 0
  fi
  if grep -qF -- "$from" "$file"; then
    perl -pi -e "s{\Q$from\E}{$to}g" -- "$file"
    echo "patched: ${file#$ROOT/} :: ${from:0:40}... -> ${to:0:40}..."
  else
    echo "skip(已应用或未找到): ${file#$ROOT/} :: ${from:0:40}..."
  fi
}

replace "$ROOT/src-tauri/tauri.conf.json" "com.wbswitch.app" "$FORK_IDENTIFIER"
replace "$ROOT/src-tauri/tauri.conf.json" "github.com/changexbc/" "github.com/$FORK_OWNER/"
replace "$ROOT/src-tauri/tauri.conf.json" \
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYwNEU4RkQ5OEZCN0FGRApSV1Q5ZXZ1WS9lZ0VEd1VuVFpOYjU1OGJGd1NmMVhaWHJTSEdnNVRSSEcweUxWR05TN0h2WnloSwo=" \
  "$FORK_PUBKEY"
replace "$ROOT/crates/wb-switch-core/src/modules/update.rs" \
  'GITHUB_OWNER: &str = "changexbc"' "GITHUB_OWNER: &str = \"$FORK_OWNER\""
replace "$ROOT/src/lib/update.ts" \
  'GITHUB_OWNER = "changexbc"' "GITHUB_OWNER = \"$FORK_OWNER\""
replace "$ROOT/package.json" "wb-switch-updater.key" "$FORK_KEY_FILE"
# 密码改成读环境变量,不内嵌值(仓库里不出现密码;CI 用 Secret,本地用 export)
replace "$ROOT/package.json" \
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=wb-switch-dev" \
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?}'
# fork 端口:webui 前端地址与 server 默认端口都替换(源码保持上游 57890)。
replace "$ROOT/src/lib/server-base.ts" "http://127.0.0.1:57890" "http://127.0.0.1:$FORK_PORT"
replace "$ROOT/crates/wb-switch-server/src/main.rs" "57890" "$FORK_PORT"

echo "apply-patch done: $FORK_OWNER/$FORK_REPO, identifier=$FORK_IDENTIFIER"
