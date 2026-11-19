import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildClient } from '../scripts/build-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = `${path.join(here, '..')}${path.sep}`

// 渲染器是普通浏览器脚本（无 import/export），单测直接把它当文本丢进 vm，取回导出的函数。
async function loadRenderer() {
  const source = await readFile(new URL('../src/live2d-avatar.js', import.meta.url), 'utf8')
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, console })
  vm.runInContext(source, context, { filename: 'src/live2d-avatar.js' })
  return module.exports
}

// react / jsdom 走 build.test.js 相同的探测顺序；缺依赖时相关用例 skip，不报假绿。
const probeDirs = [process.env.HR_TEST_REACT_DIR, `${root}node_modules`].filter(Boolean)
function loadReactTools() {
  for (const dir of probeDirs) {
    try {
      const req = createRequire(path.join(dir, 'noop.js'))
      const React = req('react')
      let client = null
      try { client = req('react-dom/client') } catch { client = null }
      let jsdom = null
      try { jsdom = req('jsdom') } catch { jsdom = null }
      const act = typeof React.act === 'function' ? React.act : (() => { try { return req('react-dom/test-utils').act } catch { return null } })()
      return { React, createRoot: client && client.createRoot, jsdom, act, dir }
    } catch { /* 换下一个探测目录 */ }
  }
  return null
}

function fakeDocument() {
  const canvases = []
  return {
    canvases,
    createElement(tag) {
      if (tag === 'canvas') {
        const canvas = { tagName: 'CANVAS', className: '', style: {}, parentNode: null }
        canvases.push(canvas)
        return canvas
      }
      return { tagName: String(tag).toUpperCase(), dataset: {}, addEventListener() {}, remove() {} }
    },
    head: { appendChild() {} },
  }
}

function fakeHost(doc) {
  const host = {
    ownerDocument: doc,
    children: [],
    clientWidth: 220,
    clientHeight: 220,
    appendChild(node) { host.children.push(node); node.parentNode = host },
    removeChild(node) { host.children = host.children.filter((item) => item !== node); node.parentNode = null },
  }
  return host
}

function fakeWindow() {
  const win = {
    devicePixelRatio: 2,
    frames: [],
    cancels: 0,
    observer: null,
    requestAnimationFrame(fn) { win.frames.push(fn); return win.frames.length },
    cancelAnimationFrame() { win.cancels += 1 },
    ResizeObserver: class {
      constructor(fn) { this.fn = fn; this.disconnected = false; win.observer = this }
      observe(node) { this.node = node }
      disconnect() { this.disconnected = true }
    },
  }
  return win
}

function fakePixi({ failFrom = null, coreModel = null } = {}) {
  const state = { fromCalls: [], appOptions: null, app: null, onRender: null }
  const model = {
    anchorValue: null,
    scaleValue: null,
    positionValue: null,
    autoUpdate: undefined,
    updateCalls: 0,
    destroyCalls: 0,
    internalModel: coreModel ? { width: 800, height: 600, coreModel } : { width: 800, height: 600 },
    anchor: { set(x, y) { model.anchorValue = [x, y] } },
    scale: {
      // PIXI 的 ObservablePoint.set(x, y = x)：只传一个数时 x 与 y 必须同时是这个值，
      // 取景层只要多传/少传一个数就可能把模型拉成非等比，所以这里把参数个数也记下来。
      set(x, y) {
        model.scaleValue = x
        model.scaleArgs = arguments.length
        model.scaleXY = [x, y === undefined ? x : y]
      },
    },
    position: { set(x, y) { model.positionValue = [x, y] } },
    update(delta) { model.updateCalls += 1; model.lastDelta = delta },
    destroy() { model.destroyCalls += 1 },
  }
  class Application {
    constructor(options) {
      state.appOptions = options
      this.destroyCalls = 0
      this.stage = { children: [], addChild(child) { this.children.push(child) } }
      this.renderer = {
        resizeCalls: [],
        renderCalls: 0,
        resize(width, height) { this.resizeCalls.push([width, height]) },
        render() { this.renderCalls += 1; if (typeof state.onRender === 'function') state.onRender() },
      }
      state.app = this
    }
    destroy(...args) { this.destroyCalls += 1; this.destroyArgs = args }
  }
  const PIXI = {
    Application,
    live2d: {
      Live2DModel: {
        async from(url, options) {
          state.fromCalls.push({ url, options })
          if (failFrom) throw new Error(failFrom)
          return model
        },
      },
    },
  }
  return { PIXI, model, state }
}

const RUNTIME_URLS = [
  '/hr-runtime/pixi-6.5.10.min.js',
  '/hr-runtime/live2dcubismcore-1.0.2.min.js',
  '/hr-runtime/pixi-live2d-display-cubism4-0.4.0.min.js',
]
const AVATAR = { kind: 'live2d', available: true, base: '/hr-avatar', model: '大肥鱼.model3.json', runtimeBase: '/hr-runtime', reason: 'ok' }

test('live2d 运行时：三个脚本按固定顺序串行加载，同一 document 只加载一次', async () => {
  const api = await loadRenderer()
  const doc = {}
  const calls = []
  let active = 0
  let peak = 0
  const loadScript = async (url) => {
    calls.push(url)
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active -= 1
  }
  const first = await api.hrLive2dLoadRuntime(doc, '/hr-runtime', { loadScript })
  assert.deepEqual(calls, RUNTIME_URLS)
  assert.equal(peak, 1, '脚本必须串行：pixi 先于 cubism core 与 display')
  await api.hrLive2dLoadRuntime(doc, '/hr-runtime/', { loadScript })
  assert.equal(calls.length, 3, '第二次挂载不得重复注入运行时脚本')
  assert.deepEqual([...first.urls], RUNTIME_URLS)
})

test('live2d 运行时：失败 reject 且不缓存，下一次还能重试', async () => {
  const api = await loadRenderer()
  const doc = {}
  const calls = []
  let broken = true
  const loadScript = async (url) => {
    calls.push(url)
    if (broken && url.includes('cubismcore')) throw new Error('cubism core 404')
  }
  await assert.rejects(() => api.hrLive2dLoadRuntime(doc, '/hr-runtime', { loadScript }), /cubism core 404/)
  broken = false
  const done = await api.hrLive2dLoadRuntime(doc, '/hr-runtime', { loadScript })
  assert.deepEqual([...done.urls], RUNTIME_URLS)
  assert.deepEqual(calls.slice(-3), RUNTIME_URLS, '重试要从第一个脚本重新按序加载')
})

test('live2d 模型 URL：逐段 encodeURIComponent，不接受绝对域，尺寸有界', async () => {
  const api = await loadRenderer()
  const url = api.hrLive2dModelUrl('/hr-avatar', '大肥鱼.model3.json')
  assert.equal(url, '/hr-avatar/%E5%A4%A7%E8%82%A5%E9%B1%BC.model3.json')
  assert.doesNotMatch(url, /^[a-z][a-z0-9+.-]*:/i)
  assert.equal(api.hrLive2dModelUrl('/hr-avatar/', 'Animation/大肥鱼.motion3.json'), '/hr-avatar/Animation/%E5%A4%A7%E8%82%A5%E9%B1%BC.motion3.json')
  assert.equal(api.hrLive2dModelUrl('https://evil.example', '大肥鱼.model3.json'), '/hr-avatar/%E5%A4%A7%E8%82%A5%E9%B1%BC.model3.json')
  assert.throws(() => api.hrLive2dModelUrl('/hr-avatar', ''), /模型入口为空/)
  assert.deepEqual([...api.hrLive2dRuntimeUrls('/hr-runtime')], RUNTIME_URLS)
  assert.equal(api.hrLive2dClampSize(120), 160)
  assert.equal(api.hrLive2dClampSize(999), 220)
  assert.equal(api.hrLive2dClampSize('x'), 190)
})

test('live2d 舞台：真 canvas + autoInteract=false，卸载清干净且不动共享运行时', async () => {
  const api = await loadRenderer()
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const win = fakeWindow()
  const { PIXI, model, state } = fakePixi()
  const loads = []
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI, core: {}, avatar: AVATAR, size: 200,
    runtime: { loadScript: async (url) => { loads.push(url) } },
  })
  await stage.promise
  assert.equal(stage.ready, true)
  assert.deepEqual(loads, RUNTIME_URLS)
  assert.equal(state.fromCalls.length, 1)
  assert.equal(state.fromCalls[0].url, '/hr-avatar/%E5%A4%A7%E8%82%A5%E9%B1%BC.model3.json')
  assert.deepEqual({ ...state.fromCalls[0].options }, { autoInteract: false, autoUpdate: false })
  assert.equal(state.appOptions.autoStart, false, '渲染由自己的 RAF 驱动，不依赖 PIXI ticker')
  assert.equal(doc.canvases.length, 1)
  assert.equal(doc.canvases[0].parentNode, host, 'canvas 真的挂进了容器')
  assert.equal(state.appOptions.view, doc.canvases[0])
  assert.equal(model.anchorValue[0], 0.5)
  assert.ok(model.scaleValue > 0 && model.scaleValue <= 1)
  assert.equal(typeof win.observer?.disconnect, 'function')
  assert.ok(win.frames.length >= 1)
  win.frames[win.frames.length - 1](16)
  assert.equal(model.updateCalls, 1)
  assert.equal(state.app.renderer.renderCalls, 1)
  stage.destroy()
  stage.destroy()
  assert.equal(stage.destroyed, true)
  assert.ok(win.cancels >= 1, '卸载必须 cancelAnimationFrame')
  assert.equal(win.observer.disconnected, true)
  assert.equal(model.destroyCalls, 1)
  assert.equal(state.app.destroyCalls, 1)
  assert.equal(state.app.destroyArgs[0], true)
  assert.deepEqual({ ...state.app.destroyArgs[1] }, { children: true })
  assert.equal(host.children.length, 0)
  assert.equal(doc.canvases[0].parentNode, null)
  // 共享运行时保留：PIXI 命名空间还在，脚本标签也没被删。
  assert.equal(typeof PIXI.live2d.Live2DModel.from, 'function')
})

