import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'

import {
  AVATAR_PREFIX,
  BACKGROUND_CONTENT_TYPE,
  BACKGROUND_FILES,
  BACKGROUND_PREFIX,
  DEFAULT_ENTRY,
  RUNTIME_CONTENT_TYPE,
  RUNTIME_FILES,
  RUNTIME_PREFIX,
  createAvatarResource,
  createAvatarRoute,
  createAvatarRuntimeResource,
  createAvatarRuntimeRoute,
  createBackgroundResource,
  createBackgroundRoute,
  toNodeHandler,
} from '../lib/avatar-route.js'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VENDOR_ROOT = join(PLUGIN_ROOT, 'lib', 'vendor')
const ASSET_BACKGROUND_ROOT = join(PLUGIN_ROOT, 'assets', 'backgrounds')

/** 带 RIFF/WEBP 头的假 WebP（路由只做字节透传，不解码）。 */
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'binary'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8L', 'binary'),
  Buffer.from([0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00]),
])
const MEETING_WEBP = Buffer.concat([WEBP, Buffer.from('#meeting', 'binary')])

/** 1x1 透明 PNG。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const MOC3 = Buffer.from('MOC3\x00stage0-fixture\x00', 'binary')
const SECRET = 'TOP-SECRET-DO-NOT-SERVE\n'

const MODEL_DOC = {
  Version: 3,
  FileReferences: {
    Moc: '大肥鱼.moc3',
    Textures: ['textures/贴图.png'],
    Physics: 'physics/physics3.json',
    DisplayInfo: 'display.json',
  },
  Groups: [],
  HitAreas: [],
}

let root
let emptyRoot
let resource

const key = (path) => `http://avatar.local${AVATAR_PREFIX}/${path}`
const get = (path, init) => resource(new Request(key(path), init))
const body = async (path) => Buffer.from(await (await get(path)).arrayBuffer())

async function writeFixture(dir) {
  const write = async (rel, data) => {
    const target = join(dir, ...rel.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, data)
  }
  await write(DEFAULT_ENTRY, JSON.stringify(MODEL_DOC, null, 2))
  await write('大肥鱼.moc3', MOC3)
  await write('textures/贴图.png', PNG)
  await write('physics/physics3.json', JSON.stringify({ meta: { physics: 'stage0' } }))
  await write('display.json', JSON.stringify({ DisplayInfo: [] }))
  await write('Animation/IDLE.motion3.json', JSON.stringify({ Meta: { Duration: 1 } }))
  // 以下都必须被拒绝，即使真实存在
  await write('PSD/大肥鱼.psd', Buffer.from('8BPS\x00\x01', 'binary'))
  await write('vtube/vtube.json', '{}')
  await write('vbridger/vbridger.json', '{}')
  await write('items_pinned/pin.png', PNG)
  await write('textures/other.png', PNG)
  await write('secret.txt', SECRET)
  await write('Animation/IDLE.motion3.json.bak', '{}')
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'hr-avatar-'))
  await writeFixture(root)
  emptyRoot = await mkdtemp(join(tmpdir(), 'hr-avatar-empty-'))
  resource = createAvatarResource({ root })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(emptyRoot, { recursive: true, force: true })
})

test('大肥鱼的压力面入口登记屑屑眼和黑脸，标准入口原样返回', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-avatar-pressure-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFixture(dir)
  await mkdir(join(dir, 'Exp3'))
  const presets = [
    { name: 'doubt', file: '屑屑眼.exp3.json', id: 'key6' },
    { name: 'black-face', file: '黑脸.exp3.json', id: 'key1' },
  ]
  const bodyOf = (id) => ({ Type: 'Live2D Expression', Parameters: [{ Id: id, Value: 1, Blend: 'Add' }] })
  for (const { file, id } of presets) await writeFile(join(dir, 'Exp3', file), JSON.stringify(bodyOf(id)))
  const excludedFiles = ['前倾.exp3.json', '流泪.exp3.json']
  for (const name of excludedFiles) await writeFile(join(dir, 'Exp3', name), '{}')
  const serve = createAvatarResource({ root: dir })
  const modelUrl = key(encodeURIComponent(DEFAULT_ENTRY))
  const standard = await serve(new Request(modelUrl))
  assert.deepEqual(await standard.json(), MODEL_DOC)
  const pressure = await serve(new Request(modelUrl + '?pressure-expressions=1'))
  assert.deepEqual((await pressure.json()).FileReferences.Expressions, presets.map(({ name, file }) => ({ Name: name, File: 'Exp3/' + file })))
  for (const { file, id } of presets) {
    const expression = await serve(new Request(key('Exp3/' + encodeURIComponent(file))))
    assert.deepEqual(await expression.json(), bodyOf(id))
  }
  for (const name of excludedFiles) {
    const excluded = await serve(new Request(key('Exp3/' + encodeURIComponent(name))))
    assert.equal(excluded.status, 403)
  }
})

test('工厂导出可直接用于 webServer 路由描述符', () => {
  const route = createAvatarRoute({ root })
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, AVATAR_PREFIX)
  assert.equal(typeof route.resource, 'function')
  assert.equal(route.resource, route.handler)
  assert.equal(typeof toNodeHandler(route.resource), 'function')
  assert.throws(() => createAvatarResource({}), TypeError)
  assert.throws(() => createAvatarResource({ root, prefix: 'hr-avatar' }), TypeError)
})

test('registry 只包含入口 + FileReferences + IDLE', async () => {
  const info = await resource.describe()
  assert.equal(info.available, true)
  assert.deepEqual([...info.files].sort(), [
    'Animation/IDLE.motion3.json',
    'display.json',
    'physics/physics3.json',
    'textures/贴图.png',
    '大肥鱼.moc3',
    '大肥鱼.model3.json',
  ].sort())
})

test('GET model3.json：200 + json + content-length', async () => {
  const response = await get(DEFAULT_ENTRY)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(response.headers.get('content-length'), String(bytes.byteLength))
  assert.equal(JSON.parse(bytes.toString('utf8')).Version, 3)
})

test('GET moc3：200 + octet-stream + 字节一致', async () => {
  const response = await get('大肥鱼.moc3')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), MOC3)
})

test('GET 中文路径 png：200 + image/png', async () => {
  const response = await get('textures/贴图.png')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('content-length'), String(PNG.byteLength))
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG)

  const encoded = await resource(
    new Request(`http://avatar.local${AVATAR_PREFIX}/textures/${encodeURIComponent('贴图')}.png`, {}),
  )
  assert.equal(encoded.status, 200)
})

test('GET physics/display/IDLE 均放行', async () => {
  for (const path of ['physics/physics3.json', 'display.json', 'Animation/IDLE.motion3.json']) {
    const response = await get(path)
    assert.equal(response.status, 200, path)
    assert.match(response.headers.get('content-type'), /^application\/json/, path)
  }
})

test('HEAD：200 + content-length，无响应体', async () => {
  const response = await get('textures/贴图.png', { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), String(PNG.byteLength))
  assert.equal(response.body, null)
  const text = await response.text()
  assert.equal(text, '')
})

test('未登记文件一律 403', async () => {
  for (const path of [
    'textures/other.png',
    'secret.txt',
    'Animation/IDLE.motion3.json.bak',
    '大肥鱼.moc3/nope.png',
  ]) {
    const response = await get(path)
    assert.equal(response.status, 403, path)
  }
})

test('PSD 与 vtube/vbridger/items_pinned 目录 403', async () => {
  for (const path of ['PSD/大肥鱼.psd', 'vtube/vtube.json', 'vbridger/vbridger.json', 'items_pinned/pin.png']) {
    const response = await get(path)
    assert.equal(response.status, 403, path)
  }
})

test('目录穿越：编码点段与编码 slash 被 403', async () => {
  for (const path of [
    '%2e%2e%2fsecret.txt',
    '%2e%2e%2f%2e%2e%2fsecret.txt',
    'textures/..%2F..%2Fsecret.txt',
    '..%5c..%5csecret.txt',
    'C:/Windows/win.ini',
    'C%3A%5CWindows%5Cwin.ini',
  ]) {
    const response = await get(path)
    assert.equal(response.status, 403, path)
  }
})

test('目录穿越：未编码点段被 URL 规范化后落到前缀外，仍拒绝', async () => {
  const response = await get('../secret.txt')
  assert.ok(response.status === 404 || response.status === 403, `status=${response.status}`)
  const text = await response.text()
  assert.ok(!text.includes('TOP-SECRET'))
})

test('重复 slash / 前缀顶点 不扩权', async () => {
  for (const path of ['/大肥鱼.moc3', 'textures//贴图.png']) {
    const response = await get(path)
    assert.equal(response.status, 403, path)
  }
  const bare = await resource(new Request('http://avatar.local/hr-avatar', {}))
  assert.equal(bare.status, 404)
  const slash = await resource(new Request('http://avatar.local/hr-avatar/', {}))
  assert.equal(slash.status, 404)
  const outside = await resource(new Request('http://avatar.local/other/大肥鱼.moc3', {}))
  assert.equal(outside.status, 404)
})

test('大小写变体 403（Windows 上会命中真实文件）', async () => {
  const response = await get('大肥鱼.MOC3')
  assert.equal(response.status, 403)
})

test('非 GET/HEAD 方法 405 + Allow', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await get(DEFAULT_ENTRY, { method })
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  }
})

test('缺失模型入口：所有请求 404，不抛错', async () => {
  const missing = createAvatarResource({ root: emptyRoot })
  for (const path of [DEFAULT_ENTRY, '大肥鱼.moc3']) {
    const response = await missing(new Request(key(path), {}))
    assert.equal(response.status, 404, path)
  }
  const info = await missing.describe()
  assert.equal(info.available, false)
  assert.deepEqual(info.files, [])

  const nowhere = createAvatarResource({ root: join(emptyRoot, 'not-here') })
  const response = await nowhere(new Request(key(DEFAULT_ENTRY), {}))
  assert.equal(response.status, 404)
})

test('非法百分号编码不抛错，返回 400', async () => {
  const response = await get('%zz.png')
  assert.equal(response.status, 400)
})

test('模型改版后 reset() 可重新解析', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-avatar-reset-'))
  try {
    const write = async (rel, data) => {
      const target = join(dir, ...rel.split('/'))
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, data)
    }
    await write(DEFAULT_ENTRY, JSON.stringify({ FileReferences: { Moc: 'a.moc3' } }))
    await write('a.moc3', 'v1')
    const one = createAvatarResource({ root: dir })
    assert.equal((await one(new Request(key('a.moc3'), {}))).status, 200)
    assert.equal((await one(new Request(key('b.moc3'), {}))).status, 403)

    await write('b.moc3', 'v2')
    await write(DEFAULT_ENTRY, JSON.stringify({ FileReferences: { Moc: 'b.moc3' } }))
    one.reset()
    assert.equal((await one(new Request(key('b.moc3'), {}))).status, 200)
    assert.equal((await one(new Request(key('a.moc3'), {}))).status, 403)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('流式：模型 GET 走 ReadableStream，HEAD 无 body 但保留真实长度', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-avatar-stream-'))
  try {
    const big = Buffer.alloc(320 * 1024, 7)
    big.write('MOC3', 0, 'binary')
    await writeFile(join(dir, DEFAULT_ENTRY), JSON.stringify({ FileReferences: { Moc: 'big.moc3' } }))
    await writeFile(join(dir, 'big.moc3'), big)
    const streamed = createAvatarResource({ root: dir })

    const response = await streamed(new Request(key('big.moc3'), {}))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), String(big.byteLength))
    assert.ok(response.body instanceof ReadableStream, 'body 必须流式')

    const chunks = []
    const reader = response.body.getReader()
    let reads = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      reads += 1
      chunks.push(Buffer.from(value))
    }
    assert.ok(reads > 1, `应分多次 flush，实际 ${reads} 次`)
    assert.deepEqual(Buffer.concat(chunks), big)

    const head = await streamed(new Request(key('big.moc3'), { method: 'HEAD' }))
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(big.byteLength))
    assert.equal(head.body, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 运行时资源 /hr-runtime                                              */
