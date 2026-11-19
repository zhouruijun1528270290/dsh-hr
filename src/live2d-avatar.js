/**
 * Live2D 阶段 0 · 浏览器最小渲染（HR 页内自渲染，不嵌 iframe、不接外部舞台）。
 *
 * 本文件是普通浏览器脚本，**不写 import / export**：构建时由 scripts/build-lib.mjs
 * 原样内联进模块工厂函数，与 src/client.js 共享同一个作用域。
 * 因此这里有四条硬约束：
 *   1. 只靠函数声明与 const 共享，不依赖任何 ESM 运行时；
 *   2. 顶层不得触碰 window / document / PIXI（SSR 与 node:vm 都要能直接跑这段文本）；
 *   3. 运行时脚本与 PIXI 全局按 document 缓存（只加载一次），模型实例绝不缓存；
 *   4. 卸载只销毁「本舞台自己创建的」PIXI app / model / RAF / ResizeObserver，
 *      不删 script 标签、不重置 window.PIXI、不碰共享的 Live2DCubismCore。
 *
 * 当前有两件事：① fill 舞台按「胸口以上近景」取景（不再是缩成一条的全身像）；
 * ② 只对 大肥鱼 这一个模型加克制的表演参数（idle 完全不写参数，呼吸/眨眼仍交给
 * pixi-live2d-display 自带的 eyeBlink / breath；其余状态只动 8 个已核实存在的参数）。
 */

// 固定顺序：pixi 必须先就位 —— cubism4 构建在初始化时就会读 window.PIXI。
const HR_LIVE2D_RUNTIME_FILES = Object.freeze([
  'pixi-6.5.10.min.js',
  'live2dcubismcore-1.0.2.min.js',
  'pixi-live2d-display-cubism4-0.4.0.min.js',
])
const HR_LIVE2D_MIN_SIZE = 160
const HR_LIVE2D_MAX_SIZE = 220

function hrLive2dClampSize(value) {
  const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) return 190
  return Math.max(HR_LIVE2D_MIN_SIZE, Math.min(HR_LIVE2D_MAX_SIZE, Math.round(size)))
}

/** base 与 runtimeBase 只允许同源相对路径：不拼绝对域，也不接受协议前缀。 */
function hrLive2dBasePath(value, fallback) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return fallback
  const trimmed = text.replace(/\/+$/, '')
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) return fallback
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function hrLive2dRuntimeUrls(runtimeBase) {
  const base = hrLive2dBasePath(runtimeBase, '/hr-runtime')
  return HR_LIVE2D_RUNTIME_FILES.map((name) => `${base}/${name}`)
}

/**
 * 模型 URL = base + '/' + 每个路径段各自 encodeURIComponent。
 * `大肥鱼.model3.json` → `/hr-avatar/%E5%A4%A7%E8%82%A5%E9%B1%BC.model3.json`：
 * 分隔符保持 `/`，中文段必须编码，绝不拼出绝对域。
 */
function hrLive2dModelUrl(base, model) {
  const root = hrLive2dBasePath(base, '/hr-avatar')
  const segments = String(model == null ? '' : model)
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  if (segments.length === 0) throw new Error('Live2D 模型入口为空，无法拼出模型地址')
  return `${root}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`
}

// 每个 document 一份运行时状态：同一个页面里重复挂载也只注入一次脚本。
const hrLive2dRuntimeCache = new WeakMap()

function hrLive2dRuntimeState(doc) {
  let state = hrLive2dRuntimeCache.get(doc)
  if (!state) {
    state = { promise: null, urls: [] }
    hrLive2dRuntimeCache.set(doc, state)
  }
  return state
}

/** 默认加载方式：真 script 标签，逐条等 load 事件，失败 reject。 */
function hrLive2dDefaultLoadScript(doc, url) {
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script')
    script.src = url
    script.async = false
    script.dataset.hrLive2dRuntime = '1'
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error(`Live2D 运行时加载失败：${url}`)), { once: true })
    const parent = doc.head || doc.body || doc.documentElement
    if (!parent) { reject(new Error('当前文档没有可挂载脚本的节点')); return }
    parent.appendChild(script)
  })
}

/**
 * 按固定顺序串行加载运行时脚本，同一 document 只加载一次。
 * 失败时清掉缓存并 reject —— 调用方（舞台）据此回退静态头像，下次挂载仍可重试。
 */
function hrLive2dLoadRuntime(doc, runtimeBase, options = {}) {
  const state = hrLive2dRuntimeState(doc)
  if (state.promise) return state.promise
  const urls = hrLive2dRuntimeUrls(runtimeBase)
  const loadScript = typeof options.loadScript === 'function'
    ? options.loadScript
    : (url) => hrLive2dDefaultLoadScript(doc, url)
  state.urls = urls
  state.promise = urls
    .reduce((chain, url) => chain.then(() => loadScript(url)), Promise.resolve())
    .then(() => ({ urls: urls.slice() }), (error) => {
      state.promise = null
      throw error
    })
  return state.promise
}

function hrLive2dResolveGlobals(config) {
  const win = config.window || (typeof window === 'undefined' ? null : window)
  const PIXI = config.PIXI || (win && win.PIXI) || null
  const core = config.core || (win && win.Live2DCubismCore) || null
  return { win, PIXI, core }
}

/**
 * 0.4.0 的 cubism4 构建把命名空间挂在 PIXI.live2d；部分文档/示例写成 PIXI.live2ds。
 * 两个都认，避免只认一个字符串就把可用运行时判成不可用。
 */
function hrLive2dNamespace(PIXI) {
  if (!PIXI) return null
  return PIXI.live2ds || PIXI.live2d || null
}