test('live2d 舞台：模型下载期间卸载会释放晚到实例', async () => {
  const api = await loadRenderer()
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const win = fakeWindow()
  const { PIXI, model, state } = fakePixi()
  let finish
  PIXI.live2d.Live2DModel.from = () => new Promise((resolve) => { finish = () => resolve(model) })
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI, core: {}, avatar: AVATAR, size: 200,
    runtime: { loadScript: async () => {} },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(typeof finish, 'function')
  stage.destroy()
  finish()
  await assert.rejects(() => stage.promise, /舞台已释放/)
  assert.equal(model.destroyCalls, 1, '晚到的模型不能只靠已结束的幂等 teardown')
  assert.equal(state.app.destroyCalls, 1)
  assert.equal(host.children.length, 0)
})

test('live2d 舞台：模型加载失败会 reject 并清理，不拖住面试', async () => {
  const api = await loadRenderer()
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const win = fakeWindow()
  const { PIXI, state } = fakePixi({ failFrom: 'moc3 404' })
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI, core: {}, avatar: AVATAR, size: 200,
    runtime: { loadScript: async () => {} },
  })
  await assert.rejects(() => stage.promise, /moc3 404/)
  assert.equal(stage.ready, false)
  assert.ok(stage.error instanceof Error)
  assert.equal(stage.destroyed, true)
  assert.equal(state.app.destroyCalls, 1)
  assert.equal(host.children.length, 0)
})

test('live2d 舞台：运行时缺失时给出可读原因而不是崩溃', async () => {
  const api = await loadRenderer()
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const stage = api.hrLive2dCreateStage({
    host, window: fakeWindow(), document: doc, core: {}, avatar: AVATAR, size: 200,
    runtime: { loadScript: async () => {} },
  })
  await assert.rejects(() => stage.promise, /PIXI 运行时尚未就绪/)
  assert.equal(stage.destroyed, true)
})

test('Live2DAvatar：加载中/成功/失败三态与卸载销毁（React 生命周期）', async (t) => {
  const tools = loadReactTools()
  if (!tools || typeof tools.createRoot !== 'function' || typeof tools.act !== 'function' || !tools.jsdom) {
    t.skip('缺少 react / react-dom / jsdom 测试依赖')
    return
  }
  const { React, createRoot, act, jsdom } = tools
  const api = await loadRenderer()
  const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = win
  globalThis.document = win.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const stages = []
    const Live2DAvatar = api.hrLive2dComponent(React, {
      createStage(config) {
        const stage = { config, destroyed: false, promise: Promise.resolve(null), destroy() { stage.destroyed = true } }
        stages.push(stage)
        return stage
      },
    })
    const container = win.document.getElementById('root')
    const rootInstance = createRoot(container)
    await act(async () => {
      rootInstance.render(React.createElement(Live2DAvatar, { avatar: AVATAR, speaking: true, size: 200 }))
    })
    assert.equal(stages.length, 1)
    assert.equal(stages[0].config.avatar.model, '大肥鱼.model3.json')
    let html = container.innerHTML
    assert.match(html, /hri-live2d/)
    assert.match(html, /role="img"|role='img'/)
    assert.match(html, /Live2D 面试官形象：HR 正在提问/, 'speaking 只改可访问文字')
    assert.doesNotMatch(html, /Live2D 加载中/)
    // 换形象：旧舞台被销毁，新舞台重新挂载
    await act(async () => {
      rootInstance.render(React.createElement(Live2DAvatar, { avatar: { ...AVATAR, model: '另一条.model3.json' }, size: 200 }))
    })
    assert.equal(stages.length, 2)
    assert.equal(stages[0].destroyed, true)
    assert.equal(stages[1].config.avatar.model, '另一条.model3.json')
    await act(async () => { rootInstance.unmount() })
    assert.equal(stages[1].destroyed, true)
    assert.equal(container.innerHTML, '')

    // 失败态：外部文案回退，静态头像仍在页面上（HRMark 那一层负责）
    const failing = api.hrLive2dComponent(React, {
      createStage() { return { destroyed: false, promise: Promise.reject(new Error('纹理 404')), destroy() {} } },
    })
    const failRoot = createRoot(container)
    await act(async () => { failRoot.render(React.createElement(failing, { avatar: AVATAR })) })
    html = container.innerHTML
    assert.match(html, /形象未加载，已用静态头像/)
    assert.match(html, /加载失败，已回退静态头像/)
    await act(async () => { failRoot.unmount() })
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
})

test('live2d 舞台 fill 模式：首帧按容器尺寸建渲染器，近景取景并跟随 ResizeObserver', async () => {
  const api = await loadRenderer()
  const doc = fakeDocument()
  const host = fakeHost(doc)
  host.clientWidth = 800
  host.clientHeight = 300
  const win = fakeWindow()
  const { PIXI, model, state } = fakePixi()
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI, core: {}, avatar: AVATAR, size: 320, fill: true,
    runtime: { loadScript: async () => {} },
  })
  await stage.promise
  assert.equal(stage.fill, true)
  assert.equal(state.appOptions.width, 800, 'fill 模式首帧就要是容器尺寸，不能先出一张 190px 的糊图')
  assert.equal(state.appOptions.height, 300)
  assert.ok(state.appOptions.resolution <= 2, '清晰度上限仍是 2 倍设备像素比')
  // 800x300 容器 vs 800x600 模型：近景优先 = 模型高 34%（204px）铺满 300px → 1.4706，
  // 横向因此裁掉约三分之一（对称，anchor 居中），不退回全身。
  assert.equal(Math.round(model.scaleValue * 10000) / 10000, 1.4706)
  assert.equal(model.positionValue[0], 400)
  assert.ok(Math.abs(model.positionValue[1] - 447.176) < 0.01, '顶对齐：模型上沿 = 447.18 - 441.18 = +6px（2% 视口高），不切头')
  assert.equal(model.scaleArgs, 1, 'scale.set 只传一个数：PIXI 会把 y 一起设成同一个值，绝不允许拉伸')
  assert.deepEqual(state.app.renderer.resizeCalls[0], [800, 300])
  assert.equal(Math.round(stage.framing.visibleFraction * 100) / 100, 0.34, '近景：只显示模型顶部 34%（头顶到胸口）')
  assert.ok(stage.framing.visibleWidthFraction < 1, '宽度不够时左右对称裁肩，而不是整幅缩小')
  // 容器变宽：ResizeObserver 重新适配（2000x1200 → 近景优先 1200/(600*0.34) = 5.882）
  host.clientWidth = 2000
  host.clientHeight = 1200
  win.observer.fn([{ target: host }])
  assert.deepEqual(state.app.renderer.resizeCalls.at(-1), [2000, 1200])
  assert.equal(Math.round(model.scaleValue * 1000) / 1000, 5.882)
  assert.equal(model.positionValue[0], 1000)
  assert.ok(Math.abs(model.positionValue[1] - 1788.706) < 0.01)
  assert.equal(Math.round(stage.framing.visibleFraction * 100) / 100, 0.34)
  stage.destroy()
  assert.equal(host.children.length, 0)
})

test('Live2DAvatar fill 模式：铺满容器、把 fill 透传给舞台、卸载销毁', async (t) => {
  const tools = loadReactTools()
  if (!tools || typeof tools.createRoot !== 'function' || typeof tools.act !== 'function' || !tools.jsdom) {
    t.skip('缺少 react / react-dom / jsdom 测试依赖')
    return
  }
  const { React, createRoot, act, jsdom } = tools
  const api = await loadRenderer()
  const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = win
  globalThis.document = win.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const stages = []
    const Live2DAvatar = api.hrLive2dComponent(React, {
      createStage(config) {
        const stage = { config, destroyed: false, promise: Promise.resolve(null), destroy() { stage.destroyed = true } }
        stages.push(stage)
        return stage
      },
    })
    const container = win.document.getElementById('root')
    const rootInstance = createRoot(container)
    await act(async () => {
      rootInstance.render(React.createElement(Live2DAvatar, { avatar: AVATAR, fill: true, size: 320 }))
    })
    assert.equal(stages.length, 1)
    assert.equal(stages[0].config.fill, true, 'fill 必须透传给舞台，否则首帧仍是卡片尺寸')
    const box = container.querySelector('.hri-live2d-fill')
    assert.ok(box, 'fill 模式要带 hri-live2d-fill 类名（面试页左半舞台）')
    assert.equal(box.style.position, 'absolute')
    assert.equal(box.style.width, '100%')
    assert.equal(box.style.height, '100%')
    assert.ok(box.style.borderRadius === '0px' || box.style.borderRadius === '0', '舞台不留卡片圆角')
    await act(async () => { rootInstance.unmount() })
    assert.equal(stages[0].destroyed, true)
    assert.equal(container.innerHTML, '')
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
})

