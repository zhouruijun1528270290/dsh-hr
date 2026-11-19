import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { buildClient, MISSING_PART } from '../scripts/build-lib.mjs'
import { parseStartOptions, parseAudio, parseMaterials, remoteFailure, HR_SERVICE, HR_HOST_CONTRIBUTION } from '../lib/contract.js'
import { apply as applyHost } from '../index.js'
const root = fileURLToPath(new URL('../', import.meta.url))
test('browser bundle parses and contains the remote contract without Node imports', async () => {
  const { output } = await buildClient({ root, write: false })
  assert.match(output, /window\.__ModuleLoader__\.load/)
  assert.match(output, /HR_CLIENT_REMOTE/)
  assert.doesNotMatch(output, /^import /m)
})
test('typed RPC normalizes pressure mode and validates bounded inputs', () => {
  assert.deepEqual(parseStartOptions({ mode: 'pressure', inputMode: 'voice', durationMinutes: 30 }), { mode: 'mock', persona: 'pressure', inputMode: 'voice', durationMinutes: 30, parentSessionId: null, preparationId: null, targetKnowledgePointId: null, asrProvider: 'auto', ttsProvider: 'auto', voice: 'stella' })
  assert.equal(parseAudio({ audioBase64: Buffer.from('synthetic audio').toString('base64'), mimeType: 'audio/wav', durationMs: 1000 }).durationMs, 1000)
  assert.equal(parseMaterials({ role: 'R', resume: 'resume', jd: 'jd', projectNotes: '' }).role, 'R')
  assert.throws(() => parseAudio({ audioBase64: 'bad', mimeType: 'audio/wav', durationMs: 0 }), /Audio|duration/)
  assert.equal(remoteFailure('x', 'y').code, 'x')
  assert.equal(parseAudio({ audioBase64: Buffer.from('synthetic audio').toString('base64'), mimeType: 'audio/webm;codecs=opus', durationMs: 1000 }).mimeType, 'audio/webm')
  assert.throws(() => parseAudio({ audioBase64: Buffer.from('synthetic audio').toString('base64'), mimeType: 'text/plain', durationMs: 1000 }), /MIME/)
})
test('host apply binds the service and registers the typed RPC contribution', () => {
  let provided = null; let contribution = null; const injections = []
  const child = { llm: { stream() {} }, typert: { register(value) { contribution = value } }, provide(name, value) { provided = { name, value } }, effect() {} }
  const speechChild = { speechToText: { snapshot: () => ({ providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }], selection: { providerId: 'sensevoice-local' } }) } }
  // rc.9：Key 只走 DSH credentials，环境变量是只读回退 —— 所以 host 会先注入 credentials。
  const stored = []
  const credentialsChild = { credentials: { describe: async (ref) => ({ configured: stored.length > 0, source: 'file', writable: true }), resolve: async () => stored[0] || null, set: async (ref, value) => { stored[0] = value }, unset: async () => { stored.length = 0 } } }
  applyHost({ inject(names, callback) { injections.push([...names]); if (names[0] === 'credentials') callback(credentialsChild); else if (names[0] === 'typert') callback(child); else if (names[0] === 'speechToText') callback(speechChild) } })
  // rc.9：Key 只走 DSH credentials，环境变量是只读回退 —— 所以 host 会先注入 credentials。
  // 其余子服务由主会话拆成独立 inject 调用，顺序按 index.js 里的实际写法断言。
  assert.deepEqual(injections, [['webServer'], ['credentials'], ['typert'], ['web'], ['agents', 'tools', 'systemPrompt'], ['llm'], ['speechToText']])
  assert.equal(provided.name, HR_SERVICE); assert.equal(provided.value.constructor.name, 'HRInterviewService'); assert.equal(contribution, HR_HOST_CONTRIBUTION)
  assert.equal(provided.value.speech.capabilities().asrMode, 'host-local')
})
test('browser bundle evaluates and mounts locale plus remote without reference errors', async () => {
  const { output } = await buildClient({ root, write: false }); let factory
  const window = { __ModuleLoader__: { load(definition) { factory = definition.factory } } }
  const React = { createElement() {}, useCallback: (value) => value, useEffect() {}, useMemo: (value) => value, useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] }
  vm.runInNewContext(output, { window })
  const client = factory((id) => { assert.equal(id, 'react'); return React })
  let mounted = null; let locales = null; let injected = null
  const ctx = {
    locale: { register(ns, value) { locales = { ns, value } }, bind() { return (key) => key } },
    remote: { $mount: async (value) => { mounted = value }, hrInterview: {} },
    inject: async (names, callback) => { injected = names; await callback(ctx) }, effect(callback) { callback() }, slots: { inject() {} },
  }
  await client.apply(ctx)
  assert.ok(mounted); assert.deepEqual(Object.keys(locales.value), ['en', 'zh']); assert.deepEqual([...injected], ['remote.hrInterview'])
})

// —— 真实 React 首屏渲染回归 ——
// 上一条测试的假 React 只验证 apply 不抛错：slots.inject 是空函数、注册到的组件从不 render，
// 于是「函数组件把 children 写成第二个形参」这类错误（渲染期才炸）完全测不出来。
// 这里用真实 react/react-dom 的 renderToStaticMarkup 把 main slot 注册到的组件渲染一次。
async function loadRealReact() {
  const candidates = [
    process.env.HR_TEST_REACT_DIR,
    path.join(root, 'node_modules'),
  ].filter(Boolean)
  for (const dir of candidates) {
    try {
      const req = createRequire(path.join(dir, '__probe__.cjs'))
      const React = req('react')
      const { renderToStaticMarkup } = req('react-dom/server')
      if (typeof renderToStaticMarkup === 'function') return { React, renderToStaticMarkup }
    } catch { /* 该目录没有 react，试下一个 */ }
  }
  return null
}

// 把 Panel 的首个 useState 种成指定 tab，其余 hook 全部走真实 React：
// 这样 react-dom 仍用真实调度器渲染子树（MaterialsView 里的 setValue 会真的执行），
// 而纯假 React 会把 setState 变成空函数、从而掩盖“渲染期调用 setter”这类缺陷。
function seedStates(React, seeds = {}) {
  let call = 0
  return {
    ...React,
    useState: (initial) => {
      call += 1
      const value = Object.hasOwn(seeds, call) ? seeds[call] : initial
      const pair = React.useState(value)
      return [value, pair[1]]
    },
  }
}

// 挂载一遍客户端 bundle，返回 main slot 注册到的那个组件
// overrides：把某一段（如 src/candidate-camera.js）换成探针源码，用来断言 client 真的把 props 传下去了，
// 而不必猜真组件内部渲染成什么样。其余段落照旧读磁盘，内联顺序与生产构建完全一致。
async function mountMainPanel(React, { brokenMount = false, seedTab, seedBundle, seedCapabilities, seedAvatarEnabled, seedBackground, capabilities = null, overrides = {}, location, openWindowsCamera, startLocalCamera, stopLocalCamera } = {}) {
  const { output } = await buildClient({ root, write: false, overrides })
  let factory
  const window = { location, __ModuleLoader__: { load(definition) { factory = definition.factory } } }
  vm.runInNewContext(output, { window })
  const seeds = { ...(seedTab ? { 1: seedTab } : {}), ...(seedCapabilities ? { 2: seedCapabilities } : {}), ...(seedBundle ? { 3: seedBundle } : {}), ...(seedAvatarEnabled ? { 6: true } : {}), ...(seedBackground ? { 7: seedBackground } : {}) }
  const client = factory((id) => { assert.equal(id, 'react'); return Object.keys(seeds).length ? seedStates(React, seeds) : React })
  const dictionaries = {}
  const registered = []
  const api = {
    capabilities: async () => capabilities || { configured: true, asrConfigured: false, asrPreparation: null },
    list: async () => ({ sessions: [], knowledge: [] }),
    materials: async () => ({ role: '', resume: '', jd: '', projectNotes: '' }),
    saveMaterials: async (value) => value,
    openWindowsCamera,
    startLocalCamera,
    stopLocalCamera,
  }
  const ctx = {
    effect: (callback) => callback(),
    locale: { register(ns, value) { dictionaries[ns] = value; return () => {} }, bind(ns) { return (key) => dictionaries[ns][key] } },
    remote: { $mount: async () => { if (brokenMount) throw new Error('remote mount down') } },
    inject: async (names, callback) => { assert.deepEqual([...names], ['remote.hrInterview']); await callback({ ...ctx, remote: { ...ctx.remote, hrInterview: api } }) },
    slots: {
      inject: (_name, callback) => callback(),
      register(options, component) { registered.push({ options, component }); return () => {} },
      entries: () => [],
    },
  }
  await client.apply(ctx)
  const main = registered.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'main slot 必须注册（否则点击入口时中央面板只会是空白）')
  assert.equal(main.options.key, 'hr-interview')
  // 探针把调用记录写进 vm 沙箱的 window 上；把沙箱挂回组件，测试才读得到。
  main.component.__sandbox = window
  return main.component
}

// 替身候选人组件：只记录 props，不碰摄像头。client 若漏传/传错 paused、active、framed，这里立刻看得见。
const CANDIDATE_PROBE = `
function hrCandidateCameraComponent(React) {
  const h = React.createElement
  return function CandidateCameraProbe({ paused = false, active = true, framed = true } = {}) {
    const calls = window.__hrCandidateCameraCalls || (window.__hrCandidateCameraCalls = [])
    calls.push({ paused, active, framed })
    return h('div', { className: 'hri-probe-candidate' }, paused ? '候选人：已暂停' : active ? '候选人：待开启' : '候选人：未激活')
  }
}
`

test('main panel renders its first screen with real React (SSR)', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom：运行 npm ci 或设置 HR_TEST_REACT_DIR'); return }
  const { React, renderToStaticMarkup } = real
  const tabLabels = ['面试', '材料', '历史与回炉']
  const assertShell = (html, scenario) => {
    assert.match(html, /HR 面试攻防/, `${scenario}: 缺少面板标题`)
    for (const label of tabLabels) {
      assert.match(html, new RegExp('<button[^>]*>' + label + '</button>'), `${scenario}: 缺少 tab 按钮「${label}」——Button 的 children 很可能没从 props 取`)
    }
  }

  // 场景一：remote 注入成功，应渲染 SetupView
  const Panel = await mountMainPanel(React, { brokenMount: false })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  assertShell(html, 'api 正常')
  assert.match(html, /面试准备/, 'api 正常时应渲染首屏入口')
  assert.match(html, /DeepSeek ASR/, '设置页应包含 DeepSeek ASR 选择')
  assert.match(html, /试听 HR 声音/, '设置页应包含音色试听')
  assert.doesNotMatch(html, /data-slot-error/)

  // 场景二：remote mount 失败，应降级成「Host 服务尚未连接」而不是白屏
  const DegradedPanel = await mountMainPanel(React, { brokenMount: true })
  const degraded = renderToStaticMarkup(React.createElement(DegradedPanel, {}))
  assertShell(degraded, 'remote mount 失败')
  assert.match(degraded, /Host 服务尚未连接/, '远程注入失败时必须自报家门，不能留空白')
})

test('Live2D 默认关闭，只显示显式启用开关与静态回退', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const capabilities = {
    configured: true, asrConfigured: true, asrPreparation: null,
    avatar: { kind: 'live2d', available: true, base: '/hr-avatar', model: '大肥鱼.model3.json', runtimeBase: '/hr-runtime', reason: 'ok' },
  }
  const Panel = await mountMainPanel(real.React, { capabilities, seedCapabilities: capabilities })
  const html = real.renderToStaticMarkup(real.React.createElement(Panel, {}))
  assert.match(html, /启用 Live2D 面试官（实验/)
  assert.match(html, /<section class="hri-setup-interviewer"[^>]*>[\s\S]*HR 技术面试官[\s\S]*type="checkbox"[\s\S]*<\/section>[\s\S]*<details[^>]*data-hri-setup-settings/)
  assert.equal((html.match(/启用 Live2D 面试官/g) || []).length, 1, '预览和开关只在准备页主区出现')
  assert.match(html, /type="checkbox"/)
  assert.doesNotMatch(html, /class="hri-live2d"/, '默认关闭时不能自动加载约 60MB 模型')
})

test('materials tab renders its form with real React (SSR)', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom：运行 npm ci 或设置 HR_TEST_REACT_DIR'); return }
  const { React, renderToStaticMarkup } = real
  const Panel = await mountMainPanel(React, { seedTab: 'materials' })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  assert.match(html, /面试材料/, '材料页缺少标题')
  assert.match(html, /目标岗位/, '材料页缺少「目标岗位」字段')
  assert.equal((html.match(/<textarea/g) || []).length, 3, '材料页应有 3 个 textarea（简历 / 岗位 JD / 项目补充）')
  assert.match(html, /保存材料/, '材料页缺少「保存材料」按钮')
  assert.doesNotMatch(html, /data-slot-error/)
})

test('history tab renders headings and empty states with real React (SSR)', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom：运行 npm ci 或设置 HR_TEST_REACT_DIR'); return }
  const { React, renderToStaticMarkup } = real
  const Panel = await mountMainPanel(React, { seedTab: 'history' })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  assert.match(html, /历史场次/, '历史页缺少「历史场次」标题')
  assert.match(html, /还没有面试记录/, '历史页空状态缺失')
  assert.match(html, /知识点回炉/, '历史页缺少「知识点回炉」标题')
  assert.match(html, /复盘后生成知识点与复查时间/, '知识点空状态缺失')
  assert.doesNotMatch(html, /data-slot-error/)
})

test('voice interview renders DeepSeek recording controls with real React (SSR)', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom：运行 npm ci 或设置 HR_TEST_REACT_DIR'); return }
  const { React, renderToStaticMarkup } = real
  const bundle = {
    session: { sessionId: 'hr-ssr-voice', status: 'waiting_for_answer', inputMode: 'voice', asrProvider: 'deepseek', ttsProvider: 'deepseek', voice: 'stella', mainQuestionCount: 1, questionBudget: 4, persona: 'professional', mode: 'mock' },
    turns: [{ id: 't-hr-1', speaker: 'hr', kind: 'main_question', questionBasis: 'simulation', text: '请做一个简短自我介绍。' }], evaluation: null,
  }
  const Panel = await mountMainPanel(React, { seedBundle: bundle })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  assert.match(html, /请做一个简短自我介绍/)
  assert.match(html, /当前问题 · 模拟题/)
  const questionAt = html.indexOf('class="hri-room-question"')
  const scrollAt = html.indexOf('class="hri-room-scroll"')
  assert.ok(questionAt > 0 && scrollAt > questionAt, '首题必须位于舞台和记录滚动区上方')
  assert.equal(depthAt(html, questionAt), depthAt(html, scrollAt), '当前题目与滚动区必须同级')
  assert.equal((html.match(/请做一个简短自我介绍/g) || []).length, 1, '回答前题干只显示在当前问题卡上')
  // 切换式：按钮文案写清「按一下开始、再按一下结束」以及空格也能切换；不再有按住语义。
  assert.match(html, /开始回答（空格）/)
  assert.match(html, /data-hri-voice-toggle="true"/)
  assert.match(html, /默认不落盘/)
  assert.match(html, /110 秒自动收尾/)
  assert.doesNotMatch(html, /按住说话|松开结束|识别完成，请核对/, '不再有按住录音与识别确认步骤')
  assert.doesNotMatch(html, /data-slot-error/)
})

// —— 左右双屏舞台（左 HR 大 Live2D / 右候选人本地画面）——
const STAGE_AVATAR = { kind: 'live2d', available: true, base: '/hr-avatar', model: '大肥鱼.model3.json', runtimeBase: '/hr-runtime', reason: 'ok' }
const stageCapabilities = () => ({ configured: true, asrConfigured: true, asrPreparation: null, avatar: STAGE_AVATAR })
const interviewBundle = (status) => ({
  session: { sessionId: 'hr-stage-1', status, inputMode: 'text', asrProvider: 'deepseek', ttsProvider: 'deepseek', voice: 'stella', mainQuestionCount: 1, questionBudget: 6, persona: 'professional', mode: 'mock' },
  turns: [{ id: 't-hr-1', speaker: 'hr', kind: 'main_question', text: '请介绍一下你最有挑战性的项目。' }],
  evaluation: null,
})

test('Windows 桌面端显示系统相机入口，其他窗口显示页面内摄像头入口', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const seedCapabilities = { ...stageCapabilities(), windowsCamera: true }
  const seedBundle = interviewBundle('waiting_for_answer')
  const openWindowsCamera = () => { throw new Error('渲染时不得打开相机') }
  for (const [url, expected] of [
    ['dsh-app://app/', '打开 Windows 相机'],
    ['dsh-app://shell/', '开启摄像头'],
    ['https://interview.local/', '开启摄像头'],
  ]) {
    const Panel = await mountMainPanel(React, { seedBundle, seedCapabilities, location: new URL(url), openWindowsCamera })
    const markup = renderToStaticMarkup(React.createElement(Panel))
    assert.match(markup, new RegExp(`>${expected}</button>`))
  }
  const native = await mountMainPanel(React, {
    seedBundle, seedCapabilities: { ...seedCapabilities, localCamera: true }, location: new URL('dsh-app://app/'),
    openWindowsCamera, startLocalCamera: openWindowsCamera, stopLocalCamera: openWindowsCamera,
  })
  const markup = renderToStaticMarkup(React.createElement(native))
  assert.match(markup, />开启本机预览<\/button>/)
  assert.match(markup, /class="hri-candidate-local-video"/)
})

test('双屏舞台：左 HR 大画面在前、右候选人画面在后，面试页不再塞 190px 小头像', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const capabilities = stageCapabilities()
  const Panel = await mountMainPanel(React, {
    capabilities, seedCapabilities: capabilities, seedBundle: interviewBundle('waiting_for_answer'), seedAvatarEnabled: true,
    overrides: { 'src/candidate-camera.js': CANDIDATE_PROBE },
  })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  assert.match(html, /class="hri-stage-grid"/, '面试页首屏必须是双屏栅格')
  const hrAt = html.indexOf('hri-stage hri-stage-hr')
  const candidateAt = html.indexOf('hri-stage hri-stage-candidate')
  assert.ok(hrAt > 0 && candidateAt > hrAt, 'HR 舞台必须在左、候选人舞台必须在右（按 DOM 顺序判断）')
  assert.match(html, /HR 面试官/, '左屏缺少「HR 面试官」标签')
  assert.match(html, /hri-live2d-fill/, '舞台模式的 Live2D 必须铺满左屏，而不是 190px 卡片')
  // 隐私披露：参考图要求双屏下方明确写一次；framed=false 的组件正常态不重复显示 note
  const noteHits = (html.match(/视频不上传 · 不做表情评分/g) || []).length
  assert.equal(noteHits, 1, '「视频不上传 · 不做表情评分」必须恰好出现一次')
  assert.doesNotMatch(html, /HR 技术面试官/, '面试页仍把小头像/标题塞在舞台旁')
  assert.doesNotMatch(html, /data-slot-error/)
  const calls = Panel.__sandbox.__hrCandidateCameraCalls || []
  assert.ok(calls.length >= 1, '候选人组件必须真的被渲染进右屏')
  // 探针记录来自 vm 沙箱另一个 realm，逐字段断言，别让原型链差异假冒成「props 传错」
  assert.equal(calls.at(-1).paused, false, '进行中：paused 必须是 false')
  assert.equal(calls.at(-1).active, true, '进行中：active 必须是 true')
  assert.equal(calls.at(-1).framed, false, '外框由 .hri-stage 提供，必须传 framed=false')
})

test('双屏舞台：会话暂停时给候选人组件传 paused=true，并卸载 Live2D 舞台', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const capabilities = stageCapabilities()
  const Panel = await mountMainPanel(React, {
    capabilities, seedCapabilities: capabilities, seedBundle: interviewBundle('paused'), seedAvatarEnabled: true,
    overrides: { 'src/candidate-camera.js': CANDIDATE_PROBE },
  })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  const calls = Panel.__sandbox.__hrCandidateCameraCalls || []
  assert.ok(calls.length >= 1)
  assert.equal(calls.at(-1).paused, true, '暂停必须沿 props 传成 paused=true（组件据此关摄像头）')
  assert.equal(calls.at(-1).active, true, '暂停时 active 仍为 true：只是暂停，不是结束')
  assert.match(html, /已暂停/)
  // 只看标记，不看 <style>：css 里有 `.hri-live2d canvas{…}` 规则，模糊匹配会误报
  assert.doesNotMatch(html, /class="hri-live2d/, '暂停后 Live2D 舞台必须卸载，不能再跑 PIXI')
  assert.match(html, /HR 面试官形象：已暂停/, '舞台位回退成静态头像，不留空白')
})

test('双屏舞台：真实候选人组件在右屏渲染，首屏不出现 video、不自动开摄像头', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const Panel = await mountMainPanel(React, { seedBundle: interviewBundle('waiting_for_answer') })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  assert.match(html, /hri-candidate-camera/, '右屏应渲染真实的候选人摄像头组件')
  assert.match(html, /你 · 候选人/)
  assert.doesNotMatch(html, /<video/, '默认关闭：首屏不能有 video 元素（也不该请求媒体权限）')
})

test('双屏舞台：复盘/评测阶段不再申请摄像头（active=false），暂停仍只算暂停', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  for (const status of ['review_pending', 'evaluating', 'completed']) {
    const Panel = await mountMainPanel(React, {
      seedBundle: interviewBundle(status), seedAvatarEnabled: true,
      overrides: { 'src/candidate-camera.js': CANDIDATE_PROBE },
    })
    renderToStaticMarkup(React.createElement(Panel, {}))
    const calls = Panel.__sandbox.__hrCandidateCameraCalls || []
    assert.ok(calls.length >= 1, `${status} 也要把候选人组件渲染出来`)
    assert.equal(calls.at(-1).active, false, `${status} 已离开答题阶段：active 必须是 false（不许留着一个亮着的摄像头）`)
    assert.equal(calls.at(-1).paused, false, `${status} 不是暂停，paused 必须是 false`)
    assert.equal(calls.at(-1).framed, false, `${status} 外框同样由 .hri-stage 提供`)
  }
})

test('双屏舞台：默认不开 Live2D 时左屏摆 120px 静态圆并提示可开启', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  // seedAvatarEnabled 不传 = 默认 false（与真实首屏一致）
  const Panel = await mountMainPanel(React, {
    seedBundle: interviewBundle('waiting_for_answer'),
    overrides: { 'src/candidate-camera.js': CANDIDATE_PROBE },
  })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  assert.match(html, /class="hri-hr-stage"/)
  assert.match(html, /HR 面试官形象：静态头像/, '未启用时仍是可访问的静态头像')
  assert.match(html, /width:120px;height:120px/, '大舞台里的静态圆是 120px，不是 92px 小点')
  assert.match(html, /未启用 Live2D 形象 · 可在开始面试前开启/, '要告诉用户这是可以开启的，不是坏了')
  assert.doesNotMatch(html, /class="hri-live2d/, '默认不加载 Live2D 运行时')
})

test('Setup 页不变成双屏舞台：原小标识与开始按钮保持不变', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const Panel = await mountMainPanel(real.React, {})
  const html = real.renderToStaticMarkup(real.React.createElement(Panel, {}))
  assert.match(html, /面试准备/)
  assert.match(html, /HR 技术面试官/, 'Setup 的 48px 小标识必须还在')
  // class 断言要带引号：<style> 里也有 .hri-stage-grid / .hri-hr-stage 这些规则名
  assert.doesNotMatch(html, /class="hri-stage-grid"/)
  assert.doesNotMatch(html, /class="hri-stage hri-stage-hr"/)
  assert.doesNotMatch(html, /class="hri-hr-stage"/)
  assert.doesNotMatch(html, /class="hri-candidate-camera/, 'Setup 不该预挂候选人摄像头')
})

// —— HR 虚拟背景（只在面试页左屏的 stage 变体生效）——
// Host 契约写死这两项；测试不造假字节：只断言 src 指向契约里的相对路径，绝不请求真实图片。
const HR_BACKGROUNDS = [
  { id: 'office', label: '现代办公室', url: '/hr-background/office.webp' },
  { id: 'meeting-room', label: '会议室', url: '/hr-background/meeting-room.webp' },
]

test('虚拟背景：Setup 只在 capabilities.backgrounds 可用时给出「HR 虚拟背景」下拉，默认现代办公室', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const withBackgrounds = { ...stageCapabilities(), backgrounds: HR_BACKGROUNDS }
  const Panel = await mountMainPanel(React, { capabilities: withBackgrounds, seedCapabilities: withBackgrounds })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))
  const fieldAt = html.indexOf('HR 虚拟背景')
  assert.ok(fieldAt > 0, 'Host 给了背景列表，Setup 就必须出现「HR 虚拟背景」这一项')
  const field = html.slice(fieldAt, html.indexOf('</label>', fieldAt))
  assert.match(field, /<select/, '「HR 虚拟背景」必须是一个下拉')
  assert.match(field, /<option value="office"[^>]*selected[^>]*>现代办公室<\/option>/, '默认必须选中 office（现代办公室）')
  assert.match(field, /<option value="meeting-room"[^>]*>会议室<\/option>/)
  assert.match(field, /<option value="off"[^>]*>关闭背景<\/option>/, '必须能一键关掉背景')
  assert.equal((field.match(/<option\b/g) || []).length, 3, '选项只该是两项背景 + 关闭背景，不许夹带其它值')
  // Setup 自己的 48px 小标识不许被大背景顶掉：badge 变体不画背景层。
  assert.doesNotMatch(html, /class="hri-hr-backdrop/, 'Setup 的 badge 不该画大背景')
  assert.doesNotMatch(html, /<img\b/, 'Setup 页不该出现任何背景图')

  for (const backgrounds of [undefined, []]) {
    const caps = stageCapabilities()
    if (backgrounds !== undefined) caps.backgrounds = backgrounds
    const Plain = await mountMainPanel(React, { capabilities: caps, seedCapabilities: caps })
    const plainHtml = renderToStaticMarkup(React.createElement(Plain, {}))
    assert.doesNotMatch(plainHtml, /HR 虚拟背景/, `backgrounds=${JSON.stringify(backgrounds)} 时不该出现空的背景设置`)
    assert.match(plainHtml, /HR 技术面试官/, '其余设置项与 badge 都必须原样保留')
  }
})

test('虚拟背景：面试页按选中的 office / meeting-room 画背景 img，关闭背景或非法 id 一律不画', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const render = async (background, backgrounds = HR_BACKGROUNDS) => {
    const caps = { ...stageCapabilities(), backgrounds }
    const Panel = await mountMainPanel(React, {
      capabilities: caps, seedCapabilities: caps, seedBackground: background,
      seedBundle: interviewBundle('waiting_for_answer'),
      overrides: { 'src/candidate-camera.js': CANDIDATE_PROBE },
    })
    return renderToStaticMarkup(React.createElement(Panel, {}))
  }
  // 默认 office（Panel 的初始 state 就是 office，不 seed 也必须是它）
  const officeHtml = await render(undefined)
  assert.match(officeHtml, /class="hri-hr-backdrop"/, '默认背景必须真的画出来')
  assert.match(officeHtml, /<img class="hri-hr-backdrop-img" src="\/hr-background\/office\.webp" alt="" aria-hidden="true"/, '默认背景必须是契约里的站内相对路径，且 alt/aria-hidden 齐备')
  assert.match(officeHtml, /class="hri-hr-backdrop-veil"/, '背景之上要叠一层暗角，保证白字与人物可读')
  assert.doesNotMatch(officeHtml, /https?:\/\//, '不允许任何外部 URL 进到页面里')

  const meetingHtml = await render('meeting-room')
  assert.match(meetingHtml, /src="\/hr-background\/meeting-room\.webp"/, '选中会议室就必须画会议室')

  const offHtml = await render('off')
  assert.doesNotMatch(offHtml, /class="hri-hr-backdrop"/, '关闭背景时不该有背景层')
  assert.doesNotMatch(offHtml, /<img\b/, '关闭背景时不该有 img')
  assert.match(offHtml, /radial-gradient\(circle at 50% 34%/, '关闭背景要保持原来的纯色/径向底色')

  // 非法 id：白名单里查不到就不画（不许「随便挑一个 url」）
  const unknownHtml = await render('conference-room')
  assert.doesNotMatch(unknownHtml, /class="hri-hr-backdrop"/, '不在白名单里的 id 不许渲染背景')

  // 非法 url：外部地址 / 协议相对地址 / 内嵌数据都不许进 <img src>
  for (const url of ['https://evil.example/office.webp', '//evil.example/office.webp', 'data:image/webp;base64,AAAA', 'javascript:alert(1)', 'hr-background/office.webp']) {
    const evilHtml = await render('office', [{ id: 'office', label: '现代办公室', url }])
    assert.doesNotMatch(evilHtml, /class="hri-hr-backdrop"/, `非法 url「${url}」不许被渲染成背景`)
    assert.doesNotMatch(evilHtml, /evil\.example|data:image/, `非法 url「${url}」不许出现在页面里`)
  }
})

test('虚拟背景：背景层压在 Live2D/静态圆与角标之下，只挂在左屏，右屏候选人与操作条一点没变', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const caps = { ...stageCapabilities(), backgrounds: HR_BACKGROUNDS }
  const renderStage = async (seedAvatarEnabled) => {
    const Panel = await mountMainPanel(React, {
      capabilities: caps, seedCapabilities: caps, seedAvatarEnabled,
      seedBundle: interviewBundle('waiting_for_answer'),
      overrides: { 'src/candidate-camera.js': CANDIDATE_PROBE },
    })
    return { html: renderToStaticMarkup(React.createElement(Panel, {})), Panel }
  }

  const live = await renderStage(true)
  const backdropAt = live.html.indexOf('class="hri-hr-backdrop"')
  const live2dAt = live.html.indexOf('class="hri-live2d')
  const labelAt = live.html.indexOf('class="hri-stage-label"')
  const badgeAt = live.html.indexOf('class="hri-stage-badge"')
  const hrStageAt = live.html.indexOf('class="hri-stage hri-stage-hr"')
  const candidateAt = live.html.indexOf('class="hri-stage hri-stage-candidate"')
  assert.ok(hrStageAt > 0 && hrStageAt < backdropAt, '背景层必须挂在 HR 左屏里')
  assert.ok(backdropAt < candidateAt, '背景层不许出现在候选人右屏（右屏完全不变）')
  assert.ok(live2dAt > 0 && backdropAt < live2dAt, '背景层必须在 DOM 里排在 Live2D 之前（后绘制的定位层才压得住它）')
  assert.equal((live.html.match(/class="hri-hr-backdrop"/g) || []).length, 1, '整个页面只该有一个背景层')
  assert.ok(labelAt > backdropAt && badgeAt > backdropAt, '「HR 面试官」标签与角标必须画在背景之上')
  // 右屏结构保持原样：stage-panel + 真实候选人组件，framed=false
  assert.match(live.html, /class="hri-stage-panel"><div class="hri-probe-candidate"/, '右屏仍是 stage-panel 包候选人组件')
  const calls = live.Panel.__sandbox.__hrCandidateCameraCalls || []
  assert.ok(calls.length >= 1)
  assert.equal(calls.at(-1).framed, false, '背景改动不许动 framed')
  assert.equal(calls.at(-1).active, true, '背景改动不许动 active')

  const plain = await renderStage(false)
  const plainBackdropAt = plain.html.indexOf('class="hri-hr-backdrop"')
  const plainCircleAt = plain.html.indexOf('width:120px;height:120px')
  assert.ok(plainBackdropAt > 0 && plainCircleAt > plainBackdropAt, '静态圆也必须画在背景之上')
  assert.match(plain.html, /HR 面试官形象：静态头像/, '有背景时静态头像依旧可访问')
  // 有背景时静态层必须透明，否则会把背景整块糊掉
  const staticStyle = plain.html.match(/<div role="img"[^>]*style="([^"]*)"/)?.[1] || ''
  assert.match(staticStyle, /background:transparent/, '有背景时静态层不该再铺不透明底色')
  assert.doesNotMatch(staticStyle, /radial-gradient/, '有背景时静态层不该再画自己的底色')

  const { output } = await buildClient({ root, write: false })
  const rule = (selector) => cssRule(output, selector)
  const backdropRule = rule('.hri-hr-backdrop')
  assert.match(backdropRule, /position:absolute/, '背景层必须绝对定位铺满舞台')
  assert.match(backdropRule, /inset:0/)
  assert.match(backdropRule, /z-index:0/, '背景层只能是 z-index:0，角标/标签是 z-index:2')
  assert.match(backdropRule, /pointer-events:none/, '背景层不许抢鼠标事件')
  assert.match(backdropRule, /overflow:hidden/, '背景图必须被舞台裁掉，不能溢出去')
  const imgRule = rule('.hri-hr-backdrop-img')
  assert.match(imgRule, /width:100%/, '背景图必须 100% 宽')
  assert.match(imgRule, /height:100%/, '背景图必须 100% 高')
  assert.match(imgRule, /object-fit:cover/, '背景图必须 cover（不能拉伸变形）')
  const veilRule = rule('.hri-hr-backdrop-veil')
  assert.match(veilRule, /position:absolute/); assert.match(veilRule, /inset:0/)
  assert.match(veilRule, /rgba\(15,23,42,\.\d+\)/, '暗角必须用深色半透明覆盖，白字才读得清')
  const labelRule = rule('.hri-stage-label')
  assert.match(labelRule, /z-index:2/, '标签仍在背景之上')
  // 不能挡住窄屏容器查询：背景规则必须写在 @container 之前
  assert.ok(output.indexOf('.hri-hr-backdrop{') < output.indexOf('@container(max-width:760px)'), '背景规则要写在容器查询之前，否则窄屏覆盖顺序被打乱')
  // 舞台高度/栅格/操作条一律不动
  assert.match(rule('.hri-stage'), /height:clamp\(200px,min\(26vw,30vh\),420px\)/, '舞台高度链不许变')
  assert.match(rule('.hri-stage-grid'), /grid-template-columns:1fr 1fr/, '双屏栅格不许变')
})

