/**
 * Live2D 阶段 0 资源路由。
 *
 * 两个独立资源：
 *  1) 模型资源 createAvatarResource：只放行「模型入口 + 该入口 FileReferences 里登记过的文件」，
 *     不做扩展名白名单（PSD、vtube/vbridger/items_pinned 等目录即使存在也一律拒绝）。
 *  2) 运行时资源 createAvatarRuntimeResource：只放行 vendor 下固定三个运行时 JS，
 *     license 与任意其它文件都不出。
 *  3) 背景资源 createBackgroundResource：只放行 assets/backgrounds 下两个顶层 WebP
 *     （office / meeting-room）；SOURCE.md、目录穿越与任意其它文件一律不出。
 *
 * 用法（与 DSH webServer 路由描述符对齐）：
 *
 *   const resource = createAvatarResource({ root: modelDir })
 *   // { kind: 'prefix', path: '/hr-avatar', handler: toNodeHandler(resource) }
 *   const route = createAvatarRoute({ root: modelDir })
 *
 *   const runtime = createAvatarRuntimeRoute()            // 默认插件 lib/vendor
 *   // { kind: 'prefix', path: '/hr-runtime', handler: toNodeHandler(runtime) }
 *
 *   const backgrounds = createBackgroundResource({ root: backgroundDir })
 *   // { kind: 'prefix', path: '/hr-background', handler: toNodeHandler(backgrounds) }
 *
 * resource 是 `(request: Request) => Promise<Response>`，兼容 Node 22 标准 Request/Response；
 * 模型与运行时文件都以流式 body 返回（createReadStream + Readable.toWeb），HEAD 不带 body。
 * 需要挂到只接受 (req, res) 的 WebRoute 时用 toNodeHandler(resource) 包一层。
 */
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

export const AVATAR_PREFIX = '/hr-avatar'
export const DEFAULT_ENTRY = '大肥鱼.model3.json'

export const RUNTIME_PREFIX = '/hr-runtime'
export const RUNTIME_CONTENT_TYPE = 'text/javascript; charset=utf-8'
const CUBISM_CORE = 'live2dcubismcore-1.0.2.min.js'

/** vendor 里只允许这三个文件按名放行，顺序即白名单本身。 */
export const RUNTIME_FILES = Object.freeze([
  'pixi-6.5.10.min.js',
  CUBISM_CORE,
  'pixi-live2d-display-cubism4-0.4.0.min.js',
])

export const BACKGROUND_PREFIX = '/hr-background'
export const BACKGROUND_CONTENT_TYPE = 'image/webp'

/**
 * 背景白名单本身就是发布契约：只有这两个顶层 WebP 可以出，id / label / 文件名都写死。
 * url 在 describe() 里按实际 prefix 拼，避免 capability 里出现宿主机绝对路径。
 */
export const BACKGROUND_FILES = Object.freeze([
  Object.freeze({ id: 'office', file: 'office.webp', label: '现代办公室' }),
  Object.freeze({ id: 'meeting-room', file: 'meeting-room.webp', label: '会议室' }),
])

const BACKGROUND_SET = new Set(BACKGROUND_FILES.map((item) => item.file))

/** 默认 vendor 目录：本模块同级的 lib/vendor。 */
const DEFAULT_RUNTIME_ROOT = fileURLToPath(new URL('./vendor/', import.meta.url))

/** 固定放行的待机动作；模型里没有就自动跳过。 */
const IDLE_MOTION = 'Animation/IDLE.motion3.json'
const PRESSURE_EXPRESSIONS = [
  { Name: 'doubt', File: 'Exp3/屑屑眼.exp3.json' },
  { Name: 'black-face', File: 'Exp3/黑脸.exp3.json' },
]

/** model3 里允许登记为资源的 FileReferences 字段。 */
const REFERENCE_KEYS = ['Moc', 'Physics', 'DisplayInfo']

const RUNTIME_SET = new Set(RUNTIME_FILES)

