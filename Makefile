# 开发用 Makefile:编译 wb2api(上游 Go 网关)并集成到本机,再编译当前项目。
#
#   make wb2api          编译 ../workbuddy2api 的 Go 网关,产物在源码目录(wb2api)
#   make wb2api-install  把产物复制到 ~/.wb-switch/gateway/bin/(switch 托管目录)
#   make gateway         = wb2api + wb2api-install
#   make rust            cargo build --workspace(编译 Rust 服务端)
#   make web             npm run build(编译前端)
#   make build           默认目标 = gateway + rust + web
#
# 环境变量:
#   GATEWAY_BIN  网关托管目录,缺省 ~/.wb-switch/gateway/bin

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

.PHONY: wb2api wb2api-install gateway rust web build

## 编译 wb2api(Go,纯静态链接,与 workbuddy2api/dev.sh 同源)。
wb2api:
	@test -d "$(WB2API_SRC)/cmd/server" || { echo "未找到 wb2api 源码: $(WB2API_SRC)" >&2; exit 1; }
	cd "$(WB2API_SRC)" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$(BIN)" ./cmd/server
	@ls -lh "$(WB2API_SRC)/$(BIN)"

## 集成到当前项目:复制二进制到 switch 的网关托管目录。
wb2api-install: wb2api
	@mkdir -p "$(GATEWAY_BIN)"
	@cp "$(WB2API_SRC)/$(BIN)" "$(GATEWAY_BIN)/$(BIN)"
	@ls -lh "$(GATEWAY_BIN)/$(BIN)"

## 编译并集成 wb2api。
gateway: wb2api-install

## 编译当前项目(Rust 服务端)。
rust:
	cargo build --workspace

## 编译当前项目(前端)。
web:
	npm run build

## 编译并集成 wb2api,再编译当前项目(默认目标)。
build: gateway rust web