test('虚拟背景（DOM）：Setup 改选会议室再进入面试，左屏就是会议室图；图加载失败只藏图、舞台与右屏照旧', async (t) => {
  const capabilities = { ...stageCapabilities(), backgrounds: HR_BACKGROUNDS }
  const harness = await mountSetupPanel({ capabilities })
  if (!harness) return skipNoReactDom(t)
  try {
    const win = harness.window
    const field = [...harness.container.querySelectorAll('label.hri-field')].find((node) => node.querySelector('span')?.textContent === 'HR 虚拟背景')
    assert.ok(field, '真实挂载的设置页必须有「HR 虚拟背景」一项')
    const select = field.querySelector('select')
    assert.ok(select, '「HR 虚拟背景」必须渲染成 select')
    assert.equal(select.value, 'office', '默认选中现代办公室')
    const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set
    await harness.act(async () => { setter.call(select, 'meeting-room'); select.dispatchEvent(new win.Event('change', { bubbles: true })) })
    await harness.flush()
    assert.equal(select.value, 'meeting-room', '受控下拉必须真的把选择写进本地 state')

    harness.state.startResult = interviewBundle('paused')
    await harness.clickButton('进入面试')
    const stage = harness.container.querySelector('.hri-hr-stage')
    assert.ok(stage, '点「进入面试」后要真的进到面试页左屏')
    const img = harness.container.querySelector('.hri-hr-backdrop-img')
    assert.ok(img, '进入面试后左屏必须画出选中的背景')
    assert.equal(img.getAttribute('src'), '/hr-background/meeting-room.webp', '必须是刚选中的会议室')
    assert.equal(img.getAttribute('alt'), '')
    assert.equal(img.getAttribute('aria-hidden'), 'true')

    // 背景图加载失败：只藏这一层，舞台底色/静态圆与右屏都不受影响
    await harness.act(async () => { img.dispatchEvent(new win.Event('error')) })
    await harness.flush()
    assert.equal(harness.container.querySelector('.hri-hr-backdrop-img'), null, '加载失败必须把破图藏掉')
    assert.equal(harness.container.querySelector('.hri-hr-backdrop'), null, '暗角层也一起撤掉，别留一层黑纱')
    const stageAfter = harness.container.querySelector('.hri-hr-stage')
    assert.ok(stageAfter, '舞台本身不能被背景失败带走')
    assert.match(stageAfter.textContent, /HR/, '静态头像/标签必须还在')
    assert.match(harness.container.innerHTML, /radial-gradient\(circle at 50% 34%/, '失败后要退回原来的纯色底')
    assert.ok(harness.container.querySelector('.hri-candidate-camera'), '右屏候选人画面不受背景影响')
    assert.ok(harness.container.querySelector('[role="toolbar"]'), '面试操作条必须还在')
    assert.match(harness.text(), /视频不上传 · 不做表情评分/, '双屏下的隐私披露照旧')
  } finally { await harness.close() }
})

test('双屏 CSS：宽屏 1fr 1fr 等高、窄屏容器查询上下堆叠，候选人画面 cover', async () => {
  const { output } = await buildClient({ root, write: false })
  assert.match(output, /\.hri-stage-grid\{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch;flex:0 0 auto\}/, '宽屏必须是左右等分两列、等高且不参与压缩')
  // 高度改成 clamp 且同时吃视口高度：宽屏在 26vw 与 30vh 里取小，矮窗口自动降高
  assert.match(output, /\.hri-stage\{position:relative;display:flex;height:clamp\(200px,min\(26vw,30vh\),420px\);min-height:0;/)
  assert.doesNotMatch(output, /\.hri-stage\{[^}]*height:clamp\(260px,26vw,440px\)/, '舞台高度不能只按宽度算 —— 矮窗口会把按钮顶出视口')
  assert.match(output, /\.hri-stage\{[^}]*height:clamp\([^}]*min\([^}]*vw[^}]*vh\)/, '舞台高度必须同时受视口高度约束')
  assert.doesNotMatch(output, /\.hri-stage\{[^}]*aspect-ratio/, '阶段高度只能由 clamp 决定，不能再有 aspect-ratio')
  assert.doesNotMatch(output, /\.hri-stage\{[^}]*min-height:220px/)
  assert.match(output, /\.hri-stage-candidate video,\.hri-stage-candidate canvas\{[^}]*object-fit:cover\}/, '候选画面要 cover，HR 走 fit 不变形')
  assert.match(output, /\.hri-stage-note\{margin:8px 0 0;font-size:12px;color:[^;]+;text-align:center\}/, '双屏下方的披露行要按参考图排在画面之下')
  const baseAt = output.indexOf('.hri-stage-grid{display:grid;grid-template-columns:1fr 1fr')
  const queryAt = output.indexOf('@container(max-width:760px)')
  assert.ok(baseAt > 0 && queryAt > baseAt, 'container 查询必须写在基础栅格之后，否则窄屏仍会被同权重规则盖回两列')
  const narrow = output.slice(queryAt, output.indexOf('}}', queryAt) + 2)
  assert.match(narrow, /\.hri-stage-grid\{grid-template-columns:1fr\}/, '窄屏缺少上下堆叠规则')
  assert.match(narrow, /\.hri-stage\{height:clamp\(180px,min\(52vw,24vh\),320px\)\}/, '窄屏高度要单独收窄，并且同样吃视口高度')
})

test('双屏角标：深色半透明胶囊 + 白字，浅底/深底都能读', async () => {
  const { output } = await buildClient({ root, write: false })
  for (const cls of ['hri-stage-label', 'hri-stage-badge']) {
    const found = output.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`))
    assert.ok(found, `.${cls} 规则缺失`)
    const rule = found[1]
    assert.match(rule, /color:#fff(;|\b)/, `${cls} 必须是白字`)
    assert.match(rule, /background:rgba\(15,23,42,\.55\)/, `${cls} 必须是深色半透明胶囊（和白底主题解耦）`)
    assert.match(rule, /text-shadow:0 1px 2px rgba\(0,0,0,\.45\)/, `${cls} 在浅色画面上靠投影保住对比度`)
    assert.doesNotMatch(rule, /background:var\(--dsw-alias-bg-primary/, `${cls} 不能再用主题白底 —— 白底白字就是这次的 bug`)
    assert.match(rule, /border:1px solid rgba\(255,255,255,\.18\)/, `${cls} 描边用半透明白，深色画面上不糊成一块`)
  }
  // 胶囊位置不动：左上标签、左下状态
  assert.match(output, /\.hri-stage-label\{position:absolute;top:10px;left:10px;/)
  assert.match(output, /\.hri-stage-badge\{position:absolute;left:10px;bottom:10px;/)
})

// —— 面试页高度约束 / 记录区滚动 / sticky 操作条 ——
// 这组断言的靶子是旧版的三处缺失：根容器没有高度链（面板按内容长高，冲出 slot）、
// 记录区靠 max-height:52vh 硬顶（矮窗口直接吃掉操作区）、按钮平铺在卡片流里没有任何贴底机制。
const VOID_TAGS = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i

/** 计算某个标记出现位置的 DOM 嵌套深度，用来判定「谁是谁的兄弟/子节点」。 */
function depthAt(html, index) {
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g
  let depth = 0
  let match = re.exec(html)
  while (match && match.index < index) {
    if (match[1] === '/') depth -= 1
    else if (!match[3].trimEnd().endsWith('/') && !VOID_TAGS.test(match[2])) depth += 1
    match = re.exec(html)
  }
  return depth
}

/** 取一条 CSS 规则体。规则里带 `${C.x}` 插值，朴素 [^}]* 会在这里被截断，必须把 ${...} 当整体跳过。 */
function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // (?:^|[}]) 把匹配锚在「规则起点」上：否则 `.hri-session` 会先命中
  // `.hri-main--stacked .hri-session{...}` 这类后代选择器的尾巴，量到的不是主规则。
  const found = source.match(new RegExp(`(?:^|[}])${escaped}\\{((?:[^{}]|\\$\\{[^}]*\\})*)\\}`))
  assert.ok(found, `${selector} 规则缺失：高度链断在这里，面板会按内容长高冲出 slot`)
  return found[1]
}

test('布局：根/内容/会话/记录四层都建立高度链，滚动兜底不许用 overflow:hidden 藏按钮', async () => {
  const { output } = await buildClient({ root, write: false })
  const rule = (selector) => cssRule(output, selector)

  const rootRule = rule('.dsh-hr-interview')
  assert.match(rootRule, /display:flex/, '根容器必须是 flex 列，才能把剩余高度传给内容')
  assert.match(rootRule, /flex-direction:column/)
  assert.match(rootRule, /height:100%/, '根容器必须撑满 slot 给的高度，而不是被内容推高')
  assert.match(rootRule, /min-height:0/, '根容器必须允许收缩（否则 flex 项的下限是内容高度）')
  assert.match(rootRule, /overflow-y:auto/, 'slot 不给确定高度时，最外层必须还能滚，不能把内容裁掉')
  assert.doesNotMatch(rootRule, /overflow(-y)?:hidden/, '根容器不能靠 hidden 裁掉溢出内容 —— 那正是按钮消失的形态')

  const mainRule = rule('.hri-main')
  assert.match(mainRule, /display:flex/)
  assert.match(mainRule, /flex-direction:column/)
  assert.match(mainRule, /flex:1 1 auto/)
  assert.match(mainRule, /min-height:0/)

  const sessionRule = rule('.hri-session')
  assert.match(sessionRule, /display:flex/)
  assert.match(sessionRule, /flex:1 1 auto/)
  assert.match(sessionRule, /min-height:0/)
  assert.match(sessionRule, /overflow-y:auto/, '.hri-session 是「固定件加起来也超高」时的滚动兜底')

  const transcriptRule = rule('.hri-transcript')
  assert.match(transcriptRule, /display:flex/)
  assert.match(transcriptRule, /flex-direction:column/)
  assert.match(transcriptRule, /flex:1 1 auto/, '记录卡片必须吃掉剩余高度，才会等于可视高度')
  assert.match(transcriptRule, /min-height:0/)

  const headRule = rule('.hri-session-head')
  assert.match(headRule, /flex:0 0 auto/, '舞台卡片不许跟着长高，否则记录区被挤没')
})

test('布局：舞台和历次回答共享滚动区，操作区保持在该滚动区之外', async () => {
  const { output } = await buildClient({ root, write: false })
  const scroll = output.match(/\.hri-room-scroll\s*\{([^{}]*)\}/)?.[1]
  assert.ok(scroll, '面试内容滚动区缺失')
  assert.match(scroll, /flex:\s*1 1 auto/)
  assert.match(scroll, /overflow-y:\s*auto/)
  assert.doesNotMatch(cssRule(output, '.hri-log'), /overflow:auto|max-height:/, '记录区跟随舞台一起滚动')
})

test('布局：底部作答区固定在滚动区之外，操作按钮可换行', async () => {
  const { output } = await buildClient({ root, write: false })
  const dock = output.match(/\.hri-room-dock\s*\{([^{}]*)\}/)?.[1]
  assert.ok(dock, '作答区缺失')
  assert.match(dock, /flex:\s*0 0 auto/)
  assert.match(dock, /padding:/)
  const actions = cssRule(output, '.hri-actions')
  assert.match(actions, /flex-wrap:wrap/)
  assert.match(actions, /border-top:/)
})

test('布局：滚动区容纳舞台和历史，作答区作为同级区域固定在下方', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const turns = []
  for (let index = 0; index < 12; index += 1) {
    turns.push({ id: `t-${index}`, speaker: index % 2 === 0 ? 'hr' : 'candidate', kind: index % 2 === 0 ? 'main_question' : 'answer', text: `第 ${index + 1} 轮内容` })
  }
  const longBundle = { session: { ...interviewBundle('waiting_for_answer').session }, turns, evaluation: null }
  const Panel = await mountMainPanel(React, { seedBundle: longBundle })
  const html = renderToStaticMarkup(React.createElement(Panel, {}))

  const at = (marker) => {
    const index = html.indexOf(marker)
    assert.ok(index > 0, `缺少 ${marker}`)
    return index
  }
  const headAt = at('class="hri-card hri-session-head"')
  const scrollAt = at('class="hri-room-scroll"')
  const dockAt = at('class="hri-card hri-room-dock"')
  const transcriptAt = at('class="hri-card hri-transcript"')
  const logAt = at('class="hri-log"')
  const composeAt = at('class="hri-compose"')
  const actionsAt = at('class="hri-actions"')
  const footAt = at('class="hri-session-foot"')
  assert.ok(scrollAt < headAt && headAt < transcriptAt && transcriptAt < logAt && logAt < dockAt && dockAt < composeAt && composeAt < actionsAt && actionsAt < footAt)

  const turnCount = (html.match(/class="hri-turn /g) || []).length
  assert.equal(turnCount, 12, `多轮记录必须全部进 log，实际渲染 ${turnCount} 轮`)
  assert.equal(depthAt(html, scrollAt), depthAt(html, dockAt), '作答区必须和内容滚动区同级')
  assert.equal(depthAt(html, headAt), depthAt(html, transcriptAt), '舞台和记录必须同在内容滚动区')
  assert.equal(depthAt(html, actionsAt), depthAt(html, composeAt), '输入与操作条都在底部作答区')
  assert.match(html.slice(actionsAt, actionsAt + 200), /role="toolbar"/, 'action bar 要有 toolbar 语义')
  // 每个按钮都必须在 action bar 里，不许散落在记录流中
  const barSlice = html.slice(actionsAt, footAt)
  for (const label of ['提交回答', '跳过本题', '直接结束', '结束并复盘']) {
    assert.ok(barSlice.includes(label), `${label} 必须在 action bar 内`)
  }
  assert.match(barSlice, /<button[\s\S]*<button[\s\S]*<button/, 'action bar 至少要容纳三个操作按钮')
})

test('布局：矮窗口由视口高度降级舞台，且不写死 DSH 顶栏偏移', async () => {
  const { output } = await buildClient({ root, write: false })
  const mediaAt = output.indexOf('@media(max-height:640px)')
  assert.ok(mediaAt > 0, '缺少按视口高度触发的降级规则')
  const containerAt = output.indexOf('@container(max-width:760px)')
  assert.ok(mediaAt > containerAt, '矮窗口规则必须写在容器查询之后（同权重后者胜），否则窄屏高度会被改回去')
  const block = output.slice(mediaAt, output.indexOf('}}', mediaAt) + 2)
  assert.match(block, /\.hri-stage\{height:clamp\(140px,min\(26vw,22vh\),260px\)\}/, '矮窗口要把舞台压到 140–260px')
  assert.match(block, /\.hri-session\{gap:10px\}/, '矮窗口要收紧卡片间距')
  assert.match(block, /\.hri-input\{max-height:110px\}/, '矮窗口要限制输入框高度，把高度让给记录区')
  // 三条 .hri-stage 高度规则（基础 / 窄屏 / 矮窗口）都必须同时吃 vw 与 vh；
  // 只按宽度算的话，1366×600 这种矮窗口里舞台会吃满整屏，把按钮顶出视口。
  const stageRules = [...output.matchAll(/\.hri-stage\{((?:[^{}]|\$\{[^}]*\})*)\}/g)].map((entry) => entry[1])
  assert.equal(stageRules.length, 3, `舞台高度应由基础/窄屏/矮窗口三条规则共同决定，实际 ${stageRules.length} 条`)
  for (const stageRule of stageRules) {
    const heightAt = stageRule.indexOf('height:clamp(')
    assert.ok(heightAt >= 0, '舞台必须由 clamp 给高度')
    const height = stageRule.slice(heightAt)
    assert.match(height, /min\(\d+vw,\d+vh\)|min\(\d+vh,\d+vw\)/, `舞台高度必须同时受宽度和视口高度约束：${height.slice(0, 48)}`)
  }
  assert.doesNotMatch(output, /top:var\(--dsw-[^)]*\)/, '不许用硬编码 DSH 顶栏偏移来算高度')
})

test('布局：材料页与历史页保持原样，不被面试页高度约束波及', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const materialsHtml = renderToStaticMarkup(React.createElement(await mountMainPanel(React, { seedTab: 'materials' }), {}))
  assert.match(materialsHtml, /面试材料/, '材料页标题不能丢')
  assert.equal((materialsHtml.match(/class="hri-input"/g) || []).length >= 3, true, '材料页仍要渲染多个输入框')
  assert.match(materialsHtml, /保存/, '材料页保存按钮不能丢')
  assert.doesNotMatch(materialsHtml, /class="hri-session"/, '材料页不该被套进面试页的高度链')
  assert.doesNotMatch(materialsHtml, /class="hri-log"/)

  const historyHtml = renderToStaticMarkup(React.createElement(await mountMainPanel(React, { seedTab: 'history' }), {}))
  assert.match(historyHtml, /历史场次/)
  assert.match(historyHtml, /知识点回炉/)
  assert.doesNotMatch(historyHtml, /class="hri-actions"/, '历史页不该出现面试操作条')
})

test('构建产物：contract → live2d → candidate → client 同域内联，缺段直接失败', async () => {
  const { output, parts } = await buildClient({ root, write: false })
  assert.deepEqual(parts, ['src/live2d-avatar.js', 'src/candidate-camera.js', 'src/client.js', 'lib/contract.js'])
  const contractAt = output.indexOf('HR_CLIENT_REMOTE')
  const live2dAt = output.indexOf('function hrLive2dComponent')
  const candidateAt = output.indexOf('function hrCandidateCameraComponent')
  const clientAt = output.indexOf('function HRMark')
  assert.ok(contractAt > 0 && contractAt < live2dAt && live2dAt < candidateAt && candidateAt < clientAt, '内联顺序必须是 contract → live2d → candidate → client')
  assert.match(output, /const CandidateCamera = hrCandidateCameraComponent\(React\)/)
  assert.doesNotMatch(output, /^import /m)
  assert.doesNotMatch(output, /^export /m)
  // 候选人段缺失时必须构建失败：静默塞占位会让线上右屏空着却一路绿灯
  await assert.rejects(
    () => buildClient({ root, write: false, overrides: { 'src/candidate-camera.js': MISSING_PART } }),
    (error) => error instanceof Error && /src\/candidate-camera\.js/.test(error.message),
    '缺 src/candidate-camera.js 时应抛错',
  )
  // overrides 注入探针仍要能跑（测试靠它断言 props），且不得把占位文本带进产物
  const probed = await buildClient({ root, write: false, overrides: { 'src/candidate-camera.js': CANDIDATE_PROBE } })
  assert.match(probed.output, /CandidateCameraProbe/)
  assert.doesNotMatch(probed.output, /hri-candidate-placeholder/)
})

// —— 语音播放策略回归（jsdom + 真实 React，真正跑 effect） ——
// 上面的 SSR 测试不执行 effect，所以「打开历史场次会不会自动朗读」「NotAllowedError 会不会写冷却」
// 这类只发生在副作用里的缺陷测不出来。这里用 jsdom 挂载真实组件树，沿用真实用户路径
// （历史与回炉 → 点开场次）来打开一次面试，然后直接观察 speak 行为。
async function loadReactDomTools() {
  const candidates = [
    process.env.HR_TEST_REACT_DIR,
    path.join(root, 'node_modules'),
  ].filter(Boolean)
  for (const dir of candidates) {
    try {
      const req = createRequire(path.join(dir, '__probe__.cjs'))
      const { JSDOM } = req('jsdom')
      // react-dom 在模块初始化时就读取全局 window/document 来判断 canUseDOM 与
      // “浏览器是否原生支持 input 事件”。若那一刻没有 document，它会退化到 IE9 的
      // attachEvent 兼容分支：jsdom 上既会抛 “attachEvent is not a function”，
      // 又让受控 input 的 onChange 永远不触发（点按钮却查不到输入值）。
      // 所以先挂一份引导用 jsdom，再 require react-dom。
      if (!globalThis.document) {
        const boot = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
        globalThis.window = boot.window
        globalThis.document = boot.window.document
        Object.defineProperty(globalThis, 'navigator', { value: boot.window.navigator, configurable: true })
      }
      const { createRoot } = req('react-dom/client')
      const ReactModule = req('react')
      // React 18.3+ 把 act 挪回了 react 本体；旧版回落到 react-dom/test-utils。
      const act = typeof ReactModule.act === 'function' ? ReactModule.act : req('react-dom/test-utils').act
      if (typeof act !== 'function') continue
      return { JSDOM, createRoot, act }
    } catch { /* 该目录没有 jsdom 或 react-dom/client，试下一个 */ }
  }
  return null
}

function fakeAudioClass(outcome) {
  return class FakeAudio {
    constructor(src) { this.src = src; this.playCalls = 0 }
    pause() {}
    play() {
      this.playCalls += 1
      if (outcome === 'blocked') {
        const error = new Error("play() failed because the user didn't interact with the document first")
        error.name = 'NotAllowedError'
        return Promise.reject(error)
      }
      return Promise.resolve()
    }
  }
}

// 挂载真实 Panel，然后在界面上点进「历史与回炉 → 该场次」，返回可交互句柄。
// evaluation 非空用于「已有复盘」这一态（rc.22 起是独立的复盘报告视图）；
// evaluationStatus 用来表示 Host 侧的复盘结论（'no_content' = 没有有效回答）。
// review.evaluation / review.error 决定 api.evaluate 的行为（成功出报告 / 失败留在原地）。
async function openInterviewFromHistory({ status, inputMode = 'voice', asrProvider = 'deepseek', ttsProvider = 'browser', capabilities = {}, audioOutcome = 'ok', speakError = null, evaluation = null, evaluationStatus = null, review = null, voiceIo = null }) {
  const real = await loadRealReact()
  const tools = real && await loadReactDomTools()
  if (!tools) return null
  const { React } = real
  const { JSDOM, createRoot, act } = tools
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  const spoken = []
  const utterances = []
  const speakCalls = []
  // 录音 / 识别 / 提交的探针：只有传了 voiceIo 才会装上假麦克风与假 MediaRecorder，
  // 其余用例保持原样（MediaRecorder 与 FileReader 都是 undefined），不影响既有断言。
  const mic = { requests: 0, stops: 0, streams: [] }
  const recorderInstances = []
  const transcribeCalls = []
  const submitCalls = []
  const controlCalls = []
  const evaluateCalls = []
  let grantMic = () => {}
  // 可选闸门：gates 打开时 transcribe / submitText 会挂住，直到测试显式放行 ——
  // 用来在「识别中」「提交中」这些瞬时相位里断言按钮禁用与空格不生效。
  let releaseTranscribe = null
  let releaseSubmit = null
  // 可选闸门 2：多场次历史里，get(id) 可以被挂住，用来复现「A→B 快速切换，A 的响应迟到」。
  const heldGets = new Map()
  // 可选闸门 3：evaluate 可以被挂住，用来断言报告页自己的「正在重试…」与 disabled。
  let releaseEvaluate = null
  // 可选假时钟：让组件里的 Date.now() 跟着测试走，用来在不真等 110 秒的前提下触发自动收尾。
  const clock = voiceIo?.clock ? { now: Date.now() } : null
  if (clock) clock.Date = class extends Date { static now() { return clock.now } }
  class FakeTrack { constructor() { this.stopped = false } stop() { if (this.stopped) return; this.stopped = true; mic.stops += 1 } }
  class FakeStream { constructor() { this.tracks = [new FakeTrack()]; mic.streams.push(this) } getTracks() { return this.tracks } getAudioTracks() { return this.tracks } }
  class FakeMediaRecorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; this.startCalls = 0; this.stopCalls = 0; recorderInstances.push(this) }
    start() { this.startCalls += 1; this.state = 'recording' }
    stop() { this.stopCalls += 1; if (this.state !== 'recording') return; this.state = 'inactive'; this.ondataavailable?.({ data: { size: 16 } }); setTimeout(() => this.onstop?.(), 0) }
  }
  class FakeFileReader { readAsDataURL() { this.result = 'data:audio/webm;base64,QUJD'; setTimeout(() => this.onload?.(), 0) } }
  if (voiceIo) {
    win.navigator.mediaDevices = {
      getUserMedia: () => {
        mic.requests += 1
        if (voiceIo.grant === 'deny') { const error = new Error('Permission denied'); error.name = 'NotAllowedError'; return Promise.reject(error) }
        if (voiceIo.grant === 'manual') return new Promise((resolve) => { grantMic = () => resolve(new FakeStream()) })
        return Promise.resolve(new FakeStream())
      },
    }
  }
  win.speechSynthesis = { cancel() {}, speak(utterance) { utterances.push(utterance); spoken.push(utterance.text) } }
  win.SpeechSynthesisUtterance = class { constructor(text) { this.text = String(text) } }
  class FakeUrl { static createObjectURL() { return 'blob:hr-probe' } static revokeObjectURL() {} }
  class FakeBlob { constructor() { this.size = 1; this.type = 'audio/wav' } }
  const caps = { configured: true, asrConfigured: false, asrPreparation: null, ttsConfigured: false, ...capabilities }
  const sessionId = 'hr-probe'
  const bundle = {
    session: { sessionId, status, ...(evaluationStatus ? { evaluationStatus } : {}), inputMode, asrProvider, ttsProvider, voice: 'stella', mainQuestionCount: 1, questionBudget: 4, persona: 'professional', mode: 'mock' },
    turns: review?.turns || [{ id: 't-hr-1', speaker: 'hr', kind: 'main_question', questionId: 'q-1', text: '请做一个简短自我介绍。' }],
    evaluation: evaluation || null,
  }
  const api = {
    capabilities: async () => ({ ...caps }),
    // review.sessions 用来测「历史里有多个场次」：那时 list 直接吐多行，get 按 id 取不同 bundle。
    list: async () => ({ sessions: review?.sessions ? review.sessions.map((item) => ({ createdAt: '2026-01-01T00:00:00.000Z', inputMode, mainQuestionCount: 1, ...item })) : [{ sessionId, status, inputMode, mainQuestionCount: 1, createdAt: '2026-01-01T00:00:00.000Z', config: { role: 'Agent 应用工程师' } }], knowledge: [], now: '2026-01-01T00:00:00.000Z' }),
    // review.bundles[id] 覆盖返回的 bundle；review.hold 里的 id 第一次 get 会挂住，等 releaseGet 放行。
    get: async (id) => {
      if (review?.bundles) {
        const next = review.bundles[id]
        assert.ok(next, `未知场次 ${id}`)
        if (Array.isArray(review.hold) && review.hold.includes(id)) await new Promise((resolve) => { heldGets.set(id, resolve) })
        return next
      }
      assert.equal(id, sessionId)
      return bundle
    },
    // 转写与提交：形状对齐 lib/service.js —— ASR 回合带 asrMeta，文字回合只带 deliveryMeta。
    transcribe: async (id, payload) => {
      assert.equal(id, sessionId)
      transcribeCalls.push({ id, payload })
      const thrown = typeof voiceIo?.transcribeError === 'function' ? voiceIo.transcribeError(transcribeCalls.length) : voiceIo?.transcribeError
      if (thrown) throw thrown
      if (voiceIo?.gates) await new Promise((resolve) => { releaseTranscribe = resolve })
      return { text: voiceIo?.text ?? '我做了三年 Agent 应用，主要做工具编排。', model: 'deepseek-asr', requestId: `asr-req-${transcribeCalls.length}`, durationMs: 12 }
    },
    submitText: async (id, text, delivery = {}) => {
      assert.equal(id, sessionId)
      submitCalls.push({ id, text, delivery })
      if (voiceIo?.gates) await new Promise((resolve) => { releaseSubmit = resolve })
      const asrMeta = delivery.asrModel ? { asrMeta: { model: delivery.asrModel, requestId: delivery.asrRequestId, durationMs: delivery.asrDurationMs, audioRetained: false } } : {}
      bundle.turns = [...bundle.turns, { id: `t-cand-${submitCalls.length}`, speaker: 'candidate', kind: 'answer', text, deliveryMeta: { transcriptCharCount: String(text).length, usedFallback: delivery.usedFallback === true }, ...asrMeta }]
      return { ...bundle, turns: bundle.turns.slice() }
    },
    control: async (id, action) => {
      assert.equal(id, sessionId)
      controlCalls.push(action)
      bundle.session = { ...bundle.session, status: action === 'pause' ? 'paused' : action === 'resume' ? 'waiting_for_answer' : action === 'finish' ? 'review_pending' : action === 'skip' ? 'processing_answer' : action === 'retry' ? 'generating_question' : bundle.session.status }
      if (action === 'end') bundle.session = { ...bundle.session, status: 'completed', evaluationStatus: 'not_requested' }
      return { ...bundle, session: bundle.session, turns: bundle.turns.slice() }
    },
    materials: async () => ({ role: '', resume: '', jd: '', projectNotes: '' }),
    saveMaterials: async (value) => value,
    speak: async (calledSessionId, turnId) => {
      speakCalls.push({ sessionId: calledSessionId, turnId })
      if (speakError) throw speakError
      return { audioBase64: Buffer.from('synthetic-audio').toString('base64'), mimeType: 'audio/wav' }
    },
    // 复盘生成：对齐 lib/service.js —— 先置 evaluating/pending，成功才 completed/ready；
    // review.evaluation 为空时保持「还在生成中」，review.error 用来测失败后的重试提示。
    evaluate: async (id) => {
      // 不限 id：多场次竞态用假 evaluate 只关心「有没有发、什么时候回」，具体场次由 evaluateCalls 记录。
      evaluateCalls.push({ id, index: evaluateCalls.length + 1 })
      if (review?.holdEvaluate) await new Promise((resolve) => { releaseEvaluate = resolve })
      if (review?.error) throw review.error
      bundle.session = { ...bundle.session, status: 'evaluating', evaluationStatus: 'pending' }
      if (review?.evaluation) {
        bundle.evaluation = review.evaluation
        bundle.session = { ...bundle.session, status: 'completed', evaluationStatus: 'ready' }
      }
      return { ...bundle, session: bundle.session, turns: bundle.turns.slice() }
    },
  }
  const { output } = await buildClient({ root, write: false })
  let factory
  win.__ModuleLoader__ = { load(definition) { factory = definition.factory } }
  const sandbox = {
    window: win, document: win.document, navigator: win.navigator,
    Audio: fakeAudioClass(audioOutcome), Blob: FakeBlob, URL: FakeUrl,
    FileReader: voiceIo ? FakeFileReader : undefined, MediaRecorder: voiceIo ? FakeMediaRecorder : undefined,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  if (clock) sandbox.Date = clock.Date
  vm.createContext(sandbox)
  vm.runInContext(output, sandbox)
  const client = factory((id) => { assert.equal(id, 'react'); return React })
  const registered = []
  const ctx = {
    effect: (callback) => callback(),
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    remote: { $mount: async () => {} },
    inject: async (names, callback) => { await callback({ ...ctx, remote: { ...ctx.remote, hrInterview: api } }) },
    slots: { inject: (_name, callback) => callback(), register(options, component) { registered.push({ options, component }); return () => {} }, entries: () => [] },
  }
  await client.apply(ctx)
  const main = registered.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'main slot 必须注册')
  // react-dom 的事件优先级会读全局 window / document，必须在 createRoot 之前挂上同一份 jsdom。
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = win
  globalThis.document = win.document
  const container = win.document.getElementById('root')
  let mounted
  await act(async () => { mounted = createRoot(container); mounted.render(React.createElement(main.component, {})) })
  const flush = async () => { for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  await flush()
  const click = async (node, label) => {
    assert.ok(node, `找不到「${label}」`)
    await act(async () => { node.dispatchEvent(new win.MouseEvent('click', { bubbles: true })) })
    await flush()
  }
  const buttonByText = (label) => [...container.querySelectorAll('button')].find((node) => node.textContent === label)
  // 空格键事件：repeat / isComposing / keyCode 在 jsdom 的 KeyboardEventInit 里不生效，用 defineProperty 补。
  const spaceEvent = (type, props = {}) => {
    const event = new win.KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    Object.defineProperty(event, 'repeat', { value: Boolean(props.repeat) })
    Object.defineProperty(event, 'isComposing', { value: Boolean(props.isComposing) })
    Object.defineProperty(event, 'keyCode', { value: props.keyCode ?? 32 })
    return event
  }
  return {
    container, window: win, spoken, speakCalls, text: () => container.textContent, flush,
    openHistory: async () => {
      await click(buttonByText('历史与回炉'), '历史与回炉 tab')
      await click(container.querySelector('.hri-history'), '历史场次条目')
    },
    // 多场次历史：切到历史 tab 后按序号点第 index 行（顺序即 review.sessions）。
    openHistoryAt: async (index) => {
      await click(buttonByText('历史与回炉'), '历史与回炉 tab')
      const rows = [...container.querySelectorAll('.hri-history')]
      assert.ok(rows[index], `找不到第 ${index} 个历史场次`)
      await click(rows[index], `历史场次 #${index}`)
    },
    // 放行被 review.hold 挂住的 get(id)：用来复现「A→B 快速切换，A 的响应迟到」。
    releaseGet: async (id) => { await act(async () => { heldGets.get(id)?.(); heldGets.delete(id) }); await flush() },
    // 放行被 review.holdEvaluate 挂住的 evaluate：用来断言「正在重试…」与 disabled。
    resolveEvaluate: async () => { await act(async () => { releaseEvaluate?.(); releaseEvaluate = null }); await flush() },
    clickButton: async (label) => {
      const button = buttonByText(label)
      assert.ok(button, `找不到按钮「${label}」`)
      assert.equal(button.disabled, false, `按钮「${label}」应可点击`)
      await click(button, label)
    },
    finishSpeech: async () => { await act(async () => { utterances.splice(0).forEach((utterance) => utterance.onend?.()) }); await flush() },
    // —— 切换式语音（只给传了 voiceIo 的用例用）——
    mic, act, recorderInstances, transcribeCalls, submitCalls, controlCalls, evaluateCalls,
    voiceToggle: () => container.querySelector('button[data-hri-voice-toggle="true"]'),
    answerArea: () => container.querySelector('textarea[data-hri-input="true"]'),
    // 键盘事件：jsdom 的 KeyboardEventInit 不认 repeat / isComposing / keyCode 这几个字段，
    // 自己补上才能测到「长按重复」「输入法组字」这两条防线。
    pressSpace: async (props = {}) => {
      const prevented = { down: false, up: false }
      await act(async () => {
        const target = props.target || win
        const down = spaceEvent('keydown', props); target.dispatchEvent(down); prevented.down = down.defaultPrevented
        if (props.skipUp) return
        const up = spaceEvent('keyup', props); target.dispatchEvent(up); prevented.up = up.defaultPrevented
      })
      await flush()
      return prevented
    },
    // 一次 act 里连发 N 次完整空格：用来验证「快速重复空格」不会录两次、也不会提交两次。
    pressSpaceBurst: async (times) => {
      await act(async () => { for (let index = 0; index < times; index += 1) { win.dispatchEvent(spaceEvent('keydown')); win.dispatchEvent(spaceEvent('keyup')) } })
      await flush()
    },
    grantMicNow: async () => { await act(async () => { grantMic(); await new Promise((resolve) => setTimeout(resolve, 0)) }); await flush() },
    typeAnswer: async (value) => {
      const area = container.querySelector('textarea[data-hri-input="true"]')
      assert.ok(area, '缺少文字兜底输入框')
      const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set
      await act(async () => { setter.call(area, value); area.dispatchEvent(new win.Event('input', { bubbles: true })) })
      await flush()
    },
    unmount: async () => { await act(async () => mounted.unmount()) },
    // 放行被 gates 挂住的转写 / 提交
    resolveTranscribe: async () => { await act(async () => { releaseTranscribe?.(); releaseTranscribe = null }) ; await flush() },
    resolveSubmit: async () => { await act(async () => { releaseSubmit?.(); releaseSubmit = null }); await flush() },
    // 模拟 Host 侧状态变化：面板持有的是同一个 bundle 对象，原地改 session 后任意一次重渲染即可看到。
    setSessionStatus: (status) => { bundle.session = { ...bundle.session, status } },
    // 等录音秒数计时器跳一次（500ms 一次 setSeconds → 触发重渲染）
    tickSeconds: async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)) }); await flush() },
    advanceClock: async (ms) => { if (!clock) throw new Error('本用例没有注入假时钟'); clock.now += ms; await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) }); await flush() },
    blurWindow: async () => { await act(async () => { win.dispatchEvent(new win.Event('blur')) }); await flush() },
    close: async () => { await act(async () => mounted.unmount()); win.close(); delete globalThis.window; delete globalThis.document },
  }
}