/* ------------------------------------------------------------------ */

const runtimeKey = (path) => `http://avatar.local${RUNTIME_PREFIX}/${path}`
const runtimeGet = (resource, path, init) => resource(new Request(runtimeKey(path), init))

test('runtime 路由描述符：prefix 与默认 vendor 根', async () => {
  assert.equal(RUNTIME_PREFIX, '/hr-runtime')
  assert.deepEqual([...RUNTIME_FILES], [
    'pixi-6.5.10.min.js',
    'live2dcubismcore-1.0.2.min.js',
    'pixi-live2d-display-cubism4-0.4.0.min.js',
  ])
  const route = createAvatarRuntimeRoute()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, RUNTIME_PREFIX)
  assert.equal(route.resource, route.handler)
  assert.equal(typeof toNodeHandler(route.resource), 'function')

  const info = await route.resource.describe()
  assert.equal(resolve(info.root).toLowerCase(), VENDOR_ROOT.toLowerCase())
  assert.equal(info.available, false)
  assert.equal(info.prefix, RUNTIME_PREFIX)
  assert.deepEqual(info.files, [...RUNTIME_FILES])

  assert.throws(() => createAvatarRuntimeResource({ prefix: 'hr-runtime' }), TypeError)
})

test('runtime GET：公开包的 vendor 文件以流返回，Core 由本地配置提供', async () => {
  const runtime = createAvatarRuntimeResource()
  for (const file of RUNTIME_FILES) {
    const response = await runtimeGet(runtime, file)
    if (file === RUNTIME_FILES[1]) { assert.equal(response.status, 404); continue }
    assert.equal(response.status, 200, file)
    assert.equal(response.headers.get('content-type'), RUNTIME_CONTENT_TYPE, file)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', file)
    const info = await stat(join(VENDOR_ROOT, file))
    assert.equal(response.headers.get('content-length'), String(info.size), file)
    assert.ok(response.body instanceof ReadableStream, file)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.byteLength, info.size, file)
    assert.deepEqual(bytes, await readFile(join(VENDOR_ROOT, file)), file)
  }
})

