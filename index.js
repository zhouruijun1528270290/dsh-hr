import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { InterviewStore } from './lib/store.js'
import { ModelGateway } from './lib/model-gateway.js'
import { SpeechGateway } from './lib/speech-gateway.js'
import { HRInterviewService } from './lib/service.js'
import { createRoleResearch } from './lib/role-research.js'
import { createPublicRoleProvider } from './lib/public-role-sources.js'
import { createDshRoleResearch } from './lib/role-search-agent.js'
import { HR_SERVICE, HR_HOST_CONTRIBUTION, bindRemote } from './lib/contract.js'
import { CredentialGateway } from './lib/credential-gateway.js'
import { createLocalCamera } from './lib/local-camera.js'
import { createAvatarResource, createAvatarRuntimeResource, createBackgroundResource, toNodeHandler } from './lib/avatar-route.js'

export const name = 'hr-interview'
export const inject = []
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
/** 默认使用本包背景；仅本机 config/env 可覆盖根目录，远程仍只有两文件白名单。 */
const DEFAULT_BACKGROUND_DIR = join(PLUGIN_ROOT, 'assets', 'backgrounds')
const execFileAsync = promisify(execFile)

// Desktop's Host runs locally in Electron's Node mode. The ordinary Web Host must not launch GUI apps.
const windowsCameraLauncher = process.platform === 'win32' && process.versions.electron
  ? async () => {
    const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    await execFileAsync(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'microsoft.windows.camera:'",
    ], { windowsHide: true, timeout: 5000 })
  }
  : null

export function createLive2dState(config = {}) {
  const rootDir = config.live2dDir || process.env.HR_INTERVIEW_LIVE2D_DIR
  const runtimeRoot = join(PLUGIN_ROOT, 'lib', 'vendor')
  const backgroundRoot = config.backgroundDir || process.env.HR_INTERVIEW_BACKGROUND_DIR || DEFAULT_BACKGROUND_DIR
  return {
    resource: rootDir ? createAvatarResource({ root: rootDir }) : null,
    runtime: createAvatarRuntimeResource({ root: runtimeRoot, coreFile: config.live2dCoreFile || process.env.HR_INTERVIEW_LIVE2D_CORE_FILE }),
    // 与模型无关：没有 Live2D 模型时背景仍然可用，静态头像回退不受影响。
    backgrounds: createBackgroundResource({ root: backgroundRoot }),
    mounted: false,
    routeError: '',
  }
}

export function mountLive2dRoutes(ctx, state) {
  if (!state?.runtime) return () => {}
  let cleanup = () => { state.mounted = false }
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      state.routeError = 'webserver-unavailable'
      return
    }
    const disposers = []
    cleanup = () => {
      state.mounted = false
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch { /* 重复卸载保持幂等 */ }
      }
    }
    try {
      // 模型资源可能为空（无模型时静态回退），背景与运行时始终尝试挂载。
      for (const resource of [state.resource, state.runtime, state.backgrounds].filter(Boolean)) {
        // 本机 webServer 的 prefix 契约是 Node handler；Fetch resource 仅保留在 state 供能力与测试使用。
        disposers.push(webServer.register({ kind: 'prefix', path: resource.prefix, handler: toNodeHandler(resource) }))
      }
      state.mounted = true
      state.routeError = ''
    } catch {
      state.routeError = 'route-registration-failed'
      cleanup()
    }
    // cordis 由 scoped.effect 负责禁用/重载清理；只返回 inject 回调值不足以注销路由。
    scoped.effect(() => cleanup, 'hr-interview: avatar routes')
  })
  return () => cleanup()
}
export function apply(ctx, config = {}) {
  let speech = null; let speechToText = null; let llm = null; let model = null
  let web = null
  let agentScope = null
  const credentials = new CredentialGateway()
  const avatar = createLive2dState(config)
  const localCamera = windowsCameraLauncher ? createLocalCamera() : null
  mountLive2dRoutes(ctx, avatar)
  if (localCamera) ctx.inject(['webServer'], (child) => {
    try {
      const cleanup = localCamera.mount(child.webServer)
      child.effect(() => cleanup, 'hr-interview: local camera')
    } catch { /* The independent Windows Camera window remains available. */ }
  })
  ctx.inject(['credentials'], (child) => {
    credentials.setService(child.credentials)
    return () => credentials.setService(null)
  })
  ctx.inject(['typert'], (child) => {
    if (!child.typert || typeof child.typert.register !== 'function' || typeof child.provide !== 'function') throw new TypeError('hr-interview requires typert.register and ctx.provide')
    const store = new InterviewStore(config.dataDir || process.env.HR_INTERVIEW_DATA_DIR || join(homedir(), '.dsh', 'data', 'hr-interview'))
    speech = new SpeechGateway(config, fetch, { speechToText, credentials })
    model = new ModelGateway(config, fetch, { llm })
    const agentResearch = createDshRoleResearch(() => agentScope)
    const service = new HRInterviewService({ store, model, speech, avatar, windowsCameraLauncher, localCamera,
      roleResearch: createRoleResearch(createPublicRoleProvider(() => web, agentResearch)) })
    bindRemote(service)
    child.provide(HR_SERVICE, service)
    child.typert.register(HR_HOST_CONTRIBUTION)
    return () => { void service.close().catch(() => {}) }
  })
  ctx.inject(['web'], (child) => {
    web = child.web
    return () => { web = null }
  })
  ctx.inject(['agents', 'tools', 'systemPrompt'], (child) => {
    agentScope = child
    return () => { agentScope = null }
  })
  ctx.inject(['llm'], (child) => {
    llm = child.llm; if (model) model.llm = llm
    return () => { llm = null; if (model) model.llm = null }
  })
  ctx.inject(['speechToText'], (child) => {
    speechToText = child.speechToText; speech?.setSpeechToText(speechToText)
    return () => { speechToText = null; speech?.setSpeechToText(null) }
  })
}