const encoder = new TextEncoder()

function normalizePrefix(value) {
  const text = String(value || '').trim()
  if (!text.startsWith('/')) throw new TypeError('avatar-route: prefix 必须以 / 开头')
  const trimmed = text.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * 把 model3 里写的相对路径规范成 `a/b/c` 形式；不可用的一律返回 null。
 * 只接受普通相对路径，绝对路径、盘符、空段、`.`、`..`、NUL 全部丢弃。
 */
function normalizeRelative(value) {
  if (typeof value !== 'string') return null
  const replaced = value.trim().replace(/\\/g, '/')
  if (replaced === '' || replaced.includes('\0')) return null
  if (replaced.startsWith('/') || /^[A-Za-z]:/.test(replaced)) return null
  const segments = replaced.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
  }
  return replaced.normalize('NFC')
}

function contentTypeOf(rel) {
  if (rel.endsWith('.moc3')) return 'application/octet-stream'
  if (rel.endsWith('.png')) return 'image/png'
  if (rel.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function textResponse(status, message, extra = {}) {
  const body = encoder.encode(`${message}\n`)
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
    'x-content-type-options': 'nosniff',
  }
  if (status === 405) headers.allow = 'GET, HEAD'
  return new Response(body, { status, headers: { ...headers, ...extra } })
}

function isInside(rootReal, target) {
  return target === rootReal || target.startsWith(rootReal + sep)
}

/** realpath + 前缀围栏；任何越界或非普通文件都视为不存在。 */
async function resolveInsideRoot(rootReal, rel) {
  const absolute = resolve(rootReal, ...rel.split('/'))
  if (!isInside(rootReal, absolute)) return null
  let real
  try {
    real = await realpath(absolute)
  } catch {
    return null
  }
  if (!isInside(rootReal, real)) return null
  try {
    const info = await stat(real)
    if (!info.isFile()) return null
    return { path: real, size: info.size }
  } catch {
    return null
  }
}

/**
 * 流式返回一个已通过围栏的文件：GET 走 createReadStream + Readable.toWeb，
 * HEAD 只给头部（含真实 Content-Length），不会把 16.5MB moc3 / 44MB 纹理读进内存。
 */
function fileResponse(target, contentType, method) {
  const headers = {
    'content-type': contentType,
    'content-length': String(target.size),
    'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=3600',
  }
  if (method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(Readable.toWeb(createReadStream(target.path)), { status: 200, headers })
}

/**
 * 解析 model3，建立精确相对路径集合。
 * available=false 表示模型入口缺失或不可解析，此时所有请求都当作 404。
 */
async function buildRegistry(root, entry) {
  const entryRel = normalizeRelative(entry)
  const empty = { available: false, files: new Set(), rootReal: null, reason: 'entry-invalid' }
  if (!entryRel) return empty

  let rootReal
  try {
    rootReal = await realpath(resolve(root))
    const info = await stat(rootReal)
    if (!info.isDirectory()) return empty
  } catch {
    return { ...empty, reason: 'root-missing' }
  }

  let document
  try {
    document = JSON.parse(await readFile(resolve(rootReal, ...entryRel.split('/')), 'utf8'))
  } catch {
    return { ...empty, rootReal, reason: 'entry-missing' }
  }

  const references = document && typeof document === 'object' ? document.FileReferences : null
  if (!references || typeof references !== 'object') return { ...empty, rootReal, reason: 'no-references' }

  const files = new Set([entryRel])
  const add = (value) => {
    const rel = normalizeRelative(value)
    if (rel) files.add(rel)
  }
  for (const key of REFERENCE_KEYS) add(references[key])
  if (Array.isArray(references.Textures)) for (const texture of references.Textures) add(texture)

  if (await resolveInsideRoot(rootReal, IDLE_MOTION)) files.add(IDLE_MOTION)

  let pressureModel = null
  if (entryRel === DEFAULT_ENTRY) {
    const expressions = []
    for (const expression of PRESSURE_EXPRESSIONS) {
      if (!await resolveInsideRoot(rootReal, expression.File)) continue
      files.add(expression.File)
      expressions.push(expression)
    }
    if (expressions.length) {
      pressureModel = encoder.encode(JSON.stringify({
        ...document,
        FileReferences: { ...references, Expressions: expressions },
      }))
    }
  }

  return { available: true, files, rootReal, reason: 'ok', pressureModel }
}

async function resolveRoot(root) {
  try {
    const rootReal = await realpath(resolve(root))
    const info = await stat(rootReal)
    return info.isDirectory() ? rootReal : null
  } catch {
    return null
  }
}

function decodeTail(tail) {
  try {
    return decodeURIComponent(tail)
  } catch {
    return null
  }
}

/** 拒绝路径绕过的统一判定：编码/未编码 slash、反斜杠、点段、绝对路径、盘符。 */
function rejectTail(tail) {
  if (tail === '') return 404
  if (tail.includes('\\')) return 403
  if (tail.includes('//')) return 403
  if (/%2f|%2F|%5c|%5C/i.test(tail)) return 403
  if (/(^|\/)\.\.?(\/|$)/.test(tail)) return 403
  const decoded = decodeTail(tail)
  if (decoded === null) return 400
  if (decoded.includes('\\') || decoded.includes('\0')) return 403
  if (decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded)) return 403
  const segments = decoded.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 403
  }
  return 0
}