/* ── 取景：fill 舞台 = 胸口以上近景，card 仍是原来的 contain ────────────────
 * 模型画布是窄高的全身像（大肥鱼实测 3749×7697，见 .tmp/nose-probe 报告的 boot 段），
 * 旧的 contain 铺满在 800×300 的舞台上只能缩到 0.037 —— 整条人只有 137×282px，
 * 脸大约 50px，等于把面试官缩成了一个挂件。
 *
 * 近景不拉伸、不切头、也不改模型：
 *   · 把「模型顶部 fraction 段」（默认 0.34 ≈ 头顶到胸口）等比放大到铺满视口高度 ——
 *     **近景优先**：宽度不够时左右对称裁掉一部分肩/尾宽，不为了塞进宽度退回全身；
 *   · 横向裁切有安全上限（contain 的 4 倍 ≈ 至少还留着模型 25% 宽度），
 *     再窄的极端竖屏才牺牲近景，保证「人还看得出是个半身」而不是一根脸柱；
 *   · 顶对齐：模型上沿落在视口内 topInset 处（是正的不是负的，切头就出在这里）；
 *   · x 居中，anchor 仍是 0.5,0.5，所以宽度变化只改缩放，不改比例。
 * Setup 页右边的 badge 由 HRMark（client.js）自己排版，本文件一个字都不碰它。
 */
const HR_LIVE2D_CLOSEUP_FRACTION = 0.34
const HR_LIVE2D_CLOSEUP_TOP_INSET = 0.02
const HR_LIVE2D_CLOSEUP_MAX_CROP = 4
const HR_LIVE2D_CARD_FIT_RATIO = 0.94

function hrLive2dPositive(value, fallback) {
  let num = NaN
  try { num = Number(value) } catch { return fallback }
  return Number.isFinite(num) && num > 0 ? num : fallback
}

function hrLive2dClampNumber(value, min, max) {
  let num = NaN
  try { num = Number(value) } catch { return min }
  if (!Number.isFinite(num)) return min
  return num < min ? min : num > max ? max : num
}

/**
 * 纯取景函数（单测直接调，不碰 PIXI / 不碰 DOM）：
 *   card → contain：min(容器比, 模型比) × 0.94 居中，与旧实现逐位一致。
 *   fill → 近景窗口：见上面的注释。
 * 返回的 x/y 是模型中心点（anchor 0.5,0.5）在舞台画布里的坐标。
 */
function hrLive2dFraming(input = {}) {
  const width = hrLive2dPositive(input.width, 1)
  const height = hrLive2dPositive(input.height, 1)
  const modelWidth = hrLive2dPositive(input.modelWidth, 1)
  const modelHeight = hrLive2dPositive(input.modelHeight, 1)
  const fill = input.mode === 'fill' || input.fill === true
  if (!fill) {
    const scale = hrLive2dPositive(Math.min(width / modelWidth, height / modelHeight) * HR_LIVE2D_CARD_FIT_RATIO, 1)
    return {
      mode: 'card',
      scale,
      x: width / 2,
      y: height / 2,
      visibleFraction: Math.min(1, height / (modelHeight * scale)),
    }
  }
  const fraction = hrLive2dClampNumber(
    input.fraction == null ? HR_LIVE2D_CLOSEUP_FRACTION : input.fraction,
    0.12,
    1,
  )
  const inset = hrLive2dClampNumber(
    input.topInset == null ? HR_LIVE2D_CLOSEUP_TOP_INSET : input.topInset,
    0,
    0.2,
  )
  const byHeight = height / (modelHeight * fraction)
  const byWidth = width / modelWidth
  // 近景优先：先按高度放大到只看见 fraction 段（visibleFraction 恒等于 fraction），
  // 宽度不足的部分由舞台左右对称裁掉（anchor 0.5,0.5 → 两侧裁的一样多）。
  // 安全上限：横向最多放大到 contain 的 MAX_CROP 倍，极端窄屏宁可脸小一点也不切成人脸柱。
  const contain = Math.min(byWidth, height / modelHeight)
  const maxScale = hrLive2dPositive(contain * HR_LIVE2D_CLOSEUP_MAX_CROP, byHeight)
  const scale = hrLive2dPositive(Math.min(byHeight, maxScale), 1)
  const displayHeight = modelHeight * scale
  return {
    mode: 'fill',
    scale,
    x: width / 2,
    // 顶对齐：模型上沿 = y - displayHeight/2 = +inset*height，头顶留一点余量再出画。
    y: displayHeight / 2 + inset * height,
    visibleFraction: Math.min(1, height / displayHeight),
    // 横向被裁掉多少（1 = 模型整幅宽度都在舞台里；< 1 = 两侧对称裁掉）。
    visibleWidthFraction: Math.min(1, width / (modelWidth * scale)),
  }
}

/** 把取景结果写进舞台：fill 走近景，card 保持原 contain。 */
function hrLive2dFit(stage) {
  const app = stage.app
  const model = stage.model
  if (!app || !model || stage.destroyed) return
  const host = stage.host
  const width = Math.max(1, Math.round(Number(host && host.clientWidth) || stage.size))
  const height = Math.max(1, Math.round(Number(host && host.clientHeight) || stage.size))
  app.renderer.resize(width, height)
  const source = model.internalModel || model
  const modelWidth = Number(source && source.width) || Number(model.width) || 1
  const modelHeight = Number(source && source.height) || Number(model.height) || 1
  const framing = hrLive2dFraming({
    mode: stage.fill ? 'fill' : 'card',
    width,
    height,
    modelWidth,
    modelHeight,
  })
  model.scale.set(framing.scale)
  model.position.set(framing.x, framing.y)
  stage.framing = framing
}

/* ── 大肥鱼 · 鼻部黑块补丁 ──────────────────────────────────────────────
 * 真实隔离 Chrome 已证实（.tmp/nose-v8-20261115124610/report.json）：Part46（鼻子）下的
 * ArtMesh246 与 ArtMesh682 是两个完全重叠的黑色面片，叠出鼻梁上那块黑斑；同一 Part 下
 * 另外三个面片（ArtMesh46/45/44）是正常阴影，必须留着。
 *
 * 因此只在运行时把这两个 drawable 的 opacity 压到 0：原模型文件一个字都不改，
 * 且**只对下面这一个模型名生效**，其它模型连判断都不进。
 */
const HR_LIVE2D_NOSE_PATCH_MODEL = '大肥鱼.model3.json'
const HR_LIVE2D_NOSE_PATCH_DRAWABLES = Object.freeze(['ArtMesh246', 'ArtMesh682'])

