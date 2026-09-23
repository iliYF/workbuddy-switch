#!/bin/bash
# build-desktop-app.sh — Tauri 桌面 App 构建 + 打 dmg(GitHub Actions build job)。
# 从 release.yaml 的 "Build desktop app" 步骤抽离,行为保持一致。
#
# 用法: sh scripts/build-desktop-app.sh <target> <bundles> <update_arch>
#   target       rust target,如 aarch64-apple-darwin / x86_64-pc-windows-msvc
#   bundles      tauri --bundles 值:app / nsis / deb,appimage
#   update_arch  updater 架构标签:aarch64 / x86_64 / 空(linux)
#
# 环境变量(由 workflow 注入):
#   GITHUB_REF_NAME               tag 名(如 v0.1.40),缺省从 src-tauri/Cargo.toml 读版本
#   TAURI_SIGNING_PRIVATE_KEY     更新包签名私钥
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD 签名私钥密码
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

# ── tauri 构建:清掉旧产物再 build,避免旧安装包被带进 Release ──
build_app() {
  local target="$1" bundles="$2"
  local root="target/$target/release/bundle"
  # cargo cache 会保留旧 NSIS/DMG/AppImage;不清理就会把旧版本产物带进 Release。
  rm -rf "$root"
  npm run tauri -- build --target "$target" --bundles "$bundles" >&2
  # 日志走 stderr,stdout 只输出 root 路径(供命令替换捕获返回值)。
  echo "bundle after build:" >&2
  find "$root" -type f | sort >&2 || true
  echo "$root"
}

# ── nsis 校验:只允许当前版本安装包,防止旧 .exe 混入 ──
verify_nsis() {
  local root="$1" ver="$2"
  local stale
  stale=$(find "$root" -type f -name '*-setup.exe' ! -name "workbuddy-switch_${ver}_x64-setup.exe" || true)
  if [ -n "$stale" ]; then
    echo "error: stale Windows installer still present:" >&2
    printf '%s\n' "$stale" >&2
    exit 1
  fi
  test -f "$root/nsis/workbuddy-switch_${ver}_x64-setup.exe"
}

# ── 按扩展名从 INSTALLER_NAMES 取发布文件名,并把 {{version}} 替换为实际版本 ──
installer_target() {
  local ext="$1" ver="$2" n
  for n in "${INSTALLER_NAMES[@]}"; do
    if [[ "${n##*.}" == "$ext" ]]; then
      echo "${n//\{\{version\}\}/$ver}"
      return 0
    fi
  done
  return 1
}

# ── 收集安装包:dmg / exe / msi / deb / AppImage 按 INSTALLER_NAMES 命名复制进 dist-bin ──
collect_installers() {
  local root="$1"
  mkdir -p dist-bin
  find "$root" -type f \
    \( -name '*.dmg' -o -name '*.exe' -o -name '*.msi' -o -name '*.deb' \
    -o -name '*.AppImage' \) \
    -print0 | while IFS= read -r -d '' f; do
      local target
      target=$(installer_target "${f##*.}" "$VER") || continue
      cp "$f" "dist-bin/$target"
    done
}

# ── mac dmg:纯命令行打 dmg(CI 无 Finder,Tauri 自带的 bundle_dmg.sh 会失败)。
#    执行顺序:① 打 dmg(make-dmg.sh,上游原文件,生成 workbuddy-switch_<ver>_<arch>.dmg)
#             → ② 复制 dmg 到 dist-bin(加 gw 前缀区分上游产物)。
#    定制版个性化处理(如需改 dmg 内容/加校验文件)插在两步之间即可。 ──
build_macos_dmg() {
  local ver="$1" arch="$2" root="$3"
  sh "$SCRIPT_DIR/make-dmg.sh" "$ver" "$arch" "$root/macos/workbuddy-switch.app"
  # 发布名取 INSTALLER_NAMES 中 .dmg 那条(矩阵统一命名,含 {{version}} 占位)。
  local dmg_name
  dmg_name=$(installer_target "dmg" "$ver")
  cp "workbuddy-switch_${ver}_${arch}.dmg" "dist-bin/$dmg_name"
}

# ── 主流程 ──────────────────────────────────────────────────────────
if [ "$#" -ne 4 ]; then
  echo "用法: sh scripts/build-desktop-app.sh <target> <bundles> <update_arch> <installer_names>" >&2
  exit 1
fi
TARGET=$1
BUNDLES=$2
UPDATE_ARCH=$3
INSTALLER_NAMES_CSV=$4

# installer_names 逗号分隔(矩阵统一定义的发布文件名,含 {{version}} 占位;linux 有 deb+AppImage 两项)。
IFS=',' read -r -a INSTALLER_NAMES <<< "$INSTALLER_NAMES_CSV"

VER=$(resolve_version)
BUNDLE_ROOT=$(build_app "$TARGET" "$BUNDLES")

if [ "$BUNDLES" = "nsis" ]; then
  verify_nsis "$BUNDLE_ROOT" "$VER"
fi

collect_installers "$BUNDLE_ROOT"

if [ "$BUNDLES" = "app" ]; then
  build_macos_dmg "$VER" "$UPDATE_ARCH" "$BUNDLE_ROOT"
fi