/** 从 request.url 取出未规范化的路径部分，避免 URL 解析把 `..` 提前吃掉。 */
function rawPathOf(value) {
  const text = String(value || '')
  const cut = text.split('#')[0].split('?')[0]
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(cut)
    ? cut.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '')
    : cut
}

/**
 * 两个资源共用的路径拆解：前缀外 404，越界写法 400/403，命中则给出 NFC 相对路径。
 * @returns {{ status: number } | { rel: string }}
 */
function resolveRequestPath(request, prefix) {
  const path = rawPathOf(request?.url)
  const boundary = prefix === '/' ? '' : prefix
  if (path === boundary || path === `${boundary}/`) return { status: 404 }
  if (!path.startsWith(`${boundary}/`)) return { status: 404 }

  const tail = path.slice(boundary.length + 1)
  const rejection = rejectTail(tail)
  if (rejection) return { status: rejection }
  return { rel: decodeTail(tail).normalize('NFC') }
}

function methodAllowed(request) {
  const method = String(request?.method || 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD' ? method : null
}

export function createAvatarResource(options = {}) {
  const opts = typeof options === 'string' ? { root: options } : (options || {})
  const root = opts.root
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TypeError('avatar-route: 需要构造参数 root（模型根目录）')
  }
  const entry = typeof opts.entry === 'string' && opts.entry.trim() !== '' ? opts.entry.trim() : DEFAULT_ENTRY
  const prefix = normalizePrefix(opts.prefix || AVATAR_PREFIX)

  let registry = null
  const load = () => {
    if (!registry) registry = buildRegistry(root, entry)
    return registry
  }

  const resource = async function avatarResource(request) {
    const method = methodAllowed(request)
    if (!method) return textResponse(405, 'method not allowed')

    const parsed = resolveRequestPath(request, prefix)
    if (parsed.status) return textResponse(parsed.status, parsed.status === 403 ? 'forbidden' : parsed.status === 400 ? 'bad request' : 'not found')
    const rel = parsed.rel

    const state = await load()
    if (!state.available) return textResponse(404, 'not found')

    if (!state.files.has(rel)) {
      // 大小写变体在 Windows 上仍然能打开真实文件，这里主动挡住。
      const lowered = rel.toLowerCase()
      for (const known of state.files) {
        if (known.toLowerCase() === lowered) return textResponse(403, 'forbidden')
      }
      return textResponse(403, 'forbidden')
    }

    const target = await resolveInsideRoot(state.rootReal, rel)
    if (!target) return textResponse(404, 'not found')
    if (rel === DEFAULT_ENTRY && state.pressureModel && request.url.split('?')[1] === 'pressure-expressions=1') {
      return new Response(method === 'HEAD' ? null : state.pressureModel, { headers: {
        'content-type': contentTypeOf(rel),
        'content-length': String(state.pressureModel.byteLength),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-cache',
      } })
    }
    return fileResponse(target, contentTypeOf(rel), method)
  }

  resource.prefix = prefix
  resource.root = root
  resource.entry = entry
  resource.warmup = () => load()
  resource.reset = () => { registry = null }
  resource.describe = async () => {
    const state = await load()
    return {
      root,
      entry,
      prefix,
      available: state.available,
      reason: state.reason,
      files: [...state.files],
    }
  }
  return resource
}