test('Live2DAvatar fill 舞台：未就绪时摆真实静态 HR 圆（加载半透明 / 失败不透明），就绪后不留水印', async (t) => {
  const tools = loadReactTools()
  if (!tools || typeof tools.createRoot !== 'function' || typeof tools.act !== 'function' || !tools.jsdom) {
    t.skip('缺少 react / react-dom / jsdom 测试依赖')
    return
  }
  const { React, createRoot, act, jsdom } = tools
  const api = await loadRenderer()
  const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = win
  globalThis.document = win.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const ringIn = (container) => {
    const spans = [...container.querySelectorAll('.hri-live2d-fill span')]
    const ring = spans.find((node) => node.textContent === 'HR')
    return ring ? ring.parentElement : null
  }
  try {
    const container = win.document.getElementById('root')
    // ① 加载中：圆在，半透明
    const loadingRoot = createRoot(container)
    await act(async () => {
      const Live2DAvatar = api.hrLive2dComponent(React, {
        createStage() { return { destroyed: false, promise: new Promise(() => {}), destroy() {} } },
      })
      loadingRoot.render(React.createElement(Live2DAvatar, { avatar: AVATAR, fill: true, size: 320 }))
    })
    const loadingRing = ringIn(container)
    assert.ok(loadingRing, '舞台加载中必须有静态 HR 圆，不能是空白')
    assert.equal(loadingRing.style.opacity, '0.45', '加载中半透明，不抢模型的视觉')
    assert.match(container.textContent, /Live2D 加载中/)
    await act(async () => { loadingRoot.unmount() })

    // ② 失败：圆不透明 + 现有提示
    const failedRoot = createRoot(container)
    await act(async () => {
      const Live2DAvatar = api.hrLive2dComponent(React, {
        createStage() { return { destroyed: false, promise: Promise.reject(new Error('纹理 404')), destroy() {} } },
      })
      failedRoot.render(React.createElement(Live2DAvatar, { avatar: AVATAR, fill: true, size: 320 }))
    })
    const failedRing = ringIn(container)
    assert.ok(failedRing, '失败后静态圆必须留着，不能塌成空舞台')
    assert.equal(failedRing.style.opacity, '1', '失败时圆要实心可见')
    assert.match(container.textContent, /形象未加载，已用静态头像/)
    await act(async () => { failedRoot.unmount() })

    // ③ ready：模型自己在画，静态圆整层消失（模型上不留水印）
    const readyRoot = createRoot(container)
    await act(async () => {
      const Live2DAvatar = api.hrLive2dComponent(React, {
        createStage() { return { destroyed: false, promise: Promise.resolve(null), destroy() {} } },
      })
      readyRoot.render(React.createElement(Live2DAvatar, { avatar: AVATAR, fill: true, size: 320 }))
    })
    assert.equal(ringIn(container), null, '就绪后不能有任何静态圆/水印挡在模型上')
    assert.doesNotMatch(container.textContent, /加载中|未加载/)
    await act(async () => { readyRoot.unmount() })
    assert.equal(container.innerHTML, '')
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
})

/* ── 大肥鱼 · 鼻部黑块补丁 ─────────────────────────────────────────────
 * 夹具刻意把两个目标 drawable 放在索引 1 和 7（不是 513/514）：哪天代码写死索引，
 * 这几条用例立刻红。update 每帧把全部 opacity 重置成 1，等价于 Cubism 每帧重算，
 * 所以「只在初始化时压一次」的实现在这里过不了。
 */
const NOSE_IDS = ['ArtMesh44', 'ArtMesh246', 'ArtMesh45', 'ArtMesh46', 'ArtMesh10', 'ArtMesh11', 'ArtMesh12', 'ArtMesh682', 'ArtMesh13']
const NOSE_TARGETS = [1, 7]
const NOSE_KEPT = ['ArtMesh44', 'ArtMesh45', 'ArtMesh46', 'ArtMesh10', 'ArtMesh11', 'ArtMesh12', 'ArtMesh13']

function tickFrame(win, stamp) {
  win.frames[win.frames.length - 1](stamp)
}

/** 建一个带 Cubism coreModel 的舞台；update 每帧把 opacity 全部重算成 1。 */
function noseStage(api, { avatar = AVATAR, ids = NOSE_IDS } = {}) {
  const opacities = ids.map(() => 1)
  const coreModel = { _model: { drawables: { ids, opacities } } }
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const win = fakeWindow()
  const pixi = fakePixi({ coreModel })
  const { model, state } = pixi
  const baseUpdate = model.update
  model.resetFrames = 0
  model.update = (delta) => { baseUpdate.call(model, delta); opacities.fill(1); model.resetFrames += 1 }
  const renders = []
  state.onRender = () => renders.push(Array.from(opacities))
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI: pixi.PIXI, core: {}, avatar, size: 200,
    runtime: { loadScript: async () => {} },
  })
  return { stage, model, state, win, doc, host, opacities, renders }
}

test('live2d 大肥鱼鼻部补丁：每帧 update 之后压 0，render 时生效，其它 drawable 不动', async () => {
  const api = await loadRenderer()
  const box = noseStage(api)
  await box.stage.promise
  assert.deepEqual([...api.hrLive2dNosePatchIndices(box.model)], NOSE_TARGETS, '索引按 ID 解析，绝不是写死的 513/514')
  tickFrame(box.win, 16)
  assert.equal(box.model.resetFrames, 1, '这一帧 update 已把 opacity 重算回 1')
  // update 刚重算完，补丁必须又压回 0 —— 只在初始化时写一次的实现这里就露馅
  assert.equal(box.opacities[1], 0)
  assert.equal(box.opacities[7], 0)
  tickFrame(box.win, 32)
  tickFrame(box.win, 48)
  assert.equal(box.model.resetFrames, 3)
  assert.equal(box.opacities[1], 0)
  assert.equal(box.opacities[7], 0)
  const kept = NOSE_IDS.filter((id, index) => box.opacities[index] !== 0)
  assert.deepEqual(kept, NOSE_KEPT, '同 Part 的其余阴影面片必须保留')
  // render 抓到的就是压过补丁之后的状态
  assert.equal(box.renders.length, 3)
  for (const snapshot of box.renders) {
    assert.equal(snapshot[1], 0)
    assert.equal(snapshot[7], 0)
    assert.equal(snapshot.filter((value) => value === 1).length, NOSE_IDS.length - 2)
  }
  box.stage.destroy()
})

test('live2d 鼻部补丁：只对 大肥鱼.model3.json 生效，其它模型完全不受影响', async () => {
  const api = await loadRenderer()
  assert.equal(api.hrLive2dNosePatchApplies('大肥鱼.model3.json'), true)
  for (const name of ['另一条.model3.json', '大肥鱼.model3.json ', '/大肥鱼.model3.json', '大肥鱼2.model3.json', '大肥鱼.model3.json.bak', '', null, undefined]) {
    assert.equal(api.hrLive2dNosePatchApplies(name), false, `不该命中：${String(name)}`)
  }
  const box = noseStage(api, { avatar: { ...AVATAR, model: '另一条.model3.json' } })
  await box.stage.promise
  tickFrame(box.win, 16)
  tickFrame(box.win, 32)
  assert.equal(box.model.resetFrames, 2)
  assert.deepEqual(box.opacities, NOSE_IDS.map(() => 1), '别的模型 opacity 必须原样保留')
  assert.deepEqual(box.renders.at(-1), NOSE_IDS.map(() => 1))
  box.stage.destroy()
})

test('live2d 鼻部补丁：drawable 结构或 ID 缺失时静默跳过，不抛不崩', async () => {
  const api = await loadRenderer()

  // ① 完全没有 coreModel：照常 tick、照常 render，只是不打补丁
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const win = fakeWindow()
  const plain = fakePixi()
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI: plain.PIXI, core: {}, avatar: AVATAR, size: 200,
    runtime: { loadScript: async () => {} },
  })
  await stage.promise
  assert.deepEqual([...api.hrLive2dNosePatchIndices(plain.model)], [])
  tickFrame(win, 16)
  tickFrame(win, 32)
  assert.equal(plain.model.updateCalls, 2)
  assert.equal(plain.state.app.renderer.renderCalls, 2)
  assert.equal(stage.error, null, '结构缺失不能把面试拖崩')
  stage.destroy()

  // ② 只命中一个 ID：压命中的那个，另一个没出现就不动
  const partial = noseStage(api, { ids: ['ArtMesh44', 'ArtMesh246', 'ArtMesh45'] })
  await partial.stage.promise
  tickFrame(partial.win, 16)
  assert.deepEqual([...api.hrLive2dNosePatchIndices(partial.model)], [1])
  assert.deepEqual(partial.opacities, [1, 0, 1])
  assert.equal(partial.stage.error, null)
  partial.stage.destroy()

  // ③ ids / opacities 任意一层缺失、索引越界、model 为空：安全返回，绝不抛
  assert.deepEqual([...api.hrLive2dNosePatchIndices({ internalModel: { coreModel: { _model: { drawables: { opacities: [1, 1] } } } } })], [])
  assert.deepEqual([...api.hrLive2dNosePatchIndices({ internalModel: {} })], [])
  assert.deepEqual([...api.hrLive2dNosePatchIndices(null)], [])
  assert.equal(api.hrLive2dHideNoseDrawables({ internalModel: { coreModel: { _model: { drawables: { ids: ['ArtMesh246'] } } } } }, [0]), false)
  assert.equal(api.hrLive2dHideNoseDrawables(null, [0]), false)
  assert.equal(api.hrLive2dHideNoseDrawables({}, []), false)
  const short = { internalModel: { coreModel: { _model: { drawables: { ids: ['ArtMesh246'], opacities: [1] } } } } }
  assert.deepEqual([...api.hrLive2dNosePatchIndices(short)], [0])
  assert.equal(api.hrLive2dHideNoseDrawables(short, [0, 5]), true, '越界索引直接跳过')
  assert.deepEqual(short.internalModel.coreModel._model.drawables.opacities, [0])
  // coreModel 本身（没有 _model）也能被认出来
  const flat = { internalModel: { coreModel: { drawables: { ids: ['ArtMesh682'], opacities: [1] } } } }
  assert.deepEqual([...api.hrLive2dNosePatchIndices(flat)], [0])
})

