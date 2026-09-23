#!/usr/bin/env python3
"""生成 release 构建矩阵(GitHub Actions resolve-platforms job)。

从环境变量读取触发上下文,把选中平台的矩阵 JSON 写入 GITHUB_OUTPUT,
供下游 build job 的 strategy.matrix 消费。

环境变量:
  EVENT_NAME   github.event_name(tag push / workflow_dispatch)
  PLATFORM     workflow_dispatch 的平台选项(空或 all = 全平台)
  GITHUB_OUTPUT  GitHub Actions 输出文件路径
"""

from __future__ import annotations

import json
import os
import sys

ALL_PLATFORMS = [
    {
        "name": "macOS-arm64",
        "os": "macos-14",
        "target": "aarch64-apple-darwin",
        "cli_bin": "wb-switch-darwin-arm64",
        "platform_tag": "darwin-arm64",
        "bundles": "app",
        "update_os": "macos",
        "update_arch": "aarch64",
        "update_bundle": "macos",
        "update_archive_name": "xbuddy-switch_{{version}}_macos-aarch64.app.tar.gz",
        "installer_names": "xbuddy-switch_{{version}}_apple-arm64.dmg",
    },
    {
        "name": "macOS-x64",
        "os": "macos-14",
        "target": "x86_64-apple-darwin",
        "cli_bin": "wb-switch-darwin-x64",
        "platform_tag": "darwin-x64",
        "bundles": "app",
        "update_os": "macos",
        "update_arch": "x86_64",
        "update_bundle": "macos",
        "update_archive_name": "xbuddy-switch_{{version}}_macos-x86_64.app.tar.gz",
        "installer_names": "xbuddy-switch_{{version}}_intel-x64.dmg",
    },
    {
        "name": "win-x64",
        "os": "windows-latest",
        "target": "x86_64-pc-windows-msvc",
        "cli_bin": "wb-switch-win32-x64.exe",
        "platform_tag": "win32-x64",
        "bundles": "nsis",
        "update_os": "windows",
        "update_arch": "x86_64",
        "update_bundle": "nsis",
        "update_archive_name": "xbuddy-switch_{{version}}_windows-x86_64-setup.exe",
        "installer_names": "xbuddy-switch_{{version}}_windows-x86_64-setup.exe",
    },
    {
        "name": "linux-x64",
        "os": "ubuntu-24.04",
        "target": "x86_64-unknown-linux-gnu",
        "cli_bin": "wb-switch-linux-x64",
        "platform_tag": "linux-x64",
        "bundles": "deb,appimage",
        "update_arch": "",
        "installer_names": "xbuddy-switch_{{version}}_amd64.deb,xbuddy-switch_{{version}}_amd64.AppImage",
    },
]

# 平台选项标签 → 矩阵 name;Universal = Apple Silicon + Intel x64 两架构并行(非 fat 二进制)
FRIENDLY = {
    "macOS Apple Silicon": ["macOS-arm64"],
    "macOS Intel x64": ["macOS-x64"],
    "macOS Universal": ["macOS-arm64", "macOS-x64"],
}


def main() -> int:
    event = os.environ.get("EVENT_NAME", "")
    platform = (os.environ.get("PLATFORM") or "all").strip()
    if event != "workflow_dispatch" or platform in ("", "all"):
        selected = ALL_PLATFORMS
    else:
        names = FRIENDLY.get(platform, [platform])
        selected = [p for p in ALL_PLATFORMS if p["name"] in names]
        if not selected:
            print(f"unknown platform: {platform}", file=sys.stderr)
            return 1
    matrix = json.dumps({"include": selected})
    out = os.environ.get("GITHUB_OUTPUT", "")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("matrix<<EOF\n")
            f.write(matrix + "\n")
            f.write("EOF\n")
    else:
        # 本地测试:直接打印到 stdout
        print(matrix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