/** 模型名精确相等才打补丁：不做 contains / 前后缀匹配，同系列变体一律不受影响。 */
function hrLive2dNosePatchApplies(model) {
  return String(model == null ? '' : model) === HR_LIVE2D_NOSE_PATCH_MODEL
}

/** Cubism 4 的 coreModel：0.4.0 上 `_model` 才是 drawables 的真正宿主，缺失时退回 coreModel 本身。 */
function hrLive2dCoreModel(model) {
  const core = model && model.internalModel && model.internalModel.coreModel
  if (!core) return null
  return core._model || core
}

/**
 * 按 drawable ID 解析索引 —— 绝不写死 513/514：索引是拍出来的，ID 才是模型里的语义。
 *
 * ids 的形状不能假定：普通数组、TypedArray、只有 Symbol.iterator 的容器，乃至 Cubism
 * 原生 csmVector（不可迭代，只有 getSize()/at()）。所以一律先 Array.from，异常只返回 []；
 * 拿不到元素再用 vector 接口兜底。任何一层缺失都只是「这次不打补丁」，面试照常跑。
 */
function hrLive2dNosePatchIndices(model) {
  const core = hrLive2dCoreModel(model)
  const drawables = core && core.drawables
  const ids = drawables && drawables.ids
  if (!ids) return []
  let list = []
  try {
    list = Array.from(ids)
  } catch {
    list = [] // 不可迭代（原生 csmVector）→ 交给下面的 vector 接口
  }
  if (list.length === 0 && typeof ids.getSize === 'function' && typeof ids.at === 'function') {
    try {
      const size = Number(ids.getSize()) || 0
      for (let index = 0; index < size; index += 1) list.push(ids.at(index))
    } catch {
      return []
    }
  }
  const found = []
  for (let index = 0; index < list.length; index += 1) {
    const id = list[index]
    if (typeof id === 'string' && HR_LIVE2D_NOSE_PATCH_DRAWABLES.includes(id)) found.push(index)
  }
  return found
}

/**
 * 把命中的 drawable opacity 压到 0，其余一律不动。
 * 必须在 model.update() 之后调用：update 每帧都会重算 opacity，提前写会被覆盖掉。
 * opacities 缺失或只读时返回 false —— 补丁失效也不能把面试拖崩。
 */
function hrLive2dHideNoseDrawables(model, indices) {
  if (!indices || indices.length === 0) return false
  const core = hrLive2dCoreModel(model)
  const opacities = core && core.drawables && core.drawables.opacities
  if (!opacities || typeof opacities.length !== 'number') return false
  let hidden = false
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= opacities.length) continue
    try {
      opacities[index] = 0
      hidden = true
    } catch { /* 只读实现：保持原样，别让面试崩 */ }
  }
  return hidden
}

/**
 * 推进恰好一帧，并把 deltaTime 清零。
 *
 * pixi-live2d-display 0.4.0 的真实语义（见 lib/vendor/pixi-live2d-display-cubism4-0.4.0.min.js）：
 *   update(t)   → this.deltaTime += t; this.elapsedTime += t      // 只累加，不推进
 *   _render(t)  → this.deltaTime && (internalModel.update(this.deltaTime, this.elapsedTime), this.deltaTime = 0)
 * 也就是说真正推进会重算 drawables.opacities 的那一步发生在 render 内部。补丁要压的 opacity
 * 想在 render 里活下来，只能先把这一帧手动推完、再把 deltaTime 清零，让 _render 那次 update 跳过。
 * 这样每帧仍然只推进一次 —— 动画、呼吸、眨眼照常走。
 */
function hrLive2dAdvanceFrame(model) {
  if (!model) return false
  let delta = 0
  try {
    delta = Number(model.deltaTime) || 0
  } catch {
    return false
  }
  if (delta === 0) return true // 本帧没有待推进时间：_render 里那次 update 也不会发生
  try {
    const proxy = model.internalModel
    if (!proxy || typeof proxy.update !== 'function') return false
    proxy.update(delta, model.elapsedTime)
    model.deltaTime = 0
    return true
  } catch {
    // 推进失败也要把 deltaTime 清掉：宁可少推一帧，也别让 render 内部把补丁冲掉。
    try { model.deltaTime = 0 } catch { /* 只读实现：保持原样 */ }
    return false
  }
}

/* ── 大肥鱼 · 表演参数 ──────────────────────────────────────────────────────
 * 只对 大肥鱼.model3.json 生效。8 个参数与范围全部取自
 * .tmp/nose-probe-20261115122635/report.json 的真实 dump（509 个参数里的这 8 个），
 * 写之前再夹一次界；参数/结构缺失就静默跳过，表演永远不能把面试拖崩。
 *
 * 克制原则：不做持续机械摇摆、不做随机大动作、不跟鼠标、不改模型文件。
 *   idle      → 一个参数都不写：原模型的呼吸 / 眨眼 / 物理照跑（沿用原样）。
 *   listening → 闭嘴基线 + 视线落在候选人身上 + 间隔不一的轻微点头（≤2.4°）。
 *   thinking  → 每 4.7s 一次短暂侧头 + 视线抬起偏左，其余时间几乎不动。
 *   speaking  → 以闭嘴为基线，嘴型只由 lipLevelRef 的振幅驱动 + 极轻前倾/头部动作。
 * 所有波形都是 t 的确定性函数（无随机数）：同 t 同参数，单测可断言。
 */
const HR_LIVE2D_PERFORMANCE_MODEL = '大肥鱼.model3.json'
const HR_LIVE2D_PERFORMANCE_STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking'])
/** 嘴张到 0.9 就够：1.0 会让下唇顶到牙齿，看起来像在喊而不是在说话。 */
const HR_LIVE2D_LIP_MAX = 0.9

