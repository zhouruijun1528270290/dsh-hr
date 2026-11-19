import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { HR_LOCAL_CAMERA_PATH } from '../lib/contract.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = `${path.join(here, '..')}${path.sep}`

// 组件是普通浏览器脚本（无 import/export），单测把它当文本丢进 vm，取回导出的函数。
// window 按用例注入 context.window —— 组件内部用 typeof window 现取，顶层不碰它。
async function loadCamera() {
  const source = await readFile(new URL('../src/candidate-camera.js', import.meta.url), 'utf8')
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, console, HR_LOCAL_CAMERA_PATH })
  vm.runInContext(source, context, { filename: 'src/candidate-camera.js' })
  return { api: module.exports, context, source }
}

// react / jsdom 走 live2d-client.test.js 相同的探测顺序；缺依赖时相关用例 skip，不报假绿。
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

const REACT_TOOLS = loadReactTools()
const SKIP = REACT_TOOLS && typeof REACT_TOOLS.createRoot === 'function' && typeof REACT_TOOLS.act === 'function' && REACT_TOOLS.jsdom
  ? false
  : '缺少 react / react-dom / jsdom 测试依赖'

/** 假流：轨道带 stop 计数与 ended 监听表，用来证明「每条轨道都有确定的释放路径」。 */
function fakeStream(label = 'cam', count = 1) {
  const tracks = Array.from({ length: count }, (_, index) => {
    const listeners = new Set()
    return {
      kind: 'video',
      label: `${label}-${index}`,
      stopCalls: 0,
      listeners,
      addEventListener(type, handler) {
        if (type === 'ended' && typeof handler === 'function') listeners.add(handler)
      },
      removeEventListener(type, handler) {
        if (type === 'ended') listeners.delete(handler)
      },
      stop() { this.stopCalls += 1 },
    }
  })
  const stream = {
    label,
    tracks,
    getTracks() { return tracks.slice() },
    getVideoTracks() { return tracks.slice() },
    getAudioTracks() { return [] },
    endedListeners() { return tracks.reduce((sum, track) => sum + track.listeners.size, 0) },
    /** 模拟设备掉线：触发当前仍挂着的 ended 监听。 */
    emitEnded() { return stream.fireHandlers([...tracks[0].listeners]) },
    /** 直接触发指定处理函数（含已被摘掉的旧监听，用于验证旧流不污染新流）。 */
    fireHandlers(handlers) {
      for (const handler of handlers) handler({ type: 'ended' })
    },
    /** 取当前 ended 处理函数快照，供「摘掉后仍被误触发」用例使用。 */
    captureEnded() { return [...tracks[0].listeners] },
  }
  return stream
}

function deferred() {
  const box = {}
  box.promise = new Promise((resolve, reject) => { box.resolve = resolve; box.reject = reject })
  return box
}

/** 假 mediaDevices：记录每次 getUserMedia 的约束对象。 */
function fakeMedia(impl) {
  const calls = []
  return {
    calls,
    getUserMedia(constraint) {
      calls.push(constraint)
      return impl(constraint, calls.length)
    },
  }
}

function cameraError(name, message) {
  const error = new Error(message || name)
  error.name = name
  return error
}