test('runtime HEAD：用户提供 Core 后可用，200 + 真实长度且无 body', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-core-file-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const coreFile = join(dir, 'live2dcubismcore.min.js')
  await writeFile(coreFile, '// test only\n')
  const runtime = createAvatarRuntimeResource({ coreFile })
  assert.equal((await runtime.describe()).available, true)
  const file = RUNTIME_FILES[1]
  const response = await runtimeGet(runtime, file, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), RUNTIME_CONTENT_TYPE)
  assert.equal(response.body, null)
  assert.equal(response.headers.get('content-length'), String((await stat(coreFile)).size))
  assert.equal(await response.text(), '')
})

test('runtime 拒绝 license / map / 任意文件 / 子目录 / 模型', async () => {
  const runtime = createAvatarRuntimeResource()
  for (const path of [
    'PIXI-LICENSE.txt',
    'Live2D-RedistributableFiles.txt',
    'Live2D-Cubism-Core-LICENSE.md',
    'package.json',
    'pixi-6.5.10.min.js.map',
    'sub/pixi-6.5.10.min.js',
    'lib/vendor/pixi-6.5.10.min.js',
    '大肥鱼.model3.json',
    'PIXI-6.5.10.MIN.JS',
  ]) {
    const response = await runtimeGet(runtime, path)
    assert.equal(response.status, 403, path)
  }
})