const HR_LIVE2D_PERF_PARAMS = Object.freeze({
  mouthOpenY: Object.freeze({ id: 'ParamMouthOpenY', min: 0, max: 1, def: 0 }),
  mouthForm: Object.freeze({ id: 'ParamMouthForm', min: -1, max: 1, def: 0 }),
  angleX: Object.freeze({ id: 'ParamAngleX', min: -30, max: 30, def: 0 }),
  angleY: Object.freeze({ id: 'ParamAngleY', min: -30, max: 30, def: 0 }),
  angleZ: Object.freeze({ id: 'ParamAngleZ', min: -30, max: 30, def: 0 }),
  bodyAngleX: Object.freeze({ id: 'ParamBodyAngleX', min: -30, max: 30, def: 0 }),
  eyeBallX: Object.freeze({ id: 'ParamEyeBallX', min: -1, max: 1, def: 0 }),
  eyeBallY: Object.freeze({ id: 'ParamEyeBallY', min: -1, max: 1, def: 0 }),
})

const HR_LIVE2D_PRESSURE_BROWS = Object.freeze({
  browLeft: { id: 'ParamBrowLY', min: -1, max: 1 },
  browRight: { id: 'ParamBrowRY', min: -1, max: 1 },
})
const HR_LIVE2D_PRESSURE_POSES = Object.freeze({
  firm: { mouthForm: -0.15, angleY: 1.8, eyeBallX: 0.10, browLeft: -0.29, browRight: -0.29 },
  pause: { mouthForm: -0.20, angleY: -3.1, eyeBallY: -0.16, browLeft: -0.26, browRight: -0.26 },
  questioning: { mouthForm: -0.1, angleZ: 4, eyeBallX: 0.16, browLeft: 0.36, browRight: -0.1 },
  sigh: { mouthForm: -0.13, angleY: -3.2, eyeBallY: -0.18, browLeft: -0.24, browRight: -0.24 },
})
const hrLive2dPerformanceSpec = (key) => HR_LIVE2D_PERF_PARAMS[key] || HR_LIVE2D_PRESSURE_BROWS[key]

/** 模型名精确相等才表演：与鼻部补丁同一套判断口径。 */
function hrLive2dPerformanceApplies(model) {
  return String(model == null ? '' : model) === HR_LIVE2D_PERFORMANCE_MODEL
}

/** 未知/空/大小写不一的 state 一律回落到 idle —— 回退方向必须是「不做动作」。 */
function hrLive2dPerformanceState(state) {
  const text = String(state == null ? '' : state).trim().toLowerCase()
  return HR_LIVE2D_PERFORMANCE_STATES.indexOf(text) >= 0 ? text : 'idle'
}

/** lipLevel 只认 0..1 的有限数：undefined / NaN / 负数 / 字符串 / 对象一律当闭嘴。 */
function hrLive2dClampLip(value) {
  let num = NaN
  try { num = Number(value) } catch { return 0 }
  if (!Number.isFinite(num) || num <= 0) return 0
  return num >= 1 ? 1 : num
}

/**
 * 「间隔不一」的单次脉冲（纯函数）：时间切成 period 长的片，每片的起点与幅度都按
 * 片号漂移 —— 于是点头/侧头的间隔一会长一会短，不会像节拍器那样准点。
 *   jitter：片内起点相对片中的摆动（0 = 每片准点；0.1 = 间隔在 ±10% 内不齐）。
 *   floor ：这一拍的最小幅度（越小越"轻描淡写"，避免每次都是同一记重点头）。
 * 返回 0..1：0 = 不动，1 = 这一拍的最大幅度。
 */
function hrLive2dSparsePulse(t, period, window = 0.3, jitter = 0, floor = 0.6) {
  const seconds = Number.isFinite(t) && t > 0 ? t : 0
  const span = hrLive2dPositive(period, 1)
  const slice = Math.floor(seconds / span)
  const drift = (Math.sin(slice * 1.7) + 1) / 2 // 0..1，按片号伪随机，但完全确定
  const swing = hrLive2dClampNumber(jitter, 0, 0.45)
  const offset = span * (0.5 + (drift - 0.5) * swing)
  const width = span * hrLive2dClampNumber(window, 0.05, 0.9)
  const local = seconds - slice * span - offset
  if (local < 0 || local >= width) return 0
  const low = hrLive2dClampNumber(floor, 0, 1)
  const amplitude = low + (1 - low) * ((Math.sin(slice * 2.3 + 1.1) + 1) / 2)
  return Math.sin((Math.PI * local) / width) ** 2 * amplitude
}

/**
 * 纯表演函数：给 state / t（秒）/ lipLevel，返回这一帧该写的参数值。
 * idle 返回 active:false + 空 values —— 调用方据此「什么都不写」。
 */
