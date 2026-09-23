#!/bin/bash
# apply-patch.sh — 构建前把上游仓库身份替换为定制身份(零侵入:只改临时工作区,不落库)。
#
# 用法: sh scripts/apply-patch.sh
# 幂等:已应用过的目标打印 skip 并正常退出;重复运行安全。
#
# 结构:
#   ① 替换对照:上游原始值(UPSTREAM_*) → 定制值,集中一处便于对比
#   ② 按功能域分组(WEB 前端 / DESKTOP 桌面 / SERVER 服务),每类一个数组 + patch_* 函数
# 还原(重置所有被补丁文件):
#   git checkout -- "${WEB_FILES[@]}" "${DESKTOP_FILES[@]}" "${SERVER_FILES[@]}"
set -euo pipefail

# ── ① 替换对照:上游原始值 → 定制值 ──
UPSTREAM_BUNDLE_ID="com.wbswitch.app"              # → $BUNDLE_ID
UPSTREAM_OWNER="changexbc"                         # → $GITHUB_OWNER
UPSTREAM_PUBKEY="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYwNEU4RkQ5OEZCN0FGRApSV1Q5ZXZ1WS9lZ0VEd1VuVFpOYjU1OGJGd1NmMVhaWHJTSEdnNVRSSEcweUxWR05TN0h2WnloSwo="  # → $UPDATER_PUBKEY
UPSTREAM_KEY_FILE="wb-switch-updater.key"          # → $SIGNING_KEY_FILE
UPSTREAM_PASSWORD="wb-switch-dev"                  # → 环境变量 TAURI_SIGNING_PRIVATE_KEY_PASSWORD
UPSTREAM_PORT="57890"                              # → $APP_PORT
UPSTREAM_PRODUCT="workbuddy-switch"                # → $PRODUCT_NAME
UPSTREAM_TITLE="workbuddy-switch · WorkBuddy 账号切换"  # → $PRODUCT_TITLE

# ── 定制值(替换目标)──
BUNDLE_ID="com.xstart.wbswitch"
GITHUB_OWNER="iliYF"
GITHUB_REPO="xbuddy-switch"
UPDATER_PUBKEY="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQzNEVGMDQwMDQyQjlCNUEKUldSYW15c0VRUEJPMCtLdytNSUYzOFYrTXVGS0lsOGV3R1E2T1hoWVp1TnJFVGYyblZtdTNFaHoK"
# 签名密钥文件名(与 ~/.wb-switch 下生成的密钥对配套;密码只在环境变量/Secret,不写进仓库)
SIGNING_KEY_FILE="wb-switch-gw.key"
# 定制端口:与网关默认端口 54321 相邻,避免与上游默认 57890 撞端口。
APP_PORT="54320"
# 产品名:显示在打包 .app 名/窗口/托盘/通知/侧栏。
PRODUCT_NAME="xBuddy Switch"
PRODUCT_TITLE="$PRODUCT_NAME · WorkBuddy 账号管理 + 兼容网关"
# 主二进制/exe 名:保持上游完整名 workbuddy-switch,现有自识别条件(匹配 workbuddy-switch/wb-switch)天然覆盖。
MAIN_BINARY="workbuddy-switch"

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

# ── ② 按功能域分组:变更文件集中声明 ──
# WEB:webui 前端(浏览器与桌面 webview 共用)——标题/API 地址/更新源/品牌/标题栏
WEB_FILES=(index.html src/lib/api.ts src/lib/update.ts src/App.tsx)
# DESKTOP:Tauri 桌面壳——身份/产品名/标题栏/托盘/通知/进程自识别/打包签名
DESKTOP_FILES=(
  src-tauri/tauri.conf.json
  src-tauri/src/tray.rs
  package.json
  scripts/fix-app.sh
  scripts/build-desktop-app.sh
  scripts/make-dmg.sh
  crates/wb-switch-core/src/modules/rotate.rs
)
# SERVER:本地服务——更新源身份、默认端口
SERVER_FILES=(
  crates/wb-switch-core/src/modules/update.rs
  crates/wb-switch-server/src/main.rs
)

# 幂等替换: $1=仓库相对路径 $2=旧值 $3=新值
# grep 用固定字符串探测;perl 用 \Q\E 转义 + {} 定界(base64 含 /)。
replace() {
  local file="$ROOT/$1" from="$2" to="$3"
  if [ ! -f "$file" ]; then
    echo "skip: 文件不存在 $1"
    return 0
  fi
  if grep -qF -- "$from" "$file"; then
    perl -pi -e "s{\Q$from\E}{$to}g" -- "$file"
    echo "patched: $1 :: ${from:0:40}... -> ${to:0:40}..."
  else
    echo "skip(已应用或未找到): $1 :: ${from:0:40}..."
  fi
}

# 预检:数组声明的文件都应存在(缺失即报错退出)。
check_files() {
  local type="$1"; shift
  for f in "$@"; do
    [ -f "$ROOT/$f" ] || { echo "error: 缺失文件 $type::$f" >&2; exit 1; }
  done
}