async function mount(loaded, options = {}) {
  const { React, createRoot, act, jsdom } = REACT_TOOLS
  const { props = {}, media, play } = options
  const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://interview.local/' })
  const win = dom.window
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = win
  globalThis.document = win.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const plays = []
  win.HTMLMediaElement.prototype.play = function playStub() {
    plays.push(this)
    return play ? play(this) : Promise.resolve()
  }
  win.HTMLMediaElement.prototype.pause = function pauseStub() { this.pauseCalls = (this.pauseCalls || 0) + 1 }
  if (media) Object.defineProperty(win.navigator, 'mediaDevices', { configurable: true, value: media })
  loaded.context.window = win
  const Camera = loaded.api.hrCandidateCameraComponent(React)
  const container = win.document.getElementById('root')
  const rootInstance = createRoot(container)
  const harness = {
    win, container, plays, Camera, rootInstance, act,
    status() {
      const node = container.querySelector('.hri-candidate-camera')
      return node ? node.getAttribute('data-status') : null
    },
    video() { return container.querySelector('video.hri-candidate-video') },
    note() {
      const node = container.querySelector('.hri-candidate-camera-note')
      return node ? node.textContent : ''
    },
    button(text) {
      return [...container.querySelectorAll('button')].find((node) => node.textContent === text) || null
    },
    async render(next = props) {
      await act(async () => { rootInstance.render(React.createElement(Camera, next)) })
    },
    /** 点一个按钮，并让 getUserMedia 的 then 链与 play() 都跑完。 */
    async click(text) {
      const node = harness.button(text)
      assert.ok(node, `找不到按钮：${text}`)
      await act(async () => {
        node.click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    },
    /** 让在途 promise 在 act 里落地（含晚到流的清理）。 */
    async settle(fn) {
      await act(async () => {
        fn()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    },
    async unmount() {
      await act(async () => { rootInstance.unmount() })
    },
    cleanup() {
      globalThis.window = previous.window
      globalThis.document = previous.document
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
      try { win.close() } catch { /* 已关闭 */ }
    },
  }
  await harness.render(props)
  return harness
}

test('默认关闭：不请求任何媒体流，只显示「你 · 候选人」占位与开启按钮', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const media = fakeMedia(() => Promise.resolve(fakeStream()))
  const h = await mount(loaded, { media })
  try {
    assert.equal(media.calls.length, 0, '挂载不得自动调用 getUserMedia')
    assert.equal(h.status(), 'idle')
    assert.match(h.container.innerHTML, /hri-candidate-camera/)
    assert.match(h.container.innerHTML, /你 · 候选人/)
    assert.match(h.container.innerHTML, /hri-candidate-camera-placeholder/)
    assert.equal(h.video(), null, '未开启时不得有 video')
    assert.ok(h.button('开启摄像头'))
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.idle)
  } finally { h.cleanup() }
})

test('点击后只请求 video（audio 显式 false），成功后 video 挂 srcObject 并自动播放', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const stream = fakeStream('first')
  const media = fakeMedia(() => Promise.resolve(stream))
  const h = await mount(loaded, { media })
  try {
    await h.click('开启摄像头')
    assert.equal(media.calls.length, 1)
    assert.deepEqual({ ...media.calls[0] }, { video: true, audio: false }, '只请求视频，不得请求音频')
    assert.equal(h.status(), 'live')
    const video = h.video()
    assert.ok(video, '成功后必须渲染 video.hri-candidate-video')
    assert.equal(video.srcObject, stream, 'srcObject 必须是拿到的流')
    assert.equal(video.muted, true, '本地预览必须静音，避免回声')
    assert.equal(video.hasAttribute('playsinline'), true)
    assert.equal(video.autoplay, true)
    const styleAttr = video.getAttribute('style') || ''
    assert.ok(video.style.objectFit === 'cover' || /object-fit:\s*cover/.test(styleAttr), '预览必须 object-fit: cover')
    assert.ok(h.plays.length >= 1, '必须显式 play()')
    assert.equal(h.win.document.querySelectorAll('video').length, 1)
    assert.ok(h.button('关闭摄像头'))
  } finally { h.cleanup() }
})

test('点「关闭摄像头」：停掉所有轨道、清空 srcObject、回到占位', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const stream = fakeStream('close', 2)
  const h = await mount(loaded, { media: fakeMedia(() => Promise.resolve(stream)) })
  try {
    await h.click('开启摄像头')
    const video = h.video()
    await h.click('关闭摄像头')
    assert.deepEqual(stream.tracks.map((track) => track.stopCalls), [1, 1], '每条轨道都必须 stop')
    assert.equal(video.srcObject, null, '关闭后 srcObject 必须清空')
    assert.equal(h.video(), null)
    assert.equal(h.status(), 'idle')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.closed)
    assert.ok(h.button('开启摄像头'))
  } finally { h.cleanup() }
})

