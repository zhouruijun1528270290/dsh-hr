import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { HR_LOCAL_CAMERA_PATH, remoteFailure } from './contract.js'

const MAX_FRAME = 512 * 1024
const VIEWER_TIMEOUT = 4500
const FIRST_FRAME_TIMEOUT = 12000
const FRAME_WAIT = 750
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const helper = fileURLToPath(new URL('./windows-camera.exe', import.meta.url))

function startHelper() {
  return spawn(helper, [String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
}

export function createLocalCamera({ launch = startHelper, clock = Date.now } = {}) {
  let active = null
  let mounted = false
  function stop(sessionId, token) {
    const capture = active
    if (!capture || (sessionId && capture.sessionId !== sessionId) || (token && capture.token !== token)) return
    active = null
    clearInterval(capture.watchdog)
    capture.viewer?.(410)
    capture.frame = null
    capture.pending = Buffer.alloc(0)
    capture.child?.stdout.destroy()
    capture.child?.kill()
  }

  function launchForViewer(capture) {
    const child = launch()
    capture.child = child
    capture.frameAt = clock()
    const close = () => { if (active === capture) stop() }
    child.once('error', close)
    child.once('exit', close)
    child.stdout.on('error', close)
    child.stdout.on('data', (chunk) => {
      if (active !== capture) return
      capture.pending = capture.pending.length ? Buffer.concat([capture.pending, chunk]) : chunk
      while (capture.pending.length >= 4) {
        const length = capture.pending.readUInt32LE()
        if (length < 4 || length > MAX_FRAME) { close(); return }
        if (capture.pending.length < length + 4) return
        const frame = capture.pending.subarray(4, 4 + length)
        if (frame.readUInt16BE(0) !== 0xffd8 || frame.readUInt16BE(length - 2) !== 0xffd9) { close(); return }
        capture.pending = capture.pending.subarray(4 + length)
        capture.frame = frame
        capture.sequence += 1
        capture.frameAt = clock()
        capture.viewer?.(200)
      }
    })
  }

  function start(sessionId) {
    if (!mounted) throw remoteFailure('hr-interview/local-camera-unavailable', '本机摄像头助手暂不可用')
    stop()
    const now = clock()
    const capture = { sessionId, child: null, token: randomBytes(32).toString('hex'), viewedAt: now, frameAt: now,
      sequence: 0, frame: null, pending: Buffer.alloc(0), watchdog: null, viewer: null }
    active = capture
    capture.watchdog = setInterval(() => {
      const time = clock()
      const frameTimeout = capture.sequence ? VIEWER_TIMEOUT : FIRST_FRAME_TIMEOUT
      if (active === capture && (time - capture.viewedAt > VIEWER_TIMEOUT || time - capture.frameAt > frameTimeout)) stop()
    }, 250)
    capture.watchdog.unref()
    return { token: capture.token }
  }

  function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    const launch = active
    if (req.method !== 'GET' || req.url !== HR_LOCAL_CAMERA_PATH || !LOOPBACK.has(req.socket?.remoteAddress)
      || !launch || req.headers['x-hr-camera-token'] !== launch.token) {
      res.statusCode = 404
      res.end()
      return
    }
    launch.viewedAt = clock()
    if (!launch.child) {
      try { launchForViewer(launch) }
      catch {
        stop()
        res.statusCode = 503
        res.end()
        return
      }
    }
    const after = req.headers['x-hr-camera-after']
    const send = (status) => {
      res.statusCode = status
      if (status !== 200) { res.end(); return }
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-HR-Camera-Frame', String(launch.sequence))
      res.end(launch.frame)
    }
    if (launch.frame && after !== String(launch.sequence)) { send(200); return }
    if (typeof after !== 'string' || !/^\d{1,12}$/.test(after)) { send(204); return }

    // Hold one request until a fresh frame arrives. The helper retains only its latest frame.
    launch.viewer?.(204)
    const detach = () => {
      clearTimeout(timer)
      res.off('close', detach)
      if (launch.viewer === deliver) launch.viewer = null
    }
    const deliver = (status) => { detach(); send(status) }
    const timer = setTimeout(() => deliver(204), FRAME_WAIT)
    launch.viewer = deliver
    res.once('close', detach)
  }

  return {
    start,
    stop,
    available: () => mounted,
    mount(webServer) {
      const dispose = webServer.register({ kind: 'prefix', path: HR_LOCAL_CAMERA_PATH, handler })
      mounted = true
      return () => { mounted = false; stop(); dispose() }
    },
  }
}