test('live2d 鼻部补丁：ids 不假定 length —— iterator-only 容器与 csmVector 两种形状都能解析', async () => {
  const api = await loadRenderer()
  const wrap = (ids) => ({ internalModel: { coreModel: { _model: { drawables: { ids, opacities: NOSE_IDS.map(() => 1) } } } } })
  // ① iterator-only：没有 length，只能被 Array.from 消费
  const iterable = { [Symbol.iterator]: function* () { yield* NOSE_IDS } }
  assert.equal('length' in iterable, false, '这条夹具必须真的没有 length')
  assert.deepEqual([...api.hrLive2dNosePatchIndices(wrap(iterable))], NOSE_TARGETS)
  // ② 原生 csmVector 形状：不可迭代，只有 getSize()/at()
  const vector = { getSize() { return NOSE_IDS.length }, at(index) { return NOSE_IDS[index] } }
  assert.equal(typeof vector[Symbol.iterator], 'undefined')
  assert.equal('length' in vector, false)
  assert.deepEqual([...api.hrLive2dNosePatchIndices(wrap(vector))], NOSE_TARGETS)
  // ③ 既不可迭代也不像 vector（含数字、空对象）：返回 []，不抛
  assert.deepEqual([...api.hrLive2dNosePatchIndices(wrap({}))], [])
  assert.deepEqual([...api.hrLive2dNosePatchIndices(wrap(42))], [])
  // ④ getSize()/at() 自己抛：也只返回 []
  assert.deepEqual([...api.hrLive2dNosePatchIndices(wrap({ getSize() { throw new Error('boom') }, at() { return 'ArtMesh246' } }))], [])
})

test('live2d 鼻部补丁：ids 晚到（前两帧为空）时第三帧重新解析并生效，其它 drawable 不动', async () => {
  const api = await loadRenderer()
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const win = fakeWindow()
  const opacities = NOSE_IDS.map(() => 1)
  // 模型就绪那一刻 drawables.ids 还是空的：第一轮解析必然落空，只能靠 tick 里的重试分支救回来
  const drawables = { ids: [], opacities }
  const { PIXI, model, state } = fakePixi({ coreModel: { _model: { drawables } } })
  const baseUpdate = model.update
  model.update = (delta) => { baseUpdate.call(model, delta); opacities.fill(1) }
  const renders = []
  state.onRender = () => renders.push(Array.from(opacities))
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI, core: {}, avatar: AVATAR, size: 200,
    runtime: { loadScript: async () => {} },
  })
  await stage.promise
  assert.deepEqual([...api.hrLive2dNosePatchIndices(model)], [], '刚就绪时 ids 为空，解析落空')
  tickFrame(win, 16)
  tickFrame(win, 32)
  assert.equal(renders.length, 2)
  assert.deepEqual(renders[0], NOSE_IDS.map(() => 1), 'ids 没到之前不许乱压')
  assert.deepEqual(renders[1], NOSE_IDS.map(() => 1))
  assert.equal(stage.error, null)
  // 第三帧之前 ids 才出现：重试分支必须重新解析，并在 render 之前把目标压到 0
  drawables.ids = NOSE_IDS
  tickFrame(win, 48)
  assert.equal(renders.length, 3)
  assert.equal(renders[2][1], 0)
  assert.equal(renders[2][7], 0)
  assert.equal(renders[2].filter((value) => value === 0).length, NOSE_TARGETS.length, '只压两个目标')
  assert.deepEqual(NOSE_IDS.filter((id, index) => renders[2][index] !== 0), NOSE_KEPT)
  // 解析成功后不再 pending，但每帧 update 仍会重算，所以补丁每帧都要再压一次
  tickFrame(win, 64)
  assert.equal(renders.length, 4)
  assert.equal(renders[3][1], 0)
  assert.equal(renders[3][7], 0)
  assert.equal(stage.error, null)
  stage.destroy()
})

/**
 * 严格按 pixi-live2d-display 0.4.0 的语义搭舞台（真机验收回归用）：
 *   Live2DModel.update(dt)   → 只累加 deltaTime / elapsedTime，不碰 drawable
 *   Live2DModel._render(gl)  → deltaTime 非 0 时 internalModel.update(deltaTime, elapsedTime)，
 *                              再把 deltaTime 清零 —— 这一步会把 opacities 重算回 1
 * 所以「update 之后压 0、render 之前不再处理」的实现在这里必然被冲掉。
 */
function strictNoseStage(api, { avatar = AVATAR, params = null, performance = null } = {}) {
  const opacities = NOSE_IDS.map(() => 1)
  const drawables = { ids: NOSE_IDS, opacities }
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const win = fakeWindow()
  const coreModel = { _model: params ? { drawables, parameterIds: params.ids, parameterValues: params.values } : { drawables } }
  if (params) {
    // 官方 setter 走这条：表演写参优先用它
    coreModel.setParameterValueById = (id, value) => {
      params.calls.push([id, value])
      const index = params.ids.indexOf(id)
      if (index >= 0) params.values[index] = value
    }
  }
  const { PIXI, model, state } = fakePixi({ coreModel })
  model.deltaTime = 0
  model.elapsedTime = 0
  model.update = (delta) => {
    model.updateCalls += 1
    model.lastDelta = delta
    model.deltaTime += delta
    model.elapsedTime += delta
  }
  const advances = []
  model.internalModel.update = (dt, now) => {
    advances.push([dt, now])
    opacities.fill(1)
    // 模拟呼吸/物理：update 里会把角度参数改写成别的值，表演必须在 advance 之后补写一次
    if (params) params.values.fill(-7)
  }
  const renders = []
  state.reupdates = 0
  state.onRender = () => {
    // 复刻 _render：deltaTime 非 0 就再 update 一次（重算 opacity）并清零，然后才画这一帧
    if (Number(model.deltaTime) !== 0) {
      model.internalModel.update(Number(model.deltaTime), model.elapsedTime)
      model.deltaTime = 0
      state.reupdates += 1
    }
    renders.push({ opacities: Array.from(opacities), deltaTime: model.deltaTime, elapsedTime: model.elapsedTime })
  }
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI, core: {}, avatar, size: 200,
    performance,
    runtime: { loadScript: async () => {} },
  })
  return { stage, model, state, win, doc, host, opacities, draws: drawables, renders, advances, params }
}

test('live2d 鼻部补丁：render 内部二次 update 不再冲掉补丁（旧顺序会失败），动画仍逐帧推进', async () => {
  const api = await loadRenderer()

  // —— ① 大肥鱼：新实现下目标在 render 时仍是 0，且每帧刚好推进一次 ——
  const box = strictNoseStage(api)
  await box.stage.promise
  for (const stamp of [16, 32, 48]) tickFrame(box.win, stamp)

  assert.equal(box.renders.length, 3)
  for (const frame of box.renders) {
    assert.equal(frame.opacities[1], 0, 'ArtMesh246 在 render 时必须是 0')
    assert.equal(frame.opacities[7], 0, 'ArtMesh682 在 render 时必须是 0')
    assert.deepEqual(NOSE_IDS.filter((id, index) => frame.opacities[index] !== 0), NOSE_KEPT, '其余阴影面片照常不透明')
    assert.equal(frame.deltaTime, 0, 'render 之前 deltaTime 必须已清零，_render 才会跳过那次 update')
  }
  assert.equal(box.state.reupdates, 0, '补丁生效时 render 内部不许再跑二次 update')
  // 动画推进：每帧恰好一次 internalModel.update，且 dt 非 0、elapsedTime 单调增长
  assert.equal(box.advances.length, 3, '每帧推一次，不多不少')
  assert.deepEqual(box.advances.map(([dt]) => dt), [16.6, 16, 16])
  assert.deepEqual(box.renders.map((frame) => frame.elapsedTime), [16.6, 32.6, 48.6])
  assert.equal(box.model.updateCalls, 3)

  // —— ② 旧顺序为什么不行：update 之后直接 render，_render 的二次 update 把 opacity 抬回 1 ——
  // 复现旧实现这一帧的状态（deltaTime 已累加、尚未推进、opacity 已压 0），然后只调 render。
  box.opacities[1] = 0
  box.opacities[7] = 0
  box.model.deltaTime = 16
  box.state.app.renderer.render(box.state.app.stage)
  assert.equal(box.state.reupdates, 1, 'deltaTime 非 0 时 _render 确实会二次 update')
  assert.deepEqual(box.renders.at(-1).opacities, NOSE_IDS.map(() => 1), '旧顺序在 draw 时看到的就是全 1 —— 黑块照旧')
  assert.equal(box.renders.at(-1).opacities[1], 1)

  // —— ③ 下一帧自愈：新顺序重新压 0，面试不中断 ——
  tickFrame(box.win, 64)
  const healed = box.renders.at(-1)
  assert.equal(healed.opacities[1], 0)
  assert.equal(healed.opacities[7], 0)
  assert.deepEqual(NOSE_IDS.filter((id, index) => healed.opacities[index] !== 0), NOSE_KEPT)
  assert.equal(box.stage.error, null)
  box.stage.destroy()

  // —— ④ 别的模型：完全不受影响，render 内部的 update 照旧由 _render 自己跑 ——
  const other = strictNoseStage(api, { avatar: { ...AVATAR, model: '另一条.model3.json' } })
  await other.stage.promise
  tickFrame(other.win, 16)
  tickFrame(other.win, 32)
  // 解析本身与模型名无关（只是按 ID 找索引）；是否生效由舞台按 avatar.model 决定
  assert.deepEqual([...api.hrLive2dNosePatchIndices(other.model)], NOSE_TARGETS)
  assert.equal(other.state.reupdates, 2, '非目标模型仍走原来的 _render 内 update 路径')
  assert.equal(other.advances.length, 2)
  assert.deepEqual(other.opacities, NOSE_IDS.map(() => 1), '别的模型不许被压任何 drawable')
  for (const frame of other.renders) assert.deepEqual(frame.opacities, NOSE_IDS.map(() => 1))
  assert.equal(other.stage.error, null)
  other.stage.destroy()

  // —— ⑤ 推进器本身的边界：无 delta 是空操作，结构缺失返回 false 且不抛 ——
  const stub = { deltaTime: 5, elapsedTime: 10, internalModel: { update() {} } }
  assert.equal(api.hrLive2dAdvanceFrame(stub), true)
  assert.equal(stub.deltaTime, 0)
  assert.equal(api.hrLive2dAdvanceFrame({ deltaTime: 0 }), true, '没有待推进时间就不算失败')
  assert.equal(api.hrLive2dAdvanceFrame({ deltaTime: 5 }), false, 'internalModel 缺失时安全返回')
  assert.equal(api.hrLive2dAdvanceFrame({}), true)
  assert.equal(api.hrLive2dAdvanceFrame(null), false)
  const boom = { deltaTime: 7, elapsedTime: 7, internalModel: { update() { throw new Error('boom') } } }
  assert.equal(api.hrLive2dAdvanceFrame(boom), false)
  assert.equal(boom.deltaTime, 0, '推进失败也要清 deltaTime，别让 render 内部把补丁冲掉')
})

