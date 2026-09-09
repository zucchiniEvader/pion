# 安全策略

## 支持版本

Pion 处于 0.x 阶段，只维护**最新发布版本**。请先用最新版本复现问题，再提交报告。

## 报告漏洞

**不要开公开 issue。** 请使用 GitHub 的私密漏洞报告：仓库 **Security → Report a vulnerability**（Security Advisories）。如果该入口不可用，也可以直接联系维护者。

报告里尽量包含：影响版本、复现步骤、实际影响、以及你判断的严重程度。我们会尽快回复并同步修复进展；修好后会在 Advisory 里公开致谢（除非你希望匿名）。

## 威胁模型与已知信任边界

Pion 是**本地优先**的桌面应用，不提供多租户或公网服务。以下边界是设计选择，不是漏洞；超出边界的报告我们会说明原因。

### 1. 本地文件是明文的，Pion 不加密

PI 的 session JSONL、项目里的 `.pion/kanban/events.jsonl`、`~/.pi` 下的配置，都是普通本地文件。任何能以你的用户身份读文件的进程都能读它们——Pion 不会、也不打算给它们加密。需要加密请用磁盘加密或文件权限。

### 2. 渲染进程不持有凭据

renderer 只能走白名单 IPC，参数是结构化数据；main 进程会按已知字段**重建** `agent.start` 参数，renderer 无法注入 `-e` 扩展或额外命令行参数。远程 runtime 的 token 只存在于 main 与 daemon 之间，不下发到 renderer。

### 3. 凭据存储

- 远程 runtime 的 token 用 Electron `safeStorage`（macOS 上由 Keychain 支撑）加密后写入 `<userData>/credentials.json`；系统加密不可用时**不落盘**。
- 远程 daemon 自己的 `~/.pion/daemon-config.json` 是 **0600 明文**，只靠文件权限保护。

### 4. 网络暴露：daemon 默认监听 `0.0.0.0`，且**没有 TLS**

`pion-daemon` 默认同时监听 TCP JSONL（默认 `4970`）和 WebSocket（默认 `4971`），绑定 `0.0.0.0`，靠握手时的 token 认证。它面向**内网自托管**：

- 不要把监听端口直接暴露到公网；需要跨网络访问时用 SSH 隧道、VPN 或反代加 TLS。
- 桌面端主动 dial-in 的连接同样只做 token 认证，不校验服务端证书。
- 防火墙放行与否由你自己决定，daemon 不会替你开口。

### 5. 二维码里带着 token

配对二维码的内容是 `pion://host:port?t=<token>`，token 明文在内。只在可信设备前展示，别截图外发。

### 6. Agent 子进程的启动方式

- `pi` 以参数数组 + `shell: false` 启动，环境变量经白名单过滤，不经过 shell 拼接。
- 不自动信任项目内的 resources；`pi update` 固定带 `--no-approve`。
- Pion 不会静默添加 `--approve`，也不会替 Agent 提权。

### 7. Agent 的权限就是你的 `pi` 的权限

Pion 只做界面，不额外提权、不额外隔离。Agent 能读写的文件、能执行的命令，等于你在同一个目录里直接跑 `pi` 的权限。**这也是为什么安装的社区扩展值得你先看一眼源码**——它们和 Agent 跑在同一个信任级别。

## 不在范围内

- 已经能在你机器上执行任意代码的攻击者。
- 物理访问、以及你自己安装的社区扩展 / prompt / skill 的行为。
- `pi` CLI 自身的漏洞——请报给上游项目。
- 未加密的本地文件被同用户其他进程读取（见 §1）。
