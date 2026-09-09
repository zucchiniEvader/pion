---
name: pion-cdp-e2e
description: 用 CDP(Chrome DevTools 协议)驱动 Pion Electron 应用做端到端测试、bug 复现和改动验证,无需任何 GUI 自动化权限。凡是要"实机测试/验证/复现 Pion 的界面行为"、改动 renderer 或 main 后想确认真实效果、或者 computer-use/辅助功能不可用时的 GUI 验证,都用这个 skill。关键词:测试、验证、复现、e2e、截图、实机。
---

# Pion CDP E2E 测试

核心思路:Electron 带 `--remote-debugging-port` 启动后,可以绕过辅助功能权限,直接通过 CDP 的 `Runtime.evaluate` 在页面里执行 JS——点击按钮、填表单、读状态、截屏。不依赖 Accessibility,headless 环境也能跑。

## 流程

### 1. 构建 + 启动(必须先杀旧实例)

```bash
npm run build   # CDP 测试跑的是构建产物 out/,改了代码必须重新构建
pkill -f "Electron.app/Contents/MacOS/Electron"; sleep 2
(npx electron . --remote-debugging-port=9223 > /tmp/pion-e2e.log 2>&1 &)
sleep 5
```

- 应用有单实例锁:不杀旧实例,新实例会静默退出,CDP 端口连不上。
- `/tmp/pion-e2e.log` 很有价值:main 进程的 console.log 和 renderer 转发的 `[renderer:ERROR]` 都在里面。

### 2. 写场景脚本(复用驱动库,不要重写样板)

新建临时脚本 `/tmp/pion-e2e-<场景>.mjs`,import 驱动库:

```js
// <repo> = 你的仓库根目录(绝对路径,因为脚本在 /tmp 下跑)
import { connect } from '<repo>/.agents/skills/pion-cdp-e2e/scripts/cdp-drive.mjs'

const app = await connect()  // 端口默认 9223
await app.waitFor(
  `[...document.querySelectorAll('button[title]')].some(x => x.title === '/path/to/project')`,
  30000, 'boot 完成',
)
await app.clickProject('/path/to/project')
await app.closeMenu()                       // 防误开菜单,点每轮交互前都调一次
console.log('会话行:', await app.sessionRowTitles())
console.log('主进程 runtime:', (await app.agentList()).length)
await app.screenshot('/tmp/pion-e2e-shot.png')
await app.close()
```

```bash
node /tmp/pion-e2e-<场景>.mjs
pkill -f "Electron.app/Contents/MacOS/Electron"   # 结束后清理
```

驱动库提供的 Pion 专用操作:`clickProject` / `clickNewTask`(header 上的"新建任务 (⌘N)"按钮)/ `clickSession(i)`(自带 chrome 按钮排除)/ `typeAndSend(text)`(React 受控 textarea + Enter)/ `agentList()`(主进程真实 runtime 列表)/ `screenshot(file)` / `waitFor(expr, timeout, label)` / `evaljs(任意页面 JS)`。
Kanban 看板(P1+):`openBoard()`(sidebar 顶部"任务看板"总入口,**无需先选项目**,默认"全部项目"聚合视图)/ `createCard(title)`(打开建卡弹窗填标题提交;项目默认按弹窗下拉,可用 drawerSelect 同款思路改)/ `boardCards()`(所有卡 [{title, column}])/ `boardFilter(value)`(项目过滤,'all' 或项目路径)/ `openCard(title)`(打开卡片详情页——覆盖看板的整页,带返回按钮)/ `drawerText()` / `drawerComment(text)` / `drawerSelect(value)`(页面内下拉)/ `drawerClickTitle(title)`(如"绑定该会话""归档卡片";注意"查看会话"按钮的 title 是"打开执行会话",按文字点)。详情页定位用 `[data-card-page]`。
Kanban dispatch(P2):`kanbanCards(projectPath)` 返回 main 投影的 cards(含 runState)——派发轮询走 IPC,不要读 DOM。

### 3. 判定结果

三层证据,按需组合:

- **DOM/文本**:`app.bodyText()` 检查界面文案;注意侧栏会话标题就是消息预览,断言"消息在屏幕上"时要区分主区和侧栏。
- **主进程真相**:`app.agentList()` 看 runtime 数量与 sessionFile;UI 状态和 React 内部读不到时,用它交叉验证。
- **截图**:`app.screenshot()` 后用 Read 查看,视觉验证布局/样式。

### 4. 主进程问题加临时诊断

main 进程的行为(runtime 退出、淘汰、IPC)在页面上看不到。在 `electron/main/index.ts` 相关位置加 `console.log('[诊断] ...')`,重新 build + 重启,从 `/tmp/pion-e2e.log` 读日志。诊断完删掉。