/** 带参数宿主的大肥鱼舞台：记录每次写参，drawable 每帧被 update 重算回 1。 */
function noseStageWithParams(api, { avatar = AVATAR, performance = null } = {}) {
  const ids = Object.values(api.HR_LIVE2D_PERF_PARAMS).map((spec) => spec.id)
  const values = ids.map(() => 0)
  const calls = []
  const opacities = NOSE_IDS.map(() => 1)
  const coreModel = {
    _model: { drawables: { ids: NOSE_IDS, opacities }, parameterIds: ids, parameterValues: values },
    setParameterValueById(id, value) {
      calls.push([id, value])
      const index = ids.indexOf(id)
      if (index >= 0) values[index] = value
    },
  }
  const doc = fakeDocument()
  const host = fakeHost(doc)
  const win = fakeWindow()
  const { PIXI, model, state } = fakePixi({ coreModel })
  const baseUpdate = model.update
  model.update = (delta) => { baseUpdate.call(model, delta); opacities.fill(1) }
  const stage = api.hrLive2dCreateStage({
    host, window: win, document: doc, PIXI, core: {}, avatar, size: 200,
    performance,
    runtime: { loadScript: async () => {} },
  })
  const param = (id) => values[ids.indexOf(id)]
  return { stage, model, state, win, doc, host, opacities, ids, values, calls, param }
}

test('live2d 取景：fill 是胸口以上近景（等比放大、不切头），card 仍是原来的 contain', async () => {
  const api = await loadRenderer()

  // —— ① card：与改造前逐位一致，不影响面试页以外的小头像 ——
  const card = api.hrLive2dFraming({ mode: 'card', width: 800, height: 300, modelWidth: 800, modelHeight: 600 })
  assert.equal(Math.round(card.scale * 100) / 100, 0.47)
  assert.deepEqual([card.x, card.y], [400, 150])
  assert.equal(card.mode, 'card')

  // —— ② fill：真实画布 3749×7697（report.json boot 段），800×300 的舞台 ——
  const REAL = { modelWidth: 3749, modelHeight: 7697 }
  const close = api.hrLive2dFraming({ mode: 'fill', width: 800, height: 300, ...REAL })
  const displayH = REAL.modelHeight * close.scale
  const displayW = REAL.modelWidth * close.scale
  assert.ok(Math.abs(close.scale - 0.114636) < 1e-6, `近景 scale ≈ 0.114636，实际 ${close.scale}`)
  assert.equal(close.y - displayH / 2, 6, '模型上沿落在视口内 2% 处：头顶不切')
  assert.equal(close.x, 400, '水平居中')
  assert.ok(Math.abs(close.visibleFraction - 0.34) < 1e-9, '默认只显示模型顶部 34%（头顶到胸口）')
  // 脸明显变大：模型顶部 18%（头顶到下颌）这一段，近景比旧 contain 大 3 倍以上
  const oldFit = Math.min(800 / REAL.modelWidth, 300 / REAL.modelHeight) * 0.94
  const faceBand = REAL.modelHeight * 0.18
  assert.ok(faceBand * close.scale > faceBand * oldFit * 3, `近景脸高 ${Math.round(faceBand * close.scale)}px，旧 fit 只有 ${Math.round(faceBand * oldFit)}px`)
  assert.ok(displayW < 800, '横向不裁切：模型显示宽度仍小于视口宽度')

  // —— ③ 宽度变化只改留白，不改比例（等比缩放，不拉伸） ——
  const wide = api.hrLive2dFraming({ mode: 'fill', width: 1600, height: 300, ...REAL })
  assert.equal(wide.scale, close.scale, '舞台更宽不应让模型变形')
  assert.equal(wide.x, 800)
  assert.ok(Math.abs(displayW / displayH - REAL.modelWidth / REAL.modelHeight) < 1e-12, '宽高比守恒')

  // —— ④ 窄面板：近景优先，横向对称裁掉部分肩宽；纵向仍只显示 34% ——
  const narrow = api.hrLive2dFraming({ mode: 'fill', width: 300, height: 900, ...REAL })
  // 900/(7697*0.34) = 0.3439 是「近景理想值」，但横向只留 300px 会把人裁成脸柱，
  // 安全上限 contain*4 = 0.32 生效 —— 顶对齐照旧，头顶不出画。
  assert.equal(Math.round(narrow.scale * 1e6) / 1e6, Math.round((300 / REAL.modelWidth) * 4 * 1e6) / 1e6)
  assert.equal(narrow.y - (REAL.modelHeight * narrow.scale) / 2, 18)
  assert.ok(narrow.visibleFraction > 0.34 && narrow.visibleFraction < 0.42, `极端窄屏牺牲一点近景：${narrow.visibleFraction}`)
  assert.ok(narrow.visibleFraction <= 1)

  // —— ⑤ 非法输入不产生 NaN / 0 缩放（尺寸未测量时的首帧会走进来） ——
  for (const bad of [0, -5, NaN, 'x', undefined, null]) {
    const framing = api.hrLive2dFraming({ mode: 'fill', width: bad, height: bad, modelWidth: bad, modelHeight: bad })
    assert.ok(Number.isFinite(framing.scale) && framing.scale > 0, `坏输入 ${String(bad)} 的 scale 必须有限为正`)
    assert.ok(Number.isFinite(framing.x) && Number.isFinite(framing.y))
    assert.ok(framing.visibleFraction > 0 && framing.visibleFraction <= 1)
  }

  // —— ⑥ fraction / topInset 可覆盖，且夹在合理区间 ——
  const tight = api.hrLive2dFraming({ mode: 'fill', width: 800, height: 300, ...REAL, fraction: 0.2, topInset: 0 })
  assert.ok(tight.visibleFraction < close.visibleFraction, 'fraction 更小 = 更近')
  assert.equal(tight.y - (REAL.modelHeight * tight.scale) / 2, 0)
  const clamped = api.hrLive2dFraming({ mode: 'fill', width: 800, height: 300, ...REAL, fraction: 99, topInset: -1 })
  assert.equal(Math.round(clamped.visibleFraction * 100) / 100, 1, 'fraction 超大被夹到 1（全身），inset 负数夹到 0')

  // —— ⑦ 常见面板宽度 × 常见窗口高度：全部是胸口以上近景（旧实现会退回 44–52% 腰臀以上） ——
  const table = []
  for (const panelWidth of [700, 900, 1200]) {
    for (const windowHeight of [1440, 1920]) {
      const framing = api.hrLive2dFraming({ mode: 'fill', width: panelWidth, height: windowHeight, ...REAL })
      table.push({ panelWidth, windowHeight, scale: Math.round(framing.scale * 10000) / 10000, visibleFraction: Math.round(framing.visibleFraction * 1000) / 1000 })
      assert.ok(framing.visibleFraction <= 0.36, `${panelWidth}×${windowHeight} 仍是全身：visibleFraction=${framing.visibleFraction}`)
      assert.ok(framing.visibleFraction >= 0.33, `${panelWidth}×${windowHeight} 过头了：visibleFraction=${framing.visibleFraction}`)
      assert.equal(framing.x, panelWidth / 2, '左右对称裁切：中心不动')
      assert.ok(Math.abs(framing.y - (REAL.modelHeight * framing.scale) / 2 - windowHeight * 0.02) < 1e-9, '顶对齐不变，不切头')
      assert.ok(framing.visibleWidthFraction < 1, '窄面板必然裁掉左右肩/尾宽，这是近景的代价')
      assert.ok(framing.scale > 0 && Number.isFinite(framing.scale))
      // 等比：任一时刻显示宽度 / 显示高度都必须等于模型本身的比例
      const displayed = (REAL.modelWidth * framing.scale) / (REAL.modelHeight * framing.scale)
      assert.ok(Math.abs(displayed - REAL.modelWidth / REAL.modelHeight) < 1e-12, '不许拉伸')
    }
  }
  assert.equal(table.length, 6)
  assert.deepEqual(table.filter((row) => row.visibleFraction > 0.35), [])
})