test('runtime 穿越与编码绕过：403 / 前缀外 404', async () => {
  const runtime = createAvatarRuntimeResource()
  for (const path of [
    '%2e%2e%2fpackage.json',
    '%2e%2e%2f%2e%2e%2findex.js',
    '..%5c..%5cpackage.json',
    'pixi-6.5.10.min.js%00.png',
    'C:/Windows/win.ini',
  ]) {
    const response = await runtimeGet(runtime, path)
    assert.equal(response.status, 403, path)
  }
  for (const path of ['../package.json', '/pixi-6.5.10.min.js', 'pixi-6.5.10.min.js//']) {
    const response = await runtimeGet(runtime, path)
    assert.ok(response.status === 403 || response.status === 404, `${path} -> ${response.status}`)
  }
  const bare = await runtime(new Request(`http://avatar.local${RUNTIME_PREFIX}`, {}))
  assert.equal(bare.status, 404)
})

test('runtime 缺失根 / 白名单文件不在盘上都 404', async () => {
  const missing = createAvatarRuntimeResource({ root: join(emptyRoot, 'no-vendor') })
  for (const file of RUNTIME_FILES) {
    assert.equal((await runtimeGet(missing, file)).status, 404, file)
  }
  assert.equal((await runtimeGet(missing, 'PIXI-LICENSE.txt')).status, 403)

  const partialRoot = await mkdtemp(join(tmpdir(), 'hr-vendor-partial-'))
  try {
    await writeFile(join(partialRoot, RUNTIME_FILES[0]), '// stub\n')
    const partial = createAvatarRuntimeResource({ root: partialRoot })
    assert.equal((await runtimeGet(partial, RUNTIME_FILES[0])).status, 200)
    assert.equal((await runtimeGet(partial, RUNTIME_FILES[1])).status, 404)
    const body = await (await runtimeGet(partial, RUNTIME_FILES[0])).text()
    assert.equal(body, '// stub\n')
  } finally {
    await rm(partialRoot, { recursive: true, force: true })
  }
})