function hrLive2dPerformanceParams(input = {}) {
  const state = hrLive2dPerformanceState(input.state)
  const t = Number.isFinite(input.t) && input.t > 0 ? input.t : 0
  const lip = hrLive2dClampLip(input.lipLevel)
  if (state === 'idle') return { state, active: false, values: {} }
  const values = {}
  if (state === 'listening') {
    // 闭嘴听 + 视线轻轻落在（右屏的）候选人身上，而不是盯着镜头 + 七八秒才轻点一下头
    const nod = hrLive2dSparsePulse(t, 7.6, 0.24, 0.1, 0.85)
    values.mouthOpenY = 0
    values.mouthForm = -0.06 // 略微收紧：听的时候不该是笑嘴
    values.angleY = -1.8 * nod
    values.angleX = 0.5 * Math.sin(t * 0.21)
    values.angleZ = 0.4 * Math.sin(t * 0.17)
    values.bodyAngleX = 0
    values.eyeBallX = 0.12 + 0.03 * Math.sin(t * 0.13) // 极轻地偏向候选人那一侧
    values.eyeBallY = 0.04
  } else if (state === 'thinking') {
    // 短暂侧头 + 视线抬起偏左：一拍进来，一拍退回去，中间只剩 ±0.12° 的慢漂移
    const beat = hrLive2dSparsePulse(t, 4.7, 0.34, 0.12)
    values.mouthOpenY = 0
    values.mouthForm = -0.1
    values.angleZ = 3.1 * beat + 0.12 * Math.sin(t * 0.061)
    values.angleY = 1.2 * beat + 0.12 * Math.sin(t * 0.043)
    values.angleX = -1.1 * beat
    values.bodyAngleX = 0
    values.eyeBallX = -0.3 * beat
    values.eyeBallY = 0.34 * beat
  } else {
    // speaking：嘴型 = lipLevelRef 的振幅；头只是极轻地跟着句子晃，前倾不超过 1.6°；
    // 眼睛不锁死 —— 每隔两秒来一次很小的扫视（左右交替），点头平均五六秒一次、≤0.8°。
    const nod = hrLive2dSparsePulse(t, 5.5, 0.22, 0.12, 0.85)
    const saccadeCell = Math.floor(t / 2.35)
    const saccade = hrLive2dSparsePulse(t, 2.35, 0.1, 0.5, 0.7) * (saccadeCell % 2 === 0 ? 1 : -1)
    values.mouthOpenY = HR_LIVE2D_LIP_MAX * lip
    values.mouthForm = -0.05
    values.angleX = 0.6 * Math.sin(t * 0.29)
    values.angleY = 0.5 * Math.sin(t * 0.23) - 0.8 * nod
    values.angleZ = 0.8 * Math.sin(t * 0.37)
    values.bodyAngleX = 1.1 + 0.5 * Math.sin(t * 0.5)
    values.eyeBallX = 0.06 * saccade
    values.eyeBallY = 0.02 + 0.02 * saccade
  }
  const pose = state === 'speaking' && Object.prototype.hasOwnProperty.call(HR_LIVE2D_PRESSURE_POSES, input.pressureReaction)
    ? HR_LIVE2D_PRESSURE_POSES[input.pressureReaction] : null
  const reactionAge = Number(input.reactionAge) || 0
  const fade = hrLive2dClampNumber((1.5 - reactionAge) / 0.7, 0, 1)
  const weight = pose ? hrLive2dClampNumber(reactionAge / 0.13, 0, 1) * (input.pressureReaction === 'firm' ? Math.max(0.5, fade) : fade) : 0
  if (weight > 0) {
    for (const [key, offset] of Object.entries(pose)) values[key] = (values[key] || 0) + offset * weight
  }
  for (const key of Object.keys(values)) {
    const spec = hrLive2dPerformanceSpec(key)
    values[key] = spec ? hrLive2dClampNumber(values[key], spec.min, spec.max) : 0
  }
  return { state, active: true, values, pressureBrows: weight > 0 }
}

/** 离开表演状态时每个写过的参数回到 def（=0），把主动权还给原模型的呼吸/眨眼。 */
function hrLive2dPerformanceResetValues() {
  const values = {}
  for (const key of Object.keys(HR_LIVE2D_PERF_PARAMS)) values[key] = HR_LIVE2D_PERF_PARAMS[key].def
  return values
}

/**
 * 参数宿主：CubismModel 上有 setParameterValueById；真正的 parameterIds / parameterValues
 * 在 `_model` 上（0.4.0 的 cubism4 构建如此）。任一层缺失都只是「这次写不进去」。
 */
function hrLive2dParamHosts(model) {
  const core = model && model.internalModel && model.internalModel.coreModel
  if (!core) return null
  const inner = core._model || core
  if (!inner) return null
  const ids = inner.parameterIds || inner._parameterIds || null
  const values = inner.parameterValues || inner._parameterValues || null
  return { core, inner, ids, values }
}

/** 在 parameterIds 里按 ID 找下标（数组 / csmVector 两种形状都认）。 */
function hrLive2dParamIndex(host, id) {
  if (!host.ids || !host.values) return -1
  let list = []
  try {
    list = Array.from(host.ids)
  } catch {
    list = [] // 不可迭代（原生 csmVector）→ 交给下面的 vector 接口
  }
  if (list.length === 0 && typeof host.ids.getSize === 'function' && typeof host.ids.at === 'function') {
    try {
      const size = Number(host.ids.getSize()) || 0
      for (let index = 0; index < size; index += 1) list.push(host.ids.at(index))
    } catch {
      return -1
    }
  }
  const index = list.indexOf(String(id))
  if (index < 0) return -1
  const length = Number(host.values.length)
  if (Number.isFinite(length) && index >= length) return -1
  return index
}

/** 写一个参数：绝对写（不累加），官方 setter 优先，退化到索引写；失败返回 false。 */
function hrLive2dWriteParameter(host, id, value) {
  if (!host) return false
  const setter = typeof host.core.setParameterValueById === 'function'
    ? host.core
    : (typeof host.inner.setParameterValueById === 'function' ? host.inner : null)
  if (setter) {
    try {
      setter.setParameterValueById(id, value)
      return true
    } catch { /* 签名不同的实现 → 退化到索引写 */ }
  }
  const index = hrLive2dParamIndex(host, id)
  if (index < 0) return false
  try {
    host.values[index] = value
    return true
  } catch {
    return false
  }
}

/** 按帧值写参数，夹到真实范围；返回真正写进去的条数（0 = 这个模型没有这些参数）。 */
function hrLive2dApplyPerformance(model, values) {
  if (!values) return 0
  const host = hrLive2dParamHosts(model)
  if (!host) return 0
  let written = 0
  for (const key of Object.keys(values)) {
    const spec = hrLive2dPerformanceSpec(key)
    if (!spec) continue
    if (hrLive2dWriteParameter(host, spec.id, hrLive2dClampNumber(values[key], spec.min, spec.max))) written += 1
  }
  return written
}

/**
 * 读通道（每帧一次）：state 来自 props，嘴型来自 lipLevelRef.current ——
 * 不经过 React re-render，所以 TTS 把 0..1 的振幅写进 ref 就能直接驱动嘴。
 */
function hrLive2dPerformanceFrame(stage, elapsedMs) {
  const perf = stage && stage.performance
  if (!perf || !perf.enabled) return null
  const channel = perf.channel || {}
  const lipRef = channel.lipLevelRef
  const lipLevel = lipRef && typeof lipRef === 'object' ? lipRef.current : 0
  const seconds = Math.max(0, Number(elapsedMs) || 0) / 1000
  if (channel.pressureReaction !== perf.pressureReaction) {
    perf.pressureReaction = channel.pressureReaction
    perf.reactionStarted = seconds
  }
  const frame = hrLive2dPerformanceParams({ state: channel.state, t: seconds, lipLevel,
    pressureReaction: perf.pressureReaction, reactionAge: seconds - (perf.reactionStarted || 0) })
  perf.state = frame.state
  perf.lipLevel = hrLive2dClampLip(lipLevel)
  return frame
}

