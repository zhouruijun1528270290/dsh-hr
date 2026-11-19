import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLive2dState, mountLive2dRoutes } from '../index.js'
import { HRInterviewService } from '../lib/service.js'

const modelDocument = () => ({
  Version: 3,
  FileReferences: {
    Moc: 'fixture.moc3',
    Textures: ['textures/texture_00.png'],
    Physics: 'fixture.physics3.json',
    DisplayInfo: 'fixture.cdi3.json',
  },
  Groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] }],
})

function serviceWithAvatar(avatar) {
  return new HRInterviewService({
    avatar,
    model: { capabilities: () => ({ configured: true, model: 'mock' }) },
    speech: { capabilities: () => ({ asrConfigured: false, ttsConfigured: false }) },
  })
}

const BACKGROUNDS = [
  { id: 'office', label: '现代办公室', url: '/hr-background/office.webp' },
  { id: 'meeting-room', label: '会议室', url: '/hr-background/meeting-room.webp' },
]

/** 只认 prefix 的 webServer 替身：同时暴露 scoped.cleanup 以便验证 effect 注销。 */
function mockCtx(routes) {
  const scoped = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(register) { scoped.cleanup = register() },
  }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback(scoped)
    },
  }
  return { ctx, scoped }
}

test('Live2D routes mount and capabilities expose only relative metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hr-live2d-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'textures'), { recursive: true })
  await writeFile(join(root, '大肥鱼.model3.json'), JSON.stringify(modelDocument()), 'utf8')
  await writeFile(join(root, 'fixture.moc3'), 'fixture', 'utf8')
  await writeFile(join(root, 'textures', 'texture_00.png'), 'fixture', 'utf8')

  const live2dCoreFile = join(root, 'live2dcubismcore.min.js')
  await writeFile(live2dCoreFile, '// test only\n')
  const state = createLive2dState({ live2dDir: root, live2dCoreFile })
  const routes = new Map()
  const { ctx } = mockCtx(routes)
  const dispose = mountLive2dRoutes(ctx, state)
  assert.equal(state.mounted, true)
  assert.deepEqual([...routes.keys()].sort(), ['/hr-avatar', '/hr-background', '/hr-runtime'])
  assert.equal(typeof routes.get('/hr-avatar').handler, 'function')
  assert.equal(Object.hasOwn(routes.get('/hr-avatar'), 'resource'), false)
  assert.equal(typeof routes.get('/hr-runtime').handler, 'function')
  assert.equal(typeof routes.get('/hr-background').handler, 'function')

  const capabilities = await serviceWithAvatar(state).capabilities()
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(capabilities.version, packageJson.version)
  assert.deepEqual(capabilities.avatar, {
    kind: 'live2d', available: true, base: '/hr-avatar', model: '大肥鱼.model3.json', runtimeBase: '/hr-runtime', reason: 'ok',
  })
  assert.equal(Object.hasOwn(capabilities.avatar, 'root'), false)
  assert.deepEqual(capabilities.backgrounds, BACKGROUNDS)
  assert.equal(Object.hasOwn(capabilities, 'root'), false)
  for (const entry of capabilities.backgrounds) {
    assert.equal(Object.hasOwn(entry, 'root'), false)
    assert.match(entry.url, /^\/hr-background\//)
  }

  const entry = await state.resource(new Request('http://local/hr-avatar/%E5%A4%A7%E8%82%A5%E9%B1%BC.model3.json'))
  assert.equal(entry.status, 200)
  assert.equal((await entry.json()).FileReferences.Moc, 'fixture.moc3')
  const runtime = await state.runtime(new Request('http://local/hr-runtime/live2dcubismcore-1.0.2.min.js', { method: 'HEAD' }))
  assert.equal(runtime.status, 200)
  assert.match(runtime.headers.get('content-type'), /text\/javascript/)
  assert.equal(await runtime.text(), '')

  const background = await state.backgrounds(new Request('http://local/hr-background/office.webp'))
  assert.equal(background.status, 200)
  assert.equal(background.headers.get('content-type'), 'image/webp')
  assert.ok((await background.arrayBuffer()).byteLength > 0)
  assert.equal((await state.backgrounds(new Request('http://local/hr-background/SOURCE.md'))).status, 403)

  dispose()
  dispose()
  assert.equal(routes.size, 0)
  const after = await serviceWithAvatar(state).capabilities()
  assert.equal(after.avatar.available, false)
  assert.deepEqual(after.backgrounds, [])

  // scoped.effect 是另一条注销路径：禁用/重载插件时必须同样清空路由与能力。
  const reloadState = createLive2dState({ live2dDir: root })
  const reloadRoutes = new Map()
  const reload = mockCtx(reloadRoutes)
  mountLive2dRoutes(reload.ctx, reloadState)
  assert.equal(reloadRoutes.size, 3)
  assert.deepEqual((await serviceWithAvatar(reloadState).capabilities()).backgrounds, BACKGROUNDS)
  reload.scoped.cleanup()
  assert.equal(reloadRoutes.size, 0)
  assert.equal(reloadState.mounted, false)
  assert.deepEqual((await serviceWithAvatar(reloadState).capabilities()).backgrounds, [])
})

test('backgrounds still mount without any Live2D model (static avatar fallback)', async () => {
  const state = createLive2dState({})
  state.resource = null
  const routes = new Map()
  const { ctx } = mockCtx(routes)
  const dispose = mountLive2dRoutes(ctx, state)
  assert.deepEqual([...routes.keys()].sort(), ['/hr-background', '/hr-runtime'])
  assert.equal(typeof routes.get('/hr-background').handler, 'function')

  const capabilities = await serviceWithAvatar(state).capabilities()
  assert.equal(capabilities.avatar.kind, 'static')
  assert.equal(capabilities.avatar.available, false)
  assert.deepEqual(capabilities.backgrounds, BACKGROUNDS)

  const response = await state.backgrounds(new Request('http://local/hr-background/meeting-room.webp', { method: 'HEAD' }))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
  dispose()
  assert.equal(routes.size, 0)
})

test('missing background resource falls back to an empty background list', async () => {
  const state = createLive2dState({ backgroundDir: join(tmpdir(), 'hr-live2d-host-no-backgrounds') })
  const routes = new Map()
  const { ctx } = mockCtx(routes)
  const dispose = mountLive2dRoutes(ctx, state)
  assert.equal(state.mounted, true)
  assert.ok(routes.has('/hr-background'))
  const capabilities = await serviceWithAvatar(state).capabilities()
  assert.deepEqual(capabilities.backgrounds, [])
  assert.equal((await state.backgrounds(new Request('http://local/hr-background/office.webp'))).status, 404)
  assert.equal((await state.backgrounds(new Request('http://local/hr-background/SOURCE.md'))).status, 403)
  dispose()
})

test('missing webServer or model falls back to static avatar', async () => {
  const state = createLive2dState({ live2dDir: join(tmpdir(), 'definitely-no-live2d-model') })
  const dispose = mountLive2dRoutes({ inject() { return () => {} } }, state)
  const capabilities = await serviceWithAvatar(state).capabilities()
  assert.equal(capabilities.avatar.kind, 'static')
  assert.equal(capabilities.avatar.available, false)
  assert.equal(capabilities.avatar.reason, 'webserver-unavailable')
  assert.deepEqual(capabilities.backgrounds, [])
  dispose()
  assert.equal((await serviceWithAvatar(null).capabilities()).avatar.reason, 'not-configured')
  assert.deepEqual((await serviceWithAvatar(null).capabilities()).backgrounds, [])
})