test('runtime 方法限制：405 + Allow', async () => {
  const runtime = createAvatarRuntimeResource()
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await runtimeGet(runtime, RUNTIME_FILES[0], { method })
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  }
})

test('发布边界：manifest、vendor、模型资产与简历样本', async () => {
  const pkg = JSON.parse(await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
  for (const need of ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'locale']) assert.ok(pkg.files.includes(need), need)
  assert.equal(pkg.files.some((file) => file.endsWith('.tgz')), false)
  // docs 随包分发：README 指向的两份边界文档必须在包里，否则安装后链接悬空
  assert.ok(pkg.files.includes('docs'), 'files 白名单必须包含 docs')
  const docsFiles = await readdir(join(PLUGIN_ROOT, 'docs'))
  for (const doc of ['content-provenance.md', 'msy-source.md']) {
    assert.ok(docsFiles.includes(doc), `缺 docs/${doc}`)
  }
  assert.equal(pkg.scripts.prepack, 'npm run check', 'prepack 必须包含全量测试，而不只是 bundle 新鲜度')
  const allowed = [
    ...RUNTIME_FILES.filter((_, index) => index !== 1),
    'PIXI-LICENSE.txt',
    'pixi-live2d-display-LICENSE.txt',
    'Live2D-Cubism-Core-LICENSE.md',
    'Live2D-RedistributableFiles.txt',
    'pdfjs',
  ]
  assert.deepEqual((await readdir(VENDOR_ROOT)).sort(), allowed.sort())
  assert.deepEqual((await readdir(join(VENDOR_ROOT, 'pdfjs'))).sort(), ['LICENSE', 'SOURCE.md', 'pdf.mjs', 'pdf.worker.mjs'].sort())
  const pdfExpected = [
    ['pdf.mjs', 398237, 'ROxvARAn7nd5E4a2bBSHal/CniC/BDPAfGcm//chK3I='],
    ['pdf.worker.mjs', 1417586, 'vYiAUXiibHKduMAQeltjDLkA7AcPTYx1KaPkVTCv1B0='],
  ]
  for (const [name, bytes, sha256] of pdfExpected) {
    const content = await readFile(join(VENDOR_ROOT, 'pdfjs', name))
    assert.equal(content.length, bytes, `${name} 字节数`)
    assert.equal(createHash('sha256').update(content).digest('base64'), sha256, `${name} 完整性`)
  }
  const files = await readdir(join(PLUGIN_ROOT, 'lib'), { recursive: true })
  for (const file of files) {
    assert.doesNotMatch(String(file), /\.(moc3|psd|motion3\.json|exp3\.json)$/i)
    assert.doesNotMatch(String(file), /texture_\d+\.png$/i)
    assert.doesNotMatch(String(file), /\.(pdf|docx)$/i, '个人简历和测试样本不能进入运行包')
  }
  const dataFiles = await readdir(join(PLUGIN_ROOT, 'lib', 'data'), { recursive: true })
  assert.deepEqual(dataFiles.sort(), ['market-question-bank.json'], 'lib/data 只允许插件自己的精选题库，第三方 NDJSON/答案缓存/简历题库不得入包')
  for (const file of dataFiles) {
    assert.doesNotMatch(String(file), /\.(ndjson|cookie|sqlite|db)$/i, '第三方题库、Cookie 和本地数据库不能进入运行包')
  }
})