/** 把一帧写进模型；idle 只在「刚离开表演状态」时复位一次，之后彻底不碰参数。 */
function hrLive2dPerformanceApply(stage, model, frame) {
  const perf = stage && stage.performance
  if (!perf || !frame) return 0
  if (perf.pressureBrows && !frame.pressureBrows) hrLive2dApplyPerformance(model, { browLeft: 0, browRight: 0 })
  perf.pressureBrows = frame.pressureBrows
  if (frame.active) {
    const written = hrLive2dApplyPerformance(model, frame.values)
    if (written > 0) perf.applied = true
    return written
  }
  if (perf.applied) {
    hrLive2dApplyPerformance(model, hrLive2dPerformanceResetValues())
    perf.applied = false
  }
  return 0
}

function hrLive2dSetPressureExpression(stage, name) {
  if ((stage.pressureExpression || '') === name) return
  stage.pressureExpression = name
  const manager = stage.model?.internalModel?.motionManager?.expressionManager
  if (!manager) return
  // pixi-live2d-display 0.4.0 keeps a pending request and the last expression
  // after resetExpression(). Clear both so an interrupted load cannot start late
  // and the same expression can be replayed on the next turn.
  manager.reserveExpressionIndex = -1
  manager.currentExpression = manager.defaultExpression
  manager.stopAllExpressions()
  if (name) void stage.model.expression(name).catch(() => {})
}

function hrLive2dPressureExpressionFrame(stage, stamp) {
  const channel = stage.performance.channel
  const gesture = channel?.pressureGesture === 'black-face' || channel?.state === 'speaking' ? channel.pressureGesture : ''
  if (gesture !== stage.pressureGesture) {
    stage.pressureGesture = gesture
    stage.pressureGestureStarted = stamp
  }
  const withinBeat = stamp - stage.pressureGestureStarted < 1050
  const name = gesture === 'black-face' || (gesture === 'doubt' && withinBeat) ? gesture : ''
  hrLive2dSetPressureExpression(stage, name)
}

