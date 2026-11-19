import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLocalCamera } from '../lib/local-camera.js'
import { HR_LOCAL_CAMERA_PATH } from '../lib/contract.js'

function fixture(t) {
  const children = []
  let handler
  let clock = 0
  const camera = createLocalCamera({ clock: () => clock, launch: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.kill = () => { child.killed = true; child.emit('exit') }
    children.push(child)
    return child
  } })
  const cleanup = camera.mount({ register(route) { handler = route.handler; return () => {} } })
  t.after(cleanup)
  return { camera, children, advance: (ms) => { clock += ms }, handler }
}

function signalFrame(jpeg) {
  const size = Buffer.alloc(4)
  size.writeUInt32LE(jpeg.length)
  return Buffer.concat([size, jpeg])
}

test('Windows 助手使用系统编码器输出可解码的内存 JPEG', { skip: process.platform !== 'win32' }, () => {
  const binary = fileURLToPath(new URL('../lib/windows-camera.exe', import.meta.url))
  const result = spawnSync(binary, ['--self-test'], { windowsHide: true, timeout: 5000 })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.readUInt32LE(), result.stdout.length - 4)
  assert.equal(result.stdout.readUInt16BE(4), 0xffd8)
  assert.equal(result.stdout.readUInt16BE(result.stdout.length - 2), 0xffd9)
})

test('相机帧仅通过带凭据的本机请求读取，关闭后旧凭据立即失效', async (t) => {
  const { camera, children, handler } = fixture(t)
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}${HR_LOCAL_CAMERA_PATH}`
  const sessionId = 'hr-preview-local'
  const { token } = camera.start(sessionId)
  const headers = { 'X-HR-Camera-Token': token }
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const frame = signalFrame(jpeg)
  assert.equal((await fetch(url)).status, 404)
  assert.equal(children.length, 0, '没有有效预览请求时不得启动摄像头')
  assert.equal((await fetch(url, { headers })).status, 204)
  children[0].stdout.write(frame.subarray(0, 3))
  assert.equal((await fetch(url, { headers })).status, 204)
  children[0].stdout.write(frame.subarray(3))
  const response = await fetch(url, { headers })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('content-type'), 'image/jpeg')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg)
  const sequence = response.headers.get('x-hr-camera-frame')
  const arrived = once(server, 'request')
  const waiting = fetch(url, { headers: { ...headers, 'X-HR-Camera-After': sequence } })
  await arrived
  children[0].stdout.write(frame)
  const fresh = await waiting
  assert.equal(fresh.status, 200)
  assert.notEqual(fresh.headers.get('x-hr-camera-frame'), sequence)
  await fresh.arrayBuffer()
  camera.stop(sessionId, '0'.repeat(64))
  assert.equal(children[0].killed, undefined)
  const pendingRequest = once(server, 'request')
  const afterClose = fetch(url, { headers: { ...headers, 'X-HR-Camera-After': fresh.headers.get('x-hr-camera-frame') } })
  await pendingRequest
  camera.stop(sessionId, token)
  assert.equal((await afterClose).status, 410)
  assert.equal(children[0].killed, true)
  assert.equal((await fetch(url, { headers })).status, 404)
})

test('预览浏览器失联后杀掉助手并丢弃帧', async (t) => {
  const { camera, children, advance, handler } = fixture(t)
  const { token } = camera.start('hr-preview-local')
  handler({ method: 'GET', url: HR_LOCAL_CAMERA_PATH, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-hr-camera-token': token } },
    { setHeader() {}, end() {} })
  const exited = once(children[0], 'exit')
  advance(5000)
  await Promise.race([exited, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('Camera was not released')), 1000)
    exited.then(() => clearTimeout(timeout))
  })])
  assert.equal(children[0].killed, true)
})