test('toNodeHandler：源流错误销毁响应，响应关闭取消源流', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  let failSource
  const failing = new ReadableStream({ start(controller) { failSource = () => controller.error(new Error('fixture read failed')) } })
  const errorHandler = toNodeHandler(async () => new Response(failing))
  const errorResponse = new PassThrough()
  errorResponse.writeHead = () => errorResponse
  let responseDestroyed = false
  const destroyErrorResponse = errorResponse.destroy.bind(errorResponse)
  errorResponse.destroy = (...args) => { responseDestroyed = true; return destroyErrorResponse(...args) }
  await errorHandler({ method: 'GET', url: '/hr-avatar/fixture', headers: { host: 'local' } }, errorResponse)
  failSource()
  await tick()
  assert.equal(responseDestroyed, true)

  let sourceCancelled = false
  const pending = new ReadableStream({ pull() {}, cancel() { sourceCancelled = true } })
  const closeHandler = toNodeHandler(async () => new Response(pending))
  const closedResponse = new PassThrough()
  closedResponse.writeHead = () => closedResponse
  await closeHandler({ method: 'GET', url: '/hr-avatar/fixture', headers: { host: 'local' } }, closedResponse)
  closedResponse.destroy()
  await tick()
  assert.equal(sourceCancelled, true)
})

/* ------------------------------------------------------------------ */
/* 背景资源 /hr-background                                             */
/* ------------------------------------------------------------------ */

const backgroundKey = (path) => `http://avatar.local${BACKGROUND_PREFIX}/${path}`
const backgroundGet = (resource, path, init) => resource(new Request(backgroundKey(path), init))

/** VP8 / VP8L / VP8X 三种头的尺寸解析，只用于验证发布资产不是缩略图。 */
function webpSize(bytes) {
  const chunk = bytes.subarray(12, 16).toString('binary')
  if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  return null
}