test('paused=true 释放并清空；恢复后不会自动重开，必须再点一次', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const first = fakeStream('first')
  const second = fakeStream('second')
  const media = fakeMedia((_, index) => Promise.resolve(index === 1 ? first : second))
  const h = await mount(loaded, { media })
  try {
    await h.click('开启摄像头')
    const video = h.video()
    assert.equal(h.status(), 'live')
    await h.render({ paused: true })
    assert.deepEqual(first.tracks.map((track) => track.stopCalls), [1], '暂停必须停掉轨道')
    assert.equal(video.srcObject, null, '暂停必须清空 srcObject')
    assert.equal(h.video(), null)
    assert.equal(h.status(), 'idle')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.paused)
    const pausedButton = h.button('开启摄像头')
    assert.equal(pausedButton.disabled, true, '暂停时按钮必须禁用')
    pausedButton.click()
    assert.equal(media.calls.length, 1, '暂停中点击不得发起新请求')
    await h.render({ paused: false })
    assert.equal(media.calls.length, 1, '恢复后不得未经操作自动重开')
    assert.equal(h.video(), null)
    assert.equal(h.status(), 'idle')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.idle)
    await h.click('开启摄像头')
    assert.equal(media.calls.length, 2, '恢复后必须由用户再点一次')
    assert.equal(h.status(), 'live')
    assert.equal(h.video().srcObject, second)
  } finally { h.cleanup() }
})

test('active=false 释放并清空（面试未开始时保持关闭）', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const stream = fakeStream('idle-off')
  const h = await mount(loaded, { media: fakeMedia(() => Promise.resolve(stream)) })
  try {
    await h.click('开启摄像头')
    const video = h.video()
    await h.render({ active: false })
    assert.equal(stream.tracks[0].stopCalls, 1)
    assert.equal(video.srcObject, null)
    assert.equal(h.video(), null)
    assert.equal(h.status(), 'idle')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.inactive)
  } finally { h.cleanup() }
})

test('卸载：停掉轨道并清空已挂载 video 的 srcObject', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const stream = fakeStream('unmount', 2)
  const h = await mount(loaded, { media: fakeMedia(() => Promise.resolve(stream)) })
  try {
    await h.click('开启摄像头')
    const video = h.video()
    assert.ok(video)
    await h.unmount()
    assert.deepEqual(stream.tracks.map((track) => track.stopCalls), [1, 1], '卸载必须停掉所有轨道')
    assert.equal(video.srcObject, null, '卸载必须清空 srcObject')
    assert.equal(h.container.innerHTML, '')
  } finally { h.cleanup() }
})

test('晚到流（暂停竞态）：requesting 中暂停，晚到的流立即 stop 且不显示 video', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const pending = deferred()
  const stream = fakeStream('late-pause', 2)
  const h = await mount(loaded, { media: fakeMedia(() => pending.promise) })
  try {
    await h.click('开启摄像头')
    assert.equal(h.status(), 'requesting')
    await h.render({ paused: true })
    assert.equal(h.status(), 'idle')
    await h.settle(() => pending.resolve(stream))
    assert.deepEqual(stream.tracks.map((track) => track.stopCalls), [1, 1], '晚到的流必须立刻释放每条轨道')
    assert.equal(h.video(), null, '晚到的流不得显示')
    assert.equal(h.status(), 'idle')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.paused)
  } finally { h.cleanup() }
})

test('晚到流（卸载竞态）：卸载后 resolve 的流同样立即 stop', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const pending = deferred()
  const stream = fakeStream('late-unmount', 2)
  const h = await mount(loaded, { media: fakeMedia(() => pending.promise) })
  try {
    await h.click('开启摄像头')
    assert.equal(h.status(), 'requesting')
    await h.unmount()
    await h.settle(() => pending.resolve(stream))
    assert.deepEqual(stream.tracks.map((track) => track.stopCalls), [1, 1])
    assert.equal(h.container.innerHTML, '')
  } finally { h.cleanup() }
})

test('权限被拒绝：显示可读文案 + 占位，且不泄露 error.message / 设备信息', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const media = fakeMedia(() => Promise.reject(cameraError('NotAllowedError', 'Permission denied for device /dev/video0 at 192.168.1.7')))
  const h = await mount(loaded, { media })
  try {
    await h.click('开启摄像头')
    assert.equal(h.status(), 'error')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.denied)
    assert.match(h.container.innerHTML, /hri-candidate-camera-placeholder/)
    assert.equal(h.video(), null)
    assert.doesNotMatch(h.container.innerHTML, /video0|192\.168\.1\.7|NotAllowedError/, '错误文案不得回显底层错误或设备信息')
    assert.ok(h.button('开启摄像头'), '失败后仍可重试，不阻断面试')
  } finally { h.cleanup() }
})