/** 幂等销毁：RAF → 监听/观察器 → model → app → canvas，运行时全局一律保留。 */
function hrLive2dTeardown(stage) {
  if (stage.destroyed) return
  stage.destroyed = true
  const win = stage.window
  if (typeof stage.frame === 'number' && stage.frame !== 0) {
    try {
      if (win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(stage.frame)
      else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(stage.frame)
    } catch { /* 已经释放的窗口不再处理 */ }
    stage.frame = 0
  }
  if (stage.observer && typeof stage.observer.disconnect === 'function') {
    try { stage.observer.disconnect() } catch { /* 同上 */ }
  }
  stage.observer = null
  if (stage.model) {
    hrLive2dSetPressureExpression(stage, '')
    const model = stage.model
    stage.model = null
    try { model.autoUpdate = false } catch { /* 未初始化完就失败时可能抛 */ }
    try { model.destroy({ children: true }) } catch { /* 销毁失败不该再拖住卸载 */ }
  }
  if (stage.app) {
    const app = stage.app
    stage.app = null
    try { app.destroy(true, { children: true }) } catch { /* 同上 */ }
  }
  const canvas = stage.canvas
  stage.canvas = null
  if (canvas && canvas.parentNode) {
    try { canvas.parentNode.removeChild(canvas) } catch { /* 同上 */ }
  }
}

/**
 * 建一个舞台：先等运行时就绪，再建 PIXI app + Live2DModel，最后用自己的 RAF 驱动。
 * 返回对象立即可用（destroy() 同步可调），promise 表示「模型真的显示出来了」。
 */
function hrLive2dCreateStage(config) {
  const host = config && config.host ? config.host : null
  const win = (config && config.window) || (typeof window === 'undefined' ? null : window)
  const doc = (config && config.document) || (host && host.ownerDocument) || (win && win.document) || null
  // fill：舞台模式（面试页左半大画面）。初始尺寸直接取容器，不夹在 160–220 的卡片区间里。
  const fill = Boolean(config && config.fill)
  const avatar = (config && config.avatar) || {}
  const stage = {
    host, window: win, document: doc, fill,
    size: hrLive2dClampSize(config && config.size),
    destroyed: false, ready: false, error: null,
    app: null, model: null, canvas: null, observer: null, frame: 0,
    framing: null,
    // 表演通道：enabled 只由模型名决定（非大肥鱼一律 false，那些模型的 update/render
    // 行为和加表演之前完全一样）。channel 是组件那边一个稳定对象，每帧读它的 state /
    // lipLevelRef.current，不触发 React 重渲染。
    performance: {
      enabled: hrLive2dPerformanceApplies(avatar.model),
      channel: (config && config.performance) || null,
      state: 'idle',
      lipLevel: 0,
      applied: false,
      writes: 0,
    },
  }
  stage.destroy = () => hrLive2dTeardown(stage)
  const performanceEnabled = stage.performance.enabled
  stage.promise = (async () => {
    if (!host || typeof host.appendChild !== 'function') throw new Error('Live2D 挂载点不可用')
    if (!doc) throw new Error('当前环境没有 document，无法加载 Live2D')
    // 运行时脚本先按序就位（只加载一次），失败会在这里 reject 并被组件回退。
    await hrLive2dLoadRuntime(doc, avatar.runtimeBase, (config && config.runtime) || {})
    if (stage.destroyed) throw new Error('Live2D 舞台已释放')
    const { PIXI, core } = hrLive2dResolveGlobals({ ...(config || {}), window: win })
    if (!PIXI) throw new Error('PIXI 运行时尚未就绪')
    if (!core) throw new Error('Live2DCubismCore 尚未就绪')
    const namespace = hrLive2dNamespace(PIXI)
    const Live2DModel = namespace && namespace.Live2DModel
    if (!Live2DModel || typeof Live2DModel.from !== 'function') throw new Error('pixi-live2d-display 尚未就绪')
    const usePressureExpressions = Boolean(config.pressureMode && performanceEnabled)
    const modelUrl = hrLive2dModelUrl(avatar.base, avatar.model)
    const url = usePressureExpressions ? `${modelUrl}?pressure-expressions=1` : modelUrl
    const canvas = doc.createElement('canvas')
    canvas.className = 'hri-live2d-canvas'
    // fill 时首帧就按容器尺寸建渲染器：否则大屏会先出一张 190px 的糊图再被 ResizeObserver 纠正。
    const initialWidth = fill ? Math.max(1, Math.round(Number(host.clientWidth) || stage.size)) : stage.size
    const initialHeight = fill ? Math.max(1, Math.round(Number(host.clientHeight) || stage.size)) : stage.size
    const app = new PIXI.Application({
      view: canvas,
      width: initialWidth,
      height: initialHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, Number(win && win.devicePixelRatio) || 1),
      autoStart: false,
    })
    stage.app = app
    stage.canvas = canvas
    if (stage.destroyed) throw new Error('Live2D 舞台已释放')
    host.appendChild(canvas)
    // autoInteract=false：禁止点击视线跟踪；autoUpdate=false：由本舞台自己的 RAF 驱动，
    // 这样卸载时一帧都不会再跑。
    const model = await Live2DModel.from(url, { autoInteract: false, autoUpdate: false })
    if (stage.destroyed) {
      // 卸载发生在模型异步下载期间：teardown 已幂等结束，必须单独释放晚到的 model。
      try { model.autoUpdate = false } catch { /* 未完整初始化时忽略 */ }
      try { model.destroy({ children: true }) } catch { /* 已释放的实现忽略 */ }
      throw new Error('Live2D 舞台已释放')
    }
    stage.model = model
    try { if (model.autoUpdate !== false) model.autoUpdate = false } catch { /* 老版本没有该 setter 时忽略 */ }
    model.anchor.set(0.5, 0.5)
    app.stage.addChild(model)
    hrLive2dFit(stage)
    // 鼻部黑块补丁：只在模型就绪后按 ID 解析一次索引；结构还没就绪时留几帧重试机会。
    let nosePatch = hrLive2dNosePatchApplies(avatar.model) ? hrLive2dNosePatchIndices(model) : []
    let nosePatchTries = 0
    let nosePatchPending = hrLive2dNosePatchApplies(avatar.model) && nosePatch.length === 0
    const Observer = win && win.ResizeObserver
    if (typeof Observer === 'function') {
      stage.observer = new Observer(() => hrLive2dFit(stage))
      if (typeof stage.observer.observe === 'function') stage.observer.observe(host)
    }
    let last = 0
    const tick = (now) => {
      if (stage.destroyed) return
      const stamp = Number(now) || 0
      // 切后台回来时 delta 可能是几十秒，钳到 64ms，否则物理/眨眼会瞬移。
      const delta = last ? Math.min(64, stamp - last) : 16.6
      last = stamp
      stage.frame = typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame(tick)
        : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tick) : 0)
      try {
        // 顺序不可调换：update 累加 deltaTime → 表演写参 → 手动推进一帧并清零 → 再写一遍
        // → 压 opacity → render。少了「清零」那步，render 内部的 _render 会再 update 一次，
        // 把 opacity 重算回 1（黑块照旧），表演参数也会被呼吸/物理改写。
        // 两遍写参都是绝对写，不会叠加；第一遍让本帧的形变用上，第二遍压掉 update 里的覆盖。
        model.update(delta)
        if (nosePatchPending && nosePatchTries < 3) {
          nosePatchTries += 1
          nosePatch = hrLive2dNosePatchIndices(model)
          nosePatchPending = nosePatch.length === 0
        }
        const performanceFrame = performanceEnabled ? hrLive2dPerformanceFrame(stage, stamp) : null
        if (usePressureExpressions) hrLive2dPressureExpressionFrame(stage, stamp)
        if (performanceFrame) stage.performance.writes += hrLive2dPerformanceApply(stage, model, performanceFrame)
        // 大肥鱼即使还没解析出鼻部索引也要推进：否则 render 里那次 update 会把表演参数冲掉。
        if (performanceEnabled || nosePatch.length > 0) hrLive2dAdvanceFrame(model)
        if (performanceFrame) stage.performance.writes += hrLive2dPerformanceApply(stage, model, performanceFrame)
        hrLive2dHideNoseDrawables(model, nosePatch)
        app.renderer.render(app.stage)
      } catch (error) {
        stage.error = error
        hrLive2dTeardown(stage)
      }
    }
    if (typeof win.requestAnimationFrame === 'function') stage.frame = win.requestAnimationFrame(tick)
    else if (typeof requestAnimationFrame === 'function') stage.frame = requestAnimationFrame(tick)
    stage.ready = true
    return model
  })().catch((error) => {
    stage.error = error
    stage.ready = false
    hrLive2dTeardown(stage)
    throw error
  })
  return stage
}

/**
 * React 组件工厂：显式接 React，避免依赖 client.js 里的 h/useState。
 *
 * 表演契约（与面试页/UI 的固定接口）：
 *   performanceState: 'idle' | 'listening' | 'thinking' | 'speaking'（默认 idle）
 *   lipLevelRef:     React ref，current 是 0..1 的数字（可空）
 * 两者都**不进**挂载依赖：状态切换只改一个稳定通道对象上的字段，舞台不重挂、不重建
 * PIXI/model，嘴型由 render tick 每帧读 lipLevelRef.current 得到。
 * speaking 仍然只管可访问文字（它在业务侧是「正在提问」的语义，不等于口型状态）。
 */
