/**
 * HR 面试 · 候选人本地预览与 Windows 相机入口。
 *
 * 与 src/live2d-avatar.js 同样的四条约束：
 *   1. 普通浏览器脚本，不写 import / export —— 构建时原样内联进 client.js 的模块工厂；
 *   2. 顶层不碰 window / document / navigator，SSR 与 node:vm 都能直接执行这段文本；
 *   3. 运行时只依赖调用方传进来的 React，不 require 任何第三方包；
 *   4. 命名统一 hrCandidate* 前缀，内联后与 client.js 共享作用域也不撞名。
 *
 * 隐私边界由本文件独立负责，不指望父组件兜底：
 *   - 默认关闭：只有用户点「开启摄像头」才调用 getUserMedia({ video: true, audio: false })，
 *     永不请求音频；
 *   - 只做本地预览：流只挂在 <video>.srcObject 上，不录制、不上传、不落盘、不做表情分析；
 *   - 唯一释放路径 hrCandidateStopStream()：点关闭 / paused=true / active=false / 卸载 /
 *     晚到流，全部走它，因此每条轨道都有确定的释放路径。
 */

const HR_CANDIDATE_TITLE = '你 · 候选人'

/**
 * framed=false 时标题与状态角标共用的深色胶囊：外部舞台可能是浅色占位/白底，
 * 白字裸放会看不见；胶囊底色保证在浅色与画面背景上都读得出来。
 */
const HR_CANDIDATE_PILL = Object.freeze({
  fontSize: 12,
  fontWeight: 600,
  color: '#fff',
  backgroundColor: 'rgba(15,23,42,.55)',
  borderRadius: 999,
  padding: '4px 10px',
  textShadow: '0 1px 2px rgba(0,0,0,.6)',
  whiteSpace: 'nowrap',
})

/** 所有对外文案都是固定串：绝不拼接 error.message，避免泄露设备名、驱动路径等信息。 */
const HR_CANDIDATE_TEXT = Object.freeze({
  idle: '摄像头默认关闭。点「开启摄像头」后画面只显示在这台设备上，不录制、不上传、不保存。',
  requesting: '正在打开摄像头…',
  live: '本地预览中：画面只显示在这台设备上，不录制、不上传。',
  closed: '摄像头已关闭。',
  paused: '面试已暂停，摄像头已关闭；继续后需要你再点一次「开启摄像头」。',
  inactive: '当前没有进行中的面试，摄像头保持关闭。',
  unsupported: '当前环境不支持摄像头预览，可以继续用语音或文字完成面试。',
  denied: '摄像头权限被拒绝，可以继续面试；需要预览时在浏览器里允许后再点一次。',
  notfound: '没有找到可用摄像头，可以继续面试。',
  busy: '摄像头被其它程序占用，可以继续面试，稍后再试。',
  insecure: '当前页面不是安全上下文，浏览器不提供摄像头，可以继续面试。',
  failed: '摄像头没有打开，可以继续面试，稍后再试。',
  play: '预览画面没有播放出来，可以继续面试，需要时再试一次。',
  lost: '摄像头连接已断开，可以继续面试，需要时再点一次「开启摄像头」。',
  windowsRequesting: '正在打开 Windows 相机…',
  windowsRequested: '已请求打开 Windows 相机。结束预览时请关闭相机窗口。',
  windowsFailed: '未能打开 Windows 相机。可以从 Windows 开始菜单打开「相机」。',
  localFailed: '本机预览未能启动或已断开。请检查 Windows 摄像头权限，或关闭占用摄像头的应用后重试。',
})

/** DOMException.name → 固定文案键；认不出的名字一律落到 failed。 */
const HR_CANDIDATE_ERROR_KEYS = Object.freeze({
  NotAllowedError: 'denied',
  PermissionDeniedError: 'denied',
  SecurityError: 'insecure',
  NotFoundError: 'notfound',
  DevicesNotFoundError: 'notfound',
  OverconstrainedError: 'notfound',
  NotReadableError: 'busy',
  TrackStartError: 'busy',
  AbortError: 'busy',
})