test('Windows 相机由点击打开一次，失败可重试，画面留在系统窗口', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const media = fakeMedia(() => { throw new Error('Windows 相机不使用 getUserMedia') })
  const pending = deferred()
  let calls = 0
  const openWindowsCamera = () => ++calls === 1 ? pending.promise : Promise.resolve({ requested: true })
  const h = await mount(loaded, { props: { openWindowsCamera, framed: false }, media })
  try {
    assert.equal(calls, 0)
    assert.equal(h.button('开启摄像头'), null)
    const button = h.button('打开 Windows 相机')
    await h.settle(() => { button.click(); button.click() })
    assert.equal(calls, 1)
    assert.equal(h.status(), 'requesting')
    await h.settle(() => pending.reject(new Error('C:/private/device')))
    assert.match(h.note(), /开始菜单/)
    assert.doesNotMatch(h.note(), /private/)
    await h.click('打开 Windows 相机')
    assert.equal(calls, 2)
    assert.match(h.note(), /请关闭相机窗口/)
    assert.equal(h.video(), null)
    assert.equal(media.calls.length, 0)
  } finally { await h.unmount(); h.cleanup() }
})

test('本机实时预览绘制到候选人画布，关闭后中止读取并释放授权', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const token = 'ab'.repeat(32)
  const stops = []
  const media = fakeMedia(() => { throw new Error('不得请求网页摄像头') })
  const h = await mount(loaded, { media, props: {
    framed: false,
    startLocalCamera: async () => ({ token }),
    stopLocalCamera: async (closed) => { stops.push(closed) },
  } })
  let painted = 0
  let released = 0
  let request
  try {
    h.win.fetch = async (path, options) => {
      assert.equal(path, HR_LOCAL_CAMERA_PATH)
      assert.equal(options.headers['X-HR-Camera-Token'], token)
      assert.equal(options.cache, 'no-store')
      request = options
      if (options.headers['X-HR-Camera-After'] === '1') {
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      return { status: 200, headers: { get: () => '1' }, blob: async () => ({}) }
    }
    h.win.createImageBitmap = async () => ({ width: 64, height: 48, close() { released += 1 } })
    h.win.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() { painted += 1 } })
    assert.equal(request, undefined)
    await h.click('开启本机预览')
    const canvas = h.container.querySelector('.hri-candidate-local-video')
    assert.equal(h.status(), 'live')
    assert.equal(canvas.width, 64)
    assert.equal(canvas.height, 48)
    assert.equal(h.container.querySelector('.hri-candidate-camera-actions').style.position, 'absolute')
    assert.ok(painted > 0)
    assert.equal(released, painted)
    assert.equal(h.video(), null)
    assert.equal(media.calls.length, 0)
    await h.click('关闭摄像头')
    assert.equal(h.status(), 'idle')
    assert.equal(canvas.width, 1)
    assert.equal(request.signal.aborted, true)
    assert.deepEqual(stops, [token])
  } finally { await h.unmount(); h.cleanup() }
})

test('没有 mediaDevices：给出「不支持」提示，不抛异常也不阻断面试', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const h = await mount(loaded) // 不注入 mediaDevices
  try {
    assert.equal(loaded.api.hrCandidateMedia(h.win), null)
    await h.click('开启摄像头')
    assert.equal(h.status(), 'error')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.unsupported)
    assert.equal(h.video(), null)
    assert.ok(h.button('开启摄像头'))
  } finally { h.cleanup() }
})

test('没有摄像头（NotFoundError）：显示可读提示，不暴露设备细节', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const media = fakeMedia(() => Promise.reject(cameraError('NotFoundError', 'Requested device not found: USB Camera (VID_1234)')))
  const h = await mount(loaded, { media })
  try {
    await h.click('开启摄像头')
    assert.equal(h.status(), 'error')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.notfound)
    assert.doesNotMatch(h.container.innerHTML, /USB Camera|VID_1234/)
  } finally { h.cleanup() }
})