const skipNoReactDom = (t) => t.skip('未找到 jsdom/react-dom：运行 npm ci 或设置 HR_TEST_REACT_DIR')

// —— 切换式语音（rc.21）：空格与页面按钮都是「按一下开始、再按一下结束」，识别成功即自动提交 ——
// 全部走真实 React + jsdom：假麦克风 / 假 MediaRecorder / 假 FileReader / 假 Host transcribe + submitText。
// 组件里的相位状态机、effect 与提交路径都真的跑一遍，不是只看 SSR 字符串。
const HTTP_CAPS = { asrConfigured: true, httpAsrConfigured: true, ttsConfigured: false }
const ASR_TEXT = '我做了三年 Agent 应用。'
const openVoiceInterview = (extra = {}) => openInterviewFromHistory({ status: 'waiting_for_answer', asrProvider: 'http', capabilities: HTTP_CAPS, voiceIo: {}, ...extra })

test('语音切换（空格）：按一下开始，再按一下识别并自动提交，不再有识别确认与 ASR 正文', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { text: ASR_TEXT } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.equal(harness.voiceToggle().textContent, '开始回答（空格）')

    const started = await harness.pressSpace()
    assert.equal(started.down, true, '空格开始时必须 preventDefault，页面不能跟着滚')
    assert.equal(harness.mic.requests, 1, '一次空格就要请求麦克风')
    assert.equal(harness.recorderInstances.length, 1, '只允许建一个 MediaRecorder')
    assert.equal(harness.recorderInstances[0].state, 'recording', '授权一完成就自动开录，不需要按第二次')
    assert.equal(harness.voiceToggle().getAttribute('aria-pressed'), 'true')
    assert.match(harness.voiceToggle().textContent, /^结束并提交（空格） · \d+s$/)

    await harness.pressSpace()
    assert.equal(harness.transcribeCalls.length, 1, '结束只触发一次转写')
    assert.equal(harness.submitCalls.length, 1, '识别成功立即提交一次')
    const [submitted] = harness.submitCalls
    assert.equal(submitted.text, ASR_TEXT)
    assert.equal(submitted.delivery.usedFallback, false, 'ASR 提交不能标成文字降级')
    assert.equal(submitted.delivery.asrModel, 'deepseek-asr')
    assert.equal(submitted.delivery.asrRequestId, 'asr-req-1')
    assert.equal(submitted.delivery.asrDurationMs, 12)
    assert.equal(typeof submitted.delivery.answerDurationMs, 'number')
    assert.equal(harness.recorderInstances[0].state, 'inactive')
    assert.equal(harness.mic.stops, 1, '录音结束必须释放麦克风轨道')

    // 面试进行中不回显 ASR 正文；识别原文只进 Host（假 submitText 收到了 text）。
    const log = harness.container.querySelector('.hri-log')
    assert.match(log.textContent, /语音回答 · 已提交/)
    assert.match(log.textContent, /请做一个简短自我介绍/, 'HR 的提问不能被 ASR 占位规则误藏')
    assert.doesNotMatch(log.textContent, new RegExp(ASR_TEXT), 'ASR 正文不能在 live log 里出现')
    assert.doesNotMatch(harness.text(), /识别完成|确认并继续/, '不再有识别确认步骤')
    const asrTurn = log.querySelector('[data-hri-asr="true"]')
    assert.ok(asrTurn, 'ASR 回合必须带 data-hri-asr 标记')
    assert.equal(asrTurn.getAttribute('data-hri-speaker'), 'candidate')
    assert.equal(harness.voiceToggle().textContent, '开始回答（空格）')
  } finally { await harness.close() }
})

test('语音切换（按钮）：点一下开始、再点一下结束并提交', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { text: ASR_TEXT } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const tap = async () => {
      const node = harness.voiceToggle()
      assert.ok(node, '缺少语音切换按钮')
      assert.equal(node.disabled, false, '语音开关应可点击')
      await harness.act(async () => { node.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true })) })
      await harness.flush()
    }
    await tap()
    assert.equal(harness.mic.requests, 1)
    assert.equal(harness.recorderInstances.length, 1)
    assert.equal(harness.recorderInstances[0].state, 'recording')
    assert.match(harness.voiceToggle().textContent, /^结束并提交（空格） · \d+s$/)
    await tap()
    assert.equal(harness.transcribeCalls.length, 1)
    assert.equal(harness.submitCalls.length, 1)
    assert.equal(harness.submitCalls[0].delivery.asrModel, 'deepseek-asr')
    assert.equal(harness.mic.stops, 1)
  } finally { await harness.close() }
})

test('空格不抢输入框：textarea 里空格照常可用，文字回答的正文照常显示', async (t) => {
  const harness = await openVoiceInterview()
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const typed = '我在做 工具编排 的平台'
    const fallback = harness.container.querySelector('.hri-room-fallback')
    assert.equal(fallback.open, false, '语音场默认折叠文字回答')
    const summarySpace = await harness.pressSpace({ target: fallback.querySelector('summary') })
    assert.equal(summarySpace.down, false, '折叠区的空格保留原生行为')
    assert.equal(harness.mic.requests, 0)
    fallback.open = true
    await harness.typeAnswer(typed)
    const area = harness.answerArea()
    assert.equal(area.value, typed, '输入框里的空格必须原样保留')
    const space = await harness.pressSpace({ target: area })
    assert.equal(space.down, false, '焦点在输入框时不得拦截空格')
    assert.equal(space.up, false)
    assert.equal(harness.mic.requests, 0, '输入框里的空格不能触发录音')

    await harness.clickButton('用文字继续')
    assert.equal(harness.submitCalls.length, 1)
    assert.equal(harness.submitCalls[0].text, typed)
    assert.equal(harness.submitCalls[0].delivery.usedFallback, true, '语音场的文字回答要标文字降级')
    const log = harness.container.querySelector('.hri-log')
    assert.match(log.textContent, new RegExp(typed), '文字回答正文不能被 ASR 占位规则误藏')
    assert.equal(log.querySelectorAll('[data-hri-asr="true"]').length, 0, '文字回合不能被标成 ASR')
  } finally { await harness.close() }
})

test('识别失败：给一句短提示并允许重说，失败那一次绝不提交', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { transcribeError: (calls) => (calls === 1 ? new Error('ASR 服务超时') : null) } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.pressSpace(); await harness.pressSpace()
    assert.equal(harness.transcribeCalls.length, 1)
    assert.equal(harness.submitCalls.length, 0, '识别失败不得提交')
    const alert = harness.container.querySelector('[data-hri-error="true"]')
    assert.ok(alert, '识别失败必须给出可见错误')
    assert.match(alert.textContent, /ASR 服务超时/)
    assert.match(alert.textContent, /再说一次/, '错误提示要告诉用户可以重说')
    assert.equal(harness.voiceToggle().textContent, '开始回答（空格）', '失败后回到可再录状态')
    assert.equal(harness.mic.stops, 1, '失败那一次也要释放轨道')
    // 失败必须回到 idle：文字输入与文字提交恢复可用（否则用户被卡死在一题上）。
    assert.equal(harness.answerArea().disabled, false, '识别失败后文字输入要恢复')
    await harness.typeAnswer('先用文字兜底')
    assert.equal(harness.container.querySelector('button[data-hri-submit-text="true"]').disabled, false, '识别失败后文字提交要恢复')

    await harness.pressSpace(); await harness.pressSpace()
    assert.equal(harness.transcribeCalls.length, 2)
    assert.equal(harness.submitCalls.length, 1, '重说成功后只提交一次')
    assert.equal(harness.mic.stops, 2)
    assert.equal(harness.container.querySelector('[data-hri-error="true"]'), null, '重说成功后错误提示要清掉')
  } finally { await harness.close() }
})

test('首次授权：等授权时就已经在录，授权完成后自动开录（不需要再按一次）', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { grant: 'manual', text: ASR_TEXT } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.pressSpace()
    assert.equal(harness.mic.requests, 1)
    assert.equal(harness.recorderInstances.length, 0, '授权还没回来，不该建 MediaRecorder')
    assert.match(harness.voiceToggle().textContent, /^结束并提交（空格）/, '等授权期间按钮已经进入「结束」态')
    await harness.grantMicNow()
    assert.equal(harness.recorderInstances.length, 1, '授权完成即自动进入录音')
    assert.equal(harness.recorderInstances[0].startCalls, 1)
    assert.equal(harness.recorderInstances[0].state, 'recording')
    assert.equal(harness.voiceToggle().getAttribute('aria-pressed'), 'true')
    await harness.pressSpace()
    assert.equal(harness.submitCalls.length, 1)
  } finally { await harness.close() }
})

test('等授权时再按一次空格：这一段作废，迟到的授权只关轨道、不入录音', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { grant: 'manual' } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.pressSpace()
    assert.equal(harness.mic.requests, 1)
    await harness.pressSpace()
    assert.equal(harness.voiceToggle().textContent, '开始回答（空格）')
    await harness.grantMicNow()
    assert.equal(harness.recorderInstances.length, 0, '被取消的那一次不许进入录音')
    assert.equal(harness.mic.stops, 1, '迟到的授权也要把轨道关掉')
    assert.equal(harness.transcribeCalls.length, 0)
    assert.equal(harness.submitCalls.length, 0)
  } finally { await harness.close() }
})

test('空格只认一次：长按 repeat、输入法组字与快速连按都不重复录音或重复提交', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { text: ASR_TEXT } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const before = harness.mic.requests
    const repeated = await harness.pressSpace({ repeat: true })
    const composing = await harness.pressSpace({ isComposing: true })
    const ime = await harness.pressSpace({ keyCode: 229 })
    assert.deepEqual([repeated.down, composing.down, ime.down], [false, false, false], '这几种 keydown 不该被吞掉也不该起录')
    assert.equal(harness.mic.requests, before, '长按与输入法组字不得起录')

    await harness.pressSpace()
    assert.equal(harness.recorderInstances[0].state, 'recording')
    await harness.pressSpaceBurst(3)
    assert.equal(harness.recorderInstances.length, 1, '连按不许开出第二次录音')
    assert.equal(harness.transcribeCalls.length, 1, '连按只转写一次')
    assert.equal(harness.submitCalls.length, 1, '连按只提交一次')
    assert.equal(harness.mic.stops, 1)
  } finally { await harness.close() }
})

test('暂停与卸载：释放轨道、不提交半截音频，也不留重复提交', async (t) => {
  const paused = await openVoiceInterview({ voiceIo: {} })
  if (!paused) return skipNoReactDom(t)
  await paused.openHistory()
  await paused.pressSpace()
  assert.equal(paused.recorderInstances[0].state, 'recording')
  await paused.clickButton('暂停')
  assert.deepEqual(paused.controlCalls, ['pause'])
  assert.equal(paused.mic.stops, 1, '暂停必须释放麦克风轨道')
  assert.equal(paused.transcribeCalls.length, 0, '暂停不识别半截音频')
  assert.equal(paused.submitCalls.length, 0)
  await paused.close()

  const unmounted = await openVoiceInterview({ voiceIo: {} })
  await unmounted.openHistory()
  await unmounted.pressSpace()
  assert.equal(unmounted.recorderInstances[0].state, 'recording')
  await unmounted.close()
  assert.equal(unmounted.mic.stops, 1, '卸载必须释放麦克风轨道')
  assert.equal(unmounted.transcribeCalls.length, 0, '卸载后旧的 onstop 回调不许提交')
  assert.equal(unmounted.submitCalls.length, 0)
})

test('录音中跳过本题：先作废这一段并停轨，不识别、不提交', async (t) => {
  const harness = await openVoiceInterview()
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.pressSpace()
    assert.equal(harness.recorderInstances[0].state, 'recording')
    await harness.clickButton('跳过本题')
    assert.deepEqual(harness.controlCalls, ['skip'])
    assert.equal(harness.mic.stops, 1, '跳过本题必须释放麦克风轨道')
    assert.equal(harness.recorderInstances[0].state, 'inactive')
    assert.equal(harness.transcribeCalls.length, 0, '跳过的这一段不许再识别')
    assert.equal(harness.submitCalls.length, 0, '跳过的这一段不许提交到下一题')
  } finally { await harness.close() }
})

test('文字草稿 + 录音不能双答：录音期间文字提交与输入框禁用，只提交 ASR 那一次', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { text: ASR_TEXT } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const submitBtn = () => harness.container.querySelector('button[data-hri-submit-text="true"]')
    await harness.typeAnswer('这是文字草稿')
    assert.equal(submitBtn().disabled, false, '空闲时草稿可以提交')

    await harness.pressSpace()
    assert.equal(submitBtn().disabled, true, '录音中文字提交必须禁用')
    assert.equal(harness.answerArea().disabled, true, '录音中文字输入也必须禁用')
    // 按钮禁用了也要再挡一次：直接派发 click 不能绕过相位 guard
    await harness.act(async () => { submitBtn().dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true })) })
    await harness.flush()
    assert.equal(harness.submitCalls.length, 0, '录音中点击文字提交不得产生回答')

    await harness.pressSpace()
    assert.equal(harness.submitCalls.length, 1, '一题只有 ASR 这一次回答')
    assert.equal(harness.submitCalls[0].text, ASR_TEXT)
    assert.equal(harness.answerArea().disabled, false, '录音结束后文字输入恢复')
    assert.equal(harness.answerArea().value, '这是文字草稿', 'ASR 提交不该清掉没提交的文字草稿')
    assert.equal(submitBtn().disabled, false, '草稿还在，文字提交也恢复')
  } finally { await harness.close() }
})

test('文字提交进行中：空格与语音按钮都不能起录', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { gates: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.typeAnswer('文字答案')
    const submitBtn = harness.container.querySelector('button[data-hri-submit-text="true"]')
    await harness.act(async () => { submitBtn.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true })) })
    await harness.flush()
    assert.equal(harness.submitCalls.length, 1, '文字提交已经开始')
    assert.equal(harness.voiceToggle().disabled, true, '提交中语音按钮要反映 busy')

    const space = await harness.pressSpace()
    assert.equal(space.down, false, '提交中空格不该被语音抢走')
    assert.equal(harness.mic.requests, 0, '提交中不得起录')

    await harness.resolveSubmit()
    assert.equal(harness.submitCalls.length, 1)
    assert.equal(harness.mic.requests, 0, '提交完成后也不该补一次录音')
  } finally { await harness.close() }
})

test('识别中不能文字提交：recognizing 期间输入框与文字按钮禁用，只算 ASR 一次', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { gates: true, text: ASR_TEXT } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const submitBtn = () => harness.container.querySelector('button[data-hri-submit-text="true"]')
    await harness.typeAnswer('文字草稿')
    await harness.pressSpace(); await harness.pressSpace()
    assert.equal(harness.transcribeCalls.length, 1)
    assert.equal(submitBtn().disabled, true, '识别中文字提交必须禁用')
    assert.equal(harness.answerArea().disabled, true, '识别中输入框必须禁用')
    await harness.act(async () => { submitBtn().dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true })) })
    await harness.flush()
    assert.equal(harness.submitCalls.length, 0, '识别中点击文字提交不得产生回答')

    await harness.resolveTranscribe()
    assert.equal(harness.submitCalls.length, 1, '只有 ASR 这一次回答')
    assert.equal(harness.submitCalls[0].text, ASR_TEXT)
    await harness.resolveSubmit()
    assert.equal(harness.answerArea().disabled, false, '识别提交结束后文字恢复')
    assert.equal(harness.answerArea().value, '文字草稿', '草稿保留')
  } finally { await harness.close() }
})

test('等待状态消失：Host 侧一换状态就停轨作废，不识别也不提交', async (t) => {
  const harness = await openVoiceInterview()
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.pressSpace()
    assert.equal(harness.recorderInstances[0].state, 'recording')
    // 模拟 Host 侧把这一题推进到「处理中」：面板持有同一个 bundle，任意一次重渲染就会看到新状态。
    harness.setSessionStatus('processing_answer')
    await harness.tickSeconds()
    assert.equal(harness.mic.stops, 1, '不再等待回答时必须立刻停轨')
    assert.equal(harness.recorderInstances[0].state, 'inactive')
    assert.equal(harness.transcribeCalls.length, 0)
    assert.equal(harness.submitCalls.length, 0)
  } finally { await harness.close() }
})

test('切窗口失焦：取消这一段并停轨，不识别不提交', async (t) => {
  const harness = await openVoiceInterview()
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.pressSpace()
    assert.equal(harness.recorderInstances[0].state, 'recording')
    await harness.blurWindow()
    assert.equal(harness.mic.stops, 1, '失焦必须释放麦克风轨道')
    const alert = harness.container.querySelector('[data-hri-error="true"]')
    assert.ok(alert, '失焦要给出可见提示')
    assert.match(alert.textContent, /窗口失焦/)
    assert.equal(harness.transcribeCalls.length, 0)
    assert.equal(harness.submitCalls.length, 0)
  } finally { await harness.close() }
})

test('110 秒自动收尾：到点自动停录并提交一次（假时钟）', async (t) => {
  const harness = await openVoiceInterview({ voiceIo: { clock: true, text: ASR_TEXT } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.pressSpace()
    assert.equal(harness.recorderInstances[0].state, 'recording')
    await harness.advanceClock(109000)
    assert.equal(harness.recorderInstances[0].state, 'recording', '没到 110 秒不许收尾')
    assert.equal(harness.submitCalls.length, 0)
    await harness.advanceClock(2000)
    assert.equal(harness.transcribeCalls.length, 1, '到点自动收尾要识别一次')
    assert.equal(harness.submitCalls.length, 1, '自动收尾只提交一次')
    assert.equal(harness.submitCalls[0].text, ASR_TEXT)
    assert.equal(harness.mic.stops, 1)
    assert.equal(harness.voiceToggle().textContent, '开始回答（空格）')
  } finally { await harness.close() }
})

// 复盘 data 的最小完整形状：EvaluationView 会读 summary/overallScore/priorities/performance/dimensions/
// questionReviews/consistencyIssues，少一个就渲染不出来，但这里不需要「好看」，只需要「存在」。
const PROBE_EVALUATION = {
  summary: '整体结构清楚，量化证据偏弱。',
  overallScore: 72,
  priorities: ['每个项目结论补一个数字'],
  performance: { latencyP75Ms: 900, latencyP95Ms: 1500, oralAcceptanceEligible: true },
  dimensions: [{ key: '结构', evaluated: true, score: 3, diagnosis: '用 STAR 讲了背景', improvement: '先给结论再铺细节', evidenceTurnIds: ['t-hr-1'] }],
  questionReviews: [{ questionId: 'q-1', issues: ['缺少指标'], rewrite: '把「提升效率」换成「把 P95 从 1.2s 压到 400ms」', drill: '重讲一遍带数字' }],
  consistencyIssues: [],
}

// —— 复盘独立视图（rc.22）：复盘是「面试记录 / 复盘报告」两个视图之一，不再堆在面试页下面 ——
const reviewRoot = (harness) => harness.container.querySelector('.hri-review')
const viewButton = (harness, key) => harness.container.querySelector(`button[data-hri-view="${key}"]`)

test('复盘独立视图：ready 场次打开就落在复盘报告，两个视图能来回切', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'completed', evaluation: PROBE_EVALUATION })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const review = reviewRoot(harness)
    assert.ok(review, 'ready 场次打开后必须直接是复盘报告视图')
    assert.equal(review.getAttribute('data-hri-review'), 'ready')
    assert.equal(harness.container.querySelector('.hri-session'), null, '复盘不再追加在面试页后面：同一时刻只能挂一个视图')
    // 首屏直接是「面试复盘」：它是复盘滚动容器里的第一个标题，不是排在整篇面试记录之后
    const heading = review.querySelector('h2')
    assert.ok(heading, '复盘视图必须有 h2 标题')
    assert.equal(heading.textContent, '面试复盘')
    assert.equal([...review.children].find((element) => element.tagName !== 'STYLE').contains(heading), true, '「面试复盘」必须在复盘视图的第一块内容里')
    assert.ok(review.classList.contains('hri-studio'), '报告和准备页共用浅色工作台')
    assert.match(harness.text(), /整体结构清楚/, '复盘正文必须渲染出来')
    // 两个视图的切换按钮都在，当前停在「复盘报告」
    assert.ok(viewButton(harness, 'record'), '必须有「面试记录」切换按钮')
    assert.ok(viewButton(harness, 'report'), '必须有「复盘报告」切换按钮')
    assert.equal(viewButton(harness, 'report').getAttribute('aria-pressed'), 'true')
    // 切到面试记录：面试页整棵回来，复盘视图消失
    await harness.clickButton('面试记录')
    assert.ok(harness.container.querySelector('.hri-session'), '切到面试记录后应渲染面试页')
    assert.equal(reviewRoot(harness), null, '同一时刻只应有一个视图')
    assert.match(harness.text(), /请做一个简短自我介绍/)
    // 再切回复盘报告
    await harness.clickButton('复盘报告')
    assert.ok(reviewRoot(harness), '切回复盘报告应重新渲染复盘')
    assert.match(harness.text(), /整体结构清楚/)
    assert.deepEqual(harness.speakCalls, [], '打开 ready 场次不应请求 TTS')
  } finally { await harness.close() }
})

test('复盘独立视图：本次 onBundle 从无复盘变成有复盘时自动进报告', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'waiting_for_answer', review: { evaluation: PROBE_EVALUATION } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.ok(harness.container.querySelector('.hri-session'), '进行中的场次默认仍是面试记录')
    assert.equal(reviewRoot(harness), null)
    // 结束面试只进入「等待复盘」，还没有复盘内容 —— 不该把面试记录顶掉
    await harness.clickButton('结束并复盘')
    assert.deepEqual(harness.controlCalls, ['finish'])
    assert.ok(harness.container.querySelector('.hri-session'), '只是进入 review_pending，不该切视图')
    // 记录页上的「重试复盘」拿到复盘后走 onBundle —— 面板应自动切到报告
    await harness.clickButton('重试复盘')
    assert.equal(harness.evaluateCalls.length, 1, '重试复盘必须真的调用 api.evaluate')
    const review = reviewRoot(harness)
    assert.ok(review, 'onBundle 带来复盘后必须自动进复盘报告')
    assert.equal(review.getAttribute('data-hri-review'), 'ready')
    assert.match(harness.text(), /整体结构清楚/)
  } finally { await harness.close() }
})

test('直接结束保留记录，后来可在历史场次主动生成复盘', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'waiting_for_answer', inputMode: 'text', review: { evaluation: PROBE_EVALUATION } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.typeAnswer('我负责检索工具的调用和离线评测。')
    await harness.clickButton('提交回答')
    await harness.clickButton('直接结束')
    assert.deepEqual(harness.controlCalls, ['end'])
    assert.deepEqual(harness.evaluateCalls, [])
    assert.equal(reviewRoot(harness), null)
    assert.match(harness.text(), /我负责检索工具的调用和离线评测/)
    assert.doesNotMatch(harness.text(), /结束并复盘|直接结束/)
    await harness.openHistory()
    assert.equal(reviewRoot(harness), null)
    await harness.clickButton('复盘报告')
    assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'not_requested')
    assert.deepEqual(harness.evaluateCalls, [])
    await harness.clickButton('生成复盘')
    assert.equal(harness.evaluateCalls.length, 1)
    assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'ready')
  } finally { await harness.close() }
})

test('复盘独立视图：手动切回面试记录后，新来的复盘不强制跳回', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'review_pending', review: { evaluation: PROBE_EVALUATION } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'review_pending', 'review_pending 打开时先给等待说明')
    await harness.clickButton('面试记录')
    assert.ok(harness.container.querySelector('.hri-session'))
    // 用户在记录页点重试：复盘到位，但用户选过的视图优先，不许自动跳
    await harness.clickButton('重试复盘')
    assert.equal(harness.evaluateCalls.length, 1)
    assert.ok(harness.container.querySelector('.hri-session'), '用户手动选过视图后，onBundle 不该强制跳回报告')
    assert.equal(reviewRoot(harness), null)
    // 切换入口仍在，随时能自己点回去
    await harness.clickButton('复盘报告')
    assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'ready')
  } finally { await harness.close() }
})

test('复盘独立视图：review_pending / evaluating 有明确等待说明和重试入口', async (t) => {
  for (const status of ['review_pending', 'evaluating']) {
    const harness = await openInterviewFromHistory({ status, review: { evaluation: PROBE_EVALUATION } })
    if (!harness) return skipNoReactDom(t)
    try {
      await harness.openHistory()
      const review = reviewRoot(harness)
      assert.ok(review, `${status} 打开后必须落到复盘视图，而不是一片空白`)
      assert.equal(review.getAttribute('data-hri-review'), status)
      assert.match(review.textContent, /面试复盘/, '复盘视图始终带标题')
      assert.match(review.textContent, status === 'evaluating' ? /正在生成复盘/ : /等待生成/, `${status} 必须写清是在等复盘`)
      assert.ok(review.querySelector('button[data-hri-review-retry="true"]'), `${status} 必须给重试入口`)
      await harness.clickButton('重试复盘')
      assert.equal(harness.evaluateCalls.length, 1, '重试必须真的打 api.evaluate')
      assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'ready', '重试成功后本页直接变报告')
      assert.match(harness.text(), /整体结构清楚/)
    } finally { await harness.close() }
  }
})

test('复盘独立视图：重试失败时给出原因，仍停在原地可再试', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'review_pending', review: { error: new Error('hr-interview/evaluation-locked') } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    await harness.clickButton('重试复盘')
    const review = reviewRoot(harness)
    assert.equal(review.getAttribute('data-hri-review'), 'review_pending', '失败不该把视图切走')
    assert.equal(review.querySelector('.hri-review-state').dataset.tone, 'error')
    assert.match(review.textContent, /复盘生成失败/)
    assert.match(review.textContent, /evaluation-locked/, '失败原因必须写在页面上，不能静默')
    assert.ok(review.querySelector('button[data-hri-review-retry="true"]'), '失败后仍可再试')
  } finally { await harness.close() }
})

test('复盘报告按真实题干合并追问，并在分项评分中展示原文证据', async (t) => {
  const turns = [
    { id: 't-hr-1', questionId: 'q-1', speaker: 'hr', kind: 'main_question', text: '接口变慢时，你会先检查什么？' },
    { id: 't-cand-1', questionId: 'q-1', speaker: 'candidate', kind: 'answer', text: '我先检查接口各阶段的耗时。' },
    { id: 't-hr-2', questionId: 'q-1', speaker: 'hr', kind: 'followup', text: '你怎么排除下游故障？' },
  ]
  const evaluation = { ...PROBE_EVALUATION, dimensions: [{ ...PROBE_EVALUATION.dimensions[0], key: 'structure', score: 72, evidenceTurnIds: ['t-cand-1', 'missing'] }], questionReviews: [...PROBE_EVALUATION.questionReviews, ...PROBE_EVALUATION.questionReviews] }
  const harness = await openInterviewFromHistory({ status: 'completed', review: { turns }, evaluation })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const report = reviewRoot(harness)
    assert.match(report.querySelector('.hri-review-dimension').textContent, /回答结构/)
    assert.match(report.querySelector('.hri-review-dimension blockquote').textContent, /我先检查接口各阶段的耗时/)
    assert.equal(report.querySelector('.hri-review-dimension meter').value, 72)
    assert.equal(report.querySelectorAll('.hri-review-question').length, 1)
    assert.match(report.querySelector('.hri-review-question > summary').textContent, /接口变慢时/)
    assert.match(report.querySelector('.hri-review-question').textContent, /你怎么排除下游故障/)
    assert.doesNotMatch(report.textContent, /q-1|t-cand-1|missing/)
  } finally { await harness.close() }
})

test('复盘独立视图：completed + no_content 明确说「没有有效回答，未生成复盘」', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'completed', evaluationStatus: 'no_content' })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const review = reviewRoot(harness)
    assert.ok(review, 'no_content 场次不能打开成空白页')
    assert.equal(review.getAttribute('data-hri-review'), 'no_content')
    assert.match(review.textContent, /没有有效回答，未生成复盘/, '必须写清为什么没有复盘')
    assert.ok(review.textContent.trim().length > 40, '不能只有标题：还要说明发生了什么')
    assert.equal(review.querySelector('button[data-hri-review-retry="true"]'), null, '没有回答时重试也生成不出复盘，不给无效按钮')
    // 记录仍可看
    await harness.clickButton('面试记录')
    assert.match(harness.text(), /请做一个简短自我介绍/)
  } finally { await harness.close() }
})