function hrLive2dComponent(React, options = {}) {
  if (!React || typeof React.createElement !== 'function') throw new TypeError('Live2D 组件需要 React')
  const h = React.createElement
  const useEffect = React.useEffect
  const useRef = React.useRef
  const useState = React.useState
  const mountStage = typeof options.createStage === 'function' ? options.createStage : hrLive2dCreateStage
  return function Live2DAvatar({
    avatar = null,
    speaking = false,
    size = 190,
    fill = false,
    performanceState = 'idle',
    lipLevelRef = null,
    pressureReaction = '',
    pressureMode = false,
    pressureGesture = '',
  }) {
    const hostRef = useRef(null)
    const [phase, setPhase] = useState('loading')
    const [reason, setReason] = useState('')
    const base = avatar ? String(avatar.base || '') : ''
    const model = avatar ? String(avatar.model || '') : ''
    const runtimeBase = avatar ? String(avatar.runtimeBase || '') : ''
    // 稳定通道：对象一经创建就不再换身份，每次渲染只改它的字段 —— 所以下面那个
    // 挂载 effect 的依赖里永远不需要出现 performanceState / lipLevelRef。
    const channelRef = useRef(null)
    if (!channelRef.current) channelRef.current = { state: 'idle', lipLevelRef: null }
    channelRef.current.state = performanceState
    channelRef.current.lipLevelRef = lipLevelRef
    channelRef.current.pressureReaction = pressureReaction
    channelRef.current.pressureGesture = pressureGesture
    useEffect(() => {
      const node = hostRef.current
      if (!node) return undefined
      let live = true
      setPhase('loading')
      setReason('')
      const stage = mountStage({
        host: node,
        avatar: { base, model, runtimeBase },
        size,
        fill,
        performance: channelRef.current,
        pressureMode,
      })
      stage.promise.then(
        () => { if (live && !stage.destroyed) setPhase('ready') },
        (error) => {
          if (!live) return
          setReason(String((error && error.message) || error || 'Live2D 加载失败'))
          setPhase('failed')
        },
      )
      return () => { live = false; stage.destroy() }
    }, [base, model, runtimeBase, size, fill, pressureMode])
    const dimension = hrLive2dClampSize(size)
    const caption = phase === 'ready' ? (speaking ? 'HR 正在提问' : '待机中') : phase === 'failed' ? '加载失败，已回退静态头像' : '加载中'
    // fill：铺满父容器（面试页左半舞台），不再带 160–220px 的卡片边框；比例由 hrLive2dFit 保证。
    const box = fill
      ? { position: 'absolute', inset: 0, width: '100%', height: '100%', flex: '1 1 auto', borderRadius: 0, overflow: 'hidden', background: 'transparent', border: 0 }
      : {
        position: 'relative',
        width: `min(100%, ${dimension}px)`,
        aspectRatio: '1',
        flex: '0 0 auto',
        borderRadius: 12,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1, #f8fafc)',
        border: '1px solid var(--dsw-alias-border-l1, #d0d5dd)',
      }
    // 舞台模式还没就绪时先摆一个真实的静态 HR 圆：加载中半透明，失败不透明。
    // 就绪后这一层整个消失 —— 模型画面上不留任何水印。
    const stageRing = fill && phase !== 'ready'
      ? h('div', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', display: 'grid', placeItems: 'center',
          opacity: phase === 'failed' ? 1 : 0.45, transition: 'opacity 160ms ease-out',
        },
      }, h('span', {
        style: {
          width: 120, height: 120, borderRadius: '50%', display: 'grid', placeItems: 'center',
          background: 'var(--dsw-alias-bg-layer-1, #f8fafc)', color: 'var(--dsw-alias-label-link, #175cd3)',
          border: '1px solid var(--dsw-alias-border-l1, #d0d5dd)', fontWeight: 700, fontSize: 34,
        },
      }, 'HR'))
      : null
    const statusStyle = fill
      ? { position: 'absolute', inset: 0, zIndex: 2, display: 'grid', justifyItems: 'center', alignContent: 'end', paddingBottom: 18, textAlign: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #667085)' }
      : { position: 'absolute', inset: 0, zIndex: 2, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #667085)' }
    return h('div', {
      className: fill ? 'hri-live2d hri-live2d-fill' : 'hri-live2d',
      role: 'img',
      'aria-label': `Live2D 面试官形象：${caption}`,
      title: phase === 'failed' && reason ? reason : undefined,
      style: box,
    },
      h('div', { ref: hostRef, className: 'hri-live2d-host', style: { position: 'absolute', inset: 0 } }),
      stageRing,
      phase !== 'ready' && h('div', {
        className: 'hri-live2d-status',
        style: statusStyle,
      }, phase === 'failed' ? '形象未加载，已用静态头像' : 'Live2D 加载中…'),
    )
  }
}

// 单测（node:vm）从这里取函数；构建内联时这个 module 就是 client.js 的模块对象，
// 随后会被 client.js 末尾的 module.exports = { apply, inject } 覆盖，不会外泄。
if (typeof module === 'object' && module && module.exports) {
  Object.assign(module.exports, {
    HR_LIVE2D_RUNTIME_FILES,
    HR_LIVE2D_NOSE_PATCH_MODEL,
    HR_LIVE2D_NOSE_PATCH_DRAWABLES,
    HR_LIVE2D_CLOSEUP_FRACTION,
    HR_LIVE2D_CLOSEUP_TOP_INSET,
    HR_LIVE2D_CLOSEUP_MAX_CROP,
    HR_LIVE2D_PERFORMANCE_MODEL,
    HR_LIVE2D_PERFORMANCE_STATES,
    HR_LIVE2D_PERF_PARAMS,
    hrLive2dClampSize,
    hrLive2dRuntimeUrls,
    hrLive2dModelUrl,
    hrLive2dLoadRuntime,
    hrLive2dCreateStage,
    hrLive2dFit,
    hrLive2dFraming,
    hrLive2dTeardown,
    hrLive2dComponent,
    hrLive2dNosePatchApplies,
    hrLive2dNosePatchIndices,
    hrLive2dHideNoseDrawables,
    hrLive2dAdvanceFrame,
    hrLive2dPerformanceApplies,
    hrLive2dPerformanceState,
    hrLive2dClampLip,
    hrLive2dSparsePulse,
    hrLive2dPerformanceParams,
    hrLive2dPerformanceResetValues,
    hrLive2dApplyPerformance,
  })
}