# ── WEB:webui 前端 ──
patch_web() {
  # 浏览器/桌面 webview 共用的页面标题
  replace index.html "$UPSTREAM_TITLE" "$PRODUCT_TITLE"
  # webui API 地址端口
  replace src/lib/api.ts "http://127.0.0.1:$UPSTREAM_PORT" "http://127.0.0.1:$APP_PORT"
  # 前端更新源 owner
  replace src/lib/update.ts "GITHUB_OWNER = \"$UPSTREAM_OWNER\"" "GITHUB_OWNER = \"$GITHUB_OWNER\""
  # 前端更新源仓库名(此前遗漏)
  replace src/lib/update.ts "GITHUB_REPO = \"$UPSTREAM_PRODUCT\"" "GITHUB_REPO = \"$GITHUB_REPO\""
  # 原生标题栏接管后,自绘拖拽区/Overlay 间距关闭;侧栏品牌同步
  replace src/App.tsx \
    'api.isDesktop() && typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh")' \
    'false'
  replace src/App.tsx "WorkBuddy Switch" "$PRODUCT_NAME"
  # 侧栏底部运行状态旁的名称(裸 "WorkBuddy" 文本节点),先替换完顶部品牌再处理,避免拆坏 "WorkBuddy Switch"。
  replace src/App.tsx ">WorkBuddy<" ">$PRODUCT_NAME<"
}

# ── DESKTOP:Tauri 桌面壳 ──
patch_desktop() {
  # tauri.conf.json:身份(bundle id/更新源/签名公钥)+ 产品名 + 原生标题栏
  replace src-tauri/tauri.conf.json "$UPSTREAM_BUNDLE_ID" "$BUNDLE_ID"
  # updater 端点完整替换:changexbc/workbuddy-switch/releases → iliYF/xbuddy-switch/releases
  replace src-tauri/tauri.conf.json "github.com/$UPSTREAM_OWNER/$UPSTREAM_PRODUCT/releases" "github.com/$GITHUB_OWNER/$GITHUB_REPO/releases"
  replace src-tauri/tauri.conf.json "github.com/$UPSTREAM_OWNER/" "github.com/$GITHUB_OWNER/"
  replace src-tauri/tauri.conf.json "$UPSTREAM_PUBKEY" "$UPDATER_PUBKEY"
  # 主二进制名独立于产品名(保持完整 workbuddy-switch),现有自识别条件天然覆盖,无需改 Rust。
  replace src-tauri/tauri.conf.json "\"productName\": \"$UPSTREAM_PRODUCT\"" \
    "\"productName\": \"$PRODUCT_NAME\",
  \"mainBinaryName\": \"$MAIN_BINARY\""
  replace src-tauri/tauri.conf.json "\"title\": \"$UPSTREAM_TITLE\"" "\"title\": \"$PRODUCT_TITLE\""
  # 原生可见标题栏(标题显示在系统标题栏,不依赖自绘),仅 macOS 定制版生效。
  replace src-tauri/tauri.conf.json '"titleBarStyle": "Overlay"' '"titleBarStyle": "Visible"'
  replace src-tauri/tauri.conf.json '"hiddenTitle": true' '"hiddenTitle": false'
  # 托盘 tooltip
  replace src-tauri/src/tray.rs "\"$UPSTREAM_PRODUCT\"" "\"$PRODUCT_NAME\""
  # package.json:签名密钥文件 + 密码改读环境变量(不内嵌;CI 用 Secret,本地 export)
  replace package.json "$UPSTREAM_KEY_FILE" "$SIGNING_KEY_FILE"
  replace package.json \
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$UPSTREAM_PASSWORD" \
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?}'
  # 本地 build:app 收尾 fix-app.sh 按 .app 目录名找包(CI 侧 make-dmg 走 ci 分支另行对齐)
  replace scripts/fix-app.sh "bundle/macos/$UPSTREAM_PRODUCT.app" "bundle/macos/$PRODUCT_NAME.app"
  # CI 打 dmg 的 .app 路径:包名随产品名变化,与 fix-app 同款处理(路径含空格,脚本内均双引号引用)
  replace scripts/build-desktop-app.sh "macos/$UPSTREAM_PRODUCT.app" "macos/$PRODUCT_NAME.app"
  replace scripts/make-dmg.sh "bundle/macos/$UPSTREAM_PRODUCT.app" "bundle/macos/$PRODUCT_NAME.app"
  # 桌面通知标题(core 组装 + 宿主兜底)
  replace crates/wb-switch-core/src/modules/rotate.rs \
    "ROTATE_NOTIFY_TITLE: &str = \"$UPSTREAM_PRODUCT\"" "ROTATE_NOTIFY_TITLE: &str = \"$PRODUCT_NAME\""
  replace crates/wb-switch-core/src/modules/rotate.rs \
    "assert_eq!(notify[\"title\"], json!(\"$UPSTREAM_PRODUCT\"))" "assert_eq!(notify[\"title\"], json!(\"$PRODUCT_NAME\"))"
}

# ── SERVER:本地服务(更新源身份/默认端口)──
patch_server() {
  replace crates/wb-switch-core/src/modules/update.rs \
    "GITHUB_OWNER: &str = \"$UPSTREAM_OWNER\"" "GITHUB_OWNER: &str = \"$GITHUB_OWNER\""
  # 服务端更新源仓库名(此前遗漏)
  replace crates/wb-switch-core/src/modules/update.rs \
    "GITHUB_REPO: &str = \"$UPSTREAM_PRODUCT\"" "GITHUB_REPO: &str = \"$GITHUB_REPO\""
  replace crates/wb-switch-server/src/main.rs "$UPSTREAM_PORT" "$APP_PORT"
}

# ── 主流程:预检文件齐全 → 按功能域逐个打补丁 ──
check_files WEB "${WEB_FILES[@]}"
check_files DESKTOP "${DESKTOP_FILES[@]}"
check_files SERVER "${SERVER_FILES[@]}"

patch_web
patch_desktop
patch_server

echo "apply-patch done: $GITHUB_OWNER/$GITHUB_REPO, identifier=$BUNDLE_ID, product=$PRODUCT_NAME"