test('复盘独立视图的布局：报告自己滚、卡片可收缩、长文本换行', async () => {
  const { output } = await buildClient({ root, write: false })
  const review = cssRule(output, '.hri-review')
  assert.match(review, /overflow-y:auto/, '复盘视图必须自己滚（不再靠 .hri-main 兜底）')
  assert.match(review, /overscroll-behavior:contain/)
  assert.match(review, /min-width:0/, '复盘容器必须能横向收缩')
  assert.match(review, /overflow-wrap:anywhere/, '长 URL / 长英文串必须换行，不许把卡片撑横')
  assert.match(review, /flex:1 1 auto/, '复盘视图吃掉剩余高度')
  assert.match(cssRule(output, '.hri-review>*'), /min-width:0/, '复盘里的卡片/分块都要能收缩')
  assert.match(cssRule(output, '.hri-card'), /min-width:0/, '卡片默认 min-width:0，grid 项才收缩得动')
  assert.match(cssRule(output, '.hri-grid'), /min-width:0/)
  assert.match(cssRule(output, '.hri-grid>*'), /min-width:0/)
  assert.match(cssRule(output, '.hri-score'), /minmax\(min\(100%,150px\),1fr\)/, '分项证据的 auto-fit 允许窄容器收缩')
  assert.match(cssRule(output, '.hri-grid'), /minmax\(min\(100%,250px\),\.7fr\)/, '双列的第二列必须能让出宽度')
  // 组合选择器整条匹配：直接按「选择器{声明}」对源码断言，不走 cssRule 的前缀锚定，
  // 否则会先命中前面单独的 `.hri-review p{margin:...}` 而量错规则。
  assert.match(output, /\.hri-review p,\.hri-review li,\.hri-review small,\.hri-review summary\{[^}]*overflow-wrap:anywhere/, '报告正文/列表/细节里的长串也要换行')
  assert.match(cssRule(output, '.hri-main--report'), /overflow:hidden/, '报告视图由 .hri-review 自己滚，外层不再跟着滚')
  assert.doesNotMatch(output, /hri-main--stacked/, '旧的「面试+复盘同级堆叠」规则必须移除')
  // 面试记录自己的滚动契约没被改坏
  assert.match(cssRule(output, '.hri-session'), /overflow-y:auto/)
  assert.match(cssRule(output, '.hri-main'), /min-height:0/)
})

// 多场次 fixture：review.sessions / review.bundles 让同一个面板里能先后打开两个场次。
const raceSession = (sessionId, status, evaluationStatus, extra = {}) => ({
  session: { sessionId, status, ...(evaluationStatus ? { evaluationStatus } : {}), inputMode: 'text', asrProvider: 'deepseek', ttsProvider: 'deepseek', voice: 'stella', mainQuestionCount: 1, questionBudget: 4, persona: 'professional', mode: 'mock' },
  turns: [{ id: `t-${sessionId}`, speaker: 'hr', kind: 'main_question', text: `请介绍 ${sessionId} 的项目。` }],
  evaluation: null,
  ...extra,
})
const raceEvaluation = (summary) => ({ ...PROBE_EVALUATION, summary })

test('复盘报告生成中会读取最新状态，并直接显示已生成的报告', async (t) => {
  const id = 'hr-polling-review'
  const bundles = { [id]: raceSession(id, 'evaluating', 'pending') }
  const harness = await openInterviewFromHistory({ status: 'evaluating', review: { bundles, sessions: [{ sessionId: id, status: 'evaluating' }] } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.equal(reviewRoot(harness).dataset.hriReview, 'evaluating')
    bundles[id] = raceSession(id, 'completed', 'ready', { evaluation: PROBE_EVALUATION })
    await harness.act(async () => { await new Promise((resolve) => setTimeout(resolve, 2600)) })
    assert.equal(reviewRoot(harness).dataset.hriReview, 'ready')
    assert.equal(harness.evaluateCalls.length, 0, '读取状态不应再触发一次生成')
  } finally { await harness.close() }
})

test('复盘独立视图：ready 报告页也能一步回记录 / 返回列表', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'completed', evaluation: PROBE_EVALUATION })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const actions = reviewRoot(harness).querySelector('.hri-review-header .hri-controls')
    assert.ok(actions, 'ready 报告页也要有出口，不必先切视图再找返回')
    assert.ok([...actions.querySelectorAll('button')].some((node) => node.textContent === '查看面试记录'))
    assert.ok([...actions.querySelectorAll('button')].some((node) => node.textContent === '返回场次列表'))
    // 报告页里的「查看面试记录」= 同一个视图切换，不额外发请求
    await harness.clickButton('查看面试记录')
    assert.ok(harness.container.querySelector('.hri-session'))
    assert.equal(reviewRoot(harness), null)
    await harness.clickButton('复盘报告')
    await harness.clickButton('返回场次列表')
    assert.equal(harness.container.querySelector('.hri-session'), null, '返回列表应离开面试页')
    assert.equal(reviewRoot(harness), null)
    assert.ok(harness.container.querySelector('.hri-history'), '应回到历史场次列表')
    // 再打开同一场次：仍然默认落在报告（换场次会复位手动选择）
    await harness.openHistory()
    assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'ready')
  } finally { await harness.close() }
})

test('复盘独立视图：进行中的场次不显示「面试记录 / 复盘报告」切换', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'waiting_for_answer' })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.ok(harness.container.querySelector('.hri-session'), '进行中必须有面试页')
    assert.equal(viewButton(harness, 'record'), null, '进行中场次没有复盘视图，也就不该出现视图切换')
    assert.equal(viewButton(harness, 'report'), null)
    assert.equal(reviewRoot(harness), null)
  } finally { await harness.close() }
})

test('复盘独立视图：completed 但仍在生成（evaluationStatus=pending）默认落报告空态，不回落到记录', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'completed', evaluationStatus: 'pending' })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    const review = reviewRoot(harness)
    assert.ok(review, 'completed+pending 是中间态，不能把用户弹回记录页')
    assert.equal(review.getAttribute('data-hri-review'), 'evaluating')
    assert.match(review.textContent, /正在生成复盘/)
    assert.ok(review.querySelector('button[data-hri-review-retry="true"]'), '中间态也要给重试')
    // 仍可主动切回记录
    await harness.clickButton('面试记录')
    assert.match(harness.text(), /请做一个简短自我介绍/)
  } finally { await harness.close() }
})

test('复盘独立视图：A 重试还没回来就退出，A 的迟到结果不许把场次拉回来', async (t) => {
  const harness = await openInterviewFromHistory({
    status: 'review_pending',
    evaluationStatus: 'pending',
    review: { holdEvaluate: true, evaluation: raceEvaluation('A 场次的复盘内容') },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'review_pending')
    await harness.clickButton('重试复盘')
    assert.deepEqual(harness.evaluateCalls.map((call) => call.id), ['hr-probe'], '重试必须打当前场次')
    await harness.clickButton('返回场次列表')
    assert.equal(harness.container.querySelector('.hri-session'), null)
    assert.equal(reviewRoot(harness), null)
    await harness.resolveEvaluate()
    assert.equal(reviewRoot(harness), null, '退出后迟到的复盘结果不许重新打开场次')
    assert.equal(harness.container.querySelector('.hri-session'), null, '也不许把面试页拉回来')
  } finally { await harness.close() }
})

test('复盘独立视图：A 重试还没回来就打开 B，A 的结果不许抢 B 的视图', async (t) => {
  const harness = await openInterviewFromHistory({
    status: 'review_pending',
    evaluationStatus: 'pending',
    review: {
      sessionId: 'hr-race-a',
      holdEvaluate: true,
      evaluation: raceEvaluation('A 场次的复盘内容'),
      sessions: [
        { sessionId: 'hr-race-a', status: 'review_pending', evaluationStatus: 'pending', config: { role: 'A 岗位' } },
        { sessionId: 'hr-race-b', status: 'completed', evaluationStatus: 'ready', config: { role: 'B 岗位' } },
      ],
      bundles: {
        'hr-race-a': raceSession('hr-race-a', 'review_pending', 'pending'),
        'hr-race-b': raceSession('hr-race-b', 'completed', 'ready', { evaluation: raceEvaluation('B 场次的复盘内容') }),
      },
    },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistoryAt(0)
    assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'review_pending')
    await harness.clickButton('重试复盘')
    assert.equal(harness.evaluateCalls.length, 1)
    // A 的 evaluate 还挂着，用户去开 B
    await harness.openHistoryAt(1)
    assert.match(harness.text(), /B 场次的复盘内容/, 'B 打开后应看到 B 的复盘')
    await harness.resolveEvaluate()
    assert.match(harness.text(), /B 场次的复盘内容/, 'A 的迟到结果不许覆盖 B')
    assert.doesNotMatch(harness.text(), /A 场次的复盘内容/)
    assert.equal(reviewRoot(harness).getAttribute('data-hri-review'), 'ready')
    // B 的重试按钮不应被 A 的 pending 串成禁用
    await harness.clickButton('面试记录')
    assert.ok(harness.container.querySelector('.hri-session'))
  } finally { await harness.close() }
})

test('复盘独立视图：A 重试中切到 B，B 的等待态按钮不被 A 的 busy 串住', async (t) => {
  const harness = await openInterviewFromHistory({
    status: 'review_pending',
    evaluationStatus: 'pending',
    review: {
      sessionId: 'hr-race-a',
      holdEvaluate: true,
      sessions: [
        { sessionId: 'hr-race-a', status: 'review_pending', evaluationStatus: 'pending', config: { role: 'A 岗位' } },
        { sessionId: 'hr-race-b', status: 'review_pending', evaluationStatus: 'pending', config: { role: 'B 岗位' } },
      ],
      bundles: {
        'hr-race-a': raceSession('hr-race-a', 'review_pending', 'pending'),
        'hr-race-b': raceSession('hr-race-b', 'review_pending', 'pending'),
      },
    },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistoryAt(0)
    await harness.clickButton('重试复盘')
    await harness.openHistoryAt(1)
    const retry = reviewRoot(harness).querySelector('button[data-hri-review-retry="true"]')
    assert.ok(retry, 'B 也要有自己的重试入口')
    assert.equal(retry.disabled, false, 'A 的重试还挂着，但不能禁用 B 的重试')
    assert.equal(retry.textContent, '重试复盘', 'B 不能显示 A 的「正在重试…」')
  } finally { await harness.close() }
})

test('复盘独立视图：历史里快速 A→B 打开，A 的迟到响应不许覆盖 B', async (t) => {
  const harness = await openInterviewFromHistory({
    status: 'completed',
    evaluation: null,
    review: {
      hold: ['hr-race-a'],
      sessions: [
        { sessionId: 'hr-race-a', status: 'completed', evaluationStatus: 'ready', config: { role: 'A 岗位' } },
        { sessionId: 'hr-race-b', status: 'completed', evaluationStatus: 'ready', config: { role: 'B 岗位' } },
      ],
      bundles: {
        'hr-race-a': raceSession('hr-race-a', 'completed', 'ready', { evaluation: raceEvaluation('A 场次的复盘内容') }),
        'hr-race-b': raceSession('hr-race-b', 'completed', 'ready', { evaluation: raceEvaluation('B 场次的复盘内容') }),
      },
    },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistoryAt(0)
    await harness.openHistoryAt(1)
    assert.match(harness.text(), /B 场次的复盘内容/)
    await harness.releaseGet('hr-race-a')
    assert.match(harness.text(), /B 场次的复盘内容/, 'A 的迟到响应必须被 openSeq 丢弃')
    assert.doesNotMatch(harness.text(), /A 场次的复盘内容/)
  } finally { await harness.close() }
})

test('舞台不被压缩：.hri-stage-grid 与 .hri-stage 都不参与 flex 收缩（SSR 双屏结构回归）', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react：运行 npm ci 或设置 HR_TEST_REACT_DIR'); return }
  const { React, renderToStaticMarkup } = real
  const { output } = await buildClient({ root, write: false })
  const grid = cssRule(output, '.hri-stage-grid')
  assert.match(grid, /flex:0 0 auto/, '.hri-stage-grid 必须声明 flex:0 0 auto，矮窗口下不许被压扁')
  assert.match(cssRule(output, '.hri-stage'), /flex:none/, '.hri-stage 必须 flex:none，高度只由 clamp 决定')
  // 双屏结构本身没动：两个 .hri-stage 仍然并排在同一层 .hri-stage-grid 里
  const Panel = await mountMainPanel(React, {
    seedTab: 'interview',
    seedBundle: {
      session: { sessionId: 'ssr-probe', status: 'waiting_for_answer', inputMode: 'text', asrProvider: 'deepseek', ttsProvider: 'browser', mainQuestionCount: 1, questionBudget: 3, persona: 'professional', mode: 'mock' },
      turns: [{ id: 't-1', speaker: 'hr', kind: 'main_question', text: '介绍一下你的项目。' }],
      evaluation: null,
    },
    seedCapabilities: { configured: true, asrConfigured: true, asrPreparation: null },
  })
  const page = renderToStaticMarkup(React.createElement(Panel, {}))
  const stages = [...page.matchAll(/class="hri-stage (hri-stage-hr|hri-stage-candidate)"/g)].map((match) => match[1])
  assert.deepEqual(stages, ['hri-stage-hr', 'hri-stage-candidate'], '双屏顺序不变：HR 在左、候选人在右')
  assert.match(page, /class="hri-stage-grid"/, '双屏网格仍在')
  assert.match(page, /class="hri-card hri-session-head"/, '舞台仍在头部卡片里')
})

test('completed 历史复盘页不自动朗读，手动「播放语音」仍然可用', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'completed', ttsProvider: 'deepseek', capabilities: { ttsConfigured: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.match(harness.text(), /请做一个简短自我介绍/, '应当真的打开了该场次的对话记录')
    assert.deepEqual(harness.speakCalls, [], '打开 completed 历史场次不应请求云端 TTS（会立刻产生费用）')
    assert.deepEqual(harness.spoken, [], '打开 completed 历史场次不应自动朗读')
    await harness.clickButton('播放语音')
    assert.equal(harness.speakCalls.length, 1, '复盘页的手动「播放语音」仍应走所选云端语音')
  } finally { await harness.close() }
})

test('waiting_for_answer 进行中场次仍自动朗读（语音与文字模式都是）', async (t) => {
  for (const inputMode of ['voice', 'text']) {
    const harness = await openInterviewFromHistory({ status: 'waiting_for_answer', inputMode })
    if (!harness) return skipNoReactDom(t)
    try {
      await harness.openHistory()
      assert.deepEqual(harness.spoken, ['请做一个简短自我介绍。'], `${inputMode} 模式：进行中的待回答场次必须自动朗读`)
    } finally { await harness.close() }
  }
})

test('Audio.play 的 NotAllowedError 改走本机语音且不写 60 秒云端冷却', async (t) => {
  const harness = await openInterviewFromHistory({ status: 'waiting_for_answer', ttsProvider: 'deepseek', capabilities: { ttsConfigured: true }, audioOutcome: 'blocked' })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.equal(harness.speakCalls.length, 1, '自动朗读应先尝试所选云端语音')
    assert.deepEqual(harness.spoken, ['请做一个简短自我介绍。'], '被浏览器拦下后应立刻改用本机语音')
    assert.match(harness.text(), /浏览器阻止自动播放，已改用本机语音/, '应说明是浏览器拦截，而不是云端故障')
    assert.doesNotMatch(harness.text(), /冷却/, '自动播放被拦不是云端失败，不该显示冷却提示')
    await harness.finishSpeech()
    await harness.clickButton('播放语音')
    assert.equal(harness.speakCalls.length, 2, 'NotAllowedError 不该写冷却：手动播放必须能再次请求云端语音')
  } finally { await harness.close() }
})

test('真实云端失败仍然写入 60 秒冷却', async (t) => {
  const speakError = Object.assign(new Error('cloud tts down'), { name: 'SpeechError' })
  const harness = await openInterviewFromHistory({ status: 'waiting_for_answer', ttsProvider: 'deepseek', capabilities: { ttsConfigured: true }, speakError })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.openHistory()
    assert.equal(harness.speakCalls.length, 1)
    assert.deepEqual(harness.spoken, ['请做一个简短自我介绍。'])
    assert.match(harness.text(), /云端 HR 朗读失败/)
    await harness.finishSpeech()
    await harness.clickButton('播放语音')
    assert.equal(harness.speakCalls.length, 1, '冷却期内不应再打云端接口')
    assert.equal(harness.spoken.length, 2, '冷却期仍可用本机语音')
  } finally { await harness.close() }
})

// —— DeepSeek API Key 设置（jsdom + 真实 React，真正跑点击与 onChange） ——
// 覆盖：密码框不落盘 / 保存与清除的 RPC 契约 / 空输入不发请求 / 「测试连接」只在点击时计费 /
// 状态区只吃 capabilities.deepSeekCredential 与 RPC 返回值，且绝不把完整 Key 渲染出来。
const HR_FULL_KEY = ['sk', 'syntheticfixturekeyonly0123456789'].join('-')

function fakeAudioInstances() {
  const instances = []
  const control = { reject: false }
  class TrackedAudio {
    constructor(src) { this.src = src; this.playCalls = 0; this.pauseCalls = 0; instances.push(this) }
    play() { this.playCalls += 1; return control.reject ? Promise.reject(new Error('play() failed')) : Promise.resolve() }
    pause() { this.pauseCalls += 1 }
  }
  return { TrackedAudio, instances, control }
}