function hrCandidateWindow() {
  return typeof window === 'undefined' ? null : window
}

/** 取出 navigator.mediaDevices；缺失（老浏览器 / 非安全上下文）时返回 null，调用方给可读提示。 */
function hrCandidateMedia(win) {
  const nav = win && win.navigator
  const media = nav && nav.mediaDevices
  if (!media || typeof media.getUserMedia !== 'function') return null
  return media
}

/**
 * 停止流里的所有轨道。幂等：重复调用、轨道已结束、track.stop() 抛异常都不影响其它轨道。
 * 返回真正调用过 stop() 的轨道数，方便测试与断言。
 */
function hrCandidateStopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return 0
  let tracks = []
  try {
    tracks = stream.getTracks() || []
  } catch {
    tracks = []
  }
  let stopped = 0
  for (const track of tracks) {
    try {
      if (track && typeof track.stop === 'function') {
        track.stop()
        stopped += 1
      }
    } catch {
      // 已结束的轨道再 stop 会抛：这里只保证后续轨道照常释放。
    }
  }
  return stopped
}

/** 错误 → 固定可读文案，永不回显 error.name / error.message 原文。 */
function hrCandidateErrorText(error) {
  const name = error && typeof error.name === 'string' ? error.name : ''
  const key = HR_CANDIDATE_ERROR_KEYS[name] || 'failed'
  return HR_CANDIDATE_TEXT[key]
}

/**
 * React 组件工厂：显式接 React，返回 CandidateCamera({ paused = false, active = true })。
 *
 * 状态机：idle →(点击) requesting →(流到手) live →(关闭/暂停/失效/卸载) released。
 * 释放只走 release()：+1 竞态序号（让在途 getUserMedia 晚到时自弃）→ stop 所有轨道 →
 * 摘掉 onloadedmetadata → pause() → srcObject = null。
 */
