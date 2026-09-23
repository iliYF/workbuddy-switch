#!/bin/bash
# gen-manifest.sh — 收集签名更新包并生成 updater 版本清单(GitHub Actions build job)。
# 从 release.yaml 的 "Generate updater manifest" 步骤抽离,行为保持一致。
#
# 用法: sh scripts/gen-manifest.sh <target> <update_os> <update_arch> <update_archive_name> <update_bundle>
#
# 环境变量(由 workflow 注入):
#   GITHUB_REF_NAME    tag 名(如 v0.1.40),缺省从 src-tauri/Cargo.toml 读版本
#   GITHUB_REPOSITORY  owner/repo(用于拼接下载 URL)
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)

# ── 版本解析:tag 名 → 版本号;非数字 tag 时回退读 src-tauri/Cargo.toml ──
resolve_version() {
  local ver="${GITHUB_REF_NAME#v}"
  if ! [[ "$ver" =~ ^[0-9] ]]; then
    ver=$(grep '^version' src-tauri/Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/')
  fi
  echo "$ver"
}

# ── 定位签名更新包:windows 用固定文件名,mac 期望恰好一个 .app.tar.gz ──
locate_archive() {
  local bundle_dir="$1" ver="$2" os="$3"
  if [ "$os" = "windows" ]; then
    echo "$bundle_dir/workbuddy-switch_${ver}_x64-setup.exe"
    return 0
  fi
  local archive count
  archive=$(find "$bundle_dir" -maxdepth 1 -type f -name '*.app.tar.gz' | sort)
  count=$(printf '%s\n' "$archive" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "$count" != 1 ]; then
    echo "error: expected exactly 1 .app.tar.gz, found $count" >&2
    printf '%s\n' "$archive" >&2
    exit 1
  fi
  echo "$archive"
}

# ── 校验:签名包与 .sig 必须都存在 ──
verify_archive() {
  local archive="$1"
  if [ ! -f "$archive" ] || [ ! -f "$archive.sig" ]; then
    echo "error: missing signed updater archive ($archive)" >&2
    exit 1
  fi
}

# ── 收集:签名包 + .sig 复制进 dist-bin;windows 的安装包即更新包,统一走 update_archive_name ──
collect_archive() {
  local archive="$1" archive_name="$2" ver="$3" os="$4"
  cp "$archive" "dist-bin/$archive_name"
  cp "$archive.sig" "dist-bin/$archive_name.sig"
}

# ── 清单:调 gen-update-json.sh 生成 latest-*.json 并复制进 dist-bin ──
generate_manifest() {
  local ver="$1" os="$2" arch="$3" bundle_dir="$4"
  UPDATE_VERSION="$ver" UPDATE_OS="$os" UPDATE_ARCH="$arch" BUNDLE_DIR="$bundle_dir" UPDATE_ARCHIVE_NAME="$UPDATE_ARCHIVE_NAME" \
    sh "$SCRIPT_DIR/gen-update-json.sh" "${GITHUB_REPOSITORY%/*}" "${GITHUB_REPOSITORY#*/}"
  local manifest="$bundle_dir/latest-${os}-${arch}.json"
  test -f "$manifest"
  cp "$manifest" dist-bin/
}

# ── 主流程 ──────────────────────────────────────────────────────────
if [ "$#" -ne 5 ]; then
  echo "用法: sh scripts/gen-manifest.sh <target> <update_os> <update_arch> <update_archive_name> <update_bundle>" >&2
  exit 1
fi
TARGET=$1
UPDATE_OS=$2
UPDATE_ARCH=$3
UPDATE_ARCHIVE_NAME=$4
UPDATE_BUNDLE=$5

VER=$(resolve_version)
# update_archive_name 模板中的 {{version}} → 实际版本(矩阵里写占位符,版本在构建期解析)
UPDATE_ARCHIVE_NAME="${UPDATE_ARCHIVE_NAME//\{\{version\}\}/$VER}"
BUNDLE_DIR="target/$TARGET/release/bundle/$UPDATE_BUNDLE"
echo "updater bundle dir: $BUNDLE_DIR (version $VER)"
ls -la "$BUNDLE_DIR" || true

ARCHIVE=$(locate_archive "$BUNDLE_DIR" "$VER" "$UPDATE_OS")
verify_archive "$ARCHIVE"
collect_archive "$ARCHIVE" "$UPDATE_ARCHIVE_NAME" "$VER" "$UPDATE_OS"
generate_manifest "$VER" "$UPDATE_OS" "$UPDATE_ARCH" "$BUNDLE_DIR"
