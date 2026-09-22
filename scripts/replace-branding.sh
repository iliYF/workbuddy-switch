#!/bin/bash
# replace-branding.sh — 批量替换应用图标资源(Web UI / 桌面 / 托盘),不改任何代码。
#
# 用法:
#   bash scripts/replace-branding.sh           实际替换
#   bash scripts/replace-branding.sh -n        只打印将要做什么(dry-run)
#
# 把新图标按下面的命名放进仓库根目录的 branding/ 即可,脚本会复制到目标路径。
# 提供 tray-icon.png(36×36)时自动重新生成托盘的 tray-icon-template.rgba。
# 幂等:重复运行安全;缺失的源文件跳过并计数。

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BRANDING="$ROOT/branding"

# ── 映射表:branding/ 下源文件名 <TAB> 目标路径(仓库根相对) ──
# 用 tab 分隔的列表而非 bash 关联数组,兼容 macOS 自带的 bash 3.2。
MAPPING=$(cat <<'EOF'
favicon.png	public/icon.png
icon-transparent.png	public/icon-transparent.png
icon.png	src-tauri/icons/icon.png
icon-32.png	src-tauri/icons/32x32.png
icon-128.png	src-tauri/icons/128x128.png
icon-128@2x.png	src-tauri/icons/128x128@2x.png
icon.icns	src-tauri/icons/icon.icns
icon.ico	src-tauri/icons/icon.ico
tray-icon.png	src-tauri/icons/tray-icon-template.png
tray-icon.rgba	src-tauri/icons/tray-icon-template.rgba
EOF
)

DRY=0
case "${1:-}" in
  -n|--dry-run) DRY=1 ;;
  "") ;;
  *) echo "用法: bash scripts/replace-branding.sh [-n]" >&2; exit 1 ;;
esac

# 托盘 .rgba:把 36×36 PNG 解码成原始 RGBA(纯标准库,无第三方依赖)。
regen_tray_rgba() {
  [ "$DRY" -eq 1 ] && { echo "  将重新生成 src-tauri/icons/tray-icon-template.rgba"; return 0; }
  python3 - "$BRANDING/tray-icon.png" "$ROOT/src-tauri/icons/tray-icon-template.rgba" <<'PY' || return 1
import struct, sys, zlib

src, dst = sys.argv[1], sys.argv[2]
data = open(src, "rb").read()
assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{src}: 不是 PNG 文件"

# 解析 IHDR / 收集 IDAT
w = h = depth = ctype = None
idat = b""
pos = 8
while pos < len(data):
    length = struct.unpack(">I", data[pos:pos+4])[0]
    kind = data[pos+4:pos+8]
    chunk = data[pos+8:pos+8+length]
    pos += 12 + length
    if kind == b"IHDR":
        w, h, depth, ctype = struct.unpack(">IIBB", chunk[:10])
    elif kind == b"IDAT":
        idat += chunk
    elif kind == b"IEND":
        break
assert depth == 8, f"{src}: 仅支持 8 位 PNG"
assert (w, h) == (36, 36), f"{src}: 托盘图标必须是 36×36,当前 {w}×{h}"
channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
raw = zlib.decompress(idat)

# 还原 PNG 行滤波
stride = w * channels
px = bytearray()
prev = bytearray(stride)
p = 0
for _ in range(h):
    f = raw[p]; p += 1
    line = bytearray(raw[p:p+stride]); p += stride
    for i in range(stride):
        a = line[i-channels] if i >= channels else 0
        b = prev[i]
        c = prev[i-channels] if i >= channels else 0
        if f == 1: line[i] = (line[i] + a) & 0xff
        elif f == 2: line[i] = (line[i] + b) & 0xff
        elif f == 3: line[i] = (line[i] + (a + b) // 2) & 0xff
        elif f == 4:
            pv = a + b - c
            pa, pb, pc = abs(pv-a), abs(pv-b), abs(pv-c)
            pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
            line[i] = (line[i] + pr) & 0xff
    px += line
    prev = line

# 统一展开成 RGBA
rgba = bytearray()
for i in range(0, len(px), channels):
    r = px[i]
    g = px[i+1] if channels >= 3 else px[i]
    b = px[i+2] if channels >= 3 else px[i]
    a = px[i+3] if channels == 4 else (px[i+1] if channels == 2 else 255)
    rgba += bytes((r, g, b, a))
open(dst, "wb").write(bytes(rgba))
print(f"  生成 {dst} ({w}×{h})")
PY
}

# 资源目录不存在时提示期望的源文件名
if [ ! -d "$BRANDING" ]; then
  mkdir -p "$BRANDING"
  echo "已创建 $BRANDING(空目录)。请放入新图标,命名见脚本顶部映射表:"
  echo "  $(cut -f1 <<< "$MAPPING" | tr '\n' ' ')"
  exit 0
fi

copied=0; skipped=0
while IFS=$'\t' read -r src dst; do
  src_path="$BRANDING/$src"
  dst_path="$ROOT/$dst"
  if [ ! -f "$src_path" ]; then
    echo "跳过  $src(缺失)"
    skipped=$((skipped+1))
    continue
  fi
  if [ "$DRY" -eq 1 ]; then
    echo "将替换  $src → $dst"
  else
    mkdir -p "$(dirname "$dst_path")"
    cp "$src_path" "$dst_path"
    echo "替换  $src → $dst"
  fi
  copied=$((copied+1))
done <<< "$MAPPING"

# 托盘:提供了源图但没给 .rgba 时自动生成
if [ -f "$BRANDING/tray-icon.png" ] && [ ! -f "$BRANDING/tray-icon.rgba" ]; then
  echo "-- 托盘源图已更新,重新生成 .rgba --"
  if command -v python3 >/dev/null 2>&1; then
    regen_tray_rgba || echo "  警告: 生成失败,请提供 36×36 的 tray-icon.rgba"
  else
    echo "  警告: 未找到 python3,请手动提供 36×36 的 tray-icon.rgba"
  fi
fi

echo "完成:替换 $copied,跳过 $skipped"