/** 直接给 webServer.register 用的路由描述符（模型资源，契约保持不变）。 */
export function createAvatarRoute(options = {}) {
  const resource = createAvatarResource(options)
  return { kind: 'prefix', path: resource.prefix, resource, handler: resource }
}

/**
 * 运行时资源：只放行 vendor 下固定三个 JS，license / map / 任意其它文件都不出。
 * root 默认指向本模块同级的 lib/vendor。
 */
export function createAvatarRuntimeResource(options = {}) {
  const opts = typeof options === 'string' ? { root: options } : (options || {})
  const root = typeof opts.root === 'string' && opts.root.trim() !== '' ? opts.root.trim() : DEFAULT_RUNTIME_ROOT
  const prefix = normalizePrefix(opts.prefix || RUNTIME_PREFIX)

  let rootPromise = null
  const load = () => {
    if (!rootPromise) rootPromise = resolveRoot(root)
    return rootPromise
  }
  const runtimeFile = async (name) => {
    if (name === CUBISM_CORE && typeof opts.coreFile === 'string' && isAbsolute(opts.coreFile) && basename(opts.coreFile).endsWith('.js')) {
      const dir = await resolveRoot(dirname(opts.coreFile))
      return dir ? resolveInsideRoot(dir, basename(opts.coreFile)) : null
    }
    const dir = await load()
    return dir ? resolveInsideRoot(dir, name) : null
  }

  const resource = async function avatarRuntimeResource(request) {
    const method = methodAllowed(request)
    if (!method) return textResponse(405, 'method not allowed')

    const parsed = resolveRequestPath(request, prefix)
    if (parsed.status) return textResponse(parsed.status, parsed.status === 403 ? 'forbidden' : parsed.status === 400 ? 'bad request' : 'not found')
    const rel = parsed.rel

    // 固定三个顶层文件：子目录、别的名字、大小写变体一律拒绝。
    if (rel.includes('/') || !RUNTIME_SET.has(rel)) return textResponse(403, 'forbidden')

    const target = await runtimeFile(rel)
    if (!target) return textResponse(404, 'not found')
    return fileResponse(target, RUNTIME_CONTENT_TYPE, method)
  }

  resource.prefix = prefix
  resource.root = root
  resource.files = [...RUNTIME_FILES]
  resource.warmup = () => load()
  resource.reset = () => { rootPromise = null }
  resource.describe = async () => ({
    root,
    prefix,
    available: (await Promise.all(RUNTIME_FILES.map(runtimeFile))).every(Boolean),
    files: [...RUNTIME_FILES],
  })
  return resource
}

/** 直接给 webServer.register 用的运行时路由描述符。 */
export function createAvatarRuntimeRoute(options = {}) {
  const resource = createAvatarRuntimeResource(options)
  return { kind: 'prefix', path: resource.prefix, resource, handler: resource }
}

/**
 * 一次性确认背景根目录与两个白名单文件（realpath 围栏 + 普通文件）。
 * 两个文件必须同时在：缺任何一个都整体按不可用处理，绝不半套上线。
 */