test('video.play() 被拒：显示可读错误、释放轨道、清空 srcObject', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const stream = fakeStream('play-fail', 2)
  const h = await mount(loaded, {
    media: fakeMedia(() => Promise.resolve(stream)),
    play: () => Promise.reject(new Error('NotAllowedError: play() blocked')),
  })
  try {
    await h.click('开启摄像头')
    assert.equal(h.status(), 'error')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.play)
    assert.deepEqual(stream.tracks.map((track) => track.stopCalls), [1, 1], '播放失败也必须释放轨道')
    assert.equal(h.video(), null)
    assert.doesNotMatch(h.container.innerHTML, /play\(\) blocked/)
    assert.ok(h.button('开启摄像头'))
  } finally { h.cleanup() }
})

test('重复点击只发起一次请求（防重复点击 / 重复请求）', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const pending = deferred()
  const stream = fakeStream('dup')
  const media = fakeMedia(() => pending.promise)
  const h = await mount(loaded, { media })
  try {
    await h.act(async () => {
      const button = h.button('开启摄像头')
      assert.ok(button)
      button.click()
      button.click()
      await Promise.resolve()
    })
    assert.equal(media.calls.length, 1, '双击只能有一次 getUserMedia')
    assert.equal(h.status(), 'requesting')
    const again = h.button('开启摄像头')
    assert.equal(again, null, '请求中按钮文案应变为「正在开启…」')
    assert.ok(h.button('正在开启…'))
    await h.settle(() => pending.resolve(stream))
    assert.equal(h.status(), 'live')
    assert.equal(stream.tracks[0].stopCalls, 0)
  } finally { h.cleanup() }
})

