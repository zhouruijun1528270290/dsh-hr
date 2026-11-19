import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { HR_QUESTION_TOPIC_LABELS, isPressureInterview, parseSessionId, remoteFailure, suggestTargetRole } from './contract.js'
import { deliveryMetrics, normalizeEvaluation, applyKnowledge } from './evaluation.js'
import { interviewRoleScope, sameOutlineDirection } from './role-research.js'
import { QUESTION_SEQUENCE_VERSION, clarifyQuestionScenario, confirmedContextAnswer, contextCheckQuestion, contextProbeQuestion, introducedProject, requiredMainQuestionContext, requiredQuestionContext, scenarioQuestion } from './question-sequence.js'

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const now = () => new Date().toISOString()
const isPreparedForDuties = (plan) => plan?.dutyPlan === true && plan.questionSequenceVersion === QUESTION_SEQUENCE_VERSION
  && (!plan.reviewAfter || plan.reviewAfter >= now().slice(0, 10))
const matchesQuestionSource = (plan, settings) => (plan?.sourceSettingsUpdatedAt || null) === (settings?.updatedAt || null)
const outlineDirections = (plan, mainOnly = false) => [...new Set(plan.items
  .filter((item) => item.duty && (!mainOnly || !item.alternate)).map((item) => item.duty))]
const hasMaterialsForInterview = (materials, roleResearch) => (roleResearch && String(materials.role || '').trim())
  || (String(materials.resume || '').trim() && String(materials.jd || '').trim())