test('live2d 表演参数：四种状态各写各的，idle 一个参数都不写', async () => {
  const api = await loadRenderer()
  const idle = api.hrLive2dPerformanceParams({ state: 'idle', t: 12.5, lipLevel: 0.7 })
  assert.equal(idle.active, false, 'idle 必须完全不写参数：呼吸与眨眼仍归原模型')
  assert.deepEqual(Object.keys(idle.values), [])

  // 未知/大小写/空值都回落到 idle —— 回退方向是「不做动作」
  assert.equal(api.hrLive2dPerformanceState('LISTENING '), 'listening')
  assert.equal(api.hrLive2dPerformanceState(' Thinking'), 'thinking')
  for (const state of ['', null, undefined, 'sleeping', 'idle-ish', 7]) assert.equal(api.hrLive2dPerformanceState(state), 'idle')

  const listen = api.hrLive2dPerformanceParams({ state: 'listening', t: 1.2, lipLevel: 0.7 })
  const think = api.hrLive2dPerformanceParams({ state: 'thinking', t: 3.149, lipLevel: 0.7 })
  const speak = api.hrLive2dPerformanceParams({ state: 'speaking', t: 1.2, lipLevel: 0.7 })
  assert.equal(listen.active, true)
  assert.equal(think.active, true)
  assert.equal(speak.active, true)

  // listening：闭嘴 + 视线轻轻偏向候选人（不是盯镜头）+ 点头（低头为负，幅度 ≤1.8°）
  assert.equal(listen.values.mouthOpenY, 0)
  assert.ok(listen.values.mouthForm < 0)
  assert.ok(listen.values.eyeBallY > 0)
  assert.ok(listen.values.eyeBallX > 0.09, `视线略偏候选人一侧：${listen.values.eyeBallX}`)
  assert.ok(Math.abs(listen.values.angleY) <= 1.8, `点头幅度必须克制：${listen.values.angleY}`)
  // thinking：侧头（AngleZ 正）+ 视线抬起偏左，t=3.149 落在脉冲峰值上
  assert.ok(think.values.angleZ > 2.5, `侧头幅度 ${think.values.angleZ}`)
  assert.ok(think.values.eyeBallX < -0.2)
  assert.ok(think.values.eyeBallY > 0.3)
  assert.equal(think.values.mouthOpenY, 0)
  // speaking：嘴型只由 lip 振幅驱动，伴随极轻微前倾
  assert.equal(speak.values.mouthOpenY, 0.9 * 0.7)
  assert.ok(speak.values.bodyAngleX > 0.5 && speak.values.bodyAngleX < 1.7, `前倾 ${speak.values.bodyAngleX}`)
  // thinking 的慢漂移：±0.12° 级别的呼吸感，不要一动不动也不要摇摆
  const thinkPulseFree = [0.05, 0.9, 1.7].map((t) => api.hrLive2dPerformanceParams({ state: 'thinking', t }).values.angleZ)
  assert.ok(new Set(thinkPulseFree.map((value) => Math.round(value * 1000))).size === 3, `脉冲之外仍要有极缓慢漂移：${thinkPulseFree}`)
  for (const value of thinkPulseFree) assert.ok(Math.abs(value) <= 0.15, `漂移幅度 ≤0.15°：${value}`)
  // speaking 的眼睛不许锁死：两秒多一次很小的扫视，左右交替、幅度极小
  const saccades = []
  for (let t = 0; t <= 12; t += 0.02) saccades.push(api.hrLive2dPerformanceParams({ state: 'speaking', t, lipLevel: 0.5 }).values.eyeBallX)
  const moving = saccades.filter((value) => Math.abs(value) > 1e-6)
  assert.ok(moving.length > 0, 'speaking 时眼球要有微扫视')
  assert.ok(moving.some((value) => value > 0.01) && moving.some((value) => value < -0.01), '扫视左右交替，不是单边定格')
  assert.ok(Math.max(...saccades.map(Math.abs)) <= 0.06, `微扫视幅度 ≤0.06：${Math.max(...saccades.map(Math.abs))}`)
  // 四态两两不同
  assert.notEqual(listen.values.angleY, think.values.angleY)
  assert.notEqual(listen.values.angleZ, think.values.angleZ)
  assert.notEqual(speak.values.mouthOpenY, listen.values.mouthOpenY)
  assert.notEqual(idle.active, speak.active)
  assert.notEqual(api.hrLive2dPerformanceParams({ state: 'thinking', t: 0.1 }).values.angleZ, think.values.angleZ, 'thinking 是间歇动作，不是一直侧着头')

  // 确定性：同输入同输出（不许有随机数，否则单测无法复现）
  assert.deepEqual(api.hrLive2dPerformanceParams({ state: 'thinking', t: 3.149, lipLevel: 0.7 }), think)
  // 点头节奏：六七秒才一次、间隔不齐，而且幅度都 ≤1.8°
  const nodTimes = []
  for (let t = 0; t < 48; t += 0.01) {
    const a = api.hrLive2dPerformanceParams({ state: 'listening', t }).values.angleY
    const b = api.hrLive2dPerformanceParams({ state: 'listening', t: t + 0.01 }).values.angleY
    if (a > -0.2 && b <= -0.2) nodTimes.push(Math.round((t + 0.01) * 100) / 100)
  }
  assert.ok(nodTimes.length >= 4 && nodTimes.length <= 8, `48 秒里点头次数应在 4~8 次（7.6s 一次）：${nodTimes}`)
  const gaps = nodTimes.slice(1).map((t, i) => Math.round((t - nodTimes[i]) * 100) / 100)
  for (const gap of gaps) assert.ok(gap >= 6 && gap <= 9.2, `点头间隔应在 6.5~9 秒附近：${gaps}`)
  assert.ok(new Set(gaps).size >= 2, `点头间隔必须不一样：${gaps}`)
  // speaking 的点头：由同一支 ≤0.85 幅度的脉冲驱动，五六秒一次、每次 ≤0.8°
  const speakNodStarts = []
  for (let t = 0; t < 60; t += 0.01) {
    const a = api.hrLive2dSparsePulse(t, 5.5, 0.22, 0.12, 0.85)
    const b = api.hrLive2dSparsePulse(t + 0.01, 5.5, 0.22, 0.12, 0.85)
    if (a === 0 && b > 0) speakNodStarts.push(Math.round((t + 0.01) * 100) / 100)
  }
  assert.ok(speakNodStarts.length >= 9, `60 秒里 speaking 应轻点头约 10 次：${speakNodStarts}`)
  for (let i = 1; i < speakNodStarts.length; i += 1) {
    assert.ok(speakNodStarts[i] - speakNodStarts[i - 1] >= 4.8 && speakNodStarts[i] - speakNodStarts[i - 1] <= 6.3, `点头间隔 5~6 秒：${speakNodStarts}`)
  }
  let speakNodPeak = 0
  for (let t = 0; t < 60; t += 0.01) speakNodPeak = Math.max(speakNodPeak, api.hrLive2dSparsePulse(t, 5.5, 0.22, 0.12, 0.85))
  assert.ok(0.8 * speakNodPeak <= 0.8, `speaking 点头幅度 ≤0.8°：${0.8 * speakNodPeak}`)

  // 克制：任意时刻幅度都在范围内（0..40s 扫描，覆盖多个脉冲）
  const limit = { angleX: 3.2, angleY: 3.2, angleZ: 3.2, bodyAngleX: 1.7 }
  for (const state of ['listening', 'thinking', 'speaking']) {
    for (let t = 0; t <= 40; t += 0.05) {
      const frame = api.hrLive2dPerformanceParams({ state, t, lipLevel: 1 })
      for (const key of Object.keys(limit)) {
        assert.ok(Math.abs(frame.values[key]) <= limit[key], `${state}@${t.toFixed(2)}s ${key}=${frame.values[key]}`)
      }
      assert.ok(frame.values.mouthOpenY >= 0 && frame.values.mouthOpenY <= 1)
      assert.ok(Math.abs(frame.values.eyeBallX) <= 1 && Math.abs(frame.values.eyeBallY) <= 1)
      if (state === 'listening') assert.ok(Math.abs(frame.values.angleY) <= 1.8, `listening 点头幅度：${frame.values.angleY}`)
      if (state === 'speaking') assert.ok(Math.abs(frame.values.angleY) <= 1.3, `speaking 头部动作幅度：${frame.values.angleY}`)
    }
  }

  // 复位值 = 全部 def：离开表演状态时把主动权还给原模型
  const reset = api.hrLive2dPerformanceResetValues()
  assert.deepEqual(Object.keys(reset).sort(), Object.keys(api.HR_LIVE2D_PERF_PARAMS).sort())
  for (const value of Object.values(reset)) assert.equal(value, 0)
  // 参数表必须是 dump 里核实过的 8 个（多一个就可能写坏皮）
  assert.deepEqual(Object.values(api.HR_LIVE2D_PERF_PARAMS).map((spec) => spec.id).sort(), [
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX',
    'ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthForm', 'ParamMouthOpenY',
  ])
  for (const spec of Object.values(api.HR_LIVE2D_PERF_PARAMS)) {
    assert.ok(spec.min < spec.max)
    assert.ok(spec.min <= spec.def && spec.def <= spec.max)
  }
})