test('运行时无第三方依赖，辅助函数可独立验证（stop 幂等 / 错误映射 / 无 require）', async () => {
  const loaded = await loadCamera()
  const api = loaded.api
  assert.doesNotMatch(loaded.source, /\brequire\s*\(/, '运行时不得 require 任何包')
  assert.doesNotMatch(loaded.source, /^\s*(import|export)\s/m, '必须是可内联的普通脚本')
  assert.throws(() => api.hrCandidateCameraComponent(null), /需要 React/)
  const stream = fakeStream('unit', 3)
  assert.equal(api.hrCandidateStopStream(stream), 3)
  assert.deepEqual(stream.tracks.map((track) => track.stopCalls), [1, 1, 1])
  assert.equal(api.hrCandidateStopStream(stream), 3, '重复调用仍需返回轨道数')
  assert.deepEqual(stream.tracks.map((track) => track.stopCalls), [2, 2, 2])
  assert.equal(api.hrCandidateStopStream(null), 0)
  assert.equal(api.hrCandidateStopStream({}), 0)
  const broken = { getTracks() { throw new Error('closed') } }
  assert.equal(api.hrCandidateStopStream(broken), 0, '取轨道失败时按 0 处理，不抛')
  assert.equal(api.hrCandidateErrorText(cameraError('NotAllowedError')), api.HR_CANDIDATE_TEXT.denied)
  assert.equal(api.hrCandidateErrorText(cameraError('NotFoundError')), api.HR_CANDIDATE_TEXT.notfound)
  assert.equal(api.hrCandidateErrorText(cameraError('NotReadableError')), api.HR_CANDIDATE_TEXT.busy)
  assert.equal(api.hrCandidateErrorText(cameraError('SecurityError')), api.HR_CANDIDATE_TEXT.insecure)
  const weird = cameraError('SomeVendorError', 'device USB Camera VID_9999 unavailable')
  assert.equal(api.hrCandidateErrorText(weird), api.HR_CANDIDATE_TEXT.failed)
  assert.doesNotMatch(api.hrCandidateErrorText(weird), /VID_9999|SomeVendorError/, '错误文案不得回显原文')
  assert.equal(api.hrCandidateErrorText(undefined), api.HR_CANDIDATE_TEXT.failed)
})

test('framed=false：根节点无内联边框/padding/圆角/背景，标题栏 absolute 覆盖画面，不叠第三层框', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const stream = fakeStream('framed-off')
  const h = await mount(loaded, { props: { framed: false }, media: fakeMedia(() => Promise.resolve(stream)) })
  try {
    const root = h.container.querySelector('.hri-candidate-camera')
    assert.ok(root)
    assert.equal(root.getAttribute('data-framed'), 'false')
    const styleAttr = root.getAttribute('style') || ''
    assert.equal(root.style.position, 'relative', '根节点必须 relative，供 absolute 标题栏定位')
    assert.equal(root.style.height, '100%')
    assert.match(styleAttr, /min-height:\s*0(px)?/, '根节点不得自带最小高度')
    assert.match(styleAttr, /padding:\s*0(px)?/, 'framed=false 不得有内联 padding')
    assert.match(styleAttr, /border(?:-width)?:\s*0(px)?/, 'framed=false 不得有内联边框')
    assert.match(styleAttr, /border-radius:\s*0(px)?/, 'framed=false 不得有内联圆角')
    assert.match(styleAttr, /background-color:\s*transparent/, 'framed=false 不得自带底色')

    const header = h.container.querySelector('.hri-candidate-camera-head')
    assert.ok(header)
    assert.equal(header.style.position, 'absolute')
    assert.equal(header.style.top, '10px')
    assert.equal(header.style.left, '10px')
    assert.equal(header.style.right, '10px')
    assert.equal(header.style.zIndex, '2', '标题栏必须压在画面上（z-index: 2）')

    const stage = h.container.querySelector('.hri-candidate-camera-stage')
    assert.ok(stage)
    assert.equal(stage.style.minHeight, '0px', '画面容器交给外部定高舞台分配高度')

    // 非 live 时舞台是浅色占位：白字裸放会看不见，标题与角标必须带自己的深色胶囊。
    assert.equal(h.status(), 'idle')
    const pillSpans = [
      h.container.querySelector('.hri-candidate-camera-title'),
      h.container.querySelector('.hri-candidate-camera-badge'),
    ]
    for (const span of pillSpans) {
      assert.ok(span, '标题与状态角标都必须存在')
      const spanStyle = span.getAttribute('style') || ''
      assert.match(spanStyle, /background-color:\s*rgba\(15,\s*23,\s*42,\s*0?\.55\)/, `浅色占位上必须带深色胶囊底：${span.className}`)
      assert.match(spanStyle, /border-radius:\s*999px/, '胶囊需圆角')
      assert.match(spanStyle, /padding:\s*4px 10px/, '胶囊内边距')
      assert.match(spanStyle, /color:\s*(#fff|rgb\(255,\s*255,\s*255\))/, '胶囊文字为白色')
      assert.match(spanStyle, /font-size:\s*12px/, '胶囊字号统一 12px')
      assert.match(spanStyle, /font-weight:\s*600/)
      assert.match(spanStyle, /text-shadow:/, '保留文字阴影')
    }
    assert.equal(h.container.querySelector('.hri-candidate-camera-badge').textContent, '已关闭')

    await h.click('开启摄像头')
    assert.equal(h.status(), 'live')
    const video = h.video()
    assert.ok(video)
    assert.equal(video.srcObject, stream)
    assert.equal(video.style.objectFit, 'cover', 'framed=false 仍要铺满画面')
    assert.equal(h.note(), '', 'framed=false 的正常状态不再重复隐私说明')
    assert.match(h.container.querySelector('.hri-candidate-camera-badge').textContent, /预览中/, '自己的状态 badge 必须保留')
    assert.match(h.container.querySelector('.hri-candidate-camera-badge').getAttribute('style') || '', /background-color:\s*rgba\(15,\s*23,\s*42/, 'live 时胶囊底仍在')
    assert.ok(h.button('关闭摄像头'), '自己的关闭按钮必须保留')
  } finally { h.cleanup() }
})

test('framed 默认（true）/显式 true：保持原卡片样式与隐私说明', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const h = await mount(loaded, { media: fakeMedia(() => Promise.resolve(fakeStream('framed-on'))) })
  try {
    const root = h.container.querySelector('.hri-candidate-camera')
    assert.equal(root.getAttribute('data-framed'), 'true')
    assert.equal(root.style.padding, '10px')
    assert.equal(root.style.borderRadius, '12px')
    assert.match(root.getAttribute('style') || '', /border:\s*1px solid/, 'framed=true 保留自己的边框')
    assert.notEqual(h.container.querySelector('.hri-candidate-camera-head').style.position, 'absolute')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.idle, 'framed=true 仍显示隐私说明')
    // framed=true 走卡片自己的浅色底，不加胶囊底。
    const plainBadge = h.container.querySelector('.hri-candidate-camera-badge')
    assert.doesNotMatch(plainBadge.getAttribute('style') || '', /rgba\(15,\s*23,\s*42/, 'framed=true 不得被胶囊样式污染')
    assert.equal(plainBadge.style.fontSize, '11px')
  } finally { h.cleanup() }
})

test('framed=false 的错误状态仍显示简洁错误（占位 + 可读文案，不阻断面试）', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const media = fakeMedia(() => Promise.reject(cameraError('NotAllowedError', 'denied: /dev/video0 at 10.0.0.9')))
  const h = await mount(loaded, { props: { framed: false }, media })
  try {
    await h.click('开启摄像头')
    assert.equal(h.status(), 'error')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.denied, '错误状态必须保留一句话错误')
    assert.match(h.container.innerHTML, /hri-candidate-camera-placeholder/)
    assert.doesNotMatch(h.container.innerHTML, /video0|10\.0\.0\.9|NotAllowedError/)
    assert.ok(h.button('开启摄像头'))
  } finally { h.cleanup() }
})