async function backgroundFixture(t, entries = { 'office.webp': WEBP, 'meeting-room.webp': MEETING_WEBP }) {
  const dir = await mkdtemp(join(tmpdir(), 'hr-background-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const write = async (rel, data) => {
    const target = join(dir, ...rel.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, data)
  }
  for (const [rel, data] of Object.entries(entries)) await write(rel, data)
  // 以下都真实存在，但必须一律拒绝。
  await write('SOURCE.md', '# 来源说明\n')
  await write('other.webp', WEBP)
  await write('office.webp.bak', WEBP)
  await write('office.png', PNG)
  await write('sub/office.webp', WEBP)
  return dir
}

test('background 描述符：默认 prefix、固定白名单与构造校验', async (t) => {
  const dir = await backgroundFixture(t)
  assert.equal(BACKGROUND_PREFIX, '/hr-background')
  assert.equal(BACKGROUND_CONTENT_TYPE, 'image/webp')
  assert.deepEqual([...BACKGROUND_FILES], [
    { id: 'office', file: 'office.webp', label: '现代办公室' },
    { id: 'meeting-room', file: 'meeting-room.webp', label: '会议室' },
  ])

  const route = createBackgroundRoute({ root: dir })
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, BACKGROUND_PREFIX)
  assert.equal(route.resource, route.handler)
  assert.equal(typeof toNodeHandler(route.resource), 'function')
  const info = await route.resource.describe()
  assert.equal(info.prefix, BACKGROUND_PREFIX)
  assert.deepEqual(info.files, ['office.webp', 'meeting-room.webp'])

  assert.throws(() => createBackgroundResource({}), TypeError)
  assert.throws(() => createBackgroundResource({ root: dir, prefix: 'hr-background' }), TypeError)
})

test('background GET：200 + image/webp + 真实长度 + 流式 + 字节一致', async (t) => {
  const dir = await backgroundFixture(t)
  const resource = createBackgroundResource({ root: dir })
  for (const [file, expected] of [['office.webp', WEBP], ['meeting-room.webp', MEETING_WEBP]]) {
    const response = await backgroundGet(resource, file)
    assert.equal(response.status, 200, file)
    assert.equal(response.headers.get('content-type'), BACKGROUND_CONTENT_TYPE, file)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', file)
    assert.equal(response.headers.get('content-length'), String(expected.byteLength), file)
    assert.ok(response.body instanceof ReadableStream, `${file} body 必须流式`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, file)
  }
})

test('background HEAD：200 + 真实长度，无 body', async (t) => {
  const dir = await backgroundFixture(t)
  const resource = createBackgroundResource({ root: dir })
  const response = await backgroundGet(resource, 'office.webp', { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), BACKGROUND_CONTENT_TYPE)
  assert.equal(response.headers.get('content-length'), String(WEBP.byteLength))
  assert.equal(response.body, null)
  assert.equal(await response.text(), '')
})

test('background 拒绝 SOURCE.md / 任意文件 / 子目录 / 大小写变体', async (t) => {
  const dir = await backgroundFixture(t)
  const resource = createBackgroundResource({ root: dir })
  for (const path of [
    'SOURCE.md',
    'source.md',
    'other.webp',
    'office.png',
    'office.webp.bak',
    'sub/office.webp',
    'OFFICE.WEBP',
    'Office.Webp',
    'package.json',
    'lib/vendor/office.webp',
  ]) {
    const response = await backgroundGet(resource, path)
    assert.equal(response.status, 403, path)
    assert.ok(!(await response.text()).includes('来源说明'), path)
  }
})

test('background 穿越与编码绕过：403 / 前缀外 404', async (t) => {
  const dir = await backgroundFixture(t)
  const resource = createBackgroundResource({ root: dir })
  for (const path of [
    '%2e%2e%2fSOURCE.md',
    '%2e%2e%2f%2e%2e%2fpackage.json',
    '..%5c..%5cSOURCE.md',
    'office.webp%00.png',
    'C:/Windows/win.ini',
    'C%3A%5CWindows%5Cwin.ini',
  ]) {
    const response = await backgroundGet(resource, path)
    assert.equal(response.status, 403, path)
  }
  for (const path of ['../SOURCE.md', '/office.webp', 'office.webp//']) {
    const response = await backgroundGet(resource, path)
    assert.ok(response.status === 403 || response.status === 404, `${path} -> ${response.status}`)
  }
  const bare = await resource(new Request(`http://avatar.local${BACKGROUND_PREFIX}`, {}))
  assert.equal(bare.status, 404)
  const slash = await resource(new Request(`http://avatar.local${BACKGROUND_PREFIX}/`, {}))
  assert.equal(slash.status, 404)
  const outside = await resource(new Request('http://avatar.local/other/office.webp', {}))
  assert.equal(outside.status, 404)
})