function hrCandidateCameraComponent(React) {
  if (!React || typeof React.createElement !== 'function') throw new TypeError('候选人摄像头组件需要 React')
  const h = React.createElement
  const useEffect = React.useEffect
  const useRef = React.useRef
  const useState = React.useState

  return function CandidateCamera({ paused = false, active = true, framed = true, openWindowsCamera = null, startLocalCamera = null, stopLocalCamera = null }) {
    const videoRef = useRef(null)
    const canvasRef = useRef(null)
    const localPreview = useRef(null)
    // 记住真正挂上的 video 节点：卸载时 ref 已被 React 摘掉，仍要能清 srcObject。
    const nodeRef = useRef(null)
    const streamRef = useRef(null)
    const busyRef = useRef(false) // 有在途 getUserMedia：防重复点击、防重复请求
    const seqRef = useRef(0) // 竞态序号：过期回调据此自弃
    const pausedRef = useRef(paused === true)
    const activeRef = useRef(active !== false)
    const guardsRef = useRef([]) // 当前流的 track ended 监听，释放时逐个摘掉
    const [phase, setPhase] = useState('idle')
    const [note, setNote] = useState('')
    const usesWindowsCamera = typeof openWindowsCamera === 'function'
    const usesLocalCamera = typeof startLocalCamera === 'function' && typeof stopLocalCamera === 'function'

    /** 摘掉当前流的所有 ended 监听：主动关闭、暂停、卸载、换流都必须走到这里。 */
    const detachGuards = () => {
      const guards = guardsRef.current
      guardsRef.current = []
      for (const guard of guards) {
        try {
          if (guard.track && typeof guard.track.removeEventListener === 'function') {
            guard.track.removeEventListener('ended', guard.onEnded)
          }
        } catch {
          // 轨道已失效时摘监听失败不影响释放。
        }
      }
    }

    const release = () => {
      seqRef.current += 1
      busyRef.current = false
      detachGuards()
      const preview = localPreview.current
      localPreview.current = null
      if (preview) {
        preview.abort.abort()
        if (preview.token) Promise.resolve().then(() => preview.stop(preview.token)).catch(() => {})
        if (canvasRef.current) canvasRef.current.width = 1
      }
      const stream = streamRef.current
      streamRef.current = null
      hrCandidateStopStream(stream)
      const node = nodeRef.current
      nodeRef.current = null
      if (node) {
        try { node.onloadedmetadata = null } catch { /* 节点已失效 */ }
        try { node.onloadeddata = null } catch { /* 同上 */ }
        try { if (typeof node.pause === 'function') node.pause() } catch { /* 同上 */ }
        try { node.srcObject = null } catch { /* 老环境没有 srcObject */ }
      }
    }

    const connectLocal = async (win, preview) => {
      try {
        const { token } = await startLocalCamera()
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid preview')
        if (preview.abort.signal.aborted) {
          await preview.stop(token)
          return
        }
        preview.token = token
        let after = '0'
        while (!preview.abort.signal.aborted) {
          const response = await win.fetch(HR_LOCAL_CAMERA_PATH, {
            cache: 'no-store',
            headers: { 'X-HR-Camera-Token': token, 'X-HR-Camera-After': after },
            signal: preview.abort.signal,
          })
          if (response.status === 200) {
            after = response.headers.get('X-HR-Camera-Frame') || '0'
            const image = await win.createImageBitmap(await response.blob())
            try {
              if (preview.abort.signal.aborted) return
              const canvas = canvasRef.current
              const context = canvas?.getContext('2d')
              if (!context) throw new Error('Camera canvas is unavailable')
              if (canvas.width !== image.width) canvas.width = image.width
              if (canvas.height !== image.height) canvas.height = image.height
              context.drawImage(image, 0, 0)
              if (!preview.visible) {
                preview.visible = true
                setPhase('live')
                setNote(HR_CANDIDATE_TEXT.live)
              }
            } finally {
              image.close()
            }
          } else if (response.status !== 204) throw new Error('Preview ended')
          // Compatibility with an older Host that returns empty responses immediately.
          if (response.status === 204) await new Promise((resolve) => win.setTimeout(resolve, 45))
        }
      } catch {
        if (localPreview.current !== preview) return
        release()
        setPhase('error')
        setNote(HR_CANDIDATE_TEXT.localFailed)
      }
    }

    const start = (external = false) => {
      // 防重复点击 / 重复请求：在途请求或已经在预览时直接忽略。
      if (busyRef.current || streamRef.current) return
      if (pausedRef.current || !activeRef.current) return
      if (usesLocalCamera && !external) {
        const win = hrCandidateWindow()
        if (!win?.AbortController || !win.fetch || !win.createImageBitmap) {
          setPhase('error')
          setNote(HR_CANDIDATE_TEXT.localFailed)
          return
        }
        const preview = { abort: new win.AbortController(), stop: stopLocalCamera, token: null, visible: false }
        localPreview.current = preview
        busyRef.current = true
        setPhase('requesting')
        setNote(HR_CANDIDATE_TEXT.requesting)
        void connectLocal(win, preview)
        return
      }
      if (usesWindowsCamera) {
        const seq = ++seqRef.current
        busyRef.current = true
        setPhase('requesting')
        setNote(HR_CANDIDATE_TEXT.windowsRequesting)
        const complete = (requested) => {
          if (seq !== seqRef.current) return
          busyRef.current = false
          setPhase(requested ? 'external' : 'error')
          setNote(requested ? HR_CANDIDATE_TEXT.windowsRequested : HR_CANDIDATE_TEXT.windowsFailed)
        }
        Promise.resolve().then(openWindowsCamera).then((result) => complete(result?.requested === true), () => complete(false))
        return
      }
      const media = hrCandidateMedia(hrCandidateWindow())
      if (!media) {
        setPhase('error')
        setNote(HR_CANDIDATE_TEXT.unsupported)
        return
      }
      const seq = ++seqRef.current
      busyRef.current = true
      setPhase('requesting')
      setNote(HR_CANDIDATE_TEXT.requesting)
      let pending
      try {
        // 只请求视频：audio 显式 false，绝不触碰麦克风。
        pending = media.getUserMedia({ video: true, audio: false })
      } catch {
        busyRef.current = false
        setPhase('error')
        setNote(HR_CANDIDATE_TEXT.failed)
        return
      }
      Promise.resolve(pending).then((stream) => {
        const stale = seq !== seqRef.current || !busyRef.current ||
          pausedRef.current || !activeRef.current || !stream ||
          typeof stream.getTracks !== 'function'
        if (stale) {
          // 晚到 / 过期的流：用户已经关闭、暂停、卸载或重开，这里立刻释放，绝不留轨道。
          hrCandidateStopStream(stream)
          return
        }
        busyRef.current = false
        streamRef.current = stream
        setPhase('live')
        setNote(HR_CANDIDATE_TEXT.live)
      }, (error) => {
        if (seq !== seqRef.current) return
        busyRef.current = false
        setPhase('error')
        setNote(hrCandidateErrorText(error))
      })
    }

    const stop = () => {
      release()
      setPhase('idle')
      setNote(HR_CANDIDATE_TEXT.closed)
    }

    // 预览挂载：srcObject 只在 video 真正进 DOM 之后绑，play() 失败按可读错误回退。
    useEffect(() => {
      if (phase !== 'live') return undefined
      const node = videoRef.current
      const stream = streamRef.current
      if (!node || !stream) return undefined
      nodeRef.current = node
      try {
        node.srcObject = stream
      } catch {
        // 没有 srcObject 的极老环境：下面 play() 会失败并回退到占位。
      }
      const clearMeta = () => {
        try { node.onloadedmetadata = null } catch { /* 节点已失效 */ }
      }
      // onloadedmetadata 只用来在拿到尺寸后把自己摘掉，不做任何分析。
      try { node.onloadedmetadata = clearMeta } catch { /* 同上 */ }
      let cancelled = false
      const fail = () => {
        if (cancelled || streamRef.current !== stream) return
        release()
        setPhase('error')
        setNote(HR_CANDIDATE_TEXT.play)
      }
      // 设备掉线（拔摄像头、系统收回权限、被别的程序抢占）：释放并给出可读状态。
      // 只认「当前这条流」：旧流的回调即便漏掉，也不许改动新流的状态。
      const onEnded = () => {
        if (streamRef.current !== stream) return
        release()
        setPhase('error')
        setNote(HR_CANDIDATE_TEXT.lost)
      }
      const guards = []
      let tracks = []
      try {
        tracks = typeof stream.getTracks === 'function' ? (stream.getTracks() || []) : []
      } catch {
        tracks = []
      }
      for (const track of tracks) {
        try {
          if (!track || typeof track.addEventListener !== 'function') continue
          track.addEventListener('ended', onEnded)
          guards.push({ track, onEnded })
        } catch {
          // 轨道不支持事件时退化为轮询不必要：释放路径仍然确定。
        }
      }
      guardsRef.current = guards
      try {
        const played = typeof node.play === 'function' ? node.play() : null
        if (played && typeof played.then === 'function') played.then(() => {}, fail)
      } catch {
        fail()
      }
      return () => {
        cancelled = true
        clearMeta()
        detachGuards()
      }
    }, [phase])

    // paused / active 变化：立即释放，并回到「未开启」；恢复后必须由用户再点一次。
    useEffect(() => {
      pausedRef.current = paused === true
      activeRef.current = active !== false
      const blocked = paused === true || active === false
      if (!blocked) {
        setNote((current) => (current === HR_CANDIDATE_TEXT.paused || current === HR_CANDIDATE_TEXT.inactive ? '' : current))
        return
      }
      release()
      setPhase('idle')
      setNote(paused === true ? HR_CANDIDATE_TEXT.paused : HR_CANDIDATE_TEXT.inactive)
    }, [paused, active])

    // 卸载：与关闭同一条释放路径（不依赖 effect 的清理时机去碰 DOM）。
    useEffect(() => () => { release() }, [])

    useEffect(() => {
      if (!usesLocalCamera) return undefined
      const document = hrCandidateWindow()?.document
      if (!document) return undefined
      const stopWhenHidden = () => {
        if (document.visibilityState === 'hidden' && localPreview.current) {
          release()
          setPhase('idle')
          setNote('')
        }
      }
      document.addEventListener('visibilitychange', stopWhenHidden)
      return () => document.removeEventListener('visibilitychange', stopWhenHidden)
    }, [usesLocalCamera])

    const live = phase === 'live'
    const requesting = phase === 'requesting'
    const blocked = paused === true || active === false
    const message = note || HR_CANDIDATE_TEXT.idle
    // framed=false：外部已经给出舞台与边框，这里只做「贴在画面上的」薄层，避免第三层框。
    const framedNow = framed !== false
    // 正常/已关闭状态不再重复隐私说明（外部页面已有），错误仍要一句话说清。
    const showNote = phase === 'error' || phase === 'external' || (framedNow && !usesWindowsCamera)
    return h('section', {
      className: 'hri-candidate-camera',
      'data-status': phase,
      'data-framed': framedNow ? 'true' : 'false',
      'aria-label': '候选人本地摄像头（仅本地预览）',
      style: framedNow
        ? {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          height: '100%',
          minHeight: 0,
          padding: 10,
          border: '1px solid var(--dsw-alias-border-l1, #d0d5dd)',
          borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-1, #f8fafc)',
          color: 'var(--dsw-alias-label-primary, inherit)',
        }
        : {
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          position: 'relative',
          height: '100%',
          minHeight: 0,
          padding: 0,
          margin: 0,
          border: '0 solid transparent',
          borderRadius: 0,
          backgroundColor: 'transparent',
          backgroundImage: 'none',
          color: 'var(--dsw-alias-label-primary, inherit)',
        },
    },
      h('header', {
        className: 'hri-candidate-camera-head',
        style: framedNow
          ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flex: '0 0 auto' }
          : {
            position: 'absolute',
            top: 10,
            left: 10,
            right: 10,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            pointerEvents: 'none',
          },
      },
        h('span', {
          className: 'hri-candidate-camera-title',
          style: framedNow ? { fontSize: 13, fontWeight: 600 } : HR_CANDIDATE_PILL,
        }, HR_CANDIDATE_TITLE),
        h('span', {
          className: 'hri-candidate-camera-badge',
          style: framedNow ? { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #667085)' } : HR_CANDIDATE_PILL,
        }, live ? '预览中' : requesting ? '连接中' : usesWindowsCamera && (!usesLocalCamera || phase === 'external') ? '系统相机' : '已关闭'),
      ),
      h('div', {
        className: 'hri-candidate-camera-stage',
        style: {
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'center',
          overflow: 'hidden',
          borderRadius: framedNow ? 10 : 0,
          background: live ? '#000' : 'var(--dsw-alias-bg-primary, Canvas)',
        },
      },
        usesLocalCamera && h('canvas', {
          ref: canvasRef,
          className: 'hri-candidate-local-video',
          'aria-label': '候选人本机摄像头预览',
          style: { display: live ? 'block' : 'none', width: '100%', height: '100%', objectFit: 'cover' },
        }),
        live && !usesLocalCamera && h('video', {
          ref: videoRef,
          className: 'hri-candidate-video',
          muted: true,
          playsInline: true,
          autoPlay: true,
          'aria-label': '候选人本地预览',
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            background: '#000',
          },
        }),
        !live && h('div', {
          className: 'hri-candidate-camera-placeholder',
          style: {
            display: 'grid',
            placeItems: 'center',
            alignContent: 'center',
            gap: 4,
            padding: 12,
            textAlign: 'center',
            color: 'var(--dsw-alias-label-secondary, #667085)',
          },
        },
          h('span', { style: { fontSize: 13 } }, usesWindowsCamera && (!usesLocalCamera || phase === 'external')
            ? requesting ? HR_CANDIDATE_TEXT.windowsRequesting : '在 Windows 相机窗口预览'
            : requesting ? '正在开启摄像头…' : '摄像头未开启'),
          h('span', { style: { fontSize: 11 } }, '画面只显示在这台设备上'),
        ),
      ),
      showNote && h('p', {
        className: 'hri-candidate-camera-note',
        role: 'status',
        'aria-live': 'polite',
        style: {
          margin: 0,
          flex: '0 0 auto',
          fontSize: 12,
          lineHeight: 1.5,
          color: phase === 'error'
            ? 'var(--dsw-alias-label-error, #b42318)'
            : 'var(--dsw-alias-label-secondary, #667085)',
          ...(framedNow ? null : { padding: '0 10px', marginTop: 8 }),
        },
      }, message),
      h('div', {
        className: 'hri-candidate-camera-actions',
        style: {
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          flex: '0 0 auto',
          ...(framedNow ? null : live
            ? { position: 'absolute', right: 10, bottom: 10, zIndex: 2 }
            : { padding: '4px 10px 10px', justifyContent: 'flex-end' }),
        },
      },
        live || (usesLocalCamera && requesting && Boolean(localPreview.current))
          ? h('button', {
            type: 'button',
            className: 'hri-candidate-camera-stop',
            onClick: stop,
            style: {
              border: '1px solid var(--dsw-alias-border-l1, #d0d5dd)',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-primary, Canvas)',
              color: 'inherit',
              padding: '7px 12px',
              fontSize: 13,
              cursor: 'pointer',
            },
          }, requesting ? '取消预览' : '关闭摄像头')
          : h('button', {
            type: 'button',
            className: 'hri-candidate-camera-start',
            onClick: () => start(),
            disabled: requesting || blocked,
            title: blocked ? (paused === true ? '面试已暂停' : '面试未开始') : undefined,
            style: {
              border: '1px solid var(--dsw-alias-border-l1, #d0d5dd)',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-primary, Canvas)',
              color: 'inherit',
              padding: '7px 12px',
              fontSize: 13,
              cursor: requesting || blocked ? 'not-allowed' : 'pointer',
              opacity: requesting || blocked ? 0.6 : 1,
            },
          }, requesting ? '正在开启…' : usesLocalCamera ? '开启本机预览' : usesWindowsCamera ? '打开 Windows 相机' : '开启摄像头'),
        usesLocalCamera && usesWindowsCamera && phase === 'error' && !blocked && h('button', {
          type: 'button',
          onClick: () => start(true),
          style: { border: '1px solid var(--dsw-alias-border-l1, #d0d5dd)', borderRadius: 8, background: 'var(--dsw-alias-bg-primary, Canvas)', color: 'inherit', padding: '7px 12px', fontSize: 13 },
        }, '打开 Windows 相机'),
      ),
    )
  }
}

// 单测（node:vm）从这里取函数；内联进 client.js 时这个 module 就是 client.js 的模块对象，
// 随后会被 client.js 末尾的 module.exports = { apply, inject } 覆盖，不会外泄。
if (typeof module === 'object' && module && module.exports) {
  Object.assign(module.exports, {
    HR_CANDIDATE_TITLE,
    HR_CANDIDATE_TEXT,
    hrCandidateWindow,
    hrCandidateMedia,
    hrCandidateStopStream,
    hrCandidateErrorText,
    hrCandidateCameraComponent,
  })
}