## 陷阱清单(每条都真实踩过)

1. **单实例锁**:启动前必须 pkill 旧实例,否则新实例静默退出。
2. **侧栏按钮误点**:项目行内部嵌套"新建任务""项目选项"等按钮,裸的 `button[title]` 查询会把它们当会话行点下去——曾导致打开项目菜单、误触"在 Finder 中显示"。永远用驱动库的 `sessionRows()`(带排除表),不要自己写选择器;每轮点击前调 `closeMenu()` 兜底。
3. **React 受控组件**:textarea 直接赋值无效,必须 native setter + `input` 事件;Enter 用 `dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'}))`。
4. **Browser CDP 域不可用**:`Browser.getWindowForTarget` 在 Electron 里不存在。要改窗口尺寸做溢出测试,直接改 DOM:`document.querySelector('aside').style.height = '420px'`。
5. **发送消息 = 真实模型调用**:花 token、耗时数秒到数十秒。测试消息用"请只回复: ok"级别的;需要长时间运行态时用"先执行 sleep 25 再回复"。测试会在真实项目里留下垃圾会话,结束后提醒用户归档。
6. **状态判定别只看一次**:流式/淘汰/绑定是异步的,断言前留 2-3 秒或用 `waitFor` 轮询;runtime 数量会因 LRU 淘汰变化,别假设恒定。
7. **验证"消息可见"的坑**:乐观气泡(startingMessage)在发送失败时也会短暂显示,侧栏标题也含消息文本。可靠判据:hero 文案("接下来交给我吧")消失 + 消息在主区 + 数秒后 assistant 内容出现。
8. **截图时机**:模型秒回时"运行中"截图会扑空。先用 `sleep` 类长任务锁住运行态再截。同理,抽屉/菜单有 140ms `dialog-in` 淡入——waitFor 探针只读 textContent 对透明度无感,会零延迟通过然后截到半透明中间态;**截图前 sleep ≥1s**。
9. **探针选择器要跟着组件形态走**:侧栏是 `<aside>`;卡片详情是覆盖看板的整页,稳定标记是 `[data-card-page]`(页脚评论输入框可作次级校验)。详情页的流转按钮本身含 "Backlog/Review" 等词——断言"看板列可见/不可见"不能只查这些词,用工具栏按钮(如 title="显示已归档卡片",仅列视图渲染)作判据。
10. **选择器转义双解析**:evaljs 的表达式字符串会被 JS 再解析一次,Tailwind 的 bracket 类(如 `text-[11px]`)转义 `\\[` 会在第二层解析中被吃掉,querySelector 直接报非法选择器。避免 bracket 类选择器,用结构选择器(如 `aside header p`)。
11. **select 赋值**:绑定会话等下拉用原生 setter + `change` 事件(同 textarea 陷阱)。

## Kanban dispatch 全闭环测试(P2)

- **派发 = 冷启动 + 真实模型调用**:~1.1s 冷启动 + 数秒到数十秒模型延迟。卡 body 里写清"不要读写文件,直接调用 kanban_report(...)",把模型行为压到最短路径。轮询预算 120s。
- **轮询走 IPC 不走 DOM**:`kanbanCards(projectPath)` 拿 main 投影(status/runState/notes),抽屉文本不保证实时。
- **两条收敛路径都要测**:① agent 汇报——卡进 Review 且 notes 有 `agent|` 源,settled tap 应当无动作;② 兜底——卡 body 要求"不要调用 kanban_report"(配 sleep 锁运行态),settled 后应有 `system|` note 并自动进 Review。
- **运行态与守卫一起测**:body 里放 `sleep 15` 锁住 running,期间经 IPC 重复 dispatch 必须被拒(main 返回错误 envelope);这也是验证 runState=running 投影的最稳手段。
- **终端第二写者不必真开终端**:bridge 的写入就是"一行 JSON append 到 events.jsonl"——脚本里 `appendFileSync` 直接追加一条 note_added,waitFor board 出现即验证了 watch→投影→changed push 全链。
- **bridge 加载预检**:换 bridge 文件后先跑一次 RPC 裸握手(pi --mode rpc -e <bridge> + get_state),无 extension_error 再进 GUI 全流程,省一轮模型调用。
- runState=failed(runtime 意外退出)会把卡标红,重启该会话后回落。

## 验收节奏

一次场景跑完 = 一份结论,格式:`VERDICT: PASS/FAIL — 证据(探针值/截图路径/日志行)`。把探针原始值打出来,不要只打结论。