// 把 Panel 挂到默认的「面试」页签（即 SetupView），暴露输入、点击与 RPC 记录。
async function mountSetupPanel({ capabilities = {}, credential = null, nonEnumerable = false, preparation = null, preparationRpc = true } = {}) {
  const real = await loadRealReact()
  const tools = real && await loadReactDomTools()
  if (!tools) return null
  const { React } = real
  const { JSDOM, createRoot, act } = tools
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  const { TrackedAudio, instances: audioInstances, control: audioControl } = fakeAudioInstances()
  const objectUrls = { created: [], revoked: [] }
  class FakeUrl {
    static createObjectURL(value) { objectUrls.created.push(value); return `blob:hr-key-${objectUrls.created.length}` }
    static revokeObjectURL(value) { objectUrls.revoked.push(value) }
  }
  class FakeBlob { constructor(parts, options) { this.parts = parts; this.size = 1; this.type = (options && options.type) || 'audio/wav' } }
  win.speechSynthesis = { cancel() {}, speak() {} }
  win.SpeechSynthesisUtterance = class { constructor(text) { this.text = String(text) } }
  const state = {
    caps: { configured: true, asrConfigured: false, asrPreparation: null, ttsConfigured: false, ...capabilities, ...(credential ? { deepSeekCredential: credential } : {}) },
    saveResult: { configured: true, source: 'file', writable: true },
    clearResult: { configured: false, source: null, writable: true },
    previewError: null,
    startResult: null,
    saveError: null,
    capsError: null,
    saveGate: null,
    listEnvelopeSessions: [],
    capsCalls: 0, listCalls: 0, saveCalls: [], clearCalls: [], previewCalls: [],
    // 提纲 RPC：preparation 就是 latestPreparation 的返回值（null = 旧 Host 里没有现成提纲）。
    preparation,
    prepareResult: null,
    latestCalls: [], prepareCalls: [],
  }
  // 真实 host 的每个 remote 方法都回 RemoteResult 信封：{ ok:true, value } / { ok:false, error }。
  const envelope = (thunk) => async (...args) => {
    try { return { ok: true, value: await thunk(...args) } } catch (error) { return { ok: false, error: { message: String(error?.message || error) } } }
  }
  const api = {
    capabilities: envelope(async () => { state.capsCalls += 1; if (state.capsError) throw new Error(state.capsError); return { ...state.caps } }),
    list: envelope(async () => { state.listCalls += 1; return { sessions: state.listEnvelopeSessions.slice(), knowledge: [] } }),
    materials: envelope(async () => ({ role: '', resume: '', jd: '', projectNotes: '' })),
    saveMaterials: envelope(async (value) => value),
    start: envelope(async () => state.startResult || {}),
    // 旧 Host（rc.22 及更早）没有这两个方法：preparationRpc:false 用来复现「安静回退」。
    ...(preparationRpc ? {
      latestPreparation: envelope(async (value) => { state.latestCalls.push(value); return state.preparation }),
      prepareInterview: envelope(async (value) => { state.prepareCalls.push(value); return state.prepareResult }),
    } : {}),
    get: envelope(async (id) => ({ session: { sessionId: id }, turns: [] })),
    previewVoice: envelope(async (voice, provider) => {
      state.previewCalls.push([voice, provider])
      if (state.previewError) throw state.previewError
      return { audioBase64: Buffer.from('synthetic-preview').toString('base64'), mimeType: 'audio/wav' }
    }),
    // 后端语义：保存/清除后 capabilities 里的 deepSeekCredential 跟着变，UI 的「刷新 capabilities」才有意义。
    saveApiKey: envelope(async (value) => {
      state.saveCalls.push(value)
      if (state.saveGate) await state.saveGate
      if (state.saveError) throw new Error(state.saveError)
      state.caps = { ...state.caps, deepSeekCredential: state.saveResult }
      return state.saveResult
    }),
    clearApiKey: envelope(async () => {
      state.clearCalls.push(true)
      state.caps = { ...state.caps, deepSeekCredential: state.clearResult }
      return state.clearResult
    }),
  }
  if (nonEnumerable) {
    const capabilitiesMethod = api.capabilities; delete api.capabilities
    Object.defineProperty(api, 'capabilities', { value: capabilitiesMethod, enumerable: false, configurable: true })
  }
  const { output } = await buildClient({ root, write: false })
  let factory
  win.__ModuleLoader__ = { load(definition) { factory = definition.factory } }
  const sandbox = {
    window: win, document: win.document, navigator: win.navigator,
    Audio: TrackedAudio, Blob: FakeBlob, URL: FakeUrl,
    FileReader: undefined, MediaRecorder: undefined,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  vm.createContext(sandbox)
  vm.runInContext(output, sandbox)
  const client = factory((id) => { assert.equal(id, 'react'); return React })
  const registered = []
  const ctx = {
    effect: (callback) => callback(),
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    remote: { $mount: async () => {} },
    inject: async (names, callback) => { assert.deepEqual([...names], ['remote.hrInterview']); await callback({ ...ctx, remote: { ...ctx.remote, hrInterview: api } }) },
    slots: { inject: (_name, callback) => callback(), register(options, component) { registered.push({ options, component }); return () => {} }, entries: () => [] },
  }
  await client.apply(ctx)
  const main = registered.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'main slot 必须注册')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = win
  globalThis.document = win.document
  const container = win.document.getElementById('root')
  let mounted
  await act(async () => { mounted = createRoot(container); mounted.render(React.createElement(main.component, {})) })
  const flush = async () => { for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  await flush()
  const keyInput = () => container.querySelector('input[type="password"]')
  const buttonByText = (label) => [...container.querySelectorAll('button')].find((node) => node.textContent === label)
  const clickButton = async (label) => {
    const node = buttonByText(label)
    assert.ok(node, `找不到按钮「${label}」`)
    assert.equal(node.disabled, false, `按钮「${label}」应可点击`)
    await act(async () => { node.dispatchEvent(new win.MouseEvent('click', { bubbles: true })) })
    await flush()
  }
  // React 受控输入要求走原型 setter，否则 value tracking 会把这次修改判成「值没变」而不触发 onChange。
  const typeKey = async (value) => {
    const input = keyInput()
    assert.ok(input, '缺少 DeepSeek API Key 密码框')
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
    await act(async () => { setter.call(input, value); input.dispatchEvent(new win.Event('input', { bubbles: true })) })
    await flush()
  }
  return {
    container, window: win, state, audio: audioInstances, audioControl, objectUrls, act, flush, keyInput, typeKey, clickButton,
    text: () => container.textContent,
    buttonDisabled: (label) => { const node = buttonByText(label); assert.ok(node, `找不到按钮「${label}」`); return node.disabled },
    close: async () => { await act(async () => mounted.unmount()); win.close(); delete globalThis.window; delete globalThis.document },
  }
}

test('API Key 输入框：密码形态、512 上限、不落盘、也不回填任何 Key 文本', async (t) => {
  const harness = await mountSetupPanel({ credential: { configured: true, source: 'file', writable: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    const input = harness.keyInput()
    assert.ok(input, '设置页「运行条件」里必须有 DeepSeek API Key 输入框')
    assert.equal(input.getAttribute('type'), 'password', 'API Key 必须用密码框')
    assert.equal(input.getAttribute('maxlength'), '512', '输入长度上限应是 512')
    assert.equal(input.getAttribute('autocomplete'), 'off')
    assert.equal(input.getAttribute('spellcheck'), 'false')
    assert.match(input.getAttribute('placeholder') || '', /不会显示或回填完整 Key/, '输入框要说明 Key 由凭据服务保存、不回填')
    assert.match(harness.text(), /DeepSeek API Key/, '输入框需要可见 label')
    assert.equal(input.value, '', '后端状态不得回填进输入框')
    assert.match(harness.text(), /已配置（DSH 凭据存储）/, '状态区应说明 Key 的来源')
    assert.equal(harness.window.localStorage.length, 0, '挂载本身不该写 localStorage')

    await harness.typeKey(HR_FULL_KEY)
    assert.equal(harness.keyInput().value, HR_FULL_KEY, '输入的 Key 只留在组件内存里')
    assert.equal(harness.window.localStorage.length, 0, '输入 Key 不得写入 localStorage')
    assert.doesNotMatch(harness.text(), new RegExp(HR_FULL_KEY), '输入的 Key 不得进入可见文本')
  } finally { await harness.close() }
})

test('保存 Key：trim 后调用 saveApiKey、清空输入、刷新 capabilities，保存中不重复发请求', async (t) => {
  const harness = await mountSetupPanel({ credential: { configured: false, source: null, writable: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.buttonDisabled('清除已保存 Key'), true, '未配置时「清除已保存 Key」应禁用')
    assert.match(harness.text(), /未配置/, '未配置时状态应说明未配置')
    const capsBefore = harness.state.capsCalls
    await harness.typeKey(`  ${HR_FULL_KEY}  `)

    // 先卡住 saveApiKey，验证「保存中」既不重复发请求、也不会把别的控件锁死。
    let release
    harness.state.saveGate = new Promise((resolve) => { release = resolve })
    await harness.clickButton('保存 Key')
    assert.deepEqual(harness.state.saveCalls, [HR_FULL_KEY], '应 trim 后调用 api.saveApiKey')
    assert.equal(harness.buttonDisabled('保存中…'), true, '保存中按钮应变成不可用')
    const busyNode = [...harness.container.querySelectorAll('button')].find((node) => node.textContent === '保存中…')
    await harness.act(async () => { busyNode.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true })) })
    assert.deepEqual(harness.state.saveCalls, [HR_FULL_KEY], '保存中重复点击不得再次发 RPC')

    release()
    await harness.flush()
    assert.equal(harness.keyInput().value, '', '保存成功后必须清空输入框')
    assert.match(harness.text(), /Key 已保存/)
    assert.ok(harness.state.capsCalls > capsBefore, '保存成功后应刷新 capabilities')
    assert.match(harness.text(), /已配置（DSH 凭据存储）/, '状态应更新为 RPC 返回的 credential')
    assert.doesNotMatch(harness.text(), new RegExp(HR_FULL_KEY), '保存后界面不得出现完整 Key')
  } finally { await harness.close() }
})

test('空输入点击保存不发 RPC，只提示「请输入 API Key」', async (t) => {
  const harness = await mountSetupPanel({ credential: { configured: false, source: null, writable: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.typeKey('   ')
    await harness.clickButton('保存 Key')
    assert.deepEqual(harness.state.saveCalls, [], '空白输入不得触发 saveApiKey')
    assert.match(harness.text(), /请输入 API Key/)
  } finally { await harness.close() }
})

test('清除已保存 Key：仅在已配置且可写时启用，成功后清输入并刷新状态', async (t) => {
  const harness = await mountSetupPanel({ credential: { configured: true, source: 'file', writable: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.buttonDisabled('清除已保存 Key'), false, '已保存且可写时应允许清除')
    await harness.typeKey(HR_FULL_KEY)
    const capsBefore = harness.state.capsCalls
    await harness.clickButton('清除已保存 Key')
    assert.deepEqual(harness.state.clearCalls, [true], '应调用 api.clearApiKey')
    assert.equal(harness.keyInput().value, '', '清除后应清空输入框')
    assert.match(harness.text(), /已清除保存的 Key/)
    assert.ok(harness.state.capsCalls > capsBefore, '清除后应刷新 capabilities')
    assert.match(harness.text(), /未配置/, '状态应变成未配置')
    assert.doesNotMatch(harness.text(), new RegExp(HR_FULL_KEY), '界面不得出现完整 Key')
  } finally { await harness.close() }
})

test('启动环境变量提供的 Key：只读、禁止插件内保存与清除', async (t) => {
  const harness = await mountSetupPanel({ credential: { configured: true, source: 'env', writable: false } })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.match(harness.text(), /已配置（启动环境变量/, '状态应说明 Key 来自启动环境变量')
    assert.match(harness.text(), /启动环境变量只读，请在启动 DSH 的环境中修改/, '只读来源要给出中文提示')
    assert.equal(harness.buttonDisabled('清除已保存 Key'), true, '环境变量来源的 Key 不允许在插件里清除')
    assert.equal(harness.buttonDisabled('保存 Key'), true, '只读来源时保存按钮必须禁用，不能假装能保存')
    assert.deepEqual(harness.state.clearCalls, [])
    await harness.typeKey(HR_FULL_KEY)
    assert.deepEqual(harness.state.saveCalls, [], '只读来源即使有输入也不得发 saveApiKey')
    assert.doesNotMatch(harness.text(), /Key 已保存/, '只读来源不得误报保存成功')
  } finally { await harness.close() }
})

test('测试连接只在点击时调用 previewVoice(voice, deepseek)，复用试听播放并在失败时脱敏', async (t) => {
  const harness = await mountSetupPanel({ capabilities: { ttsConfigured: true }, credential: { configured: true, source: 'file', writable: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.deepEqual(harness.state.previewCalls, [], '挂载不得自动产生计费试听请求')
    assert.equal(harness.audio.length, 0, '挂载时不该创建音频播放')

    // 既有「试听 HR 声音」仍然走同一个播放路径（ttsConfigured 时走 host preview）。
    await harness.clickButton('试听 HR 声音')
    assert.deepEqual(harness.state.previewCalls, [['stella', 'auto']], '试听按钮应沿用当前引擎')
    assert.equal(harness.audio.length, 1)
    assert.equal(harness.audio[0].playCalls, 1, '试听结果应真的播放')

    await harness.clickButton('测试连接')
    assert.deepEqual(harness.state.previewCalls, [['stella', 'auto'], ['stella', 'deepseek']], '测试连接必须固定用 deepseek 引擎')
    assert.equal(harness.audio.length, 2)
    assert.equal(harness.audio[0].pauseCalls, 1, '新操作要先收掉上一段试听')
    assert.match(harness.text(), /连接成功/)

    harness.state.previewError = new Error(`401 invalid api key ${HR_FULL_KEY} rejected`)
    await harness.clickButton('测试连接')
    assert.equal(harness.audio.length, 2, '失败时不该再创建音频')
    assert.match(harness.text(), /连接失败/)
    assert.doesNotMatch(harness.text(), new RegExp(HR_FULL_KEY), '失败信息里不得出现完整 Key')
    assert.match(harness.text(), /sk-\*\*\*/, '疑似 Key 的片段应被脱敏')
  } finally { await harness.close() }
})

test('RemoteResult 信封：capabilities/list 成功时拆包，失败时把后端消息当错误显示', async (t) => {
  const harness = await mountSetupPanel({ capabilities: { configured: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.ok(harness.state.capsCalls >= 1, '挂载后应调用 capabilities')
    assert.ok(harness.state.listCalls >= 1, '挂载后应调用 list')
    assert.match(harness.text(), /模型：已配置/, 'capabilities 信封 { ok:true, value } 必须被拆开成业务对象')
    assert.doesNotMatch(harness.text(), /\{"ok":/, '界面不得把信封本体当数据渲染')

    // list 同样走信封：历史页应渲染出拆包后的 sessions，而不是空列表。
    harness.state.listEnvelopeSessions.push({ sessionId: 's-1', status: 'finished', mainQuestionCount: 6, inputMode: 'voice', createdAt: new Date(0).toISOString(), config: { role: '后端工程师' } })
    await harness.clickButton('历史与回炉')
    assert.match(harness.text(), /后端工程师/, 'list 信封拆包后历史页应显示真实场次')

    // 失败信封 → 抛出 error.message，Panel 显示后端给的错误文本。
    harness.state.capsError = '凭据服务不可用'
    await harness.clickButton('历史与回炉')
    assert.match(harness.text(), /凭据服务不可用/, 'ok:false 信封应把 error.message 抛成错误并显示')
  } finally { await harness.close() }
})

test('保存 Key 失败（ok:false）：提示后端消息、保留输入、不刷新 capabilities', async (t) => {
  const harness = await mountSetupPanel({ credential: { configured: false, source: null, writable: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    harness.state.saveError = '保存失败：测试'
    const capsBefore = harness.state.capsCalls
    await harness.typeKey(HR_FULL_KEY)
    await harness.clickButton('保存 Key')
    assert.deepEqual(harness.state.saveCalls, [HR_FULL_KEY])
    assert.match(harness.text(), /保存失败：测试/, '失败信封的 message 应显示在界面上')
    assert.equal(harness.keyInput().value, HR_FULL_KEY, '保存失败必须保留输入框里的 Key，方便重试')
    assert.equal(harness.state.capsCalls, capsBefore, '保存失败不得刷新 capabilities')
    assert.doesNotMatch(harness.text(), /Key 已保存/, '保存失败不得显示成功文案')
    assert.match(harness.text(), /未配置/, '保存失败后状态仍应是未配置')
  } finally { await harness.close() }
})

test('source 映射：file / project-env / user-env 都按中文来源展示，且可写时才允许清除', async (t) => {
  const cases = [
    ['file', '已配置（DSH 凭据存储）'],
    ['project-env', '已配置（项目 .env）'],
    ['user-env', '已配置（DSH .env）'],
  ]
  for (const [source, expected] of cases) {
    const harness = await mountSetupPanel({ credential: { configured: true, source, writable: true } })
    if (!harness) return skipNoReactDom(t)
    try {
      assert.match(harness.text(), new RegExp(expected.replace(/[（）]/g, '.')), `${source} 应显示中文来源`)
      assert.equal(harness.buttonDisabled('清除已保存 Key'), false, `${source} 可写时应允许清除`)
      assert.equal(harness.buttonDisabled('保存 Key'), false, `${source} 可写时应允许保存`)
      assert.doesNotMatch(harness.text(), /启动环境变量只读/, `${source} 不是只读来源，不该出现只读提示`)
    } finally { await harness.close() }
  }
})

test('Audio.play() 被拒时立刻释放 blob URL 并给出脱敏错误', async (t) => {
  const harness = await mountSetupPanel({ capabilities: { ttsConfigured: true }, credential: { configured: true, source: 'file', writable: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    harness.audioControl.reject = true
    await harness.clickButton('测试连接')
    assert.equal(harness.objectUrls.created.length, 1, '应创建一次 blob URL')
    assert.equal(harness.objectUrls.revoked.length, 1, 'play() 被拒后必须立刻 revoke 掉 blob URL')
    assert.match(String(harness.objectUrls.revoked[0]), /^blob:/, 'revoke 的应是 createObjectURL 返回的那个 URL')
    assert.match(harness.text(), /连接失败/, '播放失败也要看到错误提示')
    assert.match(harness.text(), /play\(\) failed/, '保留原始错误信息')
    assert.equal(harness.buttonDisabled('测试连接'), false, '失败后按钮要恢复可用')
  } finally { await harness.close() }
})

test('契约声明兜底包装 non-enumerable 远程方法', async (t) => {
  const harness = await mountSetupPanel({ capabilities: { configured: true }, nonEnumerable: true })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.ok(harness.state.capsCalls >= 1)
    assert.match(harness.text(), /模型：已配置/)
  } finally { await harness.close() }
})

test('未配置 ASR 时语音开关禁用，配置后恢复', async (t) => {
  for (const [configured, disabled] of [[false, true], [true, false]]) {
    const harness = await openInterviewFromHistory({ status: 'waiting_for_answer', asrProvider: 'auto', capabilities: { asrConfigured: configured } })
    if (!harness) return skipNoReactDom(t)
    try {
      await harness.openHistory()
      const button = harness.container.querySelector('button[data-hri-voice-toggle="true"]')
      assert.ok(button, '语音场必须有切换式录音按钮')
      assert.equal(button.textContent, '开始回答（空格）')
      assert.equal(button.disabled, disabled, `asrConfigured=${configured}`)
    } finally { await harness.close() }
  }
})

// —— 简历文件上传（jsdom + 真实 React，真正跑 change 事件与 effect） ——
// 覆盖：可见文件控件与可访问名 / 分块 base64 契约 / 前端前置校验不发 RPC / 解析失败保留草稿 /
// 上传与保存互斥 / 同文件重选 / truncated 与 warnings 有限提示 / 老 Host 缺 parseResume / 卸载竞态。
const PARSE_TEXT = '张三\nAgent 应用工程师\n5 年经验'

// jsdom 的 Blob/File 在部分版本没有 arrayBuffer()：只在测试环境补一份，读的就是喂进去的字节。
function testFile(win, name, bytes, sizeOverride) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
  const file = new win.File([data], name)
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      configurable: true,
    })
  }
  if (typeof sizeOverride === 'number') Object.defineProperty(file, 'size', { value: sizeOverride, configurable: true })
  return file
}

// 挂载真实 Panel 并切到「材料」页签；api.parseResume 按真实信封返回，调用记录留在 state 里。
// materials 可覆盖 materials() 的回填值（{ role: '', jd: '' } 用来走「空字段」路径）。
async function mountMaterialsPanel({ parseResult = null, withParseResume = true, holdMaterials = false, materials = null } = {}) {
  const real = await loadRealReact()
  const tools = real && await loadReactDomTools()
  if (!tools) return null
  const { React } = real
  const { JSDOM, createRoot, act } = tools
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  const state = {
    parseCalls: [], saveCalls: [], materialsCalls: 0,
    parseGate: null, parseError: null, saveGate: null,
    parseResult: parseResult || ((payload) => ({ text: PARSE_TEXT, fileName: payload.name, format: 'txt', characters: PARSE_TEXT.length, truncated: false, warnings: [] })),
    materials: { role: 'Agent 应用工程师', resume: '', jd: '岗位 JD：负责 Agent 应用与工具链', projectNotes: '', ...(materials || {}) },
    materialsGate: null,
  }
  // holdMaterials：把 materials() 卡在 pending，用来验证「材料没落地前不许上传」。
  let materialsResolve = null
  if (holdMaterials) state.materialsGate = new Promise((resolve) => { materialsResolve = resolve })
  // 真实 host 的每个 remote 方法都回 RemoteResult 信封：{ ok: true, value } / { ok: false, error }。
  const envelope = (thunk) => async (...args) => {
    try { return { ok: true, value: await thunk(...args) } } catch (error) { return { ok: false, error: { message: String(error?.message || error) } } }
  }
  const api = {
    capabilities: envelope(async () => ({ configured: true, asrConfigured: false, asrPreparation: null, ttsConfigured: false })),
    list: envelope(async () => ({ sessions: [], knowledge: [] })),
    materials: envelope(async () => { state.materialsCalls += 1; if (state.materialsGate) await state.materialsGate; return { ...state.materials } }),
    saveMaterials: envelope(async (value) => { state.saveCalls.push(value); if (state.saveGate) await state.saveGate; return value }),
  }
  if (withParseResume) {
    api.parseResume = envelope(async (payload) => {
      state.parseCalls.push(payload)
      if (state.parseGate) await state.parseGate
      if (state.parseError) throw new Error(state.parseError)
      return state.parseResult(payload)
    })
  }
  const { output } = await buildClient({ root, write: false })
  let factory
  win.__ModuleLoader__ = { load(definition) { factory = definition.factory } }
  const sandbox = {
    window: win, document: win.document, navigator: win.navigator,
    Audio: win.Audio, Blob: win.Blob, URL: win.URL, FileReader: win.FileReader, MediaRecorder: undefined,
    // 客户端用 btoa 拼 base64：这个全局在 vm 上下文里没有，必须显式注入。
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  vm.createContext(sandbox)
  vm.runInContext(output, sandbox)
  const client = factory((id) => { assert.equal(id, 'react'); return React })
  const registered = []
  const ctx = {
    effect: (callback) => callback(),
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    remote: { $mount: async () => {} },
    inject: async (names, callback) => { assert.deepEqual([...names], ['remote.hrInterview']); await callback({ ...ctx, remote: { ...ctx.remote, hrInterview: api } }) },
    slots: { inject: (_name, callback) => callback(), register(options, component) { registered.push({ options, component }); return () => {} }, entries: () => [] },
  }
  await client.apply(ctx)
  const main = registered.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'main slot 必须注册')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = win
  globalThis.document = win.document
  const container = win.document.getElementById('root')
  let mounted
  await act(async () => { mounted = createRoot(container); mounted.render(React.createElement(main.component, {})) })
  const flush = async () => { for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  await flush()
  const buttonByText = (label) => [...container.querySelectorAll('button')].find((node) => node.textContent === label)
  const clickButton = async (label) => {
    const node = buttonByText(label)
    assert.ok(node, `找不到按钮「${label}」`)
    assert.equal(node.disabled, false, `按钮「${label}」应可点击`)
    await act(async () => { node.dispatchEvent(new win.MouseEvent('click', { bubbles: true })) })
    await flush()
  }
  // MaterialsView 只在「材料」页签挂载（默认页签是「面试」）。
  await clickButton('材料')
  // 放行被 holdMaterials 卡住的 materials()，等 React 把 materialsReady 渲染出来。
  const releaseMaterials = async () => { if (materialsResolve) materialsResolve(); await flush() }
  const fileInput = () => container.querySelector('input[type="file"]')
  const resumeArea = () => container.querySelector('textarea[placeholder*="粘贴简历正文"]')
  const selectFile = async (file) => {
    const input = fileInput()
    assert.ok(input, '缺少简历文件选择控件')
    Object.defineProperty(input, 'files', { value: file ? [file] : [], configurable: true })
    await act(async () => { input.dispatchEvent(new win.Event('change', { bubbles: true })) })
    await flush()
  }
  // React 受控控件要走原型 setter，否则 value tracking 判成「没变」而不触发 onChange。
  const typeInto = async (node, next, kind) => {
    assert.ok(node, `缺少${kind}`)
    const proto = node instanceof win.HTMLInputElement ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    await act(async () => { setter.call(node, next); node.dispatchEvent(new win.Event('input', { bubbles: true })) })
    await flush()
  }
  // 材料页的可编辑控件：岗位输入框 / 简历 / 岗位 JD。
  const roleInput = () => container.querySelector('input.hri-input')
  const jdArea = () => container.querySelector('textarea[placeholder*="粘贴岗位职责"]')
  const typeResume = (next) => typeInto(resumeArea(), next, '简历 textarea')
  const typeRole = (next) => typeInto(roleInput(), next, '目标岗位输入框')
  const typeJd = (next) => typeInto(jdArea(), next, '岗位 JD textarea')
  let closed = false; let unmounted = false
  // 只卸载一次：有的用例会先手动 unmount() 再 close()，重复 unmount 会触发 React 警告。
  const unmount = async () => { if (unmounted) return; unmounted = true; await act(async () => mounted.unmount()) }
  return {
    container, window: win, state, act, flush, fileInput, resumeArea, roleInput, jdArea, selectFile, typeResume, typeRole, typeJd, clickButton, unmount, releaseMaterials,
    text: () => container.textContent,
    buttonDisabled: (label) => { const node = buttonByText(label); assert.ok(node, `找不到按钮「${label}」`); return node.disabled },
    buttonTitle: (label) => { const node = buttonByText(label); assert.ok(node, `找不到按钮「${label}」`); return node.getAttribute('title') },
    close: async () => { if (closed) return; closed = true; await unmount(); win.close(); delete globalThis.window; delete globalThis.document },
  }
}

test('简历上传：TXT 解析成功后填入草稿、显示文件名与字符数，不自动保存', async (t) => {
  const harness = await mountMaterialsPanel()
  if (!harness) return skipNoReactDom(t)
  try {
    const input = harness.fileInput()
    assert.ok(input, '材料页「简历」字段附近必须有文件选择控件')
    assert.equal(input.getAttribute('accept'), '.pdf,.docx,.txt,.md', 'accept 必须限制在四种格式')
    assert.equal(input.getAttribute('aria-label'), '上传简历文件', '控件要有明确的可访问名称')
    assert.match(harness.text(), /最大 8 MiB，本地解析/, '要说明体积上限与本地解析')
    assert.match(harness.text(), /不上传云端/, '要说明原文件不上传')
    assert.equal(harness.resumeArea().value, '', '初始简历草稿应为空')
    // rc.13：岗位与 JD 已回填、只缺简历时仍可存草稿，不再要求三个字段全非空。
    assert.equal(harness.buttonDisabled('保存材料'), false, '只缺简历时允许保存草稿')

    const bytes = Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))
    await harness.selectFile(testFile(harness.window, 'resume.txt', bytes))
    assert.equal(harness.state.parseCalls.length, 1, '一次选择只发一次 parseResume')
    assert.deepEqual(Object.keys(harness.state.parseCalls[0]).sort(), ['dataBase64', 'mimeType', 'name'], 'RPC 只认 name/mimeType/dataBase64')
    assert.equal(harness.state.parseCalls[0].name, 'resume.txt')
    assert.equal(harness.state.parseCalls[0].mimeType, 'text/plain')
    assert.equal(harness.state.parseCalls[0].dataBase64, Buffer.from(bytes).toString('base64'), 'base64 必须与文件字节完全一致')
    assert.equal(harness.resumeArea().value, PARSE_TEXT, '解析成功才替换简历草稿')
    assert.match(harness.text(), /resume\.txt/, '要显示解析出来的文件名')
    assert.match(harness.text(), new RegExp(`${PARSE_TEXT.length} 字符`), '要显示字符数')
    assert.match(harness.text(), /请检查后保存/)
    assert.deepEqual(harness.state.saveCalls, [], '上传不得自动调用 saveMaterials')
    assert.equal(harness.fileInput().value, '', '结束后清空 input.value，同一个文件才能重选')
    assert.equal(harness.buttonDisabled('保存材料'), false, '有草稿后允许手动保存')
  } finally { await harness.close() }
})

test('简历上传：空文件/超限/非法扩展/取消都不发 RPC，解析失败保留草稿', async (t) => {
  const harness = await mountMaterialsPanel()
  if (!harness) return skipNoReactDom(t)
  const DRAFT = '我自己粘的简历草稿'
  try {
    await harness.typeResume(DRAFT)
    assert.equal(harness.resumeArea().value, DRAFT)

    await harness.selectFile(testFile(harness.window, 'empty.txt', new Uint8Array(0)))
    assert.match(harness.text(), /这个文件是空的/)

    await harness.selectFile(testFile(harness.window, 'huge.txt', Uint8Array.from([1, 2, 3]), 8 * 1024 * 1024 + 1))
    assert.match(harness.text(), /超过 8 MiB 上限/)

    await harness.selectFile(testFile(harness.window, 'resume.exe', Uint8Array.from([1, 2, 3])))
    assert.match(harness.text(), /只支持 PDF \/ DOCX \/ TXT \/ MD/)

    await harness.selectFile(null)
    assert.deepEqual(harness.state.parseCalls, [], '前置校验与用户取消都不得调用 parseResume')
    assert.equal(harness.resumeArea().value, DRAFT, '失败与取消都要保留原草稿')

    harness.state.parseError = '解析器崩了'
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from('x', 'utf8'))))
    assert.equal(harness.state.parseCalls.length, 1)
    assert.match(harness.text(), /解析失败：解析器崩了/, 'ok:false 信封的错误消息要显示出来')
    assert.equal(harness.resumeArea().value, DRAFT, 'RPC 失败不得覆盖草稿')
    assert.deepEqual(harness.state.saveCalls, [], '失败也不得自动保存')
    assert.equal(harness.fileInput().disabled, false, '失败后控件要恢复可用')
    assert.equal(harness.fileInput().value, '', '失败路径同样要清空 input.value')
  } finally { await harness.close() }
})

test('简历上传：并发只发一次 RPC，上传中禁用保存、保存中禁用上传', async (t) => {
  const harness = await mountMaterialsPanel()
  if (!harness) return skipNoReactDom(t)
  try {
    let releaseUpload
    harness.state.parseGate = new Promise((resolve) => { releaseUpload = resolve })
    const bytes = Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))
    await harness.selectFile(testFile(harness.window, 'resume.txt', bytes))
    assert.equal(harness.state.parseCalls.length, 1)
    assert.match(harness.text(), /正在本地解析/)
    assert.match(harness.text(), /解析结束前不能保存/, '上传中要说明保存为什么不可用')
    assert.equal(harness.fileInput().disabled, true, '上传中控件应禁用')
    assert.equal(harness.buttonDisabled('保存材料'), true, '上传中不得保存半份草稿')

    await harness.selectFile(testFile(harness.window, 'resume.txt', bytes))
    assert.equal(harness.state.parseCalls.length, 1, '上传中再选文件不得重复发 RPC')

    releaseUpload()
    await harness.flush()
    assert.equal(harness.resumeArea().value, PARSE_TEXT)
    assert.equal(harness.fileInput().disabled, false)
    assert.equal(harness.buttonDisabled('保存材料'), false)

    let releaseSave
    harness.state.saveGate = new Promise((resolve) => { releaseSave = resolve })
    await harness.clickButton('保存材料')
    assert.equal(harness.state.saveCalls.length, 1)
    assert.equal(harness.buttonDisabled('保存中…'), true, '保存中按钮应变成不可用')
    assert.match(harness.text(), /正在保存材料/, '保存中要说明当前在做什么')
    assert.equal(harness.fileInput().disabled, true, '保存中不得上传覆盖正在提交的值')
    releaseSave()
    await harness.flush()
    assert.equal(harness.state.saveCalls[0].resume, PARSE_TEXT, '保存的是解析后的草稿')
    assert.match(harness.text(), /材料已保存/)
    assert.equal(harness.fileInput().disabled, false)
  } finally { await harness.close() }
})

test('简历上传：truncated 与 warnings 只显示有限提示', async (t) => {
  const harness = await mountMaterialsPanel({
    parseResult: (payload) => ({ text: PARSE_TEXT, fileName: payload.name, format: 'pdf', characters: PARSE_TEXT.length, truncated: true, warnings: ['提示一', '提示二', '提示三', '提示四', '提示五'] }),
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.selectFile(testFile(harness.window, 'resume.pdf', Uint8Array.from([1, 2, 3, 4])))
    assert.equal(harness.state.parseCalls[0].mimeType, 'application/pdf')
    assert.match(harness.text(), /已截断/, 'truncated 要有中文提示')
    for (const warning of ['提示一', '提示二', '提示三']) assert.match(harness.text(), new RegExp(warning))
    assert.doesNotMatch(harness.text(), /提示四/, 'warnings 只显示前三条')
    assert.match(harness.text(), /另有 2 条提示/)
    assert.equal(harness.resumeArea().value, PARSE_TEXT, '带提示的成功结果仍要填入草稿')
  } finally { await harness.close() }
})

test('简历上传：大文件分块 base64 不错位，扩展名映射对应的 MIME', async (t) => {
  const harness = await mountMaterialsPanel()
  if (!harness) return skipNoReactDom(t)
  try {
    // 70000 字节跨过 32766 的分块边界：拼起来仍必须与单次编码完全一致。
    const big = Uint8Array.from({ length: 70000 }, (unused, index) => 97 + (index % 26))
    await harness.selectFile(testFile(harness.window, 'big.md', big))
    assert.equal(harness.state.parseCalls[0].mimeType, 'text/markdown')
    assert.equal(harness.state.parseCalls[0].dataBase64, Buffer.from(big).toString('base64'))

    await harness.selectFile(testFile(harness.window, 'resume.docx', Uint8Array.from([80, 75, 3, 4])))
    assert.equal(harness.state.parseCalls[1].mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert.equal(harness.state.parseCalls.length, 2, '同文件重选/换文件都要能再解析')
  } finally { await harness.close() }
})

test('简历上传：老 Host 缺 parseResume 时降级提示，卸载后旧请求不再回写', async (t) => {
  const legacy = await mountMaterialsPanel({ withParseResume: false })
  if (!legacy) return skipNoReactDom(t)
  try {
    await legacy.selectFile(testFile(legacy.window, 'resume.txt', Uint8Array.from(Buffer.from('x', 'utf8'))))
    assert.match(legacy.text(), /当前 Host 版本还不支持解析文件/, '缺 RPC 时要说清降级路径')
    assert.equal(legacy.resumeArea().value, '', '缺 RPC 时不得改动草稿')
    assert.equal(legacy.fileInput().disabled, false)
  } finally { await legacy.close() }

  const harness = await mountMaterialsPanel()
  try {
    let release
    harness.state.parseGate = new Promise((resolve) => { release = resolve })
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from('x', 'utf8'))))
    assert.equal(harness.state.parseCalls.length, 1)
    await harness.unmount()
    release()
    await harness.flush()
    assert.equal(harness.container.textContent, '', '卸载后旧请求不得再渲染或报错')
  } finally { await harness.close() }
})

test('简历上传：materials 未决时文件输入禁用，settle 后恢复可选', async (t) => {
  const harness = await mountMaterialsPanel({ holdMaterials: true })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.state.materialsCalls, 2, '准备页读取岗位摘要，材料页独立加载一次草稿')
    // 迟到的 materials 回填会盖掉刚解析出的草稿，所以 settle 之前不给选文件。
    assert.equal(harness.fileInput().disabled, true, 'materials 未落地前文件输入必须禁用')
    // 就算被自动填充 / 扩展硬塞一个 change（真实用户点不到 disabled 控件），也不许绕过这道闸。
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from('x', 'utf8'))))
    assert.deepEqual(harness.state.parseCalls, [], '未 ready 时不得调用 parseResume')
    assert.equal(harness.resumeArea().value, '', '未 ready 时不得改动草稿')

    await harness.releaseMaterials()
    assert.equal(harness.fileInput().disabled, false, 'materials settle 后控件要启用')
    assert.equal(harness.fileInput().value, '', '放行时 input.value 应为空，可以直接选文件')

    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))))
    assert.equal(harness.state.parseCalls.length, 1, 'ready 之后才允许解析')
    assert.equal(harness.resumeArea().value, PARSE_TEXT, '解析结果要填进草稿')
  } finally { await harness.close() }
})

// —— rc.13 材料页：空 role / 空 JD 的草稿路径，与「岗位建议不覆盖手填值」 ——
const EMPTY_MATERIALS = { role: '', resume: '', jd: '', projectNotes: '' }
const suggest = (role, source, extra = {}) => (payload) => ({
  text: PARSE_TEXT, fileName: payload.name, format: 'txt', characters: PARSE_TEXT.length, truncated: false, warnings: [], suggestedRole: role, suggestedRoleSource: source, ...extra,
})

test('材料草稿：四个字段全空时禁用保存，并把原因写在按钮上', async (t) => {
  const harness = await mountMaterialsPanel({ materials: { ...EMPTY_MATERIALS } })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.roleInput().value, '', 'materials 回填的空岗位应保持为空')
    assert.equal(harness.jdArea().value, '', 'materials 回填的空 JD 应保持为空')
    assert.equal(harness.buttonDisabled('保存材料'), true, '全空时不能保存')
    assert.match(harness.buttonTitle('保存材料'), /至少填一项/, '按钮 title 要解释为什么不可用')
    assert.match(harness.text(), /至少填一项才能保存/, '按钮附近也要说清禁用原因')
    assert.match(harness.text(), /可先保存草稿，开始面试前再补 JD/, '缺 JD 时就提示可以先存草稿')

    // 只要有一个字段有内容就必须解禁 —— 这里用简历，验证的不是「三项齐全」。
    await harness.typeResume('我自己粘的简历正文')
    assert.equal(harness.buttonDisabled('保存材料'), false, '有任意一项内容就允许保存')
    assert.equal(harness.buttonTitle('保存材料'), null, '可用时不该再挂禁用原因')
    assert.doesNotMatch(harness.text(), /至少填一项才能保存/)
  } finally { await harness.close() }
})

test('材料草稿：只有简历时也能保存，jd 按空串提交并区分「草稿已保存」', async (t) => {
  const harness = await mountMaterialsPanel({ materials: { ...EMPTY_MATERIALS } })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))))
    assert.equal(harness.resumeArea().value, PARSE_TEXT)
    assert.equal(harness.roleInput().value, '', '解析结果没有岗位建议时不得凭空填岗位')
    assert.equal(harness.buttonDisabled('保存材料'), false, '只有简历也能保存草稿')
    assert.match(harness.text(), /可先保存草稿，开始面试前再补 JD/)

    await harness.clickButton('保存材料')
    assert.equal(harness.state.saveCalls.length, 1)
    // 面板在 vm 里跑，提交对象来自另一个 realm：先过一遍 JSON 再比对，避免原型不同导致误报。
    assert.deepEqual(JSON.parse(JSON.stringify(harness.state.saveCalls[0])), { role: '', resume: PARSE_TEXT, jd: '', projectNotes: '' }, '缺 role/JD 时按空串提交')
    assert.match(harness.text(), /草稿已保存（还缺目标岗位、岗位 JD）/, '缺字段时必须说是草稿并列出缺什么')
    assert.doesNotMatch(harness.text(), /材料已保存/, '草稿不能冒充「材料已保存」')
    assert.equal(harness.buttonDisabled('保存材料'), false, '草稿保存后仍可继续改再保存')
  } finally { await harness.close() }
})

test('材料草稿：三项齐全时提示「材料已保存」，不再是草稿文案', async (t) => {
  const harness = await mountMaterialsPanel()
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))))
    assert.equal(harness.buttonDisabled('保存材料'), false)
    await harness.clickButton('保存材料')
    assert.match(harness.text(), /材料已保存/)
    assert.doesNotMatch(harness.text(), /草稿已保存/)
    assert.doesNotMatch(harness.text(), /可先保存草稿，开始面试前再补 JD/)
  } finally { await harness.close() }
})

test('岗位建议：空岗位按求职意向填入并标注来源，手改后提示消失', async (t) => {
  const harness = await mountMaterialsPanel({ materials: { ...EMPTY_MATERIALS }, parseResult: suggest('Agent 平台工程师', 'intent') })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))))
    assert.equal(harness.roleInput().value, 'Agent 平台工程师', '空岗位要被求职意向填上')
    assert.match(harness.text(), /求职意向/, '要说明建议来自求职意向')
    assert.match(harness.text(), /可修改/, '要说明可以改')
    assert.equal(harness.buttonDisabled('保存材料'), false, '自动填岗位后仍要用户自己点保存')
    assert.deepEqual(harness.state.saveCalls, [], '自动填岗位不得自动保存')

    await harness.typeRole('我自己的岗位')
    assert.doesNotMatch(harness.text(), /已按简历里的求职意向填入/, '手改岗位后来源提示要撤掉，避免与输入框不一致')
    assert.equal(harness.roleInput().value, '我自己的岗位')
  } finally { await harness.close() }
})

test('岗位建议：来源可以是文件名，并同样标注可修改', async (t) => {
  const harness = await mountMaterialsPanel({ materials: { ...EMPTY_MATERIALS }, parseResult: suggest('数据分析师', 'filename') })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))))
    assert.equal(harness.roleInput().value, '数据分析师', '空岗位要被文件名建议填上')
    assert.match(harness.text(), /文件名/, '要说明建议来自文件名')
    assert.match(harness.text(), /可修改/)
  } finally { await harness.close() }
})

test('岗位建议：用户手填的岗位不被简历建议覆盖', async (t) => {
  const harness = await mountMaterialsPanel({ materials: { ...EMPTY_MATERIALS }, parseResult: suggest('数据平台工程师', 'intent') })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.typeRole('我手填的岗位')
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))))
    assert.equal(harness.roleInput().value, '我手填的岗位', '手填的岗位绝不能被覆盖')
    assert.equal(harness.resumeArea().value, PARSE_TEXT, '简历正文仍要正常填入')
    assert.match(harness.text(), /已保留你填写的岗位/, '要说明建议被保留而不是静默丢弃')
  } finally { await harness.close() }
})

test('岗位建议：自动填入后用户改过，再上传也不覆盖', async (t) => {
  const harness = await mountMaterialsPanel({ materials: { ...EMPTY_MATERIALS }, parseResult: suggest('第一版建议岗位', 'intent') })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))))
    assert.equal(harness.roleInput().value, '第一版建议岗位', '第一次上传应自动填入')
    await harness.typeRole('我改过的岗位')

    harness.state.parseResult = suggest('第二版建议岗位', 'filename')
    await harness.selectFile(testFile(harness.window, 'resume2.txt', Uint8Array.from(Buffer.from(`${PARSE_TEXT}\n第二份`, 'utf8'))))
    assert.equal(harness.state.parseCalls.length, 2)
    assert.equal(harness.roleInput().value, '我改过的岗位', '自动建议只在上一次建议仍未被改动时才能再填')
  } finally { await harness.close() }
})

test('岗位建议：连续两次上传仍未被改动时，允许被新建议刷新', async (t) => {
  const harness = await mountMaterialsPanel({ materials: { ...EMPTY_MATERIALS }, parseResult: suggest('第一版建议岗位', 'intent') })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.selectFile(testFile(harness.window, 'resume.txt', Uint8Array.from(Buffer.from(PARSE_TEXT, 'utf8'))))
    assert.equal(harness.roleInput().value, '第一版建议岗位')
    harness.state.parseResult = suggest('第二版建议岗位', 'filename')
    await harness.selectFile(testFile(harness.window, 'resume2.txt', Uint8Array.from(Buffer.from(`${PARSE_TEXT}\n第二份`, 'utf8'))))
    assert.equal(harness.roleInput().value, '第二版建议岗位', '岗位仍等于上一次自动建议时应允许刷新')
    assert.match(harness.text(), /文件名/)
  } finally { await harness.close() }
})


// ═══ 口型表演层（lip-sync）═══
// 这一组只测表演层：client.js 里的 level 计算、AudioContext 接线/清理、以及 HRMark 真的把
// performanceState + lipLevelRef 传给了渲染端。渲染端（src/live2d-avatar.js）由别的改动负责，
// 这里一律用探针替换 —— 不启动浏览器、不放可听声音，全部是 mock/离线。
const AVATAR_PROBE = `
function hrLive2dComponent(React) {
  const h = React.createElement
  return function Live2DAvatarProbe(props = {}) {
    const calls = window.__hrAvatarCalls || (window.__hrAvatarCalls = [])
    calls.push({ performanceState: props.performanceState, speaking: props.speaking, lipLevelRef: props.lipLevelRef, fill: props.fill, pressureReaction: props.pressureReaction, pressureMode: props.pressureMode, pressureGesture: props.pressureGesture })
    return h('span', { className: 'hri-probe-avatar' }, String(props.performanceState))
  }
}
`
// 只追加进「测试产物」的导出：把 client 里的口型实现拿出来做单元级验证，磁盘上的真文件一个字不改。
const LIP_EPILOGUE = '\nmodule.exports.__lipProbe = { createLipDriver, performanceStateFor, lipLevelFromFloat, lipLevelFromByte, lipShapeFrom, LIP_SPEECH_ENVELOPE, LIP_LIMITS, playPressureBreath }\n'

async function mountClientInternals() {
  const source = await readFile(path.join(root, 'src/client.js'), 'utf8')
  const { output } = await buildClient({ root, write: false, overrides: { 'src/client.js': `${source}${LIP_EPILOGUE}` } })
  let factory
  // 与 mountMainPanel 保持同一套沙箱形状：client 只通过 window 触达宿主环境，
  // 这里把 rAF / AudioContext 留空，交给每条测试自己装替身（也顺带证明缺 rAF 时有兜底）。
  const window = { __ModuleLoader__: { load(definition) { factory = definition.factory } } }
  vm.runInNewContext(output, { window, setTimeout, clearTimeout, console })
  const React = { createElement() {}, Fragment: 'fragment', useCallback: (value) => value, useEffect() {}, useMemo: (value) => value, useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] }
  const client = factory((id) => { assert.equal(id, 'react'); return React })
  assert.ok(client.__lipProbe, '口型实现必须能被探针取到（否则这条测试等于没测）')
  return { probe: client.__lipProbe, window }
}

// 帧调度器替身：模拟 requestAnimationFrame —— tick 只跑「这一帧之前排队的回调」，
// 回调里新排的帧留到下一帧，和浏览器行为一致。cancel 按 id 撤销。
// 每帧推进一个虚拟时钟并把 timestamp 传给回调：口型平滑改成时间驱动之后，
// 测试必须能像真浏览器那样「告诉」driver 这段过了多少毫秒（step 可调，用来对比 60Hz / 120Hz）。
function fakeRaf({ step = 16 } = {}) {
  let next = 0
  let clock = 0
  const pending = new Map()
  return {
    request(callback) { next += 1; pending.set(next, callback); return next },
    cancel(id) { pending.delete(id) },
    tick(times = 1) {
      for (let index = 0; index < times; index += 1) {
        clock += step
        const batch = [...pending.values()]; pending.clear()
        for (const callback of batch) callback(clock)
      }
    },
    callbacks: () => [...pending.values()],
    pending: () => pending.size,
    clock: () => clock,
  }
}

