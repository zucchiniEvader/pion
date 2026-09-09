<div align="center">
  <img src="assets/pion-logo.png" alt="Pion" width="96" />
  <h1>Pion</h1>
  <p><strong>PI 的本地桌面 GUI —— 原生、零私货、只做界面。</strong></p>
  <p>
    <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-black" />
    <img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
    <img alt="status" src="https://img.shields.io/badge/remote%20runtime-beta-orange" />
  </p>
</div>

Pion 给 [PI](https://pi.dev) 套了一层桌面界面，但**不替代 PI、不重写 Agent Runtime、不发明自己的 Agent 行为**。

- **原生 PI**：通过 `pi --mode rpc` 驱动，不解析 TUI 屏幕，不改 PI 的运行方式。
- **零私货**：不自带作者自己的 prompt、skill 或 extension。你机器上装了哪些社区扩展、模板和 skill，Pion 就渲染哪些——同一个 PI 环境，只是多了一个窗口。
- **历史就是 PI 的历史**：PI 的 session JSONL 是对话唯一真相来源，Pion 不建第二份 transcript 库，卸载后你的数据原样留在 PI 里。

<div align="center">
  <img src="assets/screenshot.png" alt="Pion 界面：侧边栏项目与会话、主区对话流、底部输入框与模型选择" width="880" />
</div>

## 现在能做什么

- **多会话工作台**：项目 → 会话列表，最多 4 个 runtime 池化复用，流式输出、思考过程、工具调用卡片（参数与结果可展开）、截图直接粘贴、运行中 steer / abort。
- **社区扩展原生适配**：见下表。未识别的工具走通用卡片，不白屏、不丢事件。
- **扩展 UI 响应**：扩展弹出的 select / confirm / input / notify 以原生卡片呈现，直接点选即可。
- **Slash 命令补全**：输入 `/` 列出你已安装的扩展命令、prompt 模板和 skill，来源一目了然。
- **模型与思考等级**：直接读 PI 的模型目录，会话内随时切换。
- **Git 上下文**：查看分支与 worktree、一键创建 worktree、在 Finder / Ghostty / VS Code 中打开项目。
- **设置中心**：界面语言（中文 / English）、主题（跟随系统 / 浅色 / 深色）、Providers（读取 `~/.pi/agent/models.json`，可设默认模型）、检查并更新 PI 与扩展、Runtimes 管理。
- **崩溃可恢复**：PI 意外退出时，会话可一键恢复。

## 社区扩展适配

适配列表跟随你本地已安装的社区扩展持续补齐，目前已完成：

| 扩展 | 在 Pion 里的表现 |
| --- | --- |
| `@juicesharp/rpiv-todo` | 输入框上方的任务面板，实时跟随当前会话的 todo 快照 |
| `@narumitw/pi-plan-mode` | `plan_mode_question` / `plan_mode_complete` 专属卡片，`/plan` 状态提示与流程 |
| `@narumitw/pi-goal` | `/goal` 命令与 `goal_complete` / `goal_blocked` / `goal_wait` 工具正常可用 |
| 其他扩展 | 通用工具卡，参数与结果可展开；不识别也不会丢事件 |

## 任务看板（可选）

把任务从「想到」推到「做完」的一条闭环：**建卡 → 派发给 Agent → Agent 执行并回报 → 自动进入 Review → 你审核 Done / Reopen**。卡片与执行状态写在项目自己的 `.pion/kanban/events.jsonl` 事件日志里，终端里跑 `pi` 也能读写同一块看板。

看板是**可选功能**：不用就不向你的项目写入任何文件，也可以随时从侧边栏关闭看板视图。

## Remote runtime（Beta）

在另一台机器上装一个 `pion-daemon`，就能把它的项目接进 Pion，像本地项目一样用会话、流式输出和看板。支持配对码、手动 host/port/token，以及给移动客户端扫码连接（配套 iOS 客户端暂未开源）。功能已可用，仍在 Beta 阶段，欢迎反馈。

## 即将支持

- **文件变更查看**：diff 视图，直接在 GUI 里审阅 Agent 改了什么。
- **终端**：独立终端面板，与 PI RPC 通道互不干扰。

## 快速开始

前置：macOS（Apple Silicon）、Node 18+、已安装 `pi` CLI。

```bash
git clone https://github.com/zucchiniEvader/pion.git && cd pion
npm install
npm run dev        # 开发模式启动
npm run dist       # 打包 dmg（release/Pion-<version>-arm64.dmg）
npm run dist:dir   # 快速产出未压缩的 release/mac-arm64/Pion.app
```

首次启动会自动检测 PI 环境；选择本地项目文件夹即可开始。

## 边界

- 只支持 PI，不接其他 Agent，不做 ACP。
- 不解析 PI 的 TUI 屏幕，主通信只走 `pi --mode rpc`。
- 不自动信任项目内的 resources，不静默传递 `--approve`。
- 远程访问目前定位为内网自托管，不做公网暴露与云同步。

## License

[MIT](LICENSE)。参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。