const questionBudget = (minutes) => ({ 15: 4, 30: 6, 45: 8, 60: 10 })[minutes] || 6
const cleanQuestion = (value) => String(value || '').trim().slice(0, 1600)
const normalizedAnswer = (value) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : ''
const PRESSURE_PREFACE = /^(?:你刚(?:才)?(?:提到|说)(?:了|过)?[「“"][^」”"]{1,90}[」”"]|(?:根据|结合|基于)(?:你(?:刚才|前面|之前)?的?)?(?:上述|上面|刚才|前面的|以上)?(?:项目)?(?:经历|回答|介绍|描述|做法|内容))[\s，,。:：]+/u
const questionKey = (value) => normalizedAnswer(value).replace(PRESSURE_PREFACE, '').toLowerCase().replace(/[\p{P}\s]+/gu, '')
function groundedFollowup(decision, answer, previousQuestion, pressure) {
  const quote = normalizedAnswer(decision.answerQuote)
  let question = cleanQuestion(decision.question)
  if (quote.length < 4 || quote.length > 80 || !normalizedAnswer(answer).includes(quote)) return ''
  if (pressure) question = question.replace(PRESSURE_PREFACE, '').trim()
  if (!question || requiredQuestionContext(question) || normalizedAnswer(question) === normalizedAnswer(previousQuestion)) return ''
  if (pressure) return quote.length >= 14 && normalizedAnswer(question).includes(quote) ? '' : question
  return normalizedAnswer(question).includes(quote) ? question : `你刚才提到「${quote}」。${question}`
}
const PRESSURE_OPENING = '挑一个最接近这个岗位的项目或工作经历。它要解决什么问题？说清你亲自做的一个决定，以及你是怎么判断这个决定是否有效的。'
const PRESSURE_RECOVERIES = [
  '先停一下。把这题拆小，你第一步会验证什么？',
  '具体一点。你会先查哪项信息，再决定怎么做？',
  '先不用给完整答案。告诉我你会从哪一点开始验证？',
]
const PRESSURE_TRANSITIONS = ['这个点先放一放。', '这题先到这里。', '换个问题。']
const STUCK_LEAD = /^(?:嗯|呃|抱歉|不好意思|我|这个(?:问题|点)?|这(?:道)?题|这一块|这里|确实|真的|暂时|目前|有点|一下子|一时|还|也|都|现在){0,8}/u
const STUCK_REPLY = /^(?:(?:回答|答|说)不(?:上来|出来|上|出)|想不(?:出|出来|起来|到)|记不(?:太清|清楚|清|起来|得)|忘(?:记)?了?|不(?:太|是很|怎么)?(?:知道|会|懂|清楚|了解)|没(?:有)?(?:思路|想法)|无法回答)(?:这个(?:问题|点)?|这(?:道)?题|怎么(?:回答|答|做|验证)|从哪里开始|怎么办|该怎么办|了|啊|吧|呢|诶|哎){0,4}$/u
const UNKNOWN_TERM = /^(?:不知道|不清楚|不懂)什么是[\p{L}\p{N} _\-]{1,24}$/u
function explicitlyStuck(value) {
  const reply = normalizedAnswer(value)
  if (reply.length > 64) return false
  const clauses = reply.split(/[，。,.？！?!…、；;]+/u)
    .map((part) => part.replace(/\s/gu, '').replace(STUCK_LEAD, '')).filter(Boolean)
  return clauses.length > 0 && clauses.every((part) => STUCK_REPLY.test(part) || UNKNOWN_TERM.test(part) || /^(?:不知道){2,4}$/u.test(part))
}
const pressureExperienceQuestion = (question) => !/^(?:假设|假如|设想|如果)/u.test(question)
  && /你(?:们)?的\s*(?:Agent|项目|服务|系统|实现)|^(?:讲|说|举)(?:一次|一个|一段).{0,50}经历/iu.test(question)
const PRESSURE_FOCI = new Set(['evidence', 'counterexample', 'constraint'])
const PRESSURE_CHALLENGES = new Set(['counterexample', 'constraint'])
const activeStatuses = new Set(['waiting_for_answer', 'processing_answer', 'generating_question', 'error', 'paused'])
const safeError = (error) => {
  const known = { 'hr-interview/asr-preparation': '本地 ASR 尚未准备完成，请在 DSH 语音设置中准备模型，或使用文字降级', 'hr-interview/asr-local': '本地 ASR 转写失败，请重试或使用文字降级', 'hr-interview/asr-wave-required': '录音格式不符合本地 ASR 要求，请重试或使用文字降级', 'hr-interview/asr-not-configured': 'ASR 未配置，请准备本地语音或配置 HTTP ASR' }
  return known[error?.code] || String(error?.message || error || 'Unknown error').replace(/sk-[A-Za-z0-9_-]+/gi, 'sk-***').slice(0, 500)
}
const ABORTED = 'hr-interview/aborted'
const abortedFailure = () => Object.assign(remoteFailure(ABORTED, 'Request aborted'), { aborted: true })
const isAbortFailure = (error) => Boolean(error?.aborted) || error?.code === ABORTED
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')
const base64Bytes = (value) => Buffer.byteLength(String(value || ''), 'utf8')
const positiveInt = (value, fallback) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback }
const sameSummary = (a, b) => Math.max(0, Number(a?.agentQuestions) || 0) === Math.max(0, Number(b?.agentQuestions) || 0)
  && Math.max(0, Number(a?.resumeQuestions) || 0) === Math.max(0, Number(b?.resumeQuestions) || 0)
const DEFAULT_CACHE_LIMITS = { maxEntries: 128, maxBytes: 32 * 1024 * 1024 }
const PREVIEW_TEXT = '你好，我是你的模拟面试官。请放松，我们会根据你的回答继续追问。'
const resolveResponseLatency = (delivery, askedAt) => {
  const explicit = Number(delivery?.responseLatencyMs)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const asked = Date.parse(askedAt)
  return Number.isFinite(asked) ? Math.max(0, Date.now() - asked) : 0
}
export class HRInterviewService {
  constructor({ store, model, speech, avatar = null, speechCache, resumeParser = null, resumeConcurrency = 2, marketBankFactory = null, selectionSeedFactory = null, msyCandidates = [], roleResearch = null, windowsCameraLauncher = null, localCamera = null } = {}) {
    this.store = store; this.model = model; this.speech = speech; this.avatar = avatar; this.locks = new Map(); this.speechCache = new Map()
    this.requests = new Map()
    this.resumeParser = resumeParser
    this.marketBankFactory = marketBankFactory
    this.roleResearch = roleResearch
    this.windowsCameraLauncher = windowsCameraLauncher
    this.localCamera = localCamera
    this.researchAbort = new AbortController()
    this.selectionSeedFactory = selectionSeedFactory || (() => randomUUID().replace(/-/g, '').slice(0, 12))
    // 自动识别只认「显式注入的候选 + HR_INTERVIEW_MSY_DIR」，不内置任何机器相关路径；
    // 没有盘符的裸相对路径（含空串）在这里就被丢掉，绝不进入候选列表。
    this.msyCandidates = [...new Set([...msyCandidates, process.env.HR_INTERVIEW_MSY_DIR]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim())
      .filter((value) => value.length <= 1024 && isAbsolute(value)))]
    this.marketBank = null
    this.planLib = null
    this.resumeActive = 0
    this.resumeLimit = positiveInt(resumeConcurrency, 2)
    this.cacheLimits = {
      maxEntries: positiveInt(speechCache?.maxEntries, DEFAULT_CACHE_LIMITS.maxEntries),
      maxBytes: positiveInt(speechCache?.maxBytes, DEFAULT_CACHE_LIMITS.maxBytes),
    }
  }
  async withLock(id, task) {
    const previous = this.locks.get(id) || Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    this.locks.set(id, next)
    return next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id) })
  }
  trackRequest(id, task) {
    const controller = new AbortController()
    let pending = this.requests.get(id)
    if (!pending) { pending = new Set(); this.requests.set(id, pending) }
    pending.add(controller)
    const release = () => {
      pending.delete(controller)
      if (!pending.size && this.requests.get(id) === pending) this.requests.delete(id)
    }
    let running
    try { running = Promise.resolve(task(controller.signal)) } catch (error) { release(); return Promise.reject(error) }
    return running.finally(release)
  }
  abortRequests(id) {
    const pending = this.requests.get(id)
    if (!pending) return 0
    const controllers = [...pending]
    this.requests.delete(id)
    for (const controller of controllers) { if (!controller.signal.aborted) controller.abort() }
    return controllers.length
  }
  isAborted(signal, error) { return Boolean(signal?.aborted) || isAbortFailure(error) }
  async avatarCapabilities() {
    if (!this.avatar) return { kind: 'static', available: false, reason: 'not-configured' }
    if (!this.avatar.resource || !this.avatar.runtime) return { kind: 'static', available: false, reason: this.avatar.routeError || 'not-configured' }
    if (!this.avatar.mounted) return { kind: 'static', available: false, reason: this.avatar.routeError || 'webserver-unavailable' }
    try {
      const [description, runtime] = await Promise.all([this.avatar.resource.describe(), this.avatar.runtime.describe()])
      if (!description.available) return { kind: 'static', available: false, reason: description.reason || 'avatar-unavailable' }
      if (!runtime.available) return { kind: 'static', available: false, reason: 'runtime-unavailable' }
      return { kind: 'live2d', available: true, base: description.prefix, model: description.entry, runtimeBase: runtime.prefix, reason: 'ok' }
    } catch {
      return { kind: 'static', available: false, reason: 'avatar-unavailable' }
    }
  }
  /**
   * 虚拟背景只暴露相对 URL 与展示名：路由或资源不可用时是空数组，
   * 任何情况下都不把宿主目录（root）带给客户端。
   */
  async backgroundCapabilities() {
    const resource = this.avatar?.backgrounds
    if (!resource || typeof resource.describe !== 'function') return []
    if (!this.avatar.mounted || this.avatar.routeError) return []
    try {
      const description = await resource.describe()
      if (!description?.available || !Array.isArray(description.backgrounds)) return []
      return description.backgrounds.map(({ id, label, url }) => ({ id, label, url }))
    } catch {
      return []
    }
  }
  async capabilities() {
    const speech = typeof this.speech.currentCapabilities === 'function' ? await this.speech.currentCapabilities() : this.speech.capabilities()
    return { ...this.model.capabilities(), ...speech, avatar: await this.avatarCapabilities(), backgrounds: await this.backgroundCapabilities(), audioPersistent: false, version: PACKAGE_VERSION, roleDutyPreparation: Boolean(this.roleResearch), windowsCamera: Boolean(this.windowsCameraLauncher), localCamera: this.localCamera?.available() === true }
  }
  async startLocalCamera(id) {
    const sessionId = parseSessionId(id)
    return this.withLock(sessionId, async () => {
      if (!this.localCamera?.available()) throw remoteFailure('hr-interview/local-camera-unavailable', '本机摄像头助手暂不可用')
      const { session } = await this.store.get(sessionId)
      if (!activeStatuses.has(session.status) || session.status === 'paused') throw remoteFailure('hr-interview/local-camera-inactive', '请在面试进行中开启摄像头预览')
      return this.localCamera.start(sessionId)
    })
  }
  async stopLocalCamera(id, token) {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) this.localCamera?.stop(parseSessionId(id), token)
    return { stopped: true }
  }
  async openWindowsCamera(id) {
    if (!this.windowsCameraLauncher) throw remoteFailure('hr-interview/windows-camera-unavailable', 'Windows 相机仅可由本机 DSH 桌面版打开')
    const { session } = await this.store.get(parseSessionId(id))
    if (!activeStatuses.has(session.status) || session.status === 'paused') throw remoteFailure('hr-interview/windows-camera-inactive', '请在面试进行时打开 Windows 相机')
    this.localCamera?.stop(id)
    try { await this.windowsCameraLauncher() }
    catch { throw remoteFailure('hr-interview/windows-camera-launch', '未能打开 Windows 相机，请从 Windows 开始菜单打开「相机」') }
    return { requested: true }
  }
  async credentialStatus() {
    if (typeof this.speech.credentialStatus !== 'function') throw remoteFailure('hr-interview/credentials-unavailable', '当前语音通道未提供凭据状态')
    return this.speech.credentialStatus()
  }
  async saveApiKey(value) {
    if (typeof this.speech.saveApiKey !== 'function') throw remoteFailure('hr-interview/credentials-unavailable', '当前语音通道未提供凭据保存')
    return this.speech.saveApiKey(value)
  }
  async clearApiKey() {
    if (typeof this.speech.clearApiKey !== 'function') throw remoteFailure('hr-interview/credentials-unavailable', '当前语音通道未提供凭据清除')
    return this.speech.clearApiKey()
  }
  async materials() { return this.store.materials() }
  async saveMaterials(materials) { return this.store.saveMaterials(materials) }
  sourceView(value) {
    const configured = Boolean(String(value?.msyDir || '').trim())
    const summary = value?.sourceSummary && typeof value.sourceSummary === 'object' ? {
      agentQuestions: Math.max(0, Number(value.sourceSummary.agentQuestions) || 0),
      resumeQuestions: Math.max(0, Number(value.sourceSummary.resumeQuestions) || 0),
    } : null
    return { msyDir: String(value?.msyDir || ''), updatedAt: value?.updatedAt || null, configured, displayName: 'msy 本地题库', sourceSummary: summary }
  }
  async sourceSettings() { return this.sourceView(await this.store.sourceSettings()) }
  async inspectMsyDirectory(root) {
    const { readMsySource } = await import('./msy-connector.js')
    const source = await readMsySource({ dir: root })
    return {
      // readMsySource 的 stats 里可导入题数是 imported（filteredAccepted 是历史字段名，保留兜底）。
      agentQuestions: Math.max(0, Number(source?.stats?.imported ?? source?.stats?.filteredAccepted) || 0),
      resumeQuestions: Array.isArray(source?.resume) ? source.resume.length : 0,
    }
  }
  async saveSourceSettings(value) {
    // 与 prepareInterview 共用一把锁，避免关闭正在使用的连接。
    return this.withLock('prepare', async () => {
      const msyDir = String(value?.msyDir || '').trim()
      const current = await this.store.sourceSettings()
      if (!msyDir) {
        const empty = { agentQuestions: 0, resumeQuestions: 0 }
        if (String(current?.msyDir || '') === '' && sameSummary(current?.sourceSummary, empty)) return this.sourceView(current)
        await this.closeMarketBank()
        const saved = await this.store.saveSourceSettings({ msyDir: '', sourceSummary: empty })
        return this.sourceView(saved)
      }
      if (!isAbsolute(msyDir) || msyDir.length > 1024) throw remoteFailure('hr-interview/invalid-source-dir', '请输入有效的本地题库绝对目录')
      const root = resolve(msyDir)
      let sourceSummary
      try {
        const [directory, questions] = await Promise.all([stat(root), stat(resolve(root, 'data', 'questions.ndjson'))])
        if (!directory.isDirectory() || !questions.isFile()) throw new Error('invalid')
        sourceSummary = await this.inspectMsyDirectory(root)
      } catch {
        throw remoteFailure('hr-interview/source-dir-not-ready', '目录无效或题库无法读取，请选择包含 data/questions.ndjson 的 msy 目录')
      }
      // 同目录且统计没变：只重扫不落盘，updatedAt 保持不动，已有提纲与快照继续命中。
      if (String(current?.msyDir || '') === root && sameSummary(current?.sourceSummary, sourceSummary)) return this.sourceView(current)
      await this.closeMarketBank()
      const saved = await this.store.saveSourceSettings({ msyDir: root, sourceSummary })
      return this.sourceView(saved)
    })
  }
  async detectMsySource() {
    const current = await this.store.sourceSettings()
    const candidates = [...new Set([current?.msyDir, ...this.msyCandidates].filter(Boolean))]
    for (const candidate of candidates) {
      try { return await this.saveSourceSettings({ msyDir: candidate }) } catch { /* 只尝试明确的候选目录，不扫描无关目录 */ }
    }
    throw remoteFailure('hr-interview/source-not-found', '未识别到可用的 msy 题库，请选择题库目录或使用高级设置')
  }
  async getPlanLib() {
    if (!this.planLib) this.planLib = await import('./question-plan.js')
    return this.planLib
  }
  async getMarketBank() {
    if (!this.marketBank) {
      const settings = typeof this.store.sourceSettings === 'function' ? await this.store.sourceSettings() : { msyDir: '' }
      const msyDir = String(settings?.msyDir || '')
      const bank = this.marketBankFactory
        ? await this.marketBankFactory({ root: this.store.root, msyDir })
        : new (await import('./market-bank.js')).MarketQuestionBank({ root: this.store.root, msyDir })
      try { await bank.init() } catch (error) {
        try { await bank.close() } catch { /* 初始化失败时仍要释放可能已打开的连接 */ }
        throw error
      }
      this.marketBank = bank
    }
    return this.marketBank
  }
  async latestPreparation(options = {}) {
    const { materialsProfile } = await this.getPlanLib()
    const materials = await this.store.materials()
    const profile = materialsProfile(materials, { durationMinutes: options.durationMinutes || 30 })
    const latest = await this.store.latestPreparation()
    if (!latest) return null
    const settings = await this.store.sourceSettings?.()
    return { ...latest, profileMatches: latest.profileKey === profile.profileKey && matchesQuestionSource(latest, settings)
      && (!this.roleResearch || isPreparedForDuties(latest)) }
  }
  async prepareInterview(options = {}) {
    return this.withLock('prepare', async () => {
      const signal = this.researchAbort.signal
      signal.throwIfAborted()
      await this.store.init()
      const materials = await this.store.materials()
      if (!hasMaterialsForInterview(materials, this.roleResearch)) throw remoteFailure('hr-interview/materials-required', this.roleResearch ? '请先保存目标岗位，或填写简历与岗位 JD' : '请先保存简历和岗位 JD，再准备面试')
      const { materialsProfile, buildQuestionPlan, detectRolePack, selectionDiff } = await this.getPlanLib()
      const durationMinutes = options.durationMinutes || 30
      const profile = materialsProfile(materials, { durationMinutes })
      const sourceSettings = typeof this.store.sourceSettings === 'function' ? await this.store.sourceSettings() : { updatedAt: null }
      const latest = await this.store.latestPreparation({ profileKey: profile.profileKey })
      const currentOutline = isPreparedForDuties(latest) && matchesQuestionSource(latest, sourceSettings) ? latest : null
      const changingDirections = options.changeDirections === true && Boolean(this.roleResearch && currentOutline)
      const refreshingQuestions = !changingDirections && options.refresh === true
      const fixedOutline = refreshingQuestions ? currentOutline : null
      const previousDirections = changingDirections ? outlineDirections(currentOutline, true) : null
      const recentDirections = Array.isArray(currentOutline?.directionHistory) ? currentOutline.directionHistory : []
      const bank = await this.getMarketBank()
      const [items, knowledge] = await Promise.all([bank.listActive({ rolePack: detectRolePack(materials), limit: 1000 }), this.store.knowledge()])
      const baseInput = { materials, items, knowledge, durationMinutes, now: new Date() }
      const research = this.roleResearch && await this.roleResearch({ ...baseInput, cache: await this.store.roleEvidence(),
        refresh: refreshingQuestions, fixedDirections: fixedOutline ? outlineDirections(fixedOutline) : null,
        fixedRoleContextMissing: fixedOutline?.roleContextMissing === true, previousDirections, recentDirections,
        previousQuestionIds: changingDirections ? currentOutline.items.filter((item) => !item.alternate).map((item) => item.bankItemId) : [], signal })
      const unavailable = () => ({ ...currentOutline, profileMatches: true, directionRefresh: { changed: 0 } })
      if (research) {
        signal.throwIfAborted()
        const current = materialsProfile(await this.store.materials(), { durationMinutes })
        if (current.profileKey !== profile.profileKey) throw remoteFailure('hr-interview/preparation-input-changed', '准备期间材料发生变化，请重新准备面试')
        if (changingDirections && research.directionChangeUnavailable) return unavailable()
        await this.store.cacheRoleEvidence(research.updates, signal)
      }
      const build = research ? research.build : (overrides) => buildQuestionPlan({ ...baseInput, ...overrides })
      const deterministic = build({ keepOpening: changingDirections && currentOutline.items.some((item) => item.opening) })
      let plan = deterministic
      let refreshMeta = null
      let directionRefresh = null
      if (changingDirections) {
        const changed = outlineDirections(plan, true).filter((duty) => !previousDirections.some((prior) => sameOutlineDirection(duty, prior))).length
        if (!changed) return unavailable()
        directionRefresh = { changed }
      } else if (!refreshingQuestions) {
        const reusable = await this.store.latestPreparation({ profileKey: profile.profileKey, planKey: deterministic.planKey })
        if (reusable && (!research || isPreparedForDuties(reusable))
          && matchesQuestionSource(reusable, sourceSettings)) return { ...reusable, profileMatches: true }
      } else {
        let best = null
        let attempts = 0
        for (; attempts < 4;) {
          attempts += 1
          const candidate = build({ selectionSeed: this.selectionSeedFactory(), avoidItemIds: (latest?.items || []).map((item) => item?.bankItemId).filter(Boolean),
            previousItems: fixedOutline?.items, previousReviewAfter: fixedOutline?.reviewAfter })
          const diff = selectionDiff(latest?.items || [], candidate.items)
          if (!best || diff.mainChanged > best.diff.mainChanged || (diff.mainChanged === best.diff.mainChanged && diff.changed > best.diff.changed)) best = { plan: candidate, diff }
          if (diff.mainChanged > 0) break
        }
        if (latest && matchesQuestionSource(latest, sourceSettings) && best.diff.changed === 0
          && (!research || (isPreparedForDuties(latest) && !Object.keys(research.updates).length))) {
          return { ...latest, profileMatches: true, refresh: { requested: true, changed: 0, mainChanged: 0, attempts, exhausted: true, notice: '题库里可换的题不够，已保留当前提纲' } }
        }
        plan = best.plan
        refreshMeta = { requested: true, changed: best.diff.changed, mainChanged: best.diff.mainChanged, attempts, exhausted: false }
      }
      const latestMaterials = await this.store.materials()
      const currentProfile = materialsProfile(latestMaterials, { durationMinutes })
      if (currentProfile.profileKey !== profile.profileKey) throw remoteFailure('hr-interview/preparation-input-changed', '准备期间材料发生变化，请重新准备面试')
      const stats = await bank.stats()
      const sources = stats?.sources && typeof stats.sources === 'object' ? stats.sources : {}
      const warnings = Array.isArray(stats?.warnings) ? stats.warnings.map((entry) => String(entry)).filter((entry) => !entry.includes('非 Agent 方向题目')).map((entry) => entry.slice(0, 200)).slice(0, 6) : []
      const createdAt = now()
      if (research) signal.throwIfAborted()
      // refresh 是一次操作的元信息，不进冻结快照：落盘内容只取决于选题结果本身，
      // 旧 preparation 与普通 prepare 的复用判断不受它影响；RPC 返回值再补上这一块。
      const directionHistory = changingDirections ? [...previousDirections, ...recentDirections].slice(0, 18) : fixedOutline ? recentDirections : []
      const saved = await this.store.savePreparation({ ...plan, sources, warnings, directionHistory, sourceSettingsUpdatedAt: sourceSettings?.updatedAt || null, preparationId: `prep-${randomUUID()}`, createdAt, materialsUpdatedAt: materials.updatedAt || null, profileMatches: true })
      return directionRefresh ? { ...saved, directionRefresh } : refreshMeta ? { ...saved, refresh: refreshMeta } : saved
    })
  }
  async preparationForStart(materials, options) {
    if (!options.preparationId) return null
    const preparation = await this.store.getPreparation(options.preparationId)
    const main = Number(preparation?.questionBudget?.main)
    const hasMain = Array.isArray(preparation?.items) && preparation.items.some((item) => !item?.alternate)
    if (!preparation || !Array.isArray(preparation.items) || !preparation.items.length || !Number.isInteger(main) || main < 1 || main > preparation.items.length || !hasMain) throw remoteFailure('hr-interview/preparation-not-ready', '面试提纲不存在或不完整，请重新准备')
    const { materialsProfile } = await this.getPlanLib()
    const profile = materialsProfile(materials, { durationMinutes: options.durationMinutes })
    if (preparation.profileKey !== profile.profileKey) throw remoteFailure('hr-interview/preparation-stale', '材料、岗位或时长已变化，请重新准备面试')
    if (!matchesQuestionSource(preparation, await this.store.sourceSettings?.())) throw remoteFailure('hr-interview/preparation-stale', '题库已变化，请重新准备面试')
    if (this.roleResearch && !isPreparedForDuties(preparation)) throw remoteFailure('hr-interview/preparation-stale', '请按当前岗位重新准备面试提纲')
    return preparation
  }
  async closeMarketBank() {
    const bank = this.marketBank
    this.marketBank = null
    await bank?.close()
  }
  async close() {
    this.localCamera?.stop()
    this.researchAbort.abort()
    await this.withLock('prepare', () => this.closeMarketBank())
  }
  async parseResume(upload) {
    if (this.resumeActive >= this.resumeLimit) throw remoteFailure('hr-interview/resume-busy', '正在处理其它简历，请稍后再试')
    this.resumeActive += 1
    try {
      const parser = this.resumeParser || (await import('./resume-parser.js')).parseResumeFile
      const parsed = await parser({ name: upload.name, data: Buffer.from(upload.dataBase64, 'base64') })
      const suggestion = suggestTargetRole({ fileName: parsed.fileName || upload.name, text: parsed.text })
      return { ...parsed, suggestedRole: suggestion.role, suggestedRoleSource: suggestion.source }
    } catch (error) {
      if (String(error?.code || '').startsWith('hr-interview/')) throw error
      throw remoteFailure('hr-interview/resume-parse', '简历解析失败，请检查文件后重试')
    } finally {
      this.resumeActive -= 1
    }
  }
  async list() { return { sessions: await this.store.list(), knowledge: await this.store.knowledge(), now: now() } }
  async knowledge() { return this.store.knowledge() }
  async get(id) { return this.store.get(parseSessionId(id)) }
  async start(options, drillMaterials = null) {
    await this.store.init()
    const materials = drillMaterials || await this.store.materials()
    if (!hasMaterialsForInterview(materials, this.roleResearch)) throw remoteFailure('hr-interview/materials-required', this.roleResearch ? '请先保存目标岗位，或填写简历与岗位 JD' : '请先在材料页填写简历和岗位 JD')
    const auto = !options.preparationId && this.roleResearch && options.mode !== 'drill' ? await this.prepareInterview(options) : null
    const preparation = await this.preparationForStart(materials, auto ? { ...options, preparationId: auto.preparationId } : options)
    const budget = preparation ? Math.min(questionBudget(options.durationMinutes), Number(preparation.questionBudget.main), preparation.items.filter((item) => !item.alternate).length) : questionBudget(options.durationMinutes)
    const session = {
      sessionId: `hr-${randomUUID()}`, status: 'waiting_for_hr', mode: options.mode, persona: options.persona,
      durationMinutes: options.durationMinutes, questionBudget: budget,
      mainQuestionCount: 0, followupCount: 0, followupLimit: 2, currentQuestionId: null,
      inputMode: options.inputMode, asrProvider: options.asrProvider || 'auto', ttsProvider: options.ttsProvider || 'auto', voice: options.voice || 'stella', oralAcceptanceEligible: options.inputMode === 'voice',
      targetKnowledgePointId: options.targetKnowledgePointId || null, parentSessionId: options.parentSessionId || null,
      createdAt: now(), updatedAt: now(), endedAt: null, lastError: null, materialsSnapshot: materials,
      ...(preparation ? { preparationId: preparation.preparationId, preparation } : {}),
      config: { role: materials.role },
    }
    await this.store.createSession(session)
    const sessionId = session.sessionId
    return this.withLock(sessionId, async () => {
      try { return await this.askNext(sessionId) }
      catch { return this.store.get(sessionId) }
    })
  }
  async createDrill(id, knowledgePointId) {
    const source = await this.store.get(parseSessionId(id))
    return this.start({ mode: 'drill', persona: source.session.persona, durationMinutes: 15, inputMode: source.session.inputMode, asrProvider: source.session.asrProvider, ttsProvider: source.session.ttsProvider, voice: source.session.voice, parentSessionId: id, targetKnowledgePointId: knowledgePointId || null }, source.session.materialsSnapshot)
  }
  async context(id) {
    const bundle = await this.store.get(id)
    const materials = bundle.session.materialsSnapshot || await this.store.materials()
    const history = await this.store.knowledge()
    const knowledge = this.roleResearch || bundle.session.preparation?.dutyPlan
      ? history.filter((point) => point && (point.roleScope === interviewRoleScope(materials.role) || point.id === bundle.session.targetKnowledgePointId))
      : history
    return { ...bundle, materials, knowledge }
  }
  async submitText(id, text, delivery = {}) {
    const extra = delivery.asrModel ? { asrModel: delivery.asrModel, asrRequestId: delivery.asrRequestId, asrDurationMs: delivery.asrDurationMs } : {}
    return this.withLock(parseSessionId(id), () => this.processAnswer(id, text, delivery, extra))
  }
  async recognize(id, audio) {
    const sessionId = parseSessionId(id)
    return this.trackRequest(sessionId, (signal) => this.transcribeAudio(sessionId, audio, signal))
  }
  async transcribeAudio(id, audio, signal) {
    const bundle = await this.store.get(id)
    if (bundle.session.status !== 'waiting_for_answer') throw remoteFailure('hr-interview/invalid-state', `Cannot transcribe audio in ${bundle.session.status}`)
    if (this.isAborted(signal)) throw abortedFailure()
    const started = Date.now()
    try {
      const transcript = await this.speech.transcribe(audio, { provider: bundle.session.asrProvider || 'auto', signal })
      if (this.isAborted(signal)) throw abortedFailure()
      return { ...transcript, latencyMs: Date.now() - started }
    } catch (error) {
      if (this.isAborted(signal, error)) throw abortedFailure()
      await this.store.saveSession({ ...bundle.session, lastError: safeError(error) }, bundle.turns)
      throw remoteFailure(error.code || 'hr-interview/asr-failed', safeError(error))
    }
  }
  async transcribe(id, audio) {
    return this.withLock(parseSessionId(id), () => this.recognize(id, audio))
  }
  async submitAudio(id, audio, delivery = {}) {
    return this.withLock(parseSessionId(id), async () => {
      const transcript = await this.recognize(id, audio)
      return this.processAnswer(id, transcript.text, { ...delivery, asrLatencyMs: transcript.latencyMs }, { asrModel: transcript.model, asrRequestId: transcript.requestId, asrDurationMs: transcript.durationMs })
    })
  }
  async processAnswer(id, text, delivery = {}, extra = {}) {
    const bundle = await this.context(id)
    const { session, turns } = bundle
    if (session.status !== 'waiting_for_answer') throw remoteFailure('hr-interview/invalid-state', `Cannot answer in ${session.status}`)
    const current = turns.at(-1)
    if (!current || current.speaker !== 'hr' || !['main_question', 'followup'].includes(current.kind)) throw remoteFailure('hr-interview/invalid-state', 'No active HR question')
    const candidate = {
      id: `t-${randomUUID()}`, sequence: turns.length + 1, speaker: 'candidate', kind: extra.kind || 'answer',
      text: String(text).trim(), questionId: current.questionId, answeredAt: now(),
      deliveryMeta: deliveryMetrics(text, { ...delivery, responseLatencyMs: resolveResponseLatency(delivery, current.askedAt) }),
      ...(extra.asrModel ? { asrMeta: { model: extra.asrModel, requestId: extra.asrRequestId || null, durationMs: extra.asrDurationMs || 0, audioRetained: false } } : {}),
    }
    const nextTurns = [...turns, candidate]
    if (nextTurns.length > 120) return this.finish(id, nextTurns, '达到单场记录上限')
    if (delivery.usedFallback || (session.inputMode === 'voice' && !extra.asrModel && !extra.kind)) session.oralAcceptanceEligible = false
    await this.store.saveSession({ ...session, status: 'processing_answer', lastError: null }, nextTurns)
    const result = await this.askNext(id, { forceNext: extra.forceNext })
    const finalTurns = result.turns.map((turn) => turn.id === candidate.id ? { ...turn, deliveryMeta: { ...turn.deliveryMeta, processingLatencyMs: result.lastLatencyMs || 0 } } : turn)
    await this.store.saveSession(result.session, finalTurns, result.evaluation === null ? undefined : result.evaluation)
    return this.store.get(id)
  }
  async askNext(id, options = {}) {
    const sessionId = parseSessionId(id)
    return this.trackRequest(sessionId, (signal) => this.generateQuestion(sessionId, options, signal))
  }
  async generateQuestion(id, options, signal) {
    const bundle = await this.context(id)
    const { session, turns } = bundle
    if (this.isAborted(signal)) throw abortedFailure()
    if (turns.length > 120) return this.finish(id, turns, '达到单场记录上限')
    await this.store.saveSession({ ...session, status: 'generating_question', lastError: null }, turns)
    if (this.isAborted(signal)) throw abortedFailure()
    const started = Date.now()
    const planItems = Array.isArray(session.preparation?.items) ? session.preparation.items : []
    const lastHr = [...turns].reverse().find((turn) => turn.speaker === 'hr')
    const currentPlanItem = lastHr?.planItemId ? clarifyQuestionScenario(planItems.find((item) => item.planItemId === lastHr.planItemId)) || null : null
    const nextPlanItem = clarifyQuestionScenario(planItems[session.mainQuestionCount]) || null
    const dutyPlan = session.preparation?.dutyPlan === true
    const currentQuestion = dutyPlan && currentPlanItem ? { ...currentPlanItem, question: lastHr.text, stage: lastHr.questionStage } : currentPlanItem
    const planContext = session.preparation ? { current: currentQuestion, next: nextPlanItem, questionBudget: session.questionBudget, dutyPlan } : null
    const last = turns.at(-1)
    const pressure = isPressureInterview(session)
    const answered = !options.forceNext && last?.speaker === 'candidate' && last.kind !== 'no_answer'
    const stuck = pressure && answered && explicitlyStuck(last.text)
    const pressureBlackFace = pressure && session.pressureBlackFace === true
    const assessPressureAnswer = pressureBlackFace && answered && !stuck && last.questionId === lastHr?.questionId
    const pastRecoveries = pressure ? turns.filter((turn) => turn.pressureFocus === 'recovery').length : 0
    const pressureRecovery = stuck && lastHr?.pressureFocus !== 'recovery'
      && Boolean(lastHr?.questionId) && session.followupCount < session.followupLimit
    const afterPressureRecovery = pressure && answered && lastHr?.pressureFocus === 'recovery'
    const pressureEvidenceAsked = pressure && answered && lastHr?.pressureFocus === 'evidence'
    const contextToCheck = lastHr?.questionStage === 'context-check' ? lastHr.contextRequirement : null
    const contextFollowup = dutyPlan && !options.forceNext && contextToCheck && currentPlanItem && last?.speaker === 'candidate'
      && last.kind !== 'no_answer' && last.questionId === lastHr.questionId && session.followupCount < session.followupLimit
    const usePlannedMain = dutyPlan && (!answered || !currentPlanItem || session.followupCount >= session.followupLimit
      || (currentPlanItem.opening && session.followupCount > 0 && !pressureEvidenceAsked && !afterPressureRecovery))
    let plannedDecision
    if (pressureRecovery) plannedDecision = { action: 'followup', question: PRESSURE_RECOVERIES[pastRecoveries % PRESSURE_RECOVERIES.length] }
    else if (contextFollowup) plannedDecision = { action: 'followup' }
    else if (usePlannedMain || (dutyPlan && afterPressureRecovery && stuck)) plannedDecision = { action: 'next_question' }
    let modelDecision
    try {
      if (!plannedDecision || assessPressureAnswer) {
        modelDecision = await this.model.next({ ...bundle, planContext, assessPressureAnswer }, { signal })
      }
    }
    catch (error) {
      if (this.isAborted(signal, error)) throw abortedFailure()
      if (!plannedDecision) {
        await this.store.saveSession({ ...session, status: 'error', lastError: safeError(error) }, turns)
        throw remoteFailure(error.code || 'hr-interview/model-next-failed', safeError(error))
      }
    }
    if (this.isAborted(signal)) throw abortedFailure()
    let decision = plannedDecision || modelDecision
    const evidence = assessPressureAnswer && modelDecision?.answerSatisfactory === true ? normalizedAnswer(modelDecision.satisfactoryQuote) : ''
    const satisfactory = evidence.length >= 2 && evidence.length <= 80 && normalizedAnswer(last.text).includes(evidence)
    let action = options.forceNext ? 'next_question' : decision?.action
    if (!last && action !== 'next_question') action = 'next_question'
    if (action === 'followup' && (!session.currentQuestionId || session.followupCount >= session.followupLimit || last?.speaker !== 'candidate')) action = 'next_question'
    if (action === 'wrap_up' && session.mainQuestionCount < session.questionBudget) action = 'next_question'
    if (!['followup', 'next_question', 'wrap_up'].includes(action)) action = session.mainQuestionCount >= session.questionBudget ? 'wrap_up' : 'next_question'
    if (session.preparation && action === 'followup' && !currentPlanItem) action = 'next_question'
    const modelQuestion = cleanQuestion(decision?.question)
    let safeFollowup = modelQuestion
    let pressureFocus
    if (dutyPlan && action === 'followup' && !contextFollowup && !pressureRecovery) {
      let followup
      try {
        followup = await this.resolvePreparedFollowup({ ...bundle, planContext }, decision,
          { pressure, requireChallenge: pressureEvidenceAsked, signal })
      } catch (error) {
        if (this.isAborted(signal, error)) throw abortedFailure()
      }
      if (this.isAborted(signal)) throw abortedFailure()
      if (!followup) {
        decision = { action: 'next_question' }
        action = 'next_question'
      } else {
        ({ decision, question: safeFollowup } = followup)
        if (pressure) pressureFocus = PRESSURE_FOCI.has(decision.pressureFocus) ? decision.pressureFocus : 'evidence'
      }
    }
    const latency = Date.now() - started
    if (action === 'next_question' && (session.mainQuestionCount >= session.questionBudget || (session.preparation && !nextPlanItem))) action = 'wrap_up'
    if (action === 'wrap_up') return this.finish(id, turns, '', latency)
    const followup = action === 'followup'
    const planItem = followup ? currentPlanItem : nextPlanItem
    const questionId = followup ? session.currentQuestionId : `q-${session.mainQuestionCount + 1}`
    let question = !dutyPlan ? modelQuestion : followup ? safeFollowup : planItem.question
    let questionStage = null
    const contextRequirement = dutyPlan && (contextFollowup ? contextToCheck
      : !followup && (planItem.contextRequirement || requiredMainQuestionContext(planItem.question)
        || (pressure && pressureExperienceQuestion(planItem.question) ? 'project' : null)))
    if (dutyPlan && followup && !contextFollowup) questionStage = pressureRecovery ? 'pressure-recovery' : 'answer-followup'
    else if (dutyPlan && !followup && planItem.opening) {
      questionStage = 'project-introduction'
      if (pressure) question = PRESSURE_OPENING
    }
    else if (contextRequirement) {
      const rawDuty = planItem.duty || planItem.topic || '这项工作'
      const duty = pressure && Object.hasOwn(HR_QUESTION_TOPIC_LABELS, rawDuty) ? HR_QUESTION_TOPIC_LABELS[rawDuty] : rawDuty
      if (contextFollowup && confirmedContextAnswer(last.text, contextRequirement)) {
        question = contextProbeQuestion(contextRequirement, planItem.question)
        questionStage = 'context-probe'
      } else if (!followup && !stuck && !afterPressureRecovery && introducedProject(turns)) {
        question = contextCheckQuestion(contextRequirement, duty, pressure)
        questionStage = 'context-check'
      } else {
        question = scenarioQuestion(contextRequirement, duty, pressure ? rawDuty : null)
        questionStage = 'context-scenario'
      }
    }
    if (stuck && !followup && question) question = PRESSURE_TRANSITIONS[Math.max(0, pastRecoveries - 1) % PRESSURE_TRANSITIONS.length] + question
    if (!question) {
      const message = 'Model returned an empty interview question'
      await this.store.saveSession({ ...session, status: 'error', lastError: message }, turns)
      throw remoteFailure('hr-interview/model-question', message)
    }
    const modelPoints = Array.isArray(decision.expectedPoints) ? decision.expectedPoints.slice(0, 8) : []
    const isCheck = questionStage === 'context-check'
    const isScenario = questionStage === 'context-scenario'
    const isAnswerFollowup = questionStage === 'answer-followup' || questionStage === 'pressure-recovery'
    let pressureCue
    if (pressure) {
      pressureCue = pressureRecovery && followup ? ['pause', 'questioning', 'sigh'][pastRecoveries % 3] : 'firm'
      if (pressureRecovery && followup) pressureFocus = 'recovery'
      else if (followup && !contextFollowup && !pressureFocus) pressureFocus = PRESSURE_FOCI.has(decision.pressureFocus) ? decision.pressureFocus : 'evidence'
    }
    const expectedPoints = isCheck ? [] : isScenario ? ['说明执行或验证步骤', '给出可观察的判断依据']
      : planItem ? [...new Set([...(planItem.expectedPoints || []), ...(!dutyPlan ? modelPoints : [])])].slice(0, 8) : modelPoints
    const turn = {
      id: `t-${randomUUID()}`, sequence: turns.length + 1, speaker: 'hr', kind: followup ? 'followup' : 'main_question',
      text: question, questionId, askedAt: now(), expectedPoints,
      sourceRefs: Array.isArray(decision.sourceRefs) ? decision.sourceRefs.slice(0, 8) : [],
      ...(planItem ? { planItemId: planItem.planItemId, bankItemId: planItem.bankItemId, planSourceRefs: isCheck || isScenario || isAnswerFollowup ? [] : planItem.sourceRefs || [] } : {}),
      ...(dutyPlan ? { questionBasis: isAnswerFollowup ? 'answer' : isCheck ? 'opening' : isScenario ? 'simulation' : planItem.basis } : {}),
      ...(questionStage ? { questionStage, ...(contextRequirement ? { contextRequirement } : {}) } : {}),
      ...(pressureCue ? { pressureCue, ...(pressureFocus ? { pressureFocus } : {}) } : {}),
      knowledgePointId: String(dutyPlan ? `kp-${interviewRoleScope(bundle.materials.role)}-${planItem.bankItemId}`
        : planItem ? `kp-${planItem.bankItemId}` : decision.knowledgePointId || session.targetKnowledgePointId || `kp-${questionId}`),
      questionVariant: String(decision.questionVariant || '').slice(0, 500), reason: String(decision.reason || '').slice(0, 500),
    }
    const nextSession = {
      ...session, status: 'waiting_for_answer', currentQuestionId: questionId,
      mainQuestionCount: session.mainQuestionCount + (followup ? 0 : 1), followupCount: followup ? session.followupCount + 1 : 0,
      lastError: null, lastLatencyMs: latency,
      ...(pressure ? { pressureBlackFace: (pressureBlackFace && !satisfactory) || (pressureFocus === 'recovery' && pressureCue === 'questioning') } : {}),
    }
    await this.store.saveSession(nextSession, [...turns, turn])
    return { session: nextSession, turns: [...turns, turn], evaluation: null, lastLatencyMs: latency }
  }
  async resolvePreparedFollowup(context, decision, { pressure, requireChallenge, signal }) {
    const { turns } = context
    const history = turns.flatMap((turn, index) => {
      if (turn.speaker !== 'hr' || !['main_question', 'followup'].includes(turn.kind)) return []
      const preceding = turns[index - 1]
      const answerContext = turn.kind === 'followup' && preceding?.speaker === 'candidate' && preceding.kind !== 'no_answer'
        ? cleanQuestion(preceding.text).slice(0, 800) : ''
      return [{ ...turn, answerContext }]
    })
    const byKey = new Map(history.map((turn) => [questionKey(turn.text), turn]))
    const answer = turns.at(-1).text
    const previous = history.at(-1).text
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.isAborted(signal)) throw abortedFailure()
      if (decision?.action !== 'followup') return null
      const proposed = cleanQuestion(decision.question)
      const question = groundedFollowup(decision, answer, previous, pressure)
      const wrongAngle = requireChallenge && !PRESSURE_CHALLENGES.has(decision.pressureFocus)
      let duplicate = byKey.get(questionKey(proposed)) || byKey.get(questionKey(question))
      if (question && !duplicate && !wrongAngle && typeof this.model.findDuplicateFollowup === 'function') {
        const duplicateId = await this.model.findDuplicateFollowup({ question, answer: cleanQuestion(answer), history }, { signal })
        duplicate = history.find((turn) => turn.id === duplicateId)
      }
      if (!duplicate && !wrongAngle) return question ? { decision, question } : null
      if (attempt === 0) {
        decision = await this.model.next({ ...context, reviseFollowup: {
          rejectedQuestion: proposed, duplicateQuestion: duplicate?.text, requireChallenge,
        } }, { signal })
      }
    }
    return null
  }
  async control(id, action) {
    const sessionId = parseSessionId(id)
    const stopsInterviewWork = ['pause', 'finish', 'end', 'cancel'].includes(action)
    if (stopsInterviewWork) this.abortRequests(sessionId)
    return this.withLock(sessionId, async () => {
      const bundle = await this.store.get(sessionId)
      const { session, turns } = bundle
      if (stopsInterviewWork) this.localCamera?.stop(sessionId)
      if (action === 'cancel') return bundle
      if (action === 'finish') return this.finish(sessionId, turns)
      if (action === 'end') return this.finish(sessionId, turns, '', 0, { review: false })
      if (action === 'skip') {
        if (session.status !== 'waiting_for_answer') throw remoteFailure('hr-interview/invalid-state', 'Only an active question can be skipped')
        return this.processAnswer(sessionId, '（候选人选择跳过本题）', { usedFallback: false }, { kind: 'no_answer', forceNext: true })
      }
      if (action === 'pause') {
        if (session.status === 'paused') return bundle
        if (!activeStatuses.has(session.status)) throw remoteFailure('hr-interview/invalid-state', `Cannot pause in ${session.status}`)
        await this.store.saveSession({ ...session, status: 'paused', resumeStatus: session.status }, turns)
        return this.store.get(sessionId)
      }
      if (action === 'resume') {
        if (session.status !== 'paused') throw remoteFailure('hr-interview/invalid-state', 'Session is not paused')
        const resumeStatus = ['waiting_for_answer', 'error', 'generating_question', 'processing_answer'].includes(session.resumeStatus) ? session.resumeStatus : 'waiting_for_answer'
        await this.store.saveSession({ ...session, status: resumeStatus, resumeStatus: null, lastError: null }, turns)
        if (['generating_question', 'processing_answer'].includes(resumeStatus) && !this.requests.get(sessionId)?.size) return this.askNext(sessionId)
        return this.store.get(sessionId)
      }
      if (action === 'retry') {
        if (!['error', 'generating_question', 'processing_answer'].includes(session.status)) throw remoteFailure('hr-interview/invalid-state', 'Only an interrupted model turn can be retried')
        return this.askNext(sessionId)
      }
      throw remoteFailure('hr-interview/invalid-control', `Unsupported control ${action}`)
    })
  }
  async finish(id, existingTurns = null, reason = '', latency = 0, { review = true } = {}) {
    this.localCamera?.stop(id)
    this.dropSpeechCache(parseSessionId(id))
    const bundle = await this.context(id)
    const { session } = bundle; const turns = existingTurns || bundle.turns
    if (['completed', 'reviewing', 'evaluating'].includes(session.status)) return bundle
    let nextTurns = turns
    if (turns.at(-1)?.kind !== 'wrap_up') {
      const ending = reason ? `本场模拟结束。${reason}。` : '本场正式模拟到这里。'
      nextTurns = [...turns, { id: `t-${randomUUID()}`, sequence: turns.length + 1, speaker: 'hr', kind: 'wrap_up', text: review ? ending + '接下来进入复盘。' : ending, askedAt: now() }]
    }
    if (!review || !nextTurns.some((turn) => turn.speaker === 'candidate' && turn.kind !== 'no_answer')) {
      await this.store.saveSession({ ...session, status: 'completed', evaluationStatus: review ? 'no_content' : 'not_requested', endedAt: now(), lastLatencyMs: latency }, nextTurns, null)
      return this.store.get(id)
    }
    await this.store.saveSession({ ...session, status: 'review_pending', endedAt: now(), lastLatencyMs: latency }, nextTurns)
    return this.runEvaluation(id)
  }
  async evaluate(id) { const sessionId = parseSessionId(id); return this.withLock(sessionId, () => this.runEvaluation(sessionId)) }
  async runEvaluation(id) {
    const sessionId = parseSessionId(id)
    return this.trackRequest(sessionId, (signal) => this.performEvaluation(sessionId, signal))
  }
  async performEvaluation(id, signal) {
    const bundle = await this.context(id)
    const { session, turns } = bundle
    if (session.evaluationStatus === 'ready' && bundle.evaluation) return bundle
    if (!['review_pending', 'evaluating', 'completed'].includes(session.status)) throw remoteFailure('hr-interview/not-finished', 'Finish the interview before evaluation')
    if (!turns.some((turn) => turn.speaker === 'candidate' && turn.kind !== 'no_answer')) throw remoteFailure('hr-interview/no-answers', 'At least one answer is required before evaluation')
    if (this.isAborted(signal)) throw abortedFailure()
    await this.store.saveSession({ ...session, status: 'evaluating', evaluationStatus: 'pending' }, turns)
    try {
      const raw = await this.model.evaluate(bundle, { signal })
      if (this.isAborted(signal)) throw abortedFailure()
      const evaluation = normalizeEvaluation(raw, session, turns)
      if (session.preparation?.dutyPlan) {
        const roleScope = interviewRoleScope(bundle.materials.role)
        for (const point of evaluation.knowledgePoints) {
          if (!point.id.startsWith(`kp-${roleScope}-`)) point.id = `kp-${roleScope}-${point.id}`.slice(0, 120)
          point.roleScope = roleScope
        }
      }
      const nextSession = { ...session, status: 'completed', evaluationStatus: 'ready', endedAt: session.endedAt || now(), lastError: null }
      await this.store.saveSession(nextSession, turns, evaluation)
      if (session.mode !== 'drill') await this.store.saveKnowledge(applyKnowledge(await this.store.knowledge(), evaluation))
      return this.store.get(id)
    } catch (error) {
      if (this.isAborted(signal, error)) {
        const restored = session.status === 'evaluating' ? 'review_pending' : session.status
        await this.store.saveSession({ ...session, status: restored, evaluationStatus: session.evaluationStatus }, turns)
        throw abortedFailure()
      }
      await this.store.saveSession({ ...session, status: 'review_pending', evaluationStatus: 'pending', lastError: safeError(error) }, turns)
      throw remoteFailure(error.code || 'hr-interview/evaluation-failed', safeError(error))
    }
  }
  speechKey(id, provider, voice, text) { return `${id}:${sha256(`${provider}:${voice}:${text}`)}` }
  touchSpeech(key) {
    const entry = this.speechCache.get(key)
    if (!entry) return entry
    this.speechCache.delete(key); this.speechCache.set(key, entry)
    return entry
  }
  trimSpeechCache() {
    const { maxEntries, maxBytes } = this.cacheLimits
    let bytes = 0
    for (const entry of this.speechCache.values()) bytes += entry.bytes
    while (this.speechCache.size > maxEntries || bytes > maxBytes) {
      const oldest = this.speechCache.keys().next()
      if (oldest.done) break
      const entry = this.speechCache.get(oldest.value)
      this.speechCache.delete(oldest.value)
      bytes -= entry?.bytes || 0
      if (!this.speechCache.size) break
    }
  }
  dropSpeechCache(id) {
    const prefix = `${id}:`
    for (const key of [...this.speechCache.keys()]) if (key.startsWith(prefix)) this.speechCache.delete(key)
  }
  async speak(id, turnId) {
    const sessionId = parseSessionId(id)
    const bundle = await this.store.get(sessionId)
    const session = bundle.session
    const turn = bundle.turns.find((item) => item.id === turnId && item.speaker === 'hr')
    if (!turn) throw remoteFailure('hr-interview/invalid-tts-turn', 'TTS turn must belong to this session and be spoken by HR')
    const provider = session.ttsProvider || 'auto'; const voice = session.voice || 'stella'
    const key = this.speechKey(sessionId, provider, voice, turn.text)
    return this.trackRequest(sessionId, async (signal) => {
      if (this.isAborted(signal)) throw abortedFailure()
      const cached = this.speechCache.get(key)
      if (cached) return this.touchSpeech(key).value
      const pending = this.speech.synthesize(turn.text, { provider, voice, signal }).then((audio) => {
        if (this.isAborted(signal)) throw abortedFailure()
        return audio
      })
      const entry = { value: pending, bytes: 0 }
      this.speechCache.set(key, entry)
      this.trimSpeechCache()
      try {
        const audio = await pending
        entry.bytes = base64Bytes(audio?.audioBase64)
        if (entry.bytes > this.cacheLimits.maxBytes) { if (this.speechCache.get(key) === entry) this.speechCache.delete(key) }
        else this.trimSpeechCache()
        return audio
      } catch (error) {
        if (this.speechCache.get(key) === entry) this.speechCache.delete(key)
        throw error
      }
    })
  }
  async testAsr(audio) {
    // 显式诊断接口：固定 DeepSeek、只返回转写，不创建场次，也不持久化音频。
    return this.speech.transcribe(audio, { provider: 'deepseek' })
  }

  async previewVoice(voice, provider = 'deepseek') {
    const requested = typeof provider === 'string' && provider.trim() ? provider.trim() : 'deepseek'
    return this.speech.synthesize(PREVIEW_TEXT, { provider: requested, voice })
  }
}