async function inspectBackgrounds(root, prefix) {
  const rootReal = await resolveRoot(root)
  if (!rootReal) return { available: false, rootReal: null, reason: 'root-missing', backgrounds: [] }
  const backgrounds = []
  for (const item of BACKGROUND_FILES) {
    const target = await resolveInsideRoot(rootReal, item.file)
    if (!target) return { available: false, rootReal, reason: 'backgrounds-missing', backgrounds: [] }
    backgrounds.push({ id: item.id, label: item.label, url: `${prefix}/${item.file}` })
  }
  return { available: true, rootReal, reason: 'ok', backgrounds }
}

/**
 * 背景资源：只放行 assets/backgrounds 下两个顶层 WebP。
 * 白名单外（SOURCE.md、子目录、别的名字、大小写变体）→ 403；
 * 白名单命中但盘上缺失 / 根目录不可用 → 404；前缀顶点与前缀外 → 404。
 * 缩放后的 webp 也以流式 body + 真实 content-length 返回，HEAD 不带 body。
 */
export function createBackgroundResource(options = {}) {
  const opts = typeof options === 'string' ? { root: options } : (options || {})
  const root = opts.root
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TypeError('avatar-route: 需要构造参数 root（背景资源根目录）')
  }
  const prefix = normalizePrefix(opts.prefix || BACKGROUND_PREFIX)
  const files = BACKGROUND_FILES.map((item) => item.file)

  let statePromise = null
  const load = () => {
    if (!statePromise) statePromise = inspectBackgrounds(root, prefix)
    return statePromise
  }

  const resource = async function backgroundResource(request) {
    const method = methodAllowed(request)
    if (!method) return textResponse(405, 'method not allowed')

    const parsed = resolveRequestPath(request, prefix)
    if (parsed.status) return textResponse(parsed.status, parsed.status === 403 ? 'forbidden' : parsed.status === 400 ? 'bad request' : 'not found')
    const rel = parsed.rel

    // 只认两个顶层文件名：子目录、SOURCE.md、任意其它文件、大小写变体一律 403。
    if (rel.includes('/') || !BACKGROUND_SET.has(rel)) return textResponse(403, 'forbidden')

    const state = await load()
    if (!state.available) return textResponse(404, 'not found')

    const target = await resolveInsideRoot(state.rootReal, rel)
    if (!target) return textResponse(404, 'not found')
    return fileResponse(target, BACKGROUND_CONTENT_TYPE, method)
  }

  resource.prefix = prefix
  resource.root = root
  resource.files = [...files]
  resource.warmup = () => load()
  resource.reset = () => { statePromise = null }
  resource.describe = async () => {
    const state = await load()
    return {
      root,
      prefix,
      available: state.available,
      reason: state.reason,
      files: [...files],
      backgrounds: state.available ? state.backgrounds.map((item) => ({ ...item })) : [],
    }
  }
  return resource
}

/** 直接给 webServer.register 用的背景路由描述符。 */
export function createBackgroundRoute(options = {}) {
  const resource = createBackgroundResource(options)
  return { kind: 'prefix', path: resource.prefix, resource, handler: resource }
}

/** 把 fetch 风格的 resource 适配成 (req, res) 处理器；body 同样流式转发。 */
export function toNodeHandler(resource) {
  return async function avatarNodeHandler(req, res) {
    const host = req.headers?.host || 'localhost'
    const response = await resource(new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
    }))
    const headers = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    res.writeHead(response.status, headers)
    if (req.method === 'HEAD' || !response.body) {
      res.end()
      return
    }
    const body = Readable.fromWeb(response.body)
    body.on('error', () => {
      try { res.destroy() } catch { /* 已断开的响应只需尽力释放 */ }
    })
    res.on('close', () => {
      try { body.destroy() } catch { /* 关闭面板或切页时取消后续读取 */ }
    })
    body.pipe(res)
  }
}

export default createAvatarResource