test('黑脸跨说话状态和时间保留，清除时取消未加载完的表情，屑屑眼可重播', async () => {
  const api = await loadRenderer()
  const doc = fakeDocument()
  const win = fakeWindow()
  const { PIXI, model, state } = fakePixi()
  const calls = []
  const pending = []
  const manager = {
    reserveExpressionIndex: -1, defaultExpression: '', currentExpression: '',
    stopAllExpressions() { calls.push('reset') },
  }
  model.internalModel.motionManager = { expressionManager: manager }
  model.expression = async (name) => {
    calls.push(name)
    manager.reserveExpressionIndex = name
    await new Promise((resolve) => pending.push(resolve))
    if (manager.reserveExpressionIndex === name) manager.currentExpression = name
  }
  const channel = { state: 'speaking', pressureGesture: 'black-face' }
  const stage = api.hrLive2dCreateStage({
    host: fakeHost(doc), window: win, document: doc, PIXI, core: {}, avatar: AVATAR,
    pressureMode: true, performance: channel, runtime: { loadScript: async () => {} },
  })
  await stage.promise
  try {
    assert.match(state.fromCalls[0].url, /\?pressure-expressions=1$/)
    const frame = (stamp) => win.frames.at(-1)(stamp)
    frame(100)
    assert.equal(calls.at(-1), 'black-face')
    channel.state = 'listening'
    frame(1200)
    assert.equal(calls.at(-1), 'black-face')
    channel.pressureGesture = ''
    frame(1300)
    assert.equal(calls.at(-1), 'reset')
    pending.shift()()
    await Promise.resolve()
    assert.equal(manager.currentExpression, '')
    channel.state = 'speaking'
    channel.pressureGesture = 'doubt'
    frame(1400)
    pending.shift()()
    await Promise.resolve()
    assert.equal(manager.currentExpression, 'doubt')
    channel.pressureGesture = ''
    frame(1500)
    assert.equal(manager.currentExpression, '')
    channel.pressureGesture = 'doubt'
    frame(1600)
    assert.equal(calls.filter((name) => name === 'doubt').length, 2)
  } finally { stage.destroy() }
})

test('压力语气驱动 Live2D 眉眼和头部，嘴型仍由朗读驱动', async () => {
  const api = await loadRenderer()
  const base = { state: 'speaking', t: 0.4, lipLevel: 0.5, reactionAge: 0.4 }
  const standard = api.hrLive2dPerformanceParams(base)
  const question = api.hrLive2dPerformanceParams({ ...base, pressureReaction: 'questioning' })
  const sigh = api.hrLive2dPerformanceParams({ ...base, pressureReaction: 'sigh' })
  assert.equal(standard.values.browLeft, undefined)
  assert.ok(question.values.browLeft > question.values.browRight)
  assert.ok(question.values.angleZ > standard.values.angleZ)
  assert.ok(sigh.values.angleY < standard.values.angleY)
  assert.equal(sigh.values.mouthOpenY, standard.values.mouthOpenY)
  const settled = api.hrLive2dPerformanceParams({ ...base, pressureReaction: 'sigh', reactionAge: 1.6 })
  assert.deepEqual(settled.values, standard.values)
  const firm = api.hrLive2dPerformanceParams({ ...base, pressureReaction: 'firm', reactionAge: 2 })
  assert.ok(firm.values.browLeft < 0)
  assert.equal(firm.values.bodyAngleX, standard.values.bodyAngleX)
  assert.equal(firm.values.mouthOpenY, standard.values.mouthOpenY)
})

test('live2d 表演参数：lipLevel 只认 0..1 的有限数，异常值一律当闭嘴', async () => {
  const api = await loadRenderer()
  assert.equal(api.hrLive2dClampLip(0), 0)
  assert.equal(api.hrLive2dClampLip(0.42), 0.42)
  assert.equal(api.hrLive2dClampLip(1), 1)
  assert.equal(api.hrLive2dClampLip(-3), 0, '负振幅不能变成反向张嘴')
  assert.equal(api.hrLive2dClampLip(2), 1, '超过 1 要夹住')
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, 'x', {}, [], () => 1, Symbol('s')]) {
    assert.equal(api.hrLive2dClampLip(bad), 0, `异常值必须当闭嘴：${String(bad)}`)
  }
  const open = (lipLevel) => api.hrLive2dPerformanceParams({ state: 'speaking', t: 2, lipLevel }).values.mouthOpenY
  assert.equal(open(0), 0, 'speaking 但 lip=0 就是闭嘴基线')
  assert.equal(Math.round(open(0.5) * 1000) / 1000, 0.45)
  assert.equal(open(1), 0.9)
  assert.equal(open(NaN), 0)
  assert.equal(open(undefined), 0)
  assert.equal(open(-1), 0)
  assert.equal(open(Symbol('s')), 0)
})

test('live2d 表演参数：缺参数/缺结构安全回退，不从表演里抛错', async () => {
  const api = await loadRenderer()
  const values = api.hrLive2dPerformanceParams({ state: 'speaking', t: 1, lipLevel: 1 }).values
  // —— ① 没有 coreModel / 空 coreModel / model 为空：0 条写入，不抛 ——
  assert.equal(api.hrLive2dApplyPerformance(null, values), 0)
  assert.equal(api.hrLive2dApplyPerformance({}, values), 0)
  assert.equal(api.hrLive2dApplyPerformance({ internalModel: {} }, values), 0)
  assert.equal(api.hrLive2dApplyPerformance({ internalModel: { coreModel: {} } }, values), 0)
  assert.equal(api.hrLive2dApplyPerformance({ internalModel: { coreModel: {} } }, null), 0)
  assert.equal(api.hrLive2dApplyPerformance({ internalModel: { coreModel: {} } }, {}), 0)

  // —— ② 官方 setter 优先，写前按真实范围夹一次 ——
  const calls = []
  const setterModel = { internalModel: { coreModel: { setParameterValueById(id, value) { calls.push([id, value]) } } } }
  assert.equal(api.hrLive2dApplyPerformance(setterModel, { mouthOpenY: 5, mouthForm: 3, angleZ: -99 }), 3, '表里没有的 key 不写')
  assert.deepEqual(calls, [['ParamMouthOpenY', 1], ['ParamMouthForm', 1], ['ParamAngleZ', -30]])

  // —— ③ 没有 setter 时按 parameterIds 索引写（数组 / csmVector 两种形状） ——
  const ids = ['ParamMouthOpenY', 'ParamAngleZ', 'ParamEyeBallX']
  const parameterValues = [0, 0, 0]
  const indexModel = { internalModel: { coreModel: { _model: { parameterIds: ids, parameterValues } } } }
  assert.equal(api.hrLive2dApplyPerformance(indexModel, { mouthOpenY: 0.4, angleZ: 2, eyeBallX: -0.5, angleY: 9 }), 3)
  assert.deepEqual([...parameterValues], [0.4, 2, -0.5])
  const vector = { getSize: () => 2, at: (i) => ['ParamMouthForm', 'ParamEyeBallY'][i] }
  const vectorValues = [0, 0]
  assert.equal(api.hrLive2dApplyPerformance({ internalModel: { coreModel: { _model: { parameterIds: vector, parameterValues: vectorValues } } } }, { mouthForm: -0.5, eyeBallY: 0.25 }), 2)
  assert.deepEqual(vectorValues, [-0.5, 0.25])

  // —— ④ setter 自己抛（签名不同/内部断言）：退化到索引写，仍然不崩 ——
  const fallbackValues = [0]
  const throwing = {
    internalModel: {
      coreModel: {
        _model: { parameterIds: ['ParamMouthOpenY'], parameterValues: fallbackValues },
        setParameterValueById() { throw new Error('签名不同') },
      },
    },
  }
  assert.equal(api.hrLive2dApplyPerformance(throwing, { mouthOpenY: 0.8 }), 1)
  assert.deepEqual(fallbackValues, [0.8])
})