// Web Audio 替身：记录建了几张图、连到哪、关了几次；analyser 的时域数据由 wave 直接给。
function fakeWebAudio({ state = 'running', resume = 'resolve' } = {}) {
  const record = { contexts: [], analysers: [], sources: [], resumes: 0, closes: 0, resolvers: [] }
  class FakeAnalyser {
    constructor(owner) { this.owner = owner; this.fftSize = 1024; this.wave = null; this.disconnects = 0; this.connectedTo = []; record.analysers.push(this) }
    connect(node) { this.connectedTo.push(node) }
    disconnect() { this.disconnects += 1 }
    getFloatTimeDomainData(target) {
      const wave = this.wave && this.wave.length ? this.wave : [0]
      for (let index = 0; index < target.length; index += 1) target[index] = wave[index % wave.length]
    }
  }
  class FakeSource {
    constructor(element) { this.element = element; this.disconnects = 0; this.connectedTo = []; record.sources.push(this) }
    connect(node) { this.connectedTo.push(node) }
    disconnect() { this.disconnects += 1 }
  }
  class FakeContext {
    constructor() { this.state = state; this.destination = { kind: 'destination' }; record.contexts.push(this) }
    createAnalyser() { return new FakeAnalyser(this) }
    createMediaElementSource(element) { return new FakeSource(element) }
    resume() {
      record.resumes += 1
      // pending：模拟「resume 永远不落地」；manual：由测试决定什么时候落地（验证「迟到的 resume」）。
      if (resume === 'pending') return new Promise(() => {})
      if (resume === 'manual') return new Promise((resolve) => { record.resolvers.push(resolve) })
      return resume === 'reject' ? Promise.reject(new Error('resume rejected')) : Promise.resolve()
    }
    close() { record.closes += 1; return Promise.resolve() }
  }
  return { record, Context: FakeContext }
}

// 记录实例的 Audio 替身：测试要能手工触发 onended / 数 play 次数。
function trackedAudioClass(outcome = 'ok') {
  const instances = []
  class TrackingAudio {
    constructor(src) { this.src = src; this.playCalls = 0; this.pauseCalls = 0; instances.push(this) }
    pause() { this.pauseCalls += 1 }
    play() {
      this.playCalls += 1
      if (outcome === 'blocked') { const error = new Error("play() failed because the user didn't interact with the document first"); error.name = 'NotAllowedError'; return Promise.reject(error) }
      return Promise.resolve()
    }
  }
  return { Audio: TrackingAudio, instances }
}

// 走真实用户路径把面板开到「面试页」：设置页勾上「启用 Live2D 面试官」→ 历史与回炉 → 点该场次。
// 之所以不直接 seed state：InterviewView 里的 lipLevelRef / driver 都是真实 hook，只有真实挂载
// 才会真的跑 effect；而左屏的 probe 只有在 Live2D 被启用时才会被渲染出来。
async function mountStageInterview({ status = 'waiting_for_answer', inputMode = 'voice', ttsProvider = 'browser', capabilities = {}, audioOutcome = 'ok', speakError = null, browserTts = true, mode = 'mock', persona = 'professional', pressureCue, pressureFocus, pressureBlackFace, control } = {}) {
  const real = await loadRealReact()
  const tools = real && await loadReactDomTools()
  if (!tools) return null
  const { React } = real
  const { JSDOM, createRoot, act } = tools
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  // 帧与 Web Audio 都在进入沙箱之前装好：createLipDriver 在创建时就把 rAF 取走了。
  const raf = fakeRaf()
  win.requestAnimationFrame = (callback) => raf.request(callback)
  win.cancelAnimationFrame = (id) => raf.cancel(id)
  const spoken = []; const utterances = []; const speakCalls = []; const revoked = []
  if (browserTts) {
    win.speechSynthesis = { cancel() {}, speak(utterance) { utterances.push(utterance); spoken.push(utterance.text) } }
    win.SpeechSynthesisUtterance = class { constructor(text) { this.text = String(text) } }
  }
  const web = fakeWebAudio()
  win.AudioContext = web.Context
  const audio = trackedAudioClass(audioOutcome)
  class FakeUrl { static createObjectURL() { return 'blob:hr-lip' } static revokeObjectURL(url) { revoked.push(url) } }
  class FakeBlob { constructor() { this.size = 1; this.type = 'audio/wav' } }
  const caps = { configured: true, asrConfigured: true, asrPreparation: null, ttsConfigured: false, avatar: STAGE_AVATAR, ...capabilities }
  const sessionId = 'hr-lip'
  const bundle = {
    session: { sessionId, status, inputMode, asrProvider: 'deepseek', ttsProvider, voice: 'stella', mainQuestionCount: 1, questionBudget: 4, persona, mode, pressureBlackFace },
    turns: [{ id: 't-hr-1', speaker: 'hr', kind: 'main_question', text: '请做一个简短自我介绍。', pressureCue, pressureFocus }],
    evaluation: null,
  }
  const api = {
    capabilities: async () => ({ ...caps }),
    list: async () => ({ sessions: [{ sessionId, status, inputMode, mainQuestionCount: 1, createdAt: '2026-01-01T00:00:00.000Z', config: { role: 'Agent 应用工程师' } }], knowledge: [], now: '2026-01-01T00:00:00.000Z' }),
    get: async (id) => { assert.equal(id, sessionId); return bundle },
    control,
    materials: async () => ({ role: '', resume: '', jd: '', projectNotes: '' }),
    saveMaterials: async (value) => value,
    speak: async (calledSessionId, turnId) => {
      speakCalls.push({ sessionId: calledSessionId, turnId })
      if (speakError) throw speakError
      return { audioBase64: Buffer.from('synthetic-audio').toString('base64'), mimeType: 'audio/wav' }
    },
  }
  const { output } = await buildClient({ root, write: false, overrides: { 'src/live2d-avatar.js': AVATAR_PROBE } })
  let factory
  win.__ModuleLoader__ = { load(definition) { factory = definition.factory } }
  const sandbox = {
    window: win, document: win.document, navigator: win.navigator,
    Audio: audio.Audio, Blob: FakeBlob, URL: FakeUrl,
    FileReader: undefined, MediaRecorder: undefined,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  vm.createContext(sandbox)
  vm.runInContext(output, sandbox)
  const client = factory((id) => { assert.equal(id, 'react'); return React })
  const registered = []
  const ctx = {
    effect: (callback) => callback(),
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    remote: { $mount: async () => {} },
    inject: async (names, callback) => { await callback({ ...ctx, remote: { ...ctx.remote, hrInterview: api } }) },
    slots: { inject: (_name, callback) => callback(), register(options, component) { registered.push({ options, component }); return () => {} }, entries: () => [] },
  }
  await client.apply(ctx)
  const main = registered.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'main slot 必须注册')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = win
  globalThis.document = win.document
  const container = win.document.getElementById('root')
  let mounted
  await act(async () => { mounted = createRoot(container); mounted.render(React.createElement(main.component, {})) })
  const flush = async () => { for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  await flush()
  const probeCalls = () => win.__hrAvatarCalls || []
  const lastProbe = () => { const calls = probeCalls(); return calls[calls.length - 1] || null }
  const buttonByText = (label) => [...container.querySelectorAll('button')].find((node) => node.textContent === label)
  const click = async (node, label) => { assert.ok(node, `找不到「${label}」`); await act(async () => { node.dispatchEvent(new win.MouseEvent('click', { bubbles: true })) }); await flush() }
  // 准备页直接启用预览，再进历史场次检查左屏渲染端。
  const preview = container.querySelector('.hri-setup-interviewer')
  const avatarToggle = preview?.querySelector('input[type="checkbox"]')
  assert.ok(avatarToggle, '准备页预览区应给出「启用 Live2D 面试官」勾选框')
  await act(async () => { avatarToggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true })) })
  await flush()
  assert.ok(preview.querySelector('.hri-probe-avatar'), '设置仍折叠时面试官也能加载')
  assert.equal(container.querySelector('[data-hri-setup-settings]').open, false)
  await click(buttonByText('历史与回炉'), '历史与回炉 tab')
  await click(container.querySelector('.hri-history'), '历史场次条目')
  assert.match(container.textContent, /请做一个简短自我介绍/, '应当真的打开了该场次')
  assert.ok(lastProbe(), '启用 Live2D 后左屏必须挂上渲染端，否则表演状态无从观察')
  return {
    window: win, raf, web, audio, spoken, utterances, speakCalls, revoked, act,
    text: () => container.textContent,
    probe: lastProbe,
    state: () => lastProbe()?.performanceState,
    lip: () => { const probe = lastProbe(); return probe?.lipLevelRef ? probe.lipLevelRef.current : null },
    lipRef: () => lastProbe()?.lipLevelRef,
    clickButton: async (label) => { const button = buttonByText(label); assert.ok(button, `找不到按钮「${label}」`); assert.equal(button.disabled, false, `按钮「${label}」应可点击`); await click(button, label) },
    finishSpeech: async () => { await act(async () => { utterances.splice(0).forEach((utterance) => utterance.onend?.()) }); await flush() },
    close: async () => { await act(async () => mounted.unmount()); win.close(); delete globalThis.window; delete globalThis.document },
  }
}

test('压力面疑惑语调在朗读后结束，黑脸仍然保留，标准面忽略压力标记', async (t) => {
  const pressure = await mountStageInterview({ mode: 'mock', persona: 'pressure', pressureCue: 'questioning', pressureFocus: 'recovery', pressureBlackFace: true })
  if (!pressure) return skipNoReactDom(t)
  try {
    assert.equal(pressure.probe().pressureReaction, 'questioning')
    assert.equal(pressure.probe().pressureGesture, 'black-face')
    assert.equal(pressure.utterances.length, 0)
    await pressure.act(async () => { await new Promise((resolve) => setTimeout(resolve, 370)) })
    assert.equal(pressure.utterances.length, 1)
    assert.equal(pressure.utterances[0].pitch, 1.08)
    await pressure.finishSpeech()
    assert.equal(pressure.probe().pressureReaction, '')
    assert.equal(pressure.probe().pressureGesture, 'black-face')
  } finally { await pressure.close() }
  const standard = await mountStageInterview({ mode: 'mock', persona: 'professional', pressureCue: 'questioning', pressureFocus: 'recovery', pressureBlackFace: true })
  try {
    assert.equal(standard.probe().pressureReaction, '')
    assert.equal(standard.probe().pressureGesture, '')
    assert.equal(standard.utterances.length, 1)
    assert.equal(standard.utterances[0].rate, 0.95)
    assert.equal(standard.utterances[0].pitch, undefined)
  } finally { await standard.close() }
})

test('压力面跳题立即结束朗读，但黑脸在等待下一道题时保留', async (t) => {
  let complete
  const pending = new Promise((resolve) => { complete = resolve })
  const pressure = await mountStageInterview({ persona: 'pressure', pressureCue: 'questioning', pressureFocus: 'recovery', pressureBlackFace: true,
    control: (_id, action) => { assert.equal(action, 'skip'); return pending } })
  if (!pressure) return skipNoReactDom(t)
  try {
    assert.equal(pressure.probe().pressureMode, true)
    assert.equal(pressure.probe().pressureGesture, 'black-face')
    await pressure.clickButton('跳过本题')
    assert.equal(pressure.probe().speaking, false)
    assert.equal(pressure.probe().pressureGesture, 'black-face')
  } finally {
    await pressure.act(async () => complete())
    await pressure.close()
  }
})

test('压力面证据追问配合屑屑眼，标准面保留原始表现', async (t) => {
  const settings = { ttsProvider: 'deepseek', pressureCue: 'firm', pressureFocus: 'evidence' }
  const pressure = await mountStageInterview({ ...settings, persona: 'pressure' })
  if (!pressure) return skipNoReactDom(t)
  try {
    assert.equal(pressure.speakCalls.length, 1)
    assert.equal(pressure.audio.instances[0].playbackRate, 0.88)
    assert.equal(pressure.probe().pressureReaction, 'firm')
    assert.equal(pressure.probe().pressureGesture, 'doubt')
  } finally { await pressure.close() }
  const standard = await mountStageInterview(settings)
  try {
    assert.equal(standard.speakCalls.length, 1)
    assert.equal(standard.audio.instances[0].playbackRate, undefined)
    assert.equal(standard.probe().pressureReaction, '')
    assert.equal(standard.probe().pressureGesture, '')
  } finally { await standard.close() }
})

test('压力面的轻叹在本机合成，停止时关闭声音资源', async () => {
  const { probe, window } = await mountClientInternals()
  let stopped = 0
  let closed = 0
  let samples
  window.AudioContext = class {
    sampleRate = 44100
    state = 'running'
    createBuffer(_channels, length) { samples = new Float32Array(length); return { getChannelData: () => samples } }
    createBufferSource() { return { connect() {}, start() {}, stop() { stopped += 1 } } }
    async close() { closed += 1 }
  }
  const stop = probe.playPressureBreath()
  assert.ok(samples.some((value) => Math.abs(value) > 0.001))
  assert.equal(Math.abs(samples[0]), 0)
  stop()
  stop()
  assert.equal(stopped, 1)
  assert.equal(closed, 1)
})

test('口型：performanceState 优先级 speaking > thinking > listening > idle', async () => {
  const { probe } = await mountClientInternals()
  assert.equal(probe.performanceStateFor(true, 'processing_answer'), 'speaking', 'speaking 压过一切状态')
  assert.equal(probe.performanceStateFor(true, 'completed'), 'speaking')
  for (const status of ['processing_answer', 'generating_question', 'evaluating']) assert.equal(probe.performanceStateFor(false, status), 'thinking', `${status} → thinking`)
  assert.equal(probe.performanceStateFor(false, 'waiting_for_answer'), 'listening')
  for (const status of ['waiting_for_hr', 'paused', 'review_pending', 'completed', 'error', 'reviewing', undefined]) assert.equal(probe.performanceStateFor(false, status), 'idle', `${status} → idle`)
})

test('口型（真实音频）：RMS/峰值映射到 0..1，起振有平滑，静音被噪声门限归零', async () => {
  const { probe, window } = await mountClientInternals()
  const raf = fakeRaf()
  window.requestAnimationFrame = raf.request; window.cancelAnimationFrame = raf.cancel
  const audio = fakeWebAudio()
  window.AudioContext = audio.Context
  const ref = { current: 0 }
  const driver = probe.createLipDriver(ref)
  const element = {}
  assert.equal(driver.startAudio(element), true)
  assert.equal(audio.record.sources.length, 1, '必须为 audio element 建 MediaElementSource')
  assert.equal(audio.record.sources[0].element, element)
  assert.equal(audio.record.analysers.length, 1, '必须建 AnalyserNode')
  const analyser = audio.record.analysers[0]
  assert.ok(audio.record.sources[0].connectedTo.includes(analyser), 'source 必须接到 analyser')
  assert.ok(analyser.connectedTo.includes(audio.record.contexts[0].destination), 'analyser 必须接 destination：音频照常出声')
  assert.equal(analyser.fftSize, probe.LIP_LIMITS.fftSize)
  // 0.12 振幅正弦：RMS≈0.085、峰值 0.12 → 乘 gain/peakGain 后落在 0.2..0.4
  analyser.wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.12)
  const target = probe.lipLevelFromFloat(Float32Array.from(analyser.wave))
  assert.ok(target > 0.2 && target < 1, `真实振幅应映射成 0..1 的 level，实际 ${target}`)
  raf.tick(1)
  const first = ref.current
  assert.ok(first > 0.05 && first < target, `第一帧必须是平滑中间值（实际 ${first}，目标 ${target}）`)
  raf.tick(1)
  assert.ok(ref.current > first && ref.current < target, '第二帧继续收敛但不许一步跳满')
  raf.tick(60)
  assert.ok(Math.abs(ref.current - target) < 0.02, `多帧后应收敛到目标（实际 ${ref.current}，目标 ${target}）`)
  // 噪声门限：RMS 与峰值都低于 gate 一律判 0，已经张开的嘴要收回去
  analyser.wave = Array.from({ length: 64 }, () => 0.003)
  assert.equal(probe.lipLevelFromFloat(Float32Array.from(analyser.wave)), 0, '低于门限的底噪必须直接判 0')
  raf.tick(5)
  assert.ok(ref.current > 0 && ref.current < target * 0.5, `静音后必须明显收口（实际 ${ref.current}）`)
  raf.tick(80)
  assert.equal(ref.current, 0, '连续静音后必须精确归零')
  driver.stop()
  assert.equal(ref.current, 0)
  assert.equal(raf.pending(), 0, 'stop 之后不许留 RAF')
})

test('口型（真实音频）：suspended 先按策略 resume；resume 被拒就不接图、退回简化口型', async () => {
  const ok = await mountClientInternals()
  const okRaf = fakeRaf()
  ok.window.requestAnimationFrame = okRaf.request; ok.window.cancelAnimationFrame = okRaf.cancel
  const okAudio = fakeWebAudio({ state: 'suspended', resume: 'resolve' })
  ok.window.AudioContext = okAudio.Context
  const okRef = { current: 0 }
  const okDriver = ok.probe.createLipDriver(okRef)
  okDriver.startAudio({})
  assert.equal(okAudio.record.resumes, 1, 'suspended 必须按浏览器策略尝试 resume')
  assert.equal(okAudio.record.analysers.length, 0, 'resume 落地前不接分析图')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(okAudio.record.analysers.length, 1, 'resume 成功后接上真实分析链')
  okAudio.record.analysers[0].wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.2)
  okRaf.tick(2)
  assert.ok(okRef.current > 0, 'resume 之后口型要跟着真实振幅动')
  okDriver.stop()
  assert.equal(okRef.current, 0)

  const bad = await mountClientInternals()
  const badRaf = fakeRaf()
  bad.window.requestAnimationFrame = badRaf.request; bad.window.cancelAnimationFrame = badRaf.cancel
  const badAudio = fakeWebAudio({ state: 'suspended', resume: 'reject' })
  bad.window.AudioContext = badAudio.Context
  const badRef = { current: 0 }
  const badDriver = bad.probe.createLipDriver(badRef)
  badDriver.startAudio({})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(badAudio.record.analysers.length, 0, 'resume 被拒就不接图（免得声音被挂住的上下文吃掉）')
  assert.equal(badAudio.record.closes, 1, '放弃的 AudioContext 必须关掉')
  badRaf.tick(1)
  assert.ok(badRef.current > 0, 'resume 失败也要有简化口型：语音不被阻断')
  badRaf.tick(4)
  assert.ok(badRef.current <= 0.9, '简化口型要克制')
  badDriver.stop()
  badRaf.tick(2)
  assert.equal(badRef.current, 0, 'stop 之后残留帧不许再写 level')
  assert.equal(badRaf.pending(), 0)
})

test('口型（简化口型）：浏览器语音用确定性包络，stop/dispose 幂等且归零', async () => {
  const { probe, window } = await mountClientInternals()
  const raf = fakeRaf()
  window.requestAnimationFrame = raf.request; window.cancelAnimationFrame = raf.cancel
  const refA = { current: 0 }; const refB = { current: 0 }
  const driverA = probe.createLipDriver(refA); const driverB = probe.createLipDriver(refB)
  driverA.startSynthetic(); driverB.startSynthetic()
  assert.equal(window.AudioContext, undefined, '简化口型不该为了口型去建 AudioContext')
  const seriesA = []; const seriesB = []
  for (let index = 0; index < 8; index += 1) { raf.tick(1); seriesA.push(refA.current); seriesB.push(refB.current) }
  assert.deepEqual(seriesA, seriesB, '同一个节奏表必须是确定性输出')
  assert.ok(seriesA.every((value) => value >= 0 && value <= 0.9), `简化口型要克制在 0..0.9：${seriesA}`)
  assert.ok(seriesA.some((value) => value > 0.05), '口型要真的动起来')
  assert.equal(probe.LIP_SPEECH_ENVELOPE.filter((value) => value < 0 || value > 1).length, 0, '包络表自身必须落在 0..1')
  driverA.stop(); driverA.stop()
  assert.equal(refA.current, 0, 'stop 必须归零')
  assert.equal(raf.pending(), 1, 'B 还在播时只撤掉 A 的帧')
  driverA.dispose(); driverA.dispose()
  raf.tick(3)
  assert.equal(refA.current, 0, '重复 stop/dispose 之后仍不许写 level')
  driverB.stop()
  assert.equal(refB.current, 0)
  assert.equal(raf.pending(), 0)
})

test('口型（真实音频）：每个 element 只绑一次 MediaElementSource，过期帧不影响下一次播放', async () => {
  const { probe, window } = await mountClientInternals()
  const raf = fakeRaf()
  window.requestAnimationFrame = raf.request; window.cancelAnimationFrame = raf.cancel
  const audio = fakeWebAudio()
  window.AudioContext = audio.Context
  const ref = { current: 0 }
  const driver = probe.createLipDriver(ref)
  const first = {}
  driver.startAudio(first)
  assert.equal(audio.record.sources.length, 1)
  audio.record.analysers[0].wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.2)
  raf.tick(2)
  assert.ok(ref.current > 0, '第一段播放必须真的动口型')
  const staleCallbacks = raf.callbacks()
  assert.equal(staleCallbacks.length, 1, '应该正好有一帧在排队')
  // 换下一段播放：老上下文关掉、新图重建；老回调即便被调度器叫醒也不许再写 level
  const second = {}
  driver.startAudio(second)
  assert.equal(audio.record.sources.length, 2, '新播放必须为新的 element 建图')
  assert.equal(audio.record.sources[1].element, second)
  assert.equal(audio.record.contexts.length, 2, '新播放必须重建 AudioContext')
  assert.ok(audio.record.closes >= 1, '老的 AudioContext 必须关掉')
  ref.current = 0
  for (const callback of staleCallbacks) callback()
  assert.equal(ref.current, 0, '过期帧不许写 level')
  audio.record.analysers[1].wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.2)
  raf.tick(2)
  assert.ok(ref.current > 0, '新播放自己的帧照常写 level')
  // 同一个 element 再 start：第二次 createMediaElementSource 会抛 InvalidStateError，必须自己拦住
  driver.startAudio(second)
  assert.equal(audio.record.sources.length, 2, '同一个 element 只允许一次 MediaElementSource')
  raf.tick(1)
  assert.ok(ref.current >= 0 && ref.current <= 1, '绑不上的时候退回简化口型，不许抛错也不许阻断语音')
  driver.stop()
  assert.equal(ref.current, 0)
  assert.equal(raf.pending(), 0)
})

test('口型（组件）：左屏 HRMark 把 performanceState 与 lipLevelRef 真传给渲染端', async (t) => {
  const real = await loadRealReact()
  if (!real) { t.skip('未找到 react/react-dom'); return }
  const { React, renderToStaticMarkup } = real
  const cases = [['waiting_for_answer', 'listening'], ['generating_question', 'thinking'], ['processing_answer', 'thinking'], ['evaluating', 'thinking'], ['waiting_for_hr', 'idle'], ['completed', 'idle'], ['review_pending', 'idle']]
  for (const [status, expected] of cases) {
    const capabilities = stageCapabilities()
    const Panel = await mountMainPanel(React, {
      capabilities, seedCapabilities: capabilities, seedBundle: interviewBundle(status), seedAvatarEnabled: true,
      overrides: { 'src/live2d-avatar.js': AVATAR_PROBE },
    })
    const html = renderToStaticMarkup(React.createElement(Panel, {}))
    const calls = Panel.__sandbox.__hrAvatarCalls || []
    assert.ok(calls.length > 0, `${status}：左屏必须把表演状态交给渲染端`)
    const last = calls[calls.length - 1]
    assert.equal(last.performanceState, expected, `${status} 应映射成 ${expected}`)
    assert.ok(last.lipLevelRef && typeof last.lipLevelRef === 'object', `${status}：lipLevelRef 必须一起传下去`)
    assert.equal(typeof last.lipLevelRef.current, 'number')
    assert.match(html, new RegExp(`hri-probe-avatar">${expected}<`), `${status}：渲染出来的也是 ${expected}`)
  }
  // paused 沿用原卸载：舞台根本不挂载，只留 120px 静态圆
  const pausedCaps = stageCapabilities()
  const PausedPanel = await mountMainPanel(React, {
    capabilities: pausedCaps, seedCapabilities: pausedCaps, seedBundle: interviewBundle('paused'), seedAvatarEnabled: true,
    overrides: { 'src/live2d-avatar.js': AVATAR_PROBE },
  })
  const pausedHtml = renderToStaticMarkup(React.createElement(PausedPanel, {}))
  assert.doesNotMatch(pausedHtml, /hri-probe-avatar/, '暂停时 Live2D 舞台必须卸载')
  assert.match(pausedHtml, /已暂停/)
})

test('口型（DeepSeek TTS）：真实振幅驱动 lipLevelRef，停止朗读后归零并断开节点', async (t) => {
  const harness = await mountStageInterview({ status: 'waiting_for_answer', ttsProvider: 'deepseek', capabilities: { ttsConfigured: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.speakCalls.length, 1, '待回答场次仍应自动朗读（原自动朗读逻辑不许回退）')
    assert.equal(harness.audio.instances.length, 1, 'DeepSeek TTS 仍走 HTMLAudioElement')
    assert.equal(harness.audio.instances[0].playCalls, 1, '音频必须照常 play：不能只做口型不出声')
    assert.equal(harness.web.record.sources.length, 1, '必须为播放中的 element 建 MediaElementSource')
    assert.equal(harness.web.record.sources[0].element, harness.audio.instances[0])
    assert.ok(harness.web.record.analysers[0].connectedTo.includes(harness.web.record.contexts[0].destination), 'analyser 必须接 destination')
    assert.equal(harness.state(), 'speaking', '出声时表演状态优先是 speaking')
    assert.ok(harness.probe().lipLevelRef, 'lipLevelRef 必须真的递到渲染端')
    harness.web.record.analysers[0].wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.25)
    harness.raf.tick(3)
    const level = harness.lip()
    assert.ok(level > 0.05 && level <= 1, `口型 level 必须落在 0..1 且真的开了口（${level}）`)
    await harness.clickButton('停止朗读')
    assert.equal(harness.lip(), 0, '停止朗读后口型必须归零')
    assert.equal(harness.state(), 'listening', '停止后回到 listening')
    assert.ok(harness.web.record.analysers[0].disconnects >= 1, '停止后必须 disconnect AnalyserNode')
    assert.ok(harness.web.record.sources[0].disconnects >= 1, '停止后必须 disconnect MediaElementSource')
    assert.equal(harness.web.record.closes, 1, '停止后必须关闭 AudioContext')
    assert.equal(harness.raf.pending(), 0, '停止后不许留 RAF')
    // 手工再触发一次 onended：清理必须幂等（走 act，否则 setSpeaking 会在测试外更新）
    await harness.act(async () => { harness.audio.instances[0].onended?.() })
    assert.equal(harness.lip(), 0)
    assert.equal(harness.web.record.closes, 1, 'onended 的重复清理必须幂等')
  } finally { await harness.close() }
})

test('口型（浏览器语音）：简化口型跟着说话动，onend/卸载都归零且不建 AudioContext', async (t) => {
  const harness = await mountStageInterview({ status: 'waiting_for_answer', ttsProvider: 'browser' })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.deepEqual(harness.spoken, ['请做一个简短自我介绍。'], '浏览器朗读的原有自动行为不许回退')
    assert.equal(harness.web.record.contexts.length, 0, 'speechSynthesis 没有音频流：不该为口型建 AudioContext')
    assert.equal(harness.state(), 'speaking')
    harness.raf.tick(3)
    assert.ok(harness.lip() > 0, '简化口型必须真的动起来')
    await harness.finishSpeech()
    assert.equal(harness.lip(), 0, 'onend 后必须归零')
    assert.equal(harness.state(), 'listening', '说完话回到 listening')
    assert.equal(harness.raf.pending(), 0, 'onend 后不许留 RAF')
  } finally { await harness.close() }

  const second = await mountStageInterview({ status: 'waiting_for_answer', ttsProvider: 'browser' })
  if (!second) return skipNoReactDom(t)
  const ref = second.lipRef()
  assert.ok(ref && typeof ref.current === 'number', '卸载前必须能拿到 lipLevelRef')
  second.raf.tick(2)
  assert.ok(ref.current > 0, '卸载前口型是在动的')
  await second.close()
  assert.equal(ref.current, 0, '卸载后 lipLevelRef 必须归零')
  assert.equal(second.raf.pending(), 0, '卸载后不许留 RAF')
})

test('口型：自动播放被拒时不留 AudioContext/RAF；退回本机语音后仍有简化口型', async (t) => {
  // 本机语音也不可用：此时必须一点残留都不留
  const bare = await mountStageInterview({ status: 'waiting_for_answer', ttsProvider: 'deepseek', capabilities: { ttsConfigured: true }, audioOutcome: 'blocked', browserTts: false })
  if (!bare) return skipNoReactDom(t)
  try {
    assert.equal(bare.speakCalls.length, 1, '先尝试了云端语音')
    assert.match(bare.text(), /浏览器阻止自动播放，可点击「播放语音」重试/)
    assert.ok(bare.web.record.closes >= 1, '被拒时必须关掉已经建的 AudioContext')
    assert.equal(bare.web.record.sources.filter((source) => source.disconnects === 0).length, 0, '被拒时不许留还连着图的节点')
    assert.equal(bare.web.record.analysers.filter((analyser) => analyser.disconnects === 0).length, 0)
    assert.equal(bare.raf.pending(), 0, '被拒时不许留 RAF')
    assert.equal(bare.lip(), 0, '被拒后口型必须归零')
  } finally { await bare.close() }

  // 有本机语音兜底：口型要接着用简化包络，不能停在 0
  const fallback = await mountStageInterview({ status: 'waiting_for_answer', ttsProvider: 'deepseek', capabilities: { ttsConfigured: true }, audioOutcome: 'blocked' })
  if (!fallback) return skipNoReactDom(t)
  try {
    assert.deepEqual(fallback.spoken, ['请做一个简短自我介绍。'], '被拒后仍要退回本机语音')
    assert.equal(fallback.state(), 'speaking', '本机语音在说话 → speaking')
    assert.equal(fallback.raf.pending(), 1, '只剩简化口型那一条帧，Web Audio 的帧必须已经撤掉')
    fallback.raf.tick(2)
    assert.ok(fallback.lip() > 0, '退回本机语音后口型照旧跟着说')
  } finally { await fallback.close() }
})

test('语音（H2）：旧 utterance 的回调不许碰新播放，主动停止不许报错', async (t) => {
  const harness = await mountStageInterview({ status: 'waiting_for_answer', ttsProvider: 'browser' })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.utterances.length, 1, '自动朗读 A 必须已经开始')
    const first = harness.utterances[0]
    harness.raf.tick(2)
    assert.ok(harness.lip() > 0, 'A 说话时口型要在动')
    // 主动停止：token 前进，随后浏览器把这条 utterance 判成 canceled / interrupted
    await harness.clickButton('停止朗读')
    assert.equal(harness.state(), 'listening', '停止后回到 listening')
    await harness.act(async () => { first.onerror?.({ error: 'canceled' }); first.onerror?.({ error: 'interrupted' }) })
    assert.doesNotMatch(harness.text(), /播放失败/, '主动停止（canceled/interrupted）不许弹错误')
    assert.equal(harness.state(), 'listening', '旧回调不许把状态改回 speaking')
    // B 开始：A 的迟到回调不许停掉 B 的 driver、不许改 B 的 speaking
    await harness.clickButton('播放语音')
    assert.equal(harness.utterances.length, 2, 'B 必须真的开始朗读')
    harness.raf.tick(2)
    assert.equal(harness.state(), 'speaking', 'B 在读 → speaking')
    assert.ok(harness.lip() > 0, 'B 的口型必须真的动')
    await harness.act(async () => { first.onend?.(); first.onerror?.({ error: 'network' }) })
    assert.equal(harness.state(), 'speaking', 'A 的旧 onend/onerror 不许打掉 B 的 speaking')
    assert.doesNotMatch(harness.text(), /播放失败/, 'A 的旧 onerror 不许给 B 弹错误')
    harness.raf.tick(1)
    assert.equal(harness.raf.pending(), 1, 'A 的旧回调不许撤掉 B 的口型帧')
    assert.ok(harness.lip() > 0, 'B 的口型必须继续动')
    // 当前请求自己被 interrupted：属于主动停止，同样不报错
    await harness.act(async () => { harness.utterances[1].onerror?.({ error: 'interrupted' }) })
    assert.doesNotMatch(harness.text(), /播放失败/, '当前请求 interrupted 也不该报错')
    assert.equal(harness.state(), 'listening', '说完/停完回到 listening')
    assert.equal(harness.lip(), 0, '当前请求收尾后口型归零')
  } finally { await harness.close() }
})