test('background 方法限制：405 + Allow', async (t) => {
  const dir = await backgroundFixture(t)
  const resource = createBackgroundResource({ root: dir })
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await backgroundGet(resource, 'office.webp', { method })
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'GET, HEAD', method)
  }
})

test('background 缺文件 / 缺根目录：整体不可用，白名单文件也 404', async (t) => {
  const partial = await backgroundFixture(t, { 'office.webp': WEBP })
  const partialResource = createBackgroundResource({ root: partial })
  const partialInfo = await partialResource.describe()
  assert.equal(partialInfo.available, false)
  assert.equal(partialInfo.reason, 'backgrounds-missing')
  assert.deepEqual(partialInfo.backgrounds, [])
  for (const file of ['office.webp', 'meeting-room.webp']) {
    assert.equal((await backgroundGet(partialResource, file)).status, 404, file)
  }
  assert.equal((await backgroundGet(partialResource, 'SOURCE.md')).status, 403)

  const missingRoot = createBackgroundResource({ root: join(tmpdir(), 'hr-background-not-here') })
  const missingInfo = await missingRoot.describe()
  assert.equal(missingInfo.available, false)
  assert.equal(missingInfo.reason, 'root-missing')
  assert.deepEqual(missingInfo.backgrounds, [])
  assert.equal((await backgroundGet(missingRoot, 'office.webp')).status, 404)
})

test('background reset()：补上第二个文件后重新可用', async (t) => {
  const dir = await backgroundFixture(t, { 'office.webp': WEBP })
  const resource = createBackgroundResource({ root: dir })
  assert.equal((await resource.describe()).available, false)
  await writeFile(join(dir, 'meeting-room.webp'), MEETING_WEBP)
  resource.reset()
  const info = await resource.describe()
  assert.equal(info.available, true)
  assert.equal((await backgroundGet(resource, 'meeting-room.webp')).status, 200)
})

test('background 真实发布资产：两个 1344×768 WebP，元数据只给相对 URL', async () => {
  const resource = createBackgroundResource({ root: ASSET_BACKGROUND_ROOT })
  const info = await resource.describe()
  assert.equal(info.available, true)
  assert.equal(info.reason, 'ok')
  assert.deepEqual(info.backgrounds, [
    { id: 'office', label: '现代办公室', url: '/hr-background/office.webp' },
    { id: 'meeting-room', label: '会议室', url: '/hr-background/meeting-room.webp' },
  ])
  for (const entry of info.backgrounds) {
    assert.equal(Object.hasOwn(entry, 'root'), false)
    assert.match(entry.url, /^\/hr-background\/[a-z-]+\.webp$/)
    const response = await resource(new Request(`http://avatar.local${entry.url}`, {}))
    assert.equal(response.status, 200, entry.url)
    assert.equal(response.headers.get('content-type'), BACKGROUND_CONTENT_TYPE, entry.url)
    const bytes = Buffer.from(await response.arrayBuffer())
    const disk = await readFile(join(ASSET_BACKGROUND_ROOT, `${entry.id}.webp`))
    assert.equal(response.headers.get('content-length'), String(disk.byteLength), entry.url)
    assert.deepEqual(bytes, disk, entry.url)
    assert.equal(bytes.subarray(0, 4).toString('binary'), 'RIFF', entry.url)
    assert.equal(bytes.subarray(8, 12).toString('binary'), 'WEBP', entry.url)
    assert.deepEqual(webpSize(bytes), { width: 1344, height: 768 }, entry.url)
  }
  assert.equal((await backgroundGet(resource, 'SOURCE.md')).status, 403)
})