test('live2d 表演：只对 大肥鱼 生效、每帧读 lipLevelRef，切回 idle 后彻底不碰参数', async () => {
  const api = await loadRenderer()

  // —— ① 大肥鱼：speaking + ref.current=0.8 → 每帧 ParamMouthOpenY = 0.72 ——
  const big = noseStageWithParams(api, { performance: { state: 'speaking', lipLevelRef: { current: 0.8 } } })
  await big.stage.promise
  tickFrame(big.win, 16)
  tickFrame(big.win, 32)
  assert.equal(big.stage.performance.enabled, true)
  assert.ok(Math.abs(big.param('ParamMouthOpenY') - 0.9 * 0.8) < 1e-9, '嘴型由 ref 驱动，不靠 re-render')
  assert.ok(big.stage.performance.writes > 0)
  // 直接改 ref（模拟播放进度）：下一帧立刻跟上，没有新的 render
  big.stage.performance.channel.lipLevelRef.current = 1
  tickFrame(big.win, 48)
  assert.equal(big.param('ParamMouthOpenY'), 0.9)

  // —— ② 切回 idle：复位一次，之后不再写（呼吸/眨眼重新接管） ——
  const before = big.calls.length
  big.stage.performance.channel.state = 'idle'
  tickFrame(big.win, 64)
  assert.equal(big.param('ParamMouthOpenY'), 0, '离开表演状态要把写过的参数还给模型')
  const resetCount = big.calls.length
  assert.ok(resetCount > before, '复位必须真的写一次默认值')
  tickFrame(big.win, 80)
  tickFrame(big.win, 96)
  assert.equal(big.calls.length, resetCount, 'idle 之后彻底不碰参数')
  big.stage.destroy()

  // —— ③ 别的模型：同样的 performanceState 也一个参数都不写 ——
  const other = noseStageWithParams(api, { avatar: { ...AVATAR, model: '另一条.model3.json' }, performance: { state: 'speaking', lipLevelRef: { current: 1 } } })
  await other.stage.promise
  assert.equal(other.stage.performance.enabled, false)
  tickFrame(other.win, 16)
  tickFrame(other.win, 32)
  tickFrame(other.win, 48)
  assert.equal(other.calls.length, 0)
  assert.deepEqual([...other.values], other.values.map(() => 0))
  other.stage.destroy()

  // —— ④ 判定是精确相等，不做模糊匹配 ——
  assert.equal(api.hrLive2dPerformanceApplies('大肥鱼.model3.json'), true)
  for (const name of ['另一条.model3.json', '大肥鱼.model3.json ', '大肥鱼.model3.json.bak', '大肥鱼.model3.jsonx', '', null, undefined, 0]) {
    assert.equal(api.hrLive2dPerformanceApplies(name), false, `${String(name)} 不该启用表演`)
  }
  assert.deepEqual([...api.HR_LIVE2D_PERFORMANCE_STATES], ['idle', 'listening', 'thinking', 'speaking'])
})

test('live2d 表演 + 鼻部补丁：render 时补丁仍生效，参数不被 update 冲掉，动画仍每帧只推一次', async () => {
  const api = await loadRenderer()
  const ids = Object.values(api.HR_LIVE2D_PERF_PARAMS).map((spec) => spec.id)
  const params = { ids, values: ids.map(() => 0), calls: [] }
  const box = strictNoseStage(api, { params, performance: { state: 'speaking', lipLevelRef: { current: 0.8 } } })
  await box.stage.promise
  for (const stamp of [16, 32, 48]) tickFrame(box.win, stamp)

  // 鼻部补丁：render 那一刻仍然是 0，旧顺序在这里会失败
  assert.equal(box.state.reupdates, 0, '表演不能打破「render 里不再二次 update」')
  assert.equal(box.renders.length, 3)
  for (const frame of box.renders) {
    assert.equal(frame.opacities[1], 0, 'ArtMesh246 在 render 时必须是 0')
    assert.equal(frame.opacities[7], 0, 'ArtMesh682 在 render 时必须是 0')
    assert.deepEqual(NOSE_IDS.filter((id, index) => frame.opacities[index] !== 0), NOSE_KEPT)
    assert.equal(frame.deltaTime, 0)
  }
  // 动画推进：每帧恰好一次 internalModel.update，dt 序列不变
  assert.equal(box.advances.length, 3)
  assert.deepEqual(box.advances.map(([dt]) => dt), [16.6, 16, 16])
  assert.deepEqual(box.renders.map((frame) => frame.elapsedTime), [16.6, 32.6, 48.6])

  // 参数：update 里被呼吸/物理改写成 -7，advance 之后的第二遍写把它压回表演值
  for (const value of params.values) assert.notEqual(value, -7, '表演值必须盖住 update 的改写')
  assert.ok(Math.abs(params.values[ids.indexOf('ParamMouthOpenY')] - 0.9 * 0.8) < 1e-9)
  assert.equal(params.values[ids.indexOf('ParamMouthForm')], -0.05)
  const bodyAngleX = params.values[ids.indexOf('ParamBodyAngleX')]
  assert.ok(bodyAngleX > 0.5 && bodyAngleX < 1.7, `前倾 ${bodyAngleX}`)
  assert.ok(box.stage.performance.writes >= 3)
  assert.equal(box.stage.error, null)
  box.stage.destroy()

  // 非目标模型（同一套夹具）：update/render 行为与改造前完全一致
  const other = strictNoseStage(api, { avatar: { ...AVATAR, model: '另一条.model3.json' }, params: { ids, values: ids.map(() => 0), calls: [] } })
  await other.stage.promise
  tickFrame(other.win, 16)
  tickFrame(other.win, 32)
  assert.equal(other.state.reupdates, 2, '非目标模型仍走原来的 _render 内 update 路径')
  assert.deepEqual(other.params.calls, [], '非目标模型不许写任何参数')
  assert.deepEqual([...other.params.values], other.params.values.map(() => -7), '原 update 的改写保持原样，无人覆盖')
  other.stage.destroy()
})

test('Live2DAvatar：performanceState / lipLevelRef 走稳定通道，不触发舞台重挂', async (t) => {
  const tools = loadReactTools()
  if (!tools || typeof tools.createRoot !== 'function' || typeof tools.act !== 'function' || !tools.jsdom) {
    t.skip('缺少 react / react-dom / jsdom 测试依赖')
    return
  }
  const { React, createRoot, act, jsdom } = tools
  const api = await loadRenderer()
  const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = win
  globalThis.document = win.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  try {
    const stages = []
    const Live2DAvatar = api.hrLive2dComponent(React, {
      createStage(config) {
        const stage = { config, destroyed: false, promise: Promise.resolve(null), destroy() { stage.destroyed = true } }
        stages.push(stage)
        return stage
      },
    })
    const container = win.document.getElementById('root')
    const rootInstance = createRoot(container)
    const lipA = { current: 0.5 }
    await act(async () => {
      rootInstance.render(React.createElement(Live2DAvatar, { avatar: AVATAR, size: 200, fill: true, performanceState: 'listening', lipLevelRef: lipA }))
    })
    assert.equal(stages.length, 1)
    assert.equal(stages[0].config.performance.state, 'listening')
    assert.equal(stages[0].config.performance.lipLevelRef, lipA)

    // 切状态 + 换 ref：同一个舞台对象，通道字段被就地刷新（不重挂、不重载模型）
    const lipB = { current: 0.9 }
    await act(async () => {
      rootInstance.render(React.createElement(Live2DAvatar, { avatar: AVATAR, size: 200, fill: true, performanceState: 'speaking', lipLevelRef: lipB }))
    })
    assert.equal(stages.length, 1, '状态切换不许重建舞台')
    assert.equal(stages[0].destroyed, false)
    assert.equal(stages[0].config.performance.state, 'speaking')
    assert.equal(stages[0].config.performance.lipLevelRef, lipB)

    // 默认值：不传就是 idle / 空 ref（面试页非表演场景不会崩）
    const plain = api.hrLive2dComponent(React, {
      createStage(config) { const stage = { config, destroyed: false, promise: Promise.resolve(null), destroy() { stage.destroyed = true } }; stages.push(stage); return stage },
    })
    await act(async () => { rootInstance.render(React.createElement(plain, { avatar: AVATAR, size: 200 })) })
    const last = stages.at(-1)
    assert.equal(last.config.performance.state, 'idle')
    assert.equal(last.config.performance.lipLevelRef, null)
    await act(async () => { rootInstance.unmount() })
    assert.equal(last.destroyed, true)
    assert.equal(container.innerHTML, '')
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
})

test('构建产物：渲染器与 client 同域内联，无模块语法，可被 vm 执行', async () => {
  const { output, packageName } = await buildClient({ root, write: false })
  assert.equal(packageName, 'dsh-hr-interview')
  assert.match(output, /window\.__ModuleLoader__\.load/)
  assert.doesNotMatch(output, /^import /m)
  assert.doesNotMatch(output, /^export /m)
  assert.match(output, /hrLive2dComponent/)
  assert.match(output, /hrLive2dModelUrl/)
  // 内联顺序：contract 在前，渲染器在 client 的 HRMark 之前
  assert.ok(output.indexOf('HR_CLIENT_REMOTE') < output.indexOf('hrLive2dComponent'))
  assert.ok(output.indexOf('hrLive2dComponent') < output.indexOf('function HRMark'))
  // 形象仍只有一个替换点：两处调用点都把 capabilities.avatar 透传下去
  const passThrough = output.match(/avatar: capabilities\?\.avatar/g) || []
  assert.equal(passThrough.length, 2, 'SetupView 与 InterviewView 都要传 avatar')
  assert.match(output, /const live = enabled && !paused && Boolean\(avatar\) && avatar\.kind === 'live2d' && avatar\.available !== false/)
  // 假 React 就能跑通工厂函数：说明内联进的是同一作用域、没有模块边界
  let factory = null
  const sandboxWindow = { __ModuleLoader__: { load({ factory: fn }) { factory = fn } } }
  const context = vm.createContext({ window: sandboxWindow, console })
  vm.runInContext(output, context, { filename: 'client.js' })
  assert.equal(typeof factory, 'function')
  const stubReact = { createElement() {}, useEffect() {}, useRef() {}, useState() {}, useCallback() {}, useMemo() {} }
  const mod = factory(() => stubReact)
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], ['slots', 'locale', 'remote'])
})
