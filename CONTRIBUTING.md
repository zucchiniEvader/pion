# 参与开发

感谢愿意帮忙。先花五分钟读完本文，能省掉一轮返工。

## 前置

- macOS（Apple Silicon），Node 18+
- 已安装 `pi` CLI（`pi --version` 能跑通）
- 一个可用的模型 provider，用于真实跑通会话

## 快速开始

```bash
npm install        # postinstall 会修补 dev 模式下的 Electron Dock 名称
npm run dev        # 开发模式
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 主进程 + 渲染进程类型检查 |
| `npm run test:purity` | `draftDecision` 等纯函数的回归测试 |
| `npm run test:i18n` | 检查中英文字典是否对齐 |
| `npm run test:daemon` | daemon 协议 / CLI / 配对测试 |
| `npm run dist:dir` | 快速产出 `release/mac-arm64/Pion.app` |
| `npm run dist` | 打包 dmg |

## 先看哪里

- `contracts/daemon-protocol.ts`：daemon 协议的唯一真相（帧格式、方法表、版本常量），改动前先读它。
- `resources/`：随应用打包的 PI 扩展（kanban-bridge、pion-commands），由 `pi -e` 加载。
- `.agents/skills/pion-cdp-e2e/SKILL.md`：用 CDP 驱动真实应用做端到端验证的方法，不需要 GUI 自动化权限。

范围外的功能请先开 issue 讨论，别直接写 PR。

## 实现原则（不可协商）

这些不是风格偏好，是项目的地基，PR 违反会被直接要求改：

1. **只支持 PI。** 不加其他 Agent adapter，不做 ACP。
2. **只走 `pi --mode rpc`。** 不解析 PI 的 TUI 屏幕，不混用 stdin/stdout。
3. **PI session JSONL 是对话唯一真相。** 不建第二份 transcript 库。
4. **`agent_end` 不等于空闲。** 稳定结束边界是 `agent_settled`。
5. **不夹带作者私货。** 不自带自研 prompt / skill / extension；社区扩展由 PI 加载，Pion 只负责渲染。新扩展适配请走通用 fallback 之外的专用渲染，不要 fork 扩展本身。
6. **安全基线不放松。** 不自动信任项目内 resources，不静默传 `--approve`，子进程用参数数组 + `shell: false`，不向 renderer 暴露凭据。相关边界见 `SECURITY.md`。
7. **未识别的工具必须有通用 fallback UI。** 不能白屏、不能丢事件。
8. **运行时 `dependencies` 保持为空。** renderer 依赖由 electron-vite 打进 bundle，main 不引外部包；否则打包产物会带上 `node_modules`。

## 提交 PR

- **小步。** 一个 PR 解决一件事，别把重构和功能混在一起。
- **说明验证方式。** 改了什么、怎么证明它对了（命令、e2e 场景编号、截图）。
- **新增界面文案必须同时补 `src/i18n/zh.ts` 和 `en.ts`。** `npm run typecheck` 会强制 en 完整性。
- **别顺手改格式。** 无关的格式化、重命名、依赖升级请单独提。
- issue 和 PR 用中文或英文都可以。

## 签名与公证（维护者）

仓库里**不含任何个人签名信息**：`electron-builder.yml` 不写 `identity`（它带姓名和 Team ID），只留 `notarize: true` 这个开关；凭据全部走环境变量。

- **无凭据（贡献者本地）**：跳过签名 → `scripts/afterPack.cjs` 补 ad-hoc 签名，`npm run dist` 照常出包。
- **有凭据**：electron-builder 用证书签名 + 公证，afterPack 自动跳过。

### 一次性准备

1. Xcode → Settings → Accounts → Manage Certificates → `+` → **Developer ID Application**（不是 Mac App Distribution，那个只能上架 App Store），证书会进钥匙串。
2. 在 [appleid.apple.com](https://appleid.apple.com) 生成一个 **app-specific password**（不是你的 Apple ID 密码）。
3. Team ID 在 developer.apple.com → Membership（10 位）。

### 本机打包

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"
npm run dist
```

这三条放 `~/.zshrc`，或放进一个被 gitignore 的 `.env.local` 再用 `set -a; source .env.local; set +a` 加载。**不要提交进仓库。**

`identity` 不需要填：本机证书在钥匙串里时 electron-builder 会自动发现（用 `security find-identity -v -p codesigning` 确认）。要指定具体证书再用 `CSC_NAME`。

### CI / 公共打包（GitHub Actions）

CI 没有钥匙串，用 base64 的 `.p12`。仓库 secrets 里放 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`：

```yaml
- run: npm ci && npm run dist
  env:
    CSC_LINK: ${{ secrets.CSC_LINK }}
    CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

也可以用 App Store Connect API Key 替代 Apple ID：`APPLE_API_KEY`（.p8 文件路径）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。

### 验证

```bash
codesign -dv --verbose=4 release/mac-arm64/Pion.app   # Authority=Developer ID Application: ...
spctl -a -vvv -t install release/mac-arm64/Pion.app   # accepted, source=Notarized Developer ID
xcrun stapler validate release/mac-arm64/Pion.app
```

未签名构建被 Gatekeeper 拦是预期行为，不要当 bug 修；告诉用户 `xattr -dr com.apple.quarantine /Applications/Pion.app` 即可。
