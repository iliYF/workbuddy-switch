# 开发用 Makefile:存在上游 Go 网关源码时编译并集成 wb2api,再编译当前项目。
#
#   make gateway         编译并集成 wb2api(仅当上游源码 ../workbuddy2api 存在时可用)
#   make rust            cargo build --workspace(编译 Rust 服务端)
#   make web             npm run build(编译前端)
#   make build           默认目标 = gateway(如可用)+ rust + web
#   make dev             启动 Web UI 开发服务器(浏览器预览,HMR)
#   make demo            启动 Web UI 开发服务器(演示模式:只读 + 演示数据)
#   make app             编译桌面 App(先 apply-patch 再 tauri build Release + fix-app)
#
# 环境变量:
#   GATEWAY_BIN  网关托管目录,缺省 ~/.wb-switch/gateway/bin
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  桌面 App 签名密钥密码(make app 必需)

SHELL := /bin/sh

# wb2api 源码目录(与 workbuddy-switch 同级的 workbuddy2api)。
WB2API_SRC := $(CURDIR)/../workbuddy2api
# switch 托管网关二进制的目录(gateway_manage.rs 的 locate_gateway 在此扫描 wb2api*)。
GATEWAY_BIN ?= $(HOME)/.wb-switch/gateway/bin

# 平台后缀:Windows 用 .exe。
ifeq ($(shell uname -s),Windows)
  BIN := wb2api.exe
else
  BIN := wb2api
endif

# 仅在存在上游网关源码时启用网关编译目标;缺失时 make build 跳过网关。
HAVE_GATEWAY_SRC := $(wildcard $(WB2API_SRC)/cmd/server)
GATEWAY_TARGET := $(if $(HAVE_GATEWAY_SRC),gateway)

.PHONY: rust web build dev demo app
ifneq ($(HAVE_GATEWAY_SRC),)
.PHONY: wb2api wb2api-install gateway

## 编译 wb2api(Go,纯静态链接,与 workbuddy2api/dev.sh 同源)。
wb2api:
	cd "$(WB2API_SRC)" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$(BIN)" ./cmd/server
	@ls -lh "$(WB2API_SRC)/$(BIN)"

## 集成到当前项目:复制二进制到 switch 的网关托管目录。
wb2api-install: wb2api
	@mkdir -p "$(GATEWAY_BIN)"
	@cp "$(WB2API_SRC)/$(BIN)" "$(GATEWAY_BIN)/$(BIN)"
	@ls -lh "$(GATEWAY_BIN)/$(BIN)"

## 编译并集成 wb2api。
gateway: wb2api-install
endif

## 编译当前项目(Rust 服务端)。
rust:
	cargo build --workspace

## 编译当前项目(前端)。
web:
	npm run build

## 网关(如可用)再编译当前项目(默认目标)。
build: $(GATEWAY_TARGET) rust web

## 启动本地后端 + Web UI 开发服务器(一键开发,后端 57890,vite HMR;Ctrl+C 一起退出)。
## 前端在浏览器里 hasUnifiedTitleBar=false,顶部标题不显示(看标题需 make app)。
dev:
	@bash scripts/dev-web.sh

## 启动 Web UI 开发服务器(演示模式:只读前端 + 演示数据)。
demo:
	npm run dev:demo

## 编译桌面 App(先 apply-patch 应用 fork 身份/产品名,再 tauri build Release + fix-app)。
## 产物在 target/release/bundle/macos/WorkBuddy Switch.app;需先 export TAURI_SIGNING_PRIVATE_KEY_PASSWORD。
app:
	@bash scripts/apply-patch.sh
	@test -n "$$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" || { echo "错误: 请先 export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=…" >&2; exit 1; }
	npm run build:app:release
