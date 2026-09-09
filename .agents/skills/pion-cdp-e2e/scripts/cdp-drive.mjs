// Pion CDP E2E 驱动库。启动 app 的方式见同目录 SKILL.md。
// 场景脚本模板:
//   import { connect } from '<本文件绝对路径>'
//   const app = await connect()          // 默认端口 9223
//   await app.waitFor(`...js 表达式...`, 15000, '某个 UI 就绪标志')
//   await app.clickProject('/path/to/project')
//   ...
//   await app.screenshot('/tmp/shot.png')
//   await app.close()
import { writeFileSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function connect(port = 9223) {
  let wsUrl = null
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page')
      if (page) wsUrl = page.webSocketDebuggerUrl
    } catch {
      /* app 还没起来,继续等 */
    }
    if (!wsUrl) await sleep(500)
  }
  if (!wsUrl) {
    throw new Error('找不到 CDP target。确认 app 已带 --remote-debugging-port 启动,且启动日志里有 "DevTools listening"。')
  }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 连接失败'))
  })
  let rpcId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res, rej) => {
      const i = ++rpcId
      pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)))
      ws.send(JSON.stringify({ id: i, method, params }))
    })

  // 在页面里执行任意 JS(自动等待 Promise),返回可序列化的结果。
  const evaljs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    }
    return r.result.value
  }

  // 轮询直到 js 表达式为真。表达式会在页面里反复求值。
  const waitFor = async (expression, timeoutMs, label) => {
    const t0 = Date.now()
    for (;;) {
      if (await evaljs(expression)) return
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${label}`)
      await sleep(300)
    }
  }

  await send('Page.enable', {})
  await injectHelpers(evaljs)

  return {
    send,
    evaljs,
    waitFor,
    sleep,
    /** 截图到本地文件,用 Read 工具查看。 */
    screenshot: async (file) => {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(file, Buffer.from(shot.data, 'base64'))
      return file
    },
    /** 主进程真实 runtime 列表(不包含隐藏预热)。 */
    agentList: () => evaljs('(async () => window.pi.agent.list())()'),
    close: () => ws.close(),
    // ── Pion 专用操作(页面侧 helper 见 injectHelpers)──
    clickProject: (path) => evaljs(`window.__p.clickProject(${JSON.stringify(path)})`),
    clickNewTask: () => evaljs('window.__p.clickNewTask()'),
    /** 打开第 i 个真实会话行。行选择带 chrome 按钮排除表,勿自己写 [title] 查询。 */
    clickSession: (i) => evaljs(`window.__p.clickSession(${i})`),
    sessionRowCount: () => evaljs('window.__p.sessionRows().length'),
    sessionRowTitles: () => evaljs('window.__p.sessionRows().slice(0, 8).map((b) => b.title.slice(0, 24))'),
    typeAndSend: (text) => evaljs(`window.__p.typeAndSend(${JSON.stringify(text)})`),
    closeMenu: () => evaljs('window.__p.closeMenu()'),
    bodyText: () => evaljs('document.body.innerText'),
    // ── Kanban 看板(P1+)──
    openBoard: () => evaljs('window.__p.openBoard()'),
    /** 工具栏建卡:填标题 + 点"新建卡片"。 */
    createCard: (title) => evaljs(`window.__p.createCard(${JSON.stringify(title)})`),
    /** [{title, column}] 当前看板上所有卡片(不含抽屉)。 */
    boardCards: () => evaljs('window.__p.boardCards()'),
    /** 点列里的卡片打开详情抽屉。 */
    openCard: (title) => evaljs(`window.__p.openCard(${JSON.stringify(title)})`),
    /** 抽屉全文。注意:抽屉定位按评论输入框,不会误中侧栏 <aside>。 */
    drawerText: () => evaljs('window.__p.drawerText()'),
    /** 填评论输入框并点"评论"。 */
    drawerComment: (text) => evaljs(`window.__p.drawerComment(${JSON.stringify(text)})`),
    /** 设置抽屉里 <select>(绑定会话)并触发 change。 */
    drawerSelect: (value) => evaljs(`window.__p.drawerSelect(${JSON.stringify(value)})`),
    /** 抽屉里的按钮按 title 点(如 "绑定该会话"/"归档卡片")。 */
    drawerClickTitle: (title) => evaljs(`window.__p.drawerClickTitle(${JSON.stringify(title)})`),
    /** kanban:list 的 cards(main 已算好 runState)——dispatch 轮询用 IPC,别读 DOM。 */
    kanbanCards: (projectPath) => evaljs(`window.pi.kanban.list(${JSON.stringify(projectPath)}).then((b) => b.cards)`),
    /** 工具栏项目过滤:'all' 或项目路径。 */
    boardFilter: (value) => evaljs(`window.__p.boardFilter(${JSON.stringify(value)})`),
  }
}

// 页面侧 helper:只注入一次。所有选择器陷阱都在这里处理。
async function injectHelpers(evaljs) {
  await evaljs(`
    window.__p = {
      clickProject: (path) => {
        const b = [...document.querySelectorAll('button[title]')].find((x) => x.title === path)
        if (!b) return false
        b.click()
        return true
      },
      clickNewTask: () => {
        // 用 header 上明确的新建按钮,不要用 ⌘N 键事件之外的猜测。
        const b = document.querySelector('button[title="新建任务 (⌘N)"]')
        if (!b) return false
        b.click()
        return true
      },
      // 会话行 = 侧栏嵌套列表里的按钮。项目行内部嵌着"新建任务""项目选项"
      // 等 chrome 按钮,裸的 [title] 查询必然误点(会打开菜单甚至 Finder)。
      sessionRows: () =>
        [...document.querySelectorAll('aside ul li button[title]')].filter((b) => {
          const t = b.title
          if (!t) return false
          if (t.startsWith('/') || t.startsWith('非') || t.startsWith('在 Finder') || t.startsWith('刷新')) return false
          if (t === '新建任务' || t === '项目选项' || t === '归档' || t.includes('(⌘N)')) return false
          return true
        }),
      clickSession: (i) => {
        const rows = window.__p.sessionRows()
        if (!rows[i]) return false
        rows[i].click()
        return true
      },
      // React 受控 textarea 必须走 native setter + input 事件,直接赋值无效。
      typeAndSend: (text) => {
        const ta = document.querySelector('textarea')
        if (!ta) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, text)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        return true
      },
      // 项目选项菜单若被误开,点掉全屏遮罩。
      closeMenu: () => {
        const o = document.querySelector('div.fixed.inset-0')
        if (o) {
          o.click()
          return true
        }
        return false
      },
      // ── Kanban 看板 ──
      openBoard: () => {
        const b = document.querySelector('button[title="任务看板"]')
        if (!b) return false
        b.click()
        return true
      },
      // 建卡走弹窗:点"新建卡片" → 等弹窗 → 填标题 → 提交。
      createCard: async (title) => {
        const btn = [...document.querySelectorAll('main button')].find((x) => x.textContent.includes('新建卡片'))
        if (!btn) return false
        btn.click()
        for (let i = 0; i < 20; i++) {
          const inp = document.querySelector('div.fixed input[placeholder="要做什么？"]')
          if (inp) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(inp, title)
            inp.dispatchEvent(new Event('input', { bubbles: true }))
            const submit = [...document.querySelectorAll('div.fixed button')].find((x) => x.textContent.includes('创建卡片'))
            if (!submit) return false
            submit.click()
            return true
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        return false
      },
      boardCards: () =>
        [...document.querySelectorAll('main section button[title]')].map((b) => ({
          title: b.title,
          column: b.closest('section')?.querySelector('h3')?.textContent ?? '',
        })),
      openCard: (title) => {
        const b = [...document.querySelectorAll('main section button[title]')].find((x) => x.title === title)
        if (!b) return false
        b.click()
        return true
      },
      // 卡片详情页(覆盖看板的页面,不是 aside):稳定标记 data-card-page,
      // 页脚评论输入框是次级校验。
      drawerEl: () => {
        const el = document.querySelector('[data-card-page]')
        return el && el.querySelector('input[placeholder="添加评论…"]') ? el : null
      },
      drawerText: () => window.__p.drawerEl()?.textContent ?? '',
      drawerComment: (text) => {
        const d = window.__p.drawerEl()
        const inp = d?.querySelector('input[placeholder="添加评论…"]')
        if (!d || !inp) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(inp, text)
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        const btn = [...d.querySelectorAll('button')].find((x) => x.title === '添加评论')
        if (!btn) return false
        btn.click()
        return true
      },
      drawerSelect: (value) => {
        const sel = window.__p.drawerEl()?.querySelector('select')
        if (!sel) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        setter.call(sel, value)
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      },
      drawerClickTitle: (title) => {
        const d = window.__p.drawerEl()
        const b = d && [...d.querySelectorAll('button[title]')].find((x) => x.title === title)
        if (!b) return false
        b.click()
        return true
      },
      boardFilter: (value) => {
        const sel = document.querySelector('main select')
        if (!sel) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        setter.call(sel, value)
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      },
    }
    true
  `)
}