test('语音（M1）：旧 audio element 的 ended/error 不许停掉新播放，但自己的 blob 照样释放', async (t) => {
  const harness = await mountStageInterview({ status: 'waiting_for_answer', ttsProvider: 'deepseek', capabilities: { ttsConfigured: true } })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.audio.instances.length, 1, 'A 已经自动播放')
    const first = harness.audio.instances[0]
    harness.web.record.analysers[0].wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.25)
    harness.raf.tick(3)
    assert.ok(harness.lip() > 0, 'A 的口型在动')
    await harness.clickButton('停止朗读')
    assert.equal(first.pauseCalls, 1, '停止朗读必须 pause 音频')
    await harness.clickButton('播放语音')
    assert.equal(harness.speakCalls.length, 2, '第二次播放要重新请求云端语音')
    assert.equal(harness.audio.instances.length, 2, 'B 是新的 audio element')
    const second = harness.audio.instances[1]
    assert.notEqual(second, first)
    harness.web.record.analysers[1].wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.25)
    harness.raf.tick(3)
    assert.equal(harness.state(), 'speaking', 'B 在出声 → speaking')
    const closesBefore = harness.web.record.closes
    const revokedBefore = harness.revoked.length
    // A 的迟到 onended：不许关 B 的 AudioContext、不许停 B 的口型、不许改 speaking
    await harness.act(async () => { first.onended?.() })
    assert.equal(harness.state(), 'speaking', 'A 的旧 onended 不许打掉 B 的 speaking')
    assert.equal(harness.web.record.closes, closesBefore, 'A 的旧 onended 不许关掉 B 的 AudioContext')
    assert.equal(harness.raf.pending(), 1, 'A 的旧 onended 不许撤掉 B 的口型帧')
    harness.raf.tick(1)
    assert.ok(harness.lip() > 0, 'A 的旧 onended 不许停掉 B 的口型')
    assert.ok(harness.revoked.length > revokedBefore, '过期 element 自己的 blob URL 仍必须释放')
    await harness.act(async () => { first.onerror?.() })
    assert.doesNotMatch(harness.text(), /播放失败/, 'A 的旧 onerror 不许给 B 报错')
    assert.equal(harness.state(), 'speaking', 'A 的旧 onerror 不许改 B 的 speaking')
  } finally { await harness.close() }
})

test('口型（M2）：resume 一直不落地时看门狗退回简化口型并关掉上下文，迟到的 resume 不许重建图', async () => {
  const slow = await mountClientInternals()
  const raf = fakeRaf()
  slow.window.requestAnimationFrame = raf.request; slow.window.cancelAnimationFrame = raf.cancel
  const audio = fakeWebAudio({ state: 'suspended', resume: 'manual' })
  slow.window.AudioContext = audio.Context
  const ref = { current: 0 }
  const driver = slow.probe.createLipDriver(ref, { resumeTimeout: 20 })
  assert.equal(driver.startAudio({}), true)
  assert.equal(audio.record.resumes, 1, 'suspended 必须先试 resume')
  assert.equal(audio.record.analysers.length, 0, 'resume 落地前不许建图 / createMediaElementSource')
  assert.equal(audio.record.sources.length, 0, 'resume 落地前绝不改 element 的输出路由')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(audio.record.analysers.length, 0, 'resume 仍 pending：不许接图')
  assert.equal(audio.record.closes, 1, '看门狗必须把挂住的 AudioContext 关掉')
  raf.tick(2)
  assert.ok(ref.current > 0, '看门狗之后必须有简化口型：不许停在没声音也没口型')
  assert.ok(ref.current <= 0.9, '简化口型仍要克制')
  // 迟到的 resume 落地：context 已经作废，绝不许偷偷补建图
  audio.record.resolvers.forEach((resolve) => resolve())
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(audio.record.analysers.length, 0, 'resume 晚到也不许重新建图')
  assert.equal(audio.record.sources.length, 0, 'resume 晚到也不许改输出路由')
  raf.tick(1)
  assert.ok(ref.current > 0, '迟到的 resume 不许把简化口型打断')
  // stop 会把看门狗一起撤掉：之后不许再有 close
  driver.stop()
  const closesAfterStop = audio.record.closes
  assert.equal(ref.current, 0)
  assert.equal(raf.pending(), 0)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(audio.record.closes, closesAfterStop, 'stop 之后看门狗不许再触发')

  // 对照：resume 正常落地时，看门狗不许误伤已经接好的图
  const quick = await mountClientInternals()
  const quickRaf = fakeRaf()
  quick.window.requestAnimationFrame = quickRaf.request; quick.window.cancelAnimationFrame = quickRaf.cancel
  const okAudio = fakeWebAudio({ state: 'suspended', resume: 'resolve' })
  quick.window.AudioContext = okAudio.Context
  const okRef = { current: 0 }
  const okDriver = quick.probe.createLipDriver(okRef, { resumeTimeout: 20 })
  okDriver.startAudio({})
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(okAudio.record.analysers.length, 1, 'resume 成功后看门狗不许再关这张图')
  assert.equal(okAudio.record.closes, 0, 'resume 成功后不该出现 close')
  okAudio.record.analysers[0].wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.25)
  quickRaf.tick(3)
  assert.ok(okRef.current > 0, 'resume 成功路径照旧走真实振幅')
  okDriver.stop()
  assert.equal(okRef.current, 0)
})

test('口型（M3）：平滑与合成包络按时间走，60Hz 与 120Hz 得到同一条曲线', async () => {
  const wave = Array.from({ length: 64 }, (_, index) => Math.sin(index) * 0.25)
  const run = async (step, mode) => {
    const { probe, window } = await mountClientInternals()
    const raf = fakeRaf({ step })
    window.requestAnimationFrame = raf.request; window.cancelAnimationFrame = raf.cancel
    const audio = fakeWebAudio(); window.AudioContext = audio.Context
    const ref = { current: 0 }
    const driver = probe.createLipDriver(ref)
    if (mode === 'audio') { driver.startAudio({}); audio.record.analysers[0].wave = wave } else driver.startSynthetic()
    raf.tick(Math.round(200 / step))
    const level = ref.current
    driver.stop()
    assert.equal(ref.current, 0, 'stop 必须归零')
    assert.equal(raf.pending(), 0, 'stop 之后不许留帧')
    return level
  }
  const slowAudio = await run(16, 'audio')
  const fastAudio = await run(8, 'audio')
  assert.ok(slowAudio > 0.2 && fastAudio > 0.2, `两档都必须真的开口（16ms ${slowAudio} / 8ms ${fastAudio}）`)
  const spreadAudio = Math.abs(slowAudio - fastAudio) / Math.max(slowAudio, fastAudio)
  assert.ok(spreadAudio < 0.1, `真实音频的平滑必须与帧率无关：16ms ${slowAudio.toFixed(3)} vs 8ms ${fastAudio.toFixed(3)}（偏差 ${(spreadAudio * 100).toFixed(1)}%）`)
  const slowSynth = await run(16, 'synthetic')
  const fastSynth = await run(8, 'synthetic')
  assert.ok(slowSynth > 0.02 && fastSynth > 0.02, `简化口型两档都要动（16ms ${slowSynth} / 8ms ${fastSynth}）`)
  const spreadSynth = Math.abs(slowSynth - fastSynth) / Math.max(slowSynth, fastSynth)
  assert.ok(spreadSynth < 0.1, `合成包络必须与帧率无关：16ms ${slowSynth.toFixed(3)} vs 8ms ${fastSynth.toFixed(3)}（偏差 ${(spreadSynth * 100).toFixed(1)}%）`)
})

// —— 面试提纲（本地准备）：真实 React + jsdom ——
// 和 mountClientInternals 同一手法：把探针追加到 client 源码末尾再构建（write:false，不碰生成物）。
// 直挂 SetupView 才能把 onStarted 换成 spy ——「双击只开一场」「卸载后旧结果不 onStarted」只靠面板
// 的副作用很难断言，直挂才测得准。
const SETUP_PROBE_EPILOGUE = '\nmodule.exports.__setupProbe = { SetupView, preparationShape, wrapRemoteApi }\n'

const HR_PLAN_KINDS = ['project', 'incident', 'principle', 'evaluation', 'behavioral', 'project', 'principle', 'incident']
// 题库条目的真实形状：questionBudget 是 {main,alternates,total}（不是数字），items 前 main 条是主问题、
// 其余带 alternate:true 当备选；来源标题与 URL 在 sourceRefs 里。
const hrPreparation = ({ duration = 30, ...overrides } = {}) => {
  const total = duration === 15 ? 6 : 8
  const items = Array.from({ length: total }, (_, index) => ({
    planItemId: `plan-${index + 1}`,
    bankItemId: `bank-agent-${String(index + 1).padStart(3, '0')}`,
    topic: index === 0 ? 'RAG 检索链路' : index === 1 ? '工具调用失败' : `主题 ${index + 1}`,
    kind: HR_PLAN_KINDS[index],
    question: index === 0 ? `请讲一次你在 ${duration} 分钟场里把检索增强生成跑到线上的经历。` : `第 ${index + 1} 个问题：说说你的判断依据。`,
    followups: [],
    expectedPoints: index === 0 ? ['召回率从 62% 提到 81%', 'P95 延迟压在 1.8s', '第三条不该显示'] : ['关键点'],
    alternate: index >= (duration === 15 ? 4 : 6),
    sourceRefs: [{
      bankItemId: `bank-agent-${String(index + 1).padStart(3, '0')}`,
      revision: index + 1,
      sourceTitle: index === 0 ? '牛客 · Agent 面经合集' : index === 1 ? '内部通用训练题' : `来源 ${index + 1}`,
      // 第 2 条故意给 http：只有 https 才允许变成可点链接。
      sourceUrl: index === 0 ? 'https://example.com/interview/agent' : index === 1 ? 'http://example.com/plain/title-only' : '',
      evidenceLevel: 'first_hand',
    }],
  }))
  return {
    preparationId: `prep-${duration === 15 ? '15151515aaaa' : '30303030bbbb'}`,
    profileKey: 'fp-0123456789abcdef-not-for-ui',
    planKey: 'plankey-must-never-render',
    packId: 'pack-agent-01',
    taxonomyVersion: 'bank-2026-11',
    durationMinutes: duration,
    questionBudget: { main: duration === 15 ? 4 : 6, alternates: 2, total },
    items,
    createdAt: '2026-11-17T10:00:00.000Z',
    materialsUpdatedAt: '2026-11-17T09:30:00.000Z',
    profileMatches: true,
    ...overrides,
  }
}
const hrDeferred = () => { let release; const promise = new Promise((resolve) => { release = resolve }); return { promise, release: () => release() } }

async function mountSetupView(options = {}) {
  const real = await loadRealReact()
  const tools = real && await loadReactDomTools()
  if (!tools) return null
  const { React } = real
  const { JSDOM, createRoot, act } = tools
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const win = dom.window
  const state = {
    caps: { configured: true, asrConfigured: false, asrPreparation: null, ttsConfigured: false, ...(options.capabilities || {}) },
    latest: options.latest === undefined ? null : options.latest,
    latestGates: options.latestGates || {},
    prepareResult: options.prepareResult === undefined ? null : options.prepareResult,
    prepareGate: options.prepareGate || null,
    startResult: options.startResult === undefined ? interviewBundle('paused') : options.startResult,
    startGate: options.startGate || null,
    latestCalls: [], prepareCalls: [], startCalls: [],
    // 本地 msy 题库设置：sourceSettings() 的返回值就是这里；保存后按真实 Host 的语义改写。
    source: options.source === undefined
      ? { msyDir: '', updatedAt: null, configured: false, displayName: 'msy 本地题库', sourceSummary: { agentQuestions: 0, resumeQuestions: 0 } }
      : { ...options.source },
    sourceReadError: options.sourceReadError || null,
    sourceGate: options.sourceGate || null,
    sourceSaveGate: options.sourceSaveGate || null,
    sourceSaveError: options.sourceSaveError || null,
    sourceCalls: 0, saveSourceCalls: [],
    // detectMsySource()：Host 扫完会自己保存，这里同样改写 state.source 并把统计一起换掉。
    detectResult: options.detectResult === undefined ? null : options.detectResult,
    detectGate: options.detectGate || null,
    detectError: options.detectError || null,
    detectCalls: 0,
  }
  const envelope = (thunk) => async (...args) => {
    try { return { ok: true, value: await thunk(...args) } } catch (error) { return { ok: false, error: { message: String(error?.message || error) } } }
  }
  const api = {
    capabilities: envelope(async () => ({ ...state.caps })),
    list: envelope(async () => ({ sessions: [], knowledge: [] })),
    materials: envelope(async () => ({ role: '', resume: '', jd: '', projectNotes: '' })),
    saveMaterials: envelope(async (value) => value),
    start: envelope(async (value) => { state.startCalls.push(value); if (state.startGate) await state.startGate; return state.startResult }),
  }
  // preparationRpc:false 复现旧 Host：包装后这两个成员是 undefined（不是会抛错的方法）。
  if (options.preparationRpc !== false) {
    api.latestPreparation = envelope(async (value) => {
      state.latestCalls.push(value)
      const gate = state.latestGates[value.durationMinutes]
      if (gate) await gate
      return typeof state.latest === 'function' ? state.latest(value) : state.latest
    })
    api.prepareInterview = envelope(async (value) => {
      state.prepareCalls.push(value)
      if (state.prepareGate) await state.prepareGate
      return state.prepareResult
    })
  }
  // sourceRpc:false / 不传 source 时复现旧 Host（rc.23）：这两个方法在包装后是 undefined。
  if (options.sourceRpc === true || options.source !== undefined || options.sourceReadError) {
    api.sourceSettings = envelope(async () => {
      state.sourceCalls += 1
      if (state.sourceGate) await state.sourceGate
      if (state.sourceReadError) throw new Error(state.sourceReadError)
      return { ...state.source }
    })
    api.saveSourceSettings = envelope(async (value) => {
      state.saveSourceCalls.push(value)
      if (state.sourceSaveGate) await state.sourceSaveGate
      if (state.sourceSaveError) throw new Error(state.sourceSaveError)
      const msyDir = String(value?.msyDir || '').trim()
      const saved = {
        msyDir,
        updatedAt: '2026-11-18T12:00:00.000Z',
        configured: Boolean(msyDir),
        displayName: 'msy 本地题库',
        sourceSummary: msyDir ? { agentQuestions: 46, resumeQuestions: 12 } : { agentQuestions: 0, resumeQuestions: 0 },
      }
      state.source = saved
      return saved
    })
    // sourceDetect:false 复现「有设置 RPC 但还没有自动识别」的中间版本 Host。
    if (options.sourceDetect !== false) {
      api.detectMsySource = envelope(async () => {
        state.detectCalls += 1
        if (state.detectGate) await state.detectGate
        if (state.detectError) throw new Error(state.detectError)
        if (state.detectResult !== null) { state.source = { ...state.detectResult }; return { ...state.source } }
        const found = {
          msyDir: 'D:/work/msy-detected',
          updatedAt: '2026-11-18T12:30:00.000Z',
          configured: true,
          displayName: 'msy 本地题库',
          sourceSummary: { agentQuestions: 61, resumeQuestions: 12 },
        }
        state.source = found
        return found
      })
    }
  }
  const source = await readFile(path.join(root, 'src/client.js'), 'utf8')
  const { output } = await buildClient({ root, write: false, overrides: { 'src/client.js': `${source}${SETUP_PROBE_EPILOGUE}` } })
  let factory
  win.__ModuleLoader__ = { load(definition) { factory = definition.factory } }
  const sandbox = {
    window: win, document: win.document, navigator: win.navigator,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  // 目录选择的两条来路：宿主注入的桥（globalThis.__DSH_DIRECTORY_PICKER__），或 ctx 上的 uiWorkspace。
  // 传函数就每次点击现算一次（测「取消一次、再选一次」）；传值就是固定返回。
  if (options.directoryPicker !== undefined) {
    const pick = options.directoryPicker
    sandbox.__DSH_DIRECTORY_PICKER__ = { pick: async () => (typeof pick === 'function' ? pick() : pick) }
  }
  vm.createContext(sandbox)
  vm.runInContext(output, sandbox)
  const client = factory((id) => { assert.equal(id, 'react'); return React })
  const probe = client.__setupProbe
  assert.ok(probe && probe.SetupView, '必须能从探针取到 SetupView')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = win
  globalThis.document = win.document
  const container = win.document.getElementById('root')
  const started = []
  let mounted
  await act(async () => {
    mounted = createRoot(container)
    mounted.render(React.createElement(probe.SetupView, {
      api: probe.wrapRemoteApi(api),
      capabilities: state.caps,
      onStarted: (bundle) => { started.push(bundle) },
      onMaterials() {}, onRefresh: async () => {}, avatarEnabled: false, onAvatarEnabledChange() {},
      background: 'office', onBackgroundChange() {},
      // ctx 只是可选入参：Panel 原样往下传，界面自己不去 inject 任何东西。
      ctx: options.ctx === undefined ? null : options.ctx,
    }))
  })
  const flush = async () => { for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  await flush()
  const buttonByText = (label) => [...container.querySelectorAll('button')].find((node) => node.textContent === label)
  const clickNode = async (node) => {
    assert.ok(node, '找不到要点的按钮')
    await act(async () => { node.dispatchEvent(new win.MouseEvent('click', { bubbles: true })) })
  }
  // 快速双击：两次 click 落在同一个 act 里、中间不重渲染 —— 只有同步锁能挡住第二次。
  const doubleClick = async (node) => {
    assert.ok(node, '找不到要点的按钮')
    await act(async () => {
      node.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
      node.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    })
  }
  const clickButton = async (label) => { await clickNode(buttonByText(label)); await flush() }
  const durationSelect = () => {
    const field = [...container.querySelectorAll('label.hri-field')].find((node) => node.querySelector('span')?.textContent === '时长')
    assert.ok(field, '设置页必须有「时长」一项')
    return field.querySelector('select')
  }
  const chooseDuration = async (value) => {
    const select = durationSelect()
    const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set
    await act(async () => { setter.call(select, String(value)); select.dispatchEvent(new win.Event('change', { bubbles: true })) })
    await flush()
  }
  const sourceCard = () => container.querySelector('[data-hri-source-settings="true"]')
  const sourceInput = () => container.querySelector('[data-hri-source-dir]')
  // 路径输入与「保存目录/清除」默认收在「高级设置」里：先展开再操作。
  const openSourceAdvanced = async () => {
    if (sourceInput()) return
    await clickButton('高级设置')
  }
  const typeSourceDir = async (value) => {
    await openSourceAdvanced()
    const node = sourceInput()
    assert.ok(node, '缺少本地题库目录输入框')
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
    await act(async () => { setter.call(node, value); node.dispatchEvent(new win.Event('input', { bubbles: true })) })
    await flush()
  }
  return {
    container, window: win, state, started, probe, act, flush, buttonByText, clickButton, clickNode, doubleClick, durationSelect, chooseDuration,
    sourceCard, sourceInput, typeSourceDir, openSourceAdvanced,
    sourceStats: () => container.querySelector('[data-hri-source-stats]'),
    prepNotice: () => container.querySelector('[data-hri-prep-notice]'),
    text: () => container.textContent,
    outline: () => container.querySelector('[data-hri-preparation="true"]'),
    planItems: () => [...container.querySelectorAll('[data-hri-plan-item]')],
    unmount: async () => { await act(async () => mounted.unmount()) },
    close: async () => { await act(async () => mounted.unmount()); win.close(); delete globalThis.window; delete globalThis.document },
  }
}

test('面试提纲（面板）：挂载即按当前时长读 latestPreparation，匹配时给出主问题数，提纲里没有任何来源链接', async (t) => {
  const harness = await mountSetupPanel({ capabilities: stageCapabilities(), preparation: hrPreparation() })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.deepEqual(harness.state.latestCalls.map((call) => call.durationMinutes), [30], '初挂载必须按默认时长读一次现成提纲')
    const outline = harness.container.querySelector('[data-hri-preparation="true"]')
    assert.ok(outline, '有匹配提纲时必须显示提纲区')
    assert.match(harness.container.querySelector('.hri-setup-summary').textContent, /6 道主问 · 2 道备选/)
    const items = outline.querySelectorAll('[data-hri-plan-item]')
    assert.equal(items.length, 8, '30 分钟提纲 8 条都要列出来')
    assert.match(items[0].textContent, /RAG 检索链路/)
    assert.match(items[0].textContent, /项目/, 'kind 要显示成中文标签')
    assert.match(items[6].textContent, /备选/, '后 2 条要点出「备选」')
    assert.match(items[0].textContent, /召回率从 62% 提到 81%/)
    assert.doesNotMatch(items[0].textContent, /第三条不该显示/, 'expectedPoints 最多显示 2 条')
    // rc.26：题目来源一律不进界面 —— https 来源也不再生成 <a>，标题与 URL 都不出现。
    assert.equal(items[0].querySelector('a'), null, 'https 来源也不许变成链接')
    assert.equal(items[1].querySelector('a'), null, 'http 来源更不许变成链接')
    assert.equal(outline.querySelectorAll('a').length, 0, '提纲里一个 <a> 都不许有')
    assert.equal(outline.querySelectorAll('[href]').length, 0, '也不许留 href 属性')
    assert.doesNotMatch(outline.textContent, /example\.com|牛客|内部通用训练题/, '来源标题与 URL 都不许出现在提纲里')
    assert.equal(harness.container.querySelector('[data-hri-sources]'), null, '来源统计整行不显示')
    assert.doesNotMatch(harness.container.textContent, /fp-0123456789abcdef/, '不许泄露 profileKey')
    assert.doesNotMatch(harness.container.textContent, /plankey-must-never-render/, '不许泄露 planKey')
    assert.equal([...harness.container.querySelectorAll('button')].some((node) => node.textContent === '使用提纲进入面试'), true, '有匹配提纲时开始按钮要说明会用提纲')
  } finally { await harness.close() }
})

test('面试准备页：就绪后在首屏入场，备选折叠，方向键切换，设置按需展开', async (t) => {
  const latest = hrPreparation()
  latest.items[0] = { ...latest.items[0], topic: 'rag' }
  latest.items[1] = { ...latest.items[1], topic: 'mcp-tools' }
  const harness = await mountSetupView({ latest })
  if (!harness) return skipNoReactDom(t)
  try {
    const { container, window, act } = harness
    const buttons = () => [...container.querySelectorAll('.hri-plan-toggle')]
    assert.equal(container.querySelector('.hri-setup-status').dataset.state, 'ready')
    assert.equal(container.querySelectorAll('[data-hri-start="prepared"]').length, 1)
    assert.equal(harness.planItems().filter((item) => !item.hidden).length, 6)
    assert.equal(buttons()[0].querySelector('strong').textContent, 'RAG 检索')
    assert.equal(buttons()[1].querySelector('strong').textContent, 'MCP 与工具调用')
    assert.equal(buttons().filter((button) => button.getAttribute('aria-expanded') === 'true').length, 1)
    const first = buttons()[0]
    first.focus()
    await act(async () => {
      first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.equal(window.document.activeElement, buttons()[1])
    assert.equal(buttons()[1].getAttribute('aria-expanded'), 'true')
    assert.equal(first.getAttribute('aria-expanded'), 'false')
    await harness.clickButton('查看 2 道备选')
    assert.equal(harness.planItems().filter((item) => !item.hidden).length, 8)
    await harness.clickNode(buttons()[7])
    assert.equal(buttons()[7].getAttribute('aria-expanded'), 'true')
    await harness.clickButton('收起备选题')
    assert.equal(harness.planItems()[7].hidden, true)
    assert.equal(buttons()[7].getAttribute('aria-expanded'), 'false')
    const settings = container.querySelector('[data-hri-setup-settings]')
    assert.equal(settings.open, false)
    await harness.clickButton('本场设置')
    assert.equal(settings.open, true)
    assert.equal(window.document.activeElement, settings.querySelector('summary'))
    assert.match(settings.textContent, /识别后自动提交/)
  } finally { await harness.close() }
})

test('面试提纲（直挂）：点「准备面试」走本地选题并展示条目，且完全不依赖模型配置', async (t) => {
  const harness = await mountSetupView({ capabilities: { configured: false }, prepareResult: hrPreparation() })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.deepEqual(harness.state.latestCalls.map((call) => call.durationMinutes), [30], '挂载时按当前时长读一次现成提纲')
    // 模型未配置：开始按钮保持原来的闸门，但「准备面试」不调模型，必须能点。
    assert.equal(harness.buttonByText('进入面试').disabled, true, '模型未配置时开始按钮仍应禁用')
    const prepare = harness.buttonByText('准备面试')
    assert.ok(prepare, '缺模型配置不许把准备按钮藏起来')
    assert.equal(prepare.disabled, false, '准备是本地选题，不受模型配置影响')
    await harness.clickButton('准备面试')
    assert.deepEqual(harness.state.prepareCalls.map((call) => `${call.durationMinutes}:${call.refresh}`), ['30:false'], '准备只带时长，不碰模型/凭据')
    const outline = harness.outline()
    assert.ok(outline, '准备成功后必须显示提纲')
    assert.match(harness.container.querySelector('.hri-setup-summary').textContent, /6 道主问 · 2 道备选/, '准备完成后要报出主问题与备选数')
    assert.equal(harness.planItems().length, 8)
    assert.match(outline.textContent, /请讲一次你在 30 分钟场里/, '题干要真的显示出来')
    assert.doesNotMatch(outline.textContent, /牛客 · Agent 面经合集|example\.com/, 'rc.26 起提纲不显示题目来源')
    assert.equal(outline.querySelectorAll('a').length, 0, '提纲里不许冒出任何来源链接')
    assert.ok(harness.buttonByText('换一批题'), '已经用上这份提纲后，按钮变成「换一批题」')
    assert.doesNotMatch(harness.text(), /准备中…/)
    assert.doesNotMatch(harness.text(), /fp-0123456789abcdef|plankey-must-never-render/, '提纲区不许泄露 profileKey / planKey')
  } finally { await harness.close() }
})

test('面试提纲：双击「准备面试」只发一次 RPC，完成后按钮回到「换一批题」', async (t) => {
  const gate = hrDeferred()
  const harness = await mountSetupView({ prepareGate: gate.promise, prepareResult: hrPreparation() })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.doubleClick(harness.buttonByText('准备面试'))
    assert.equal(harness.state.prepareCalls.length, 1, '同步 guard 必须挡住第二次点击')
    assert.ok(harness.buttonByText('准备中…'), '准备中要有独立文案')
    gate.release(); await harness.flush()
    assert.equal(harness.state.prepareCalls.length, 1, '放行之后也不许多发一次')
    const again = harness.buttonByText('换一批题')
    assert.ok(again)
    assert.equal(again.disabled, false, '完成后按钮要恢复可点')
  } finally { await harness.close() }
})

test('面试提纲：切换时长后，旧时长的迟到提纲不许覆盖新时长', async (t) => {
  const gate30 = hrDeferred(); const gate15 = hrDeferred()
  const harness = await mountSetupView({ latestGates: { 30: gate30.promise, 15: gate15.promise }, latest: (value) => hrPreparation({ duration: value.durationMinutes }) })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.deepEqual(harness.state.latestCalls.map((call) => call.durationMinutes), [30])
    await harness.chooseDuration(15)
    assert.deepEqual(harness.state.latestCalls.map((call) => call.durationMinutes), [30, 15], '改时长必须按新时长重新读')
    gate15.release(); await harness.flush()
    assert.match(harness.text(), /4 道主问 · 2 道备选/, '15 分钟版先到就先显示它')
    assert.equal(harness.planItems().length, 6)
    // A（30 分钟）迟到：prepSeq 判它过期，绝不能盖掉用户正在看的 B（15 分钟）
    gate30.release(); await harness.flush()
    assert.match(harness.text(), /4 道主问 · 2 道备选/, '30 分钟的迟到结果不许覆盖 15 分钟')
    assert.doesNotMatch(harness.text(), /旧提纲不会用于本场/, '迟到的 30 分钟提纲根本不该落到界面')
    assert.equal(harness.planItems().length, 6, '列表必须还是 15 分钟那 6 条')
  } finally { await harness.close() }
})

test('面试提纲：资料或时长不匹配时提示重新准备，start 明确不携带 preparationId', async (t) => {
  const stale = await mountSetupView({ latest: hrPreparation({ duration: 30, profileMatches: false }) })
  if (!stale) return skipNoReactDom(t)
  try {
    assert.match(stale.text(), /旧提纲不会用于本场，请重新准备/, '不匹配要明确提示')
    assert.ok(stale.buttonByText('进入面试'), '不匹配时按钮保持「进入面试」')
    assert.equal(stale.buttonByText('使用提纲进入面试'), undefined)
    await stale.clickButton('进入面试')
    assert.equal(Object.prototype.hasOwnProperty.call(stale.state.startCalls[0], 'preparationId'), false, '不匹配就明确不携带 preparationId')
    assert.equal(stale.state.startCalls[0].durationMinutes, 30)
    assert.equal(stale.started.length, 1, '不匹配也要能正常开始（Host 走旧动态模式）')
  } finally { await stale.close() }

  // 时长换过之后，同一份提纲也不再算匹配（本地按当前时长再判一次）
  const mismatch = await mountSetupView({ latest: hrPreparation({ duration: 30, profileMatches: true }) })
  try {
    assert.ok(mismatch.buttonByText('使用提纲进入面试'), '30 分钟场里这份提纲是匹配的')
    await mismatch.chooseDuration(15)
    assert.match(mismatch.text(), /旧提纲不会用于本场，请重新准备/, '时长一换就必须提示重新准备')
    assert.ok(mismatch.buttonByText('进入面试'))
    await mismatch.clickButton('进入面试')
    assert.equal(Object.prototype.hasOwnProperty.call(mismatch.state.startCalls[0], 'preparationId'), false, '时长不符不许携带 preparationId')
  } finally { await mismatch.close() }
})

test('面试提纲：匹配时按钮变成「使用提纲进入面试」，start 带上 preparationId', async (t) => {
  const harness = await mountSetupView({ latest: hrPreparation({ duration: 30 }) })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.ok(harness.buttonByText('使用提纲进入面试'), '有匹配提纲时按钮文案要说明')
    assert.equal(harness.buttonByText('进入面试'), undefined, '匹配时不该同时出现「进入面试」')
    await harness.clickButton('使用提纲进入面试')
    const payload = harness.state.startCalls[0]
    assert.equal(payload.preparationId, 'prep-30303030bbbb', 'start 必须带上 preparationId')
    assert.equal(payload.durationMinutes, 30)
    assert.equal(payload.mode, 'standard')
    assert.equal(payload.inputMode, 'voice')
    assert.equal(harness.started.length, 1, '只开一场')
  } finally { await harness.close() }
})

test('面试提纲：旧 Host 缺 RPC 时安静回退，开始照旧不带 preparationId', async (t) => {
  const harness = await mountSetupView({ preparationRpc: false })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.container.querySelector('[data-hri-prepare]'), null, '缺 RPC 不许露出准备按钮')
    assert.equal(harness.buttonByText('准备面试'), undefined)
    assert.equal(harness.buttonByText('重新准备'), undefined)
    assert.equal(harness.container.querySelector('[data-hri-preparation]'), null)
    assert.doesNotMatch(harness.text(), /旧提纲不会用于本场/, '没有提纲就谈不上「旧提纲」')
    assert.equal(harness.container.querySelector('[role="alert"]'), null, '缺 RPC 不许弹错')
    assert.ok(harness.buttonByText('进入面试'))
    await harness.clickButton('进入面试')
    assert.equal(Object.prototype.hasOwnProperty.call(harness.state.startCalls[0], 'preparationId'), false)
    assert.equal(harness.started.length, 1, '旧 Host 也要能照常开面试')
  } finally { await harness.close() }
})

test('面试提纲：卸载后迟到的结果不回写、不 onStarted', async (t) => {
  const startGate = hrDeferred()
  const late = await mountSetupView({ latest: hrPreparation({ duration: 30 }), startGate: startGate.promise })
  if (!late) return skipNoReactDom(t)
  await late.clickNode(late.buttonByText('使用提纲进入面试'))
  assert.equal(late.state.startCalls.length, 1)
  await late.unmount()
  startGate.release(); await late.flush()
  assert.equal(late.started.length, 0, '卸载后旧结果不许 onStarted')
  await late.close()

  // 提纲同理：卸载后迟到的 latestPreparation 结果不许回写（不抛错、不留内容）
  const gate = hrDeferred()
  const latePrep = await mountSetupView({ latestGates: { 30: gate.promise }, latest: hrPreparation({ duration: 30 }) })
  await latePrep.unmount()
  gate.release(); await latePrep.flush()
  assert.equal(latePrep.container.textContent, '', '卸载后迟到的提纲不许回写')
  assert.equal(latePrep.planItems().length, 0)
  await latePrep.close()
})