test('轨道 ended（设备掉线）：释放全部轨道、回到错误状态并可重试', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const stream = fakeStream('lost', 2)
  const h = await mount(loaded, { media: fakeMedia(() => Promise.resolve(stream)) })
  try {
    await h.click('开启摄像头')
    assert.equal(h.status(), 'live')
    assert.equal(stream.endedListeners(), 2, '每条轨道都要挂 ended 监听')
    await h.settle(() => stream.emitEnded())
    assert.equal(h.status(), 'error')
    assert.equal(h.note(), loaded.api.HR_CANDIDATE_TEXT.lost, '掉线要给可读状态，不阻断面试')
    assert.deepEqual(stream.tracks.map((track) => track.stopCalls), [1, 1], '掉线必须释放所有轨道')
    assert.equal(stream.endedListeners(), 0, '释放后必须摘掉 ended 监听')
    assert.equal(h.video(), null)
    assert.ok(h.button('开启摄像头'), '掉线后可手动重新开启')
  } finally { h.cleanup() }
})

test('旧流的 ended 晚触发：不得改动新流的状态，也不误停新轨道', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const first = fakeStream('old')
  const second = fakeStream('new')
  const queue = [first, second]
  const h = await mount(loaded, { media: fakeMedia(() => Promise.resolve(queue.shift())) })
  try {
    await h.click('开启摄像头')
    assert.equal(h.video().srcObject, first)
    const staleHandlers = first.captureEnded()
    assert.equal(staleHandlers.length, 1)
    await h.click('关闭摄像头')
    await h.click('开启摄像头')
    assert.equal(h.status(), 'live')
    assert.equal(h.video().srcObject, second)
    // 旧流已释放，但监听若还残留并被触发，也不许把新流打成错误。
    await h.settle(() => first.fireHandlers(staleHandlers))
    assert.equal(h.status(), 'live', '旧流的回调不得改变新流状态')
    assert.equal(h.video().srcObject, second)
    assert.equal(second.tracks[0].stopCalls, 0, '旧流回调不得误停新流轨道')
    assert.equal(first.tracks[0].stopCalls, 1)
  } finally { h.cleanup() }
})

test('关闭 / 暂停 / 卸载都摘掉 ended 监听（每条轨道只剩确定的释放路径）', { skip: SKIP }, async () => {
  const loaded = await loadCamera()
  const streams = [fakeStream('g1'), fakeStream('g2'), fakeStream('g3')]
  const h = await mount(loaded, { media: fakeMedia(() => Promise.resolve(streams.shift())) })
  try {
    await h.click('开启摄像头')
    const first = h.video().srcObject
    assert.equal(first.endedListeners(), 1)
    await h.click('关闭摄像头')
    assert.equal(first.endedListeners(), 0, '关闭必须摘监听')
    assert.equal(first.tracks[0].stopCalls, 1)

    await h.click('开启摄像头')
    const second = h.video().srcObject
    assert.equal(second.endedListeners(), 1)
    await h.render({ paused: true })
    assert.equal(second.endedListeners(), 0, '暂停必须摘监听')
    assert.equal(second.tracks[0].stopCalls, 1)

    await h.render({ paused: false })
    await h.click('开启摄像头')
    const third = h.video().srcObject
    assert.equal(third.endedListeners(), 1)
    await h.unmount()
    assert.equal(third.endedListeners(), 0, '卸载必须摘监听')
    assert.equal(third.tracks[0].stopCalls, 1)
  } finally { h.cleanup() }
})