// —— 本地 msy 题库设置（jsdom + 真实 React，真正跑挂载、点击与 onChange） ——
// 覆盖：挂载读取与回填 / 保存与清除 / 双击只发一次 / 卸载后迟到结果不回写 / 旧 Host 缺 RPC 安静回退 /
// 题库设置版本不一致时不携带 preparationId / 重新准备后恢复匹配 / 来源统计与降级提示 / 旧 preparation 无字段不显示。
const HR_SOURCE_STAMP = '2026-11-18T09:00:00.000Z'
// rc.25 的 sourceSettings / saveSourceSettings / detectMsySource 形状：多了显示名与题量统计。
const hrSourceSettings = (msyDir, updatedAt = HR_SOURCE_STAMP) => ({
  msyDir,
  updatedAt,
  configured: Boolean(msyDir),
  displayName: 'msy 本地题库',
  sourceSummary: msyDir ? { agentQuestions: 46, resumeQuestions: 12 } : { agentQuestions: 0, resumeQuestions: 0 },
})
const hrSources = (overrides = {}) => ({
  msyQuestions: { status: 'ok', imported: 372, scanned: 11184, invalid: 3, skippedOffTopic: 10809, withAnswer: 300, ...(overrides.msyQuestions || {}) },
  msyResume: { status: 'ok', imported: 39, ...(overrides.msyResume || {}) },
})

test('本地题库设置：挂载即读取设置并回填已保存目录，路径不落 localStorage', async (t) => {
  const harness = await mountSetupView({ source: hrSourceSettings('D:/work/msy-fixture') })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.state.sourceCalls, 1, '挂载必须读一次题库设置')
    const card = harness.sourceCard()
    assert.ok(card, 'Host 有 RPC 时必须显示本地题库设置')
    assert.match(card.textContent, /msy 本地题库/, '默认显示 Host 给的名字')
    assert.match(card.textContent, /已启用/)
    // 默认只给名字 / 启停 / 题量统计：裸路径与保存按钮都收进「高级设置」。
    assert.equal(harness.sourceInput(), null, '默认不显示路径输入框')
    assert.equal(harness.buttonByText('保存目录'), undefined, '默认不显示保存按钮')
    assert.ok(harness.buttonByText('选择题库'), '选择题库是主路径')
    assert.ok(harness.buttonByText('重新扫描'), '已启用时给「重新扫描」')
    assert.ok(harness.buttonByText('停用'), '已启用时给「停用」')
    const stats = harness.sourceStats()
    assert.ok(stats, '启用后要显示题量统计')
    assert.match(stats.textContent, /岗位题 46/)
    assert.match(stats.textContent, /简历深挖 12/)
    await harness.openSourceAdvanced()
    assert.equal(harness.sourceInput().value, 'D:/work/msy-fixture', '已保存目录要回填到输入框')
    assert.equal(harness.window.localStorage.length, 0, '题库目录不得写入 localStorage')
    assert.doesNotMatch(harness.text(), /E:\/Dsh_Project\/msy/, '不许出现任何硬编码的本机路径')
  } finally { await harness.close() }
})

test('本地题库设置：保存目录 trim 后调 RPC，双击只发一次，成功后状态变已启用', async (t) => {
  const gate = hrDeferred()
  const harness = await mountSetupView({ source: hrSourceSettings(''), sourceSaveGate: gate.promise })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.match(harness.sourceCard().textContent, /未启用/)
    assert.equal(harness.buttonByText('停用'), undefined, '未启用时没有「停用」')
    assert.ok(harness.buttonByText('自动识别'), '未启用时给「自动识别」')
    await harness.openSourceAdvanced()
    assert.equal(harness.buttonByText('清除').disabled, false, '高级设置里的清除始终可点')
    await harness.typeSourceDir('  D:/work/msy-fixture  ')
    await harness.doubleClick(harness.buttonByText('保存目录'))
    // 参数对象在 bundle 的 vm realm 里创建，跨 realm 原型不同，按字段取值比较。
    assert.deepEqual(harness.state.saveSourceCalls.map((call) => call.msyDir), ['D:/work/msy-fixture'], '保存要 trim，双击只能发一次')
    assert.ok(harness.buttonByText('保存中…'), '保存中要有独立文案')
    gate.release(); await harness.flush()
    assert.match(harness.text(), /已保存本地题库目录/)
    assert.match(harness.sourceCard().textContent, /已启用/)
    assert.equal(harness.sourceInput().value, 'D:/work/msy-fixture')
    assert.equal(harness.window.localStorage.length, 0, '保存后也不许把路径写进 localStorage')
    // 题库目录不是准备/开始参数：这两条请求里都不许出现路径。
    await harness.clickButton('进入面试')
    assert.equal(Object.prototype.hasOwnProperty.call(harness.state.startCalls[0], 'msyDir'), false)
    assert.equal(JSON.stringify(harness.state.startCalls[0]).includes('msy-fixture'), false, 'start 不得携带题库路径')
  } finally { await harness.close() }
})

test('本地题库设置：停用与清除都发空目录，成功后回到未启用且输入框清空', async (t) => {
  const harness = await mountSetupView({ source: hrSourceSettings('D:/work/msy-fixture') })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.buttonByText('停用').disabled, false, '已启用时允许停用')
    await harness.clickButton('停用')
    assert.deepEqual(harness.state.saveSourceCalls.map((call) => call.msyDir), [''], '停用就是把空目录交给同一个 RPC')
    assert.match(harness.text(), /已停用本地题库/)
    assert.match(harness.sourceCard().textContent, /未启用/)
    assert.equal(harness.buttonByText('停用'), undefined, '停用后不再显示「停用」')
    assert.ok(harness.buttonByText('自动识别'), '停用后回到「自动识别」')
    await harness.openSourceAdvanced()
    assert.equal(harness.sourceInput().value, '', '停用后输入框要空')
    await harness.clickButton('清除')
    assert.deepEqual(harness.state.saveSourceCalls.map((call) => call.msyDir), ['', ''], '清除走同一个 RPC')
    assert.match(harness.text(), /已清除本地题库目录/)
  } finally { await harness.close() }
})

test('本地题库设置：卸载后迟到的读取与保存结果都不回写', async (t) => {
  const readGate = hrDeferred()
  const lateRead = await mountSetupView({ source: hrSourceSettings('D:/work/msy-fixture'), sourceGate: readGate.promise })
  if (!lateRead) return skipNoReactDom(t)
  await lateRead.unmount()
  readGate.release(); await lateRead.flush()
  assert.equal(lateRead.container.textContent, '', '卸载后迟到的设置读取不许回写')
  await lateRead.close()

  const saveGate = hrDeferred()
  const lateSave = await mountSetupView({ source: hrSourceSettings(''), sourceSaveGate: saveGate.promise })
  if (!lateSave) return skipNoReactDom(t)
  await lateSave.typeSourceDir('D:/work/msy-fixture')
  await lateSave.clickNode(lateSave.buttonByText('保存目录'))
  assert.equal(lateSave.state.saveSourceCalls.length, 1)
  await lateSave.unmount()
  saveGate.release(); await lateSave.flush()
  assert.equal(lateSave.container.textContent, '', '卸载后迟到的保存结果不许回写')
  await lateSave.close()
})

test('本地题库设置：旧 Host 缺 RPC 时整块不出现，准备与开始照旧', async (t) => {
  const harness = await mountSetupView({ prepareResult: hrPreparation() })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.sourceCard(), null, '缺 RPC 不许露出题库设置')
    assert.doesNotMatch(harness.text(), /本地 msy 题库/, '缺 RPC 时相关文案也不该出现')
    assert.equal(harness.container.querySelector('[role="alert"]'), null, '缺 RPC 不许弹错')
    assert.ok(harness.buttonByText('准备面试'), '准备按钮照旧出现')
    await harness.clickButton('准备面试')
    assert.ok(harness.outline(), '准备成功后照样显示提纲')
    assert.ok(harness.buttonByText('使用提纲进入面试'))
    await harness.clickButton('使用提纲进入面试')
    assert.equal(harness.state.startCalls[0].preparationId, 'prep-30303030bbbb')
    assert.equal(harness.started.length, 1, '旧 Host 也要能照常开始')
  } finally { await harness.close() }
})

test('题库设置变化后：提示重新准备，start 不携带 preparationId 但照旧能开始', async (t) => {
  const harness = await mountSetupView({
    latest: hrPreparation({ sourceSettingsUpdatedAt: '2026-11-17T00:00:00.000Z' }),
    source: hrSourceSettings('D:/work/msy-fixture'),
  })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.match(harness.text(), /题库设置已变化，请重新准备/, '版本不一致要明确提示')
    assert.equal(harness.buttonByText('使用提纲进入面试'), undefined, '不许声称会用这份旧提纲')
    assert.ok(harness.buttonByText('进入面试'), '仍可无提纲开始')
    await harness.clickButton('进入面试')
    assert.equal(Object.prototype.hasOwnProperty.call(harness.state.startCalls[0], 'preparationId'), false, 'start 明确不携带 preparationId')
    assert.equal(harness.started.length, 1, '不匹配也要能正常开始')
  } finally { await harness.close() }
})

test('旧 preparation 没有 sourceSettingsUpdatedAt：按匹配处理，不被判成过期（rc.23 兼容）', async (t) => {
  const harness = await mountSetupView({ latest: hrPreparation({ duration: 30 }), source: hrSourceSettings('D:/work/msy-fixture') })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.doesNotMatch(harness.text(), /题库设置已变化/, '没有版本可比时不许凭空提示')
    assert.ok(harness.buttonByText('使用提纲进入面试'))
    await harness.clickButton('使用提纲进入面试')
    assert.equal(harness.state.startCalls[0].preparationId, 'prep-30303030bbbb')
  } finally { await harness.close() }
})

test('题库设置变化后重新准备：按新设置刷新后恢复匹配并重新携带 preparationId', async (t) => {
  const harness = await mountSetupView({
    latest: hrPreparation({ sourceSettingsUpdatedAt: '2026-11-17T00:00:00.000Z' }),
    prepareResult: hrPreparation({ sourceSettingsUpdatedAt: HR_SOURCE_STAMP }),
    source: hrSourceSettings('D:/work/msy-fixture'),
  })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.match(harness.text(), /题库设置已变化/)
    await harness.clickButton('重新准备')
    assert.deepEqual(harness.state.prepareCalls.map((call) => call.durationMinutes), [30])
    assert.equal(Object.prototype.hasOwnProperty.call(harness.state.prepareCalls[0], 'msyDir'), false, '准备请求不得携带题库路径')
    assert.doesNotMatch(harness.text(), /题库设置已变化/, '新提纲版本一致后提示要消失')
    assert.ok(harness.buttonByText('使用提纲进入面试'))
    await harness.clickButton('使用提纲进入面试')
    assert.equal(harness.state.startCalls[0].preparationId, 'prep-30303030bbbb')
  } finally { await harness.close() }
})

test('提纲来源统计（rc.26）：sources 里带条数也不再显示，旧 preparation 同样不显示', async (t) => {
  const harness = await mountSetupView({ latest: hrPreparation({ sources: hrSources() }) })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.container.querySelector('[data-hri-sources]'), null, 'sources 里带条数也不许渲染来源统计')
    const text = harness.text()
    assert.doesNotMatch(text, /精选\s*46|msy岗位题|简历深挖\s*\d/, '「精选46＋msy岗位题X＋简历深挖Y」整行消失')
    assert.equal(harness.container.querySelector('[data-hri-sources-degraded]'), null, '全部 ok 时不该提示降级')
    assert.equal(harness.planItems().length, 8, '题照样全列出来')
    assert.match(harness.outline().textContent, /请讲一次你在 30 分钟场里/, '题干仍在')
    assert.doesNotMatch(text, /profileKey|planKey/, '统计不许捎带内部键')
  } finally { await harness.close() }

  const legacy = await mountSetupView({ latest: hrPreparation() })
  if (!legacy) return skipNoReactDom(t)
  try {
    assert.equal(legacy.container.querySelector('[data-hri-sources]'), null, '旧 preparation 没有 sources 也一样不显示')
    assert.equal(legacy.container.querySelector('[data-hri-sources-degraded]'), null, '没有 sources 就不提示降级')
    assert.equal(legacy.planItems().length, 8, '旧 preparation 的条目照旧显示')
  } finally { await legacy.close() }
})

test('提纲来源降级：只留一句通用中文提示，不渲染统计、路径或底层错误', async (t) => {
  const harness = await mountSetupView({
    latest: hrPreparation({
      sources: hrSources({
        msyQuestions: { status: 'degraded', imported: 0, scanned: 0, invalid: 2, skippedOffTopic: 0, withAnswer: 0 },
        msyResume: { status: 'disabled', imported: 0 },
      }),
      warnings: ['E:/secret/msy/data/questions.ndjson: EACCES permission denied', 'shrink guard kept previous snapshot'],
    }),
    source: hrSourceSettings('D:/work/msy-fixture'),
  })
  if (!harness) return skipNoReactDom(t)
  try {
    const degraded = harness.container.querySelector('[data-hri-sources-degraded]')
    assert.ok(degraded, 'degraded / warnings 必须给中文提示')
    assert.equal(degraded.textContent, '本地题库降级：部分内容没有载入，本次用通用题库继续', '降级提示只说状态，不带条数与出处')
    assert.equal(harness.container.querySelector('[data-hri-sources]'), null, '降级时也不显示来源统计')
    assert.equal(harness.planItems().length, 8, '降级时题照旧列出来')
    const text = harness.text()
    assert.doesNotMatch(text, /E:\/secret|EACCES|permission denied|shrink guard/, '提示里不许出现路径或底层错误')
  } finally { await harness.close() }
})

// rc.26 的核心回归：sourceRefs 里塞满 https / 标题 / javascript: / 奇怪文本，提纲也不许透出任何来源。
// 直挂 SetupView，一次覆盖「没有 <a>、没有 href、没有来源文本、没有来源统计」，同时确认本地题库卡没被误删。
const hrHostilePreparation = () => {
  const base = hrPreparation({ duration: 30 })
  const hostile = [
    { bankItemId: 'bank-agent-001', revision: 1, sourceTitle: '牛客 · Agent 面经合集', sourceUrl: 'https://example.com/interview/agent', evidenceLevel: 'first_hand' },
    { bankItemId: 'bank-agent-002', revision: 2, sourceTitle: 'javascript:alert(1)', sourceUrl: 'javascript:alert(document.cookie)', evidenceLevel: 'first_hand' },
    { bankItemId: 'bank-agent-003', revision: 3, sourceTitle: 'http://plain.example.com/title-only', sourceUrl: 'http://plain.example.com/title-only', evidenceLevel: 'second_hand' },
    { bankItemId: 'bank-agent-004', revision: 4, sourceTitle: '<b>来源 46</b> 精选46＋msy岗位题372＋简历深挖39', sourceUrl: 'https://evil.example.com/精选46＋msy岗位题372＋简历深挖39', evidenceLevel: 'first_hand' },
  ]
  const items = base.items.map((item, index) => ({ ...item, basis: index === 0 ? 'public-duty' : 'simulation', sourceRefs: [hostile[index % hostile.length]] }))
  return { ...base, items, sources: hrSources() }
}

test('面试提纲（rc.26）：sourceRefs 含 https / 标题 / javascript: 也不生成来源 <a>、来源文本或来源统计', async (t) => {
  const harness = await mountSetupView({ latest: hrHostilePreparation(), source: hrSourceSettings('D:/work/msy-fixture') })
  if (!harness) return skipNoReactDom(t)
  try {
    const outline = harness.outline()
    assert.ok(outline, '提纲照旧显示')
    assert.equal(harness.planItems().length, 8, '条目一条都不少')
    // 1) 结构上：没有 <a>、没有 href，也没有任何能点出去的东西。
    assert.equal(outline.querySelectorAll('a').length, 0, '提纲里不许出现 <a>')
    assert.equal(outline.querySelectorAll('[href]').length, 0, '也不许留 href')
    assert.equal(outline.querySelectorAll('small').length, 0, '不再用 <small> 兜底显示来源标题')
    // 2) 文本上：来源标题 / URL / 协议 / 来源统计都不出现。
    const text = outline.textContent
    assert.match(text, /根据公开岗位职责生成/)
    assert.match(text, /模拟题/)
    for (const leaked of ['牛客', 'javascript', 'https', 'http', 'example.com', 'msy岗位题', '精选46', '<b>来源 46</b>']) {
      assert.equal(text.includes(leaked), false, `提纲不许出现来源痕迹：${leaked}`)
    }
    assert.equal(harness.container.querySelector('[data-hri-sources]'), null, '来源统计整行不许出现')
    assert.doesNotMatch(harness.text(), /精选\s*46|msy岗位题/, '整页都不许出现来源统计')
    // 3) 该留的还在：序号 / topic / kind / 题干 / 主备 / expectedPoints。
    assert.equal(harness.planItems()[0].querySelector('.hri-plan-number').textContent, '01', '序号仍在')
    assert.match(text, /RAG 检索链路/)
    assert.match(text, /项目/, 'kind 仍是中文标签')
    assert.match(text, /请讲一次你在 30 分钟场里/, '题干仍在')
    assert.match(text, /召回率从 62% 提到 81%/, '要点仍在')
    assert.match(harness.planItems()[6].textContent, /备选/, '备选标注仍在')
    // 4) 本地题库卡（选择题库 / 启停 / 题量 / 目录）没被一起删掉。
    const card = harness.sourceCard()
    assert.ok(card, '本地题库设置卡必须还在')
    assert.match(card.textContent, /msy 本地题库/, '仍显示友好名称')
    assert.match(card.textContent, /已启用/, '仍显示启停状态')
    assert.ok(harness.buttonByText('选择题库'), '选择题库还在')
    assert.ok(harness.buttonByText('停用'), '停用还在')
    assert.ok(harness.buttonByText('重新扫描'), '重新扫描还在')
    assert.match(harness.sourceStats().textContent, /岗位题 46/, '题量统计还在')
    assert.match(harness.sourceStats().textContent, /简历深挖 12/, '题量统计还在')
    await harness.openSourceAdvanced()
    assert.equal(harness.sourceInput().value, 'D:/work/msy-fixture', '目录输入仍在高级设置里')
  } finally { await harness.close() }
})

test('题库设置读取失败：不弹错、不误判过期，准备与开始照旧', async (t) => {
  const harness = await mountSetupView({ latest: hrPreparation({ duration: 30 }), sourceReadError: 'settings.json unreadable' })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.state.sourceCalls, 1, '仍然尝试读了一次')
    assert.match(harness.sourceCard().textContent, /状态未读取/)
    assert.equal(harness.container.querySelector('[role="alert"]'), null, '读取失败不许弹错')
    assert.doesNotMatch(harness.text(), /题库设置已变化/, '读不到设置就无法判断过期，不许凭空提示')
    assert.ok(harness.buttonByText('使用提纲进入面试'))
    await harness.clickButton('使用提纲进入面试')
    assert.equal(harness.state.startCalls[0].preparationId, 'prep-30303030bbbb')
  } finally { await harness.close() }
})

test('本地题库设置：保存失败时显示后端消息、保留输入并恢复按钮', async (t) => {
  const harness = await mountSetupView({ source: hrSourceSettings(''), sourceSaveError: '目录中未找到 data/questions.ndjson，请检查 msy 目录' })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.typeSourceDir('D:/broken/msy')
    await harness.clickButton('保存目录')
    assert.deepEqual(harness.state.saveSourceCalls.map((call) => call.msyDir), ['D:/broken/msy'])
    assert.match(harness.text(), /题库设置保存失败/)
    assert.match(harness.text(), /data\/questions\.ndjson/, '后端消息要能看见，方便改路径重试')
    assert.equal(harness.sourceInput().value, 'D:/broken/msy', '失败时保留输入')
    assert.equal(harness.buttonByText('保存目录').disabled, false, '失败后按钮要恢复可用')
    assert.doesNotMatch(harness.text(), /已保存本地题库目录/, '失败不得显示成功文案')
  } finally { await harness.close() }
})

// —— rc.25：题库卡片友好化（选择题库 / 自动识别 / 重新扫描 / 停用）与「换一批题」——
// 按 bankItemId 重排一批题，专门制造「换到新题」和「没有更多可换的题」两种结果。
const hrPlanIds = (prefix, count = 8) => Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`)
const hrPreparationWith = ({ duration = 30, bankIds, preparationId, sourceSettingsUpdatedAt } = {}) => {
  const base = hrPreparation({ duration })
  const items = base.items.map((item, index) => {
    const bankItemId = (bankIds && bankIds[index]) || item.bankItemId
    return { ...item, bankItemId, sourceRefs: [{ ...item.sourceRefs[0], bankItemId }] }
  })
  const next = { ...base, preparationId: preparationId || base.preparationId, items }
  if (sourceSettingsUpdatedAt !== undefined) next.sourceSettingsUpdatedAt = sourceSettingsUpdatedAt
  return next
}

test('本地题库设置：点「自动识别」只走 detectMsySource，结果与统计一起刷新', async (t) => {
  const harness = await mountSetupView({
    source: hrSourceSettings(''),
    detectResult: { msyDir: 'D:/work/msy-auto', updatedAt: '2026-11-18T12:30:00.000Z', configured: true, displayName: 'msy 本地题库', sourceSummary: { agentQuestions: 88, resumeQuestions: 15 } },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.buttonByText('自动识别').disabled, false, '未启用时「自动识别」可点')
    await harness.clickButton('自动识别')
    assert.equal(harness.state.detectCalls, 1, '识别只由按钮触发一次')
    assert.equal(harness.state.sourceCalls, 1, '识别不额外调 sourceSettings')
    assert.equal(harness.sourceInput(), null, '识别不该顺手把路径输入框摊开')
    assert.match(harness.text(), /自动识别完成/)
    assert.match(harness.sourceCard().textContent, /已启用/)
    assert.match(harness.sourceStats().textContent, /岗位题 88/)
    assert.match(harness.sourceStats().textContent, /简历深挖 15/)
    assert.ok(harness.buttonByText('重新扫描'), '启用后按钮变成「重新扫描」')
    assert.doesNotMatch(harness.text(), /D:\/work\/msy-auto/, '识别出来的路径不进正文')
  } finally { await harness.close() }
})

test('本地题库设置：已启用时「重新扫描」重新统计；失败只给有限中文提示', async (t) => {
  const harness = await mountSetupView({ source: hrSourceSettings('D:/work/msy-fixture') })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.clickButton('重新扫描')
    assert.equal(harness.state.detectCalls, 1)
    assert.match(harness.text(), /重新扫描完成/)
    assert.match(harness.sourceStats().textContent, /岗位题 61/, '扫描后统计要换成新数字')
  } finally { await harness.close() }

  const broken = await mountSetupView({ source: hrSourceSettings('D:/work/msy-fixture'), detectError: 'EACCES: permission denied, open D:/work/msy-fixture/data/questions.ndjson' })
  if (!broken) return skipNoReactDom(t)
  try {
    await broken.clickButton('重新扫描')
    assert.match(broken.text(), /重新扫描失败/, '失败要明确说是哪个动作失败')
    assert.doesNotMatch(broken.text(), /EACCES|permission denied|data\/questions/, '底层错误不许原样摊给用户')
  } finally { await broken.close() }
})

test('本地题库设置：选择题库优先用宿主桥，取到路径直接保存并刷新统计', async (t) => {
  const ctxCalls = []
  const harness = await mountSetupView({
    source: hrSourceSettings(''),
    directoryPicker: () => 'D:/work/msy-bridge',
    ctx: { get: (name) => { ctxCalls.push(name); return { pickDirectory: async () => 'D:/work/msy-ctx' } } },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.clickButton('选择题库')
    assert.deepEqual(harness.state.saveSourceCalls.map((call) => call.msyDir), ['D:/work/msy-bridge'], '桥优先，选完直接保存')
    assert.deepEqual(ctxCalls, [], '有桥时不该去碰 ctx')
    assert.match(harness.sourceCard().textContent, /已启用/)
    assert.match(harness.sourceStats().textContent, /岗位题 46/)
    assert.equal(harness.sourceInput(), null, '选完不需要展开高级设置')
  } finally { await harness.close() }
})

test('本地题库设置：没有宿主桥时回落到 ctx.uiWorkspace.pickDirectory', async (t) => {
  const harness = await mountSetupView({
    source: hrSourceSettings(''),
    ctx: { get: (name) => (name === 'uiWorkspace' ? { pickDirectory: async () => 'D:/work/msy-ctx' } : null) },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.clickButton('选择题库')
    assert.deepEqual(harness.state.saveSourceCalls.map((call) => call.msyDir), ['D:/work/msy-ctx'])
  } finally { await harness.close() }
})

test('本地题库设置：选择器取消（null）不改任何状态，也不发保存请求', async (t) => {
  const harness = await mountSetupView({ source: hrSourceSettings('D:/work/msy-fixture'), directoryPicker: () => null })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.clickButton('选择题库')
    assert.equal(harness.state.saveSourceCalls.length, 0, '取消不许发保存')
    assert.match(harness.sourceCard().textContent, /已启用/, '取消后仍是原来的状态')
    assert.equal(harness.container.querySelector('[role="alert"]'), null, '取消不算错误')
    // 只盯题库设置自己的提示：页面别处本来就有「TTS 失败会自动尝试浏览器朗读」这类文案。
    assert.doesNotMatch(harness.text(), /当前环境不支持|目录选择失败|题库设置保存失败/, '取消不是错误，也不是「没有接口」')
  } finally { await harness.close() }

  const empty = await mountSetupView({ source: hrSourceSettings(''), directoryPicker: () => null })
  if (!empty) return skipNoReactDom(t)
  try {
    await empty.clickButton('选择题库')
    assert.equal(empty.state.saveSourceCalls.length, 0)
    assert.match(empty.sourceCard().textContent, /未启用/)
  } finally { await empty.close() }
})

test('本地题库设置：两处都没有目录选择接口时，展开高级设置并给出中文提示', async (t) => {
  const harness = await mountSetupView({ source: hrSourceSettings('') })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.sourceInput(), null, '默认仍然不摊开路径输入框')
    await harness.clickButton('选择题库')
    assert.match(harness.text(), /当前环境不支持目录选择/, '没有接口要明说，不能静默失败')
    assert.ok(harness.sourceInput(), '同时把高级设置摊开，让用户手填')
    assert.equal(harness.state.saveSourceCalls.length, 0)
  } finally { await harness.close() }
})

test('本地题库设置：Host 有设置 RPC 但没有自动识别时，只少两颗按钮', async (t) => {
  const harness = await mountSetupView({ source: hrSourceSettings('D:/work/msy-fixture'), sourceDetect: false })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.ok(harness.sourceCard(), '设置卡照旧出现')
    assert.equal(harness.buttonByText('自动识别'), undefined, '缺 RPC 不显示「自动识别」')
    assert.equal(harness.buttonByText('重新扫描'), undefined, '缺 RPC 不显示「重新扫描」')
    assert.ok(harness.buttonByText('选择题库'))
    assert.ok(harness.buttonByText('停用'))
    await harness.clickButton('停用')
    assert.deepEqual(harness.state.saveSourceCalls.map((call) => call.msyDir), [''], '其余功能不受影响')
  } finally { await harness.close() }
})

test('换一批题：题干没变时保留原提纲并提示「没有更多可换的题」', async (t) => {
  const harness = await mountSetupView({
    latest: hrPreparationWith({ bankIds: hrPlanIds('bank-agent') }),
    prepareResult: hrPreparationWith({ bankIds: hrPlanIds('bank-reindexed'), preparationId: 'prep-30303030cccc' }),
  })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.ok(harness.buttonByText('换一批题'), '匹配状态下按钮叫「换一批题」')
    await harness.clickButton('换一批题')
    assert.deepEqual(harness.state.prepareCalls.map((call) => `${call.durationMinutes}:${call.refresh}`), ['30:true'], '换题仍然只发时长与 refresh')
    assert.match(harness.prepNotice().textContent, /没有更多可换的题/)
    assert.equal(harness.planItems().length, 8, '提纲还在')
    assert.equal(harness.outline().querySelectorAll('.hri-plan-changed').length, 0)
    await harness.clickButton('使用提纲进入面试')
    assert.equal(harness.state.startCalls[0].preparationId, 'prep-30303030bbbb', '没换到新题就继续用原来那份')
  } finally { await harness.close() }
})

test('换一批题：相同主题下按题干标出已更换的主问和备选，固定开场不标为更换', async (t) => {
  const previous = hrPreparation()
  previous.items[0] = { ...previous.items[0], topic: '项目介绍', question: '先介绍一个与你应聘岗位相关的项目。', opening: true }
  const changedItems = previous.items.map((item, index) => index === 0 ? item : { ...item, question: `新题 ${index}：说说你会如何验证结果？` })
  const harness = await mountSetupView({
    latest: previous,
    prepareResult: { ...previous, items: changedItems, preparationId: 'prep-30303030dddd' },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.clickButton('换一批题')
    assert.equal(harness.prepNotice().textContent, '已换 5 道主问、2 道备选')
    assert.equal(harness.prepNotice().parentElement, harness.buttonByText('换一批题').parentElement)
    const rows = harness.planItems()
    assert.match(rows[0].textContent, /固定开场/)
    assert.equal(rows[0].querySelector('.hri-plan-changed'), null)
    assert.deepEqual(rows.filter((row) => !row.hidden && row.querySelector('.hri-plan-changed')), rows.slice(1, 6))
    assert.match(rows[1].textContent, /工具调用失败.*新题 1/)
    await harness.clickButton('查看 2 道备选 · 2 道已更换')
    assert.deepEqual(rows.filter((row) => !row.hidden && row.querySelector('.hri-plan-changed')), rows.slice(1))
    await harness.clickButton('使用提纲进入面试')
    assert.equal(harness.state.startCalls[0].preparationId, 'prep-30303030dddd', '换到了新题就用新提纲')
  } finally { await harness.close() }
})

test('换考察方向独立调用准备接口，题卡以实际考察方向为标题', async (t) => {
  const previous = hrPreparation({ dutyPlan: true })
  previous.items[4] = { ...previous.items[4], duty: 'rag', topic: 'agent-core', question: '向量数据库原理是什么？' }
  const nextItems = previous.items.map((item, index) => index === 4 ? { ...item, duty: 'project-general' } : item)
  const next = { ...previous, items: nextItems, preparationId: 'prep-30303030ffff', directionRefresh: { changed: 1 } }
  const harness = await mountSetupView({ latest: previous, prepareResult: next })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.equal(harness.planItems()[4].querySelector('.hri-plan-title strong').textContent, 'RAG 检索')
    assert.equal(harness.buttonByText('换一批题').parentElement, harness.buttonByText('换考察方向').parentElement)
    await harness.clickButton('换考察方向')
    assert.deepEqual({ ...harness.state.prepareCalls[0] }, { durationMinutes: 30, refresh: false, changeDirections: true })
    assert.equal(harness.prepNotice().textContent, '已换 1 个考察方向')
    assert.equal(harness.planItems()[4].querySelector('.hri-plan-title strong').textContent, '项目深挖')
    harness.state.prepareResult = { ...next, directionRefresh: { changed: 0 } }
    await harness.clickButton('换考察方向')
    assert.match(harness.prepNotice().textContent, /没有可替换的考察方向/)
    await harness.clickButton('使用提纲进入面试')
    assert.equal(harness.state.startCalls[0].preparationId, next.preparationId)
  } finally { await harness.close() }
})

test('换一批题：只有备选题变化时只报告备选变化', async (t) => {
  const previous = hrPreparation()
  const items = previous.items.map((item, index) => index === 6 ? { ...item, question: '新备选题' } : item)
  const harness = await mountSetupView({
    latest: previous,
    prepareResult: { ...previous, items, preparationId: 'prep-30303030eeee' },
  })
  if (!harness) return skipNoReactDom(t)
  try {
    await harness.clickButton('换一批题')
    assert.equal(harness.prepNotice().textContent, '已换 1 道备选')
    assert.equal(harness.outline().querySelectorAll('.hri-plan-item:not([hidden]) .hri-plan-changed').length, 0)
    await harness.clickButton('查看 2 道备选 · 1 道已更换')
    assert.match(harness.planItems()[6].textContent, /已更换.*新备选题/)
  } finally { await harness.close() }
})

test('换一批题：旧提纲过期时按「重新准备」走，允许拿回同一批题', async (t) => {
  const harness = await mountSetupView({
    latest: hrPreparationWith({ bankIds: hrPlanIds('bank-agent'), sourceSettingsUpdatedAt: '2026-11-17T00:00:00.000Z' }),
    prepareResult: hrPreparationWith({ bankIds: hrPlanIds('bank-agent'), sourceSettingsUpdatedAt: HR_SOURCE_STAMP }),
    source: hrSourceSettings('D:/work/msy-fixture'),
  })
  if (!harness) return skipNoReactDom(t)
  try {
    assert.match(harness.text(), /题库设置已变化/)
    assert.ok(harness.buttonByText('重新准备'), '不匹配时按钮是「重新准备」')
    await harness.clickButton('重新准备')
    assert.equal(harness.prepNotice(), null, '重建不算换题，不许报「没有更多可换的题」')
    assert.doesNotMatch(harness.text(), /没有更多可换的题/)
    assert.doesNotMatch(harness.text(), /题库设置已变化/, '重建后版本对齐')
    await harness.clickButton('使用提纲进入面试')
    assert.equal(harness.state.startCalls[0].preparationId, 'prep-30303030bbbb')
  } finally { await harness.close() }
})
