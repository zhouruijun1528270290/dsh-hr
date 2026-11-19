import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseSessionId, parsePreparationId, remoteFailure } from './contract.js'
import { clarifyQuestionScenario } from './question-sequence.js'
import { normalizeKnowledgeSchedule } from './evaluation.js'

const queues = new Map()
const enqueue = (key, task) => {
  const previous = queues.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  queues.set(key, next)
  return next.finally(() => { if (queues.get(key) === next) queues.delete(key) })
}
async function atomicJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw remoteFailure('hr-interview/corrupt-store', '本地数据文件损坏，请先备份再重置')
  }
}
const validSession = (value, id) => {
  if (!value || value.sessionId !== id || !Array.isArray(value.turns === undefined ? [] : value.turns)) throw remoteFailure('hr-interview/corrupt-session', `Invalid session ${id}`)
  return value
}
export class InterviewStore {
  constructor(root) {
    const resolved = resolve(root)
    if (!resolved || resolved.length < 4) throw new TypeError('A bounded interview data root is required')
    this.root = resolved
  }
  async init() { await mkdir(join(this.root, 'sessions'), { recursive: true }) }
  async materials() { return readJson(join(this.root, 'materials.json'), { resume: '', jd: '', projectNotes: '', role: '', updatedAt: null }) }
  async roleEvidence() {
    try {
      const records = await readJson(join(this.root, 'market-role-evidence.json'), {})
      return records && typeof records === 'object' && !Array.isArray(records) ? records : {}
    } catch (error) {
      if (error.code === 'hr-interview/corrupt-store') return {}
      throw error
    }
  }
  async cacheRoleEvidence(updates, signal) {
    if (!Object.keys(updates).length) return
    return enqueue(`${this.root}:role-evidence`, async () => {
      const records = { ...await this.roleEvidence(), ...updates }
      const current = Object.entries(records)
        .filter(([key, item]) => /^[a-f0-9]{64}$/.test(key) && Date.parse(item?.reviewAfter) > Date.now())
        .sort((a, b) => Date.parse(b[1].reviewAfter) - Date.parse(a[1].reviewAfter)).slice(0, 256)
      signal?.throwIfAborted()
      await atomicJson(join(this.root, 'market-role-evidence.json'), Object.fromEntries(current))
    })
  }
  async sourceSettings() { return readJson(join(this.root, 'settings.json'), { msyDir: '', updatedAt: null, sourceSummary: { agentQuestions: 0, resumeQuestions: 0 } }) }
  async saveSourceSettings(value) {
    return enqueue('source-settings', async () => {
      const count = (input) => Math.max(0, Math.min(1000000, Number.isInteger(input) ? input : 0))
      const sourceSummary = {
        agentQuestions: count(value?.sourceSummary?.agentQuestions),
        resumeQuestions: count(value?.sourceSummary?.resumeQuestions),
      }
      const next = { msyDir: String(value?.msyDir || ''), updatedAt: new Date().toISOString(), sourceSummary }
      await atomicJson(join(this.root, 'settings.json'), next)
      return next
    })
  }
  async saveMaterials(value) {
    const next = { ...value, updatedAt: new Date().toISOString() }
    await atomicJson(join(this.root, 'materials.json'), next)
    return next
  }
  preparationPath(id) { return join(this.root, 'preparations', `${parsePreparationId(id)}.json`) }
  async savePreparation(value) {
    const id = parsePreparationId(value?.preparationId)
    return enqueue('preparations', async () => {
      const next = { ...value, preparationId: id }
      if (!Array.isArray(next.items) || typeof next.profileKey !== 'string' || typeof next.planKey !== 'string') throw remoteFailure('hr-interview/preparation-invalid', '面试提纲内容不完整，请重新准备')
      await atomicJson(this.preparationPath(id), next)
      const path = join(this.root, 'preparations.json')
      const current = await readJson(path, [])
      const summary = { preparationId: id, profileKey: next.profileKey, planKey: next.planKey, durationMinutes: next.durationMinutes, createdAt: next.createdAt, materialsUpdatedAt: next.materialsUpdatedAt || null }
      const items = [...current.filter((item) => item.preparationId !== id), summary].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      await atomicJson(path, items)
      return next
    })
  }
  async getPreparation(id) {
    const value = await readJson(this.preparationPath(id), null)
    if (value === null) return null
    if (value.preparationId !== id || !Array.isArray(value.items)) throw remoteFailure('hr-interview/preparation-invalid', '面试提纲记录损坏，请重新准备')
    return { ...value, items: value.items.map(clarifyQuestionScenario) }
  }
  async latestPreparation({ profileKey = null, planKey = null } = {}) {
    const items = await readJson(join(this.root, 'preparations.json'), [])
    if (!Array.isArray(items) || !items.length) return null
    const hit = items.find((item) => (!profileKey || item?.profileKey === profileKey) && (!planKey || item?.planKey === planKey))
    return hit ? this.getPreparation(hit.preparationId) : null
  }
  sessionDir(id) { return join(this.root, 'sessions', parseSessionId(id)) }
  async createSession(session) {
    await this.init()
    const dir = this.sessionDir(session.sessionId)
    await mkdir(dir, { recursive: false })
    await atomicJson(join(dir, 'turns.json'), [])
    await atomicJson(join(dir, 'session.json'), session)
    await this.updateIndex(session)
    return session
  }
  async get(id) {
    const dir = this.sessionDir(id)
    const session = validSession(await readJson(join(dir, 'session.json'), null), id)
    const turns = await readJson(join(dir, 'turns.json'), [])
    if (!Array.isArray(turns)) throw remoteFailure('hr-interview/corrupt-session', `Invalid turns for ${id}`)
    const evaluation = await readJson(join(dir, 'evaluation.json'), null)
    return { session, turns, evaluation }
  }
  async saveSession(session, turns, evaluation = undefined) {
    const id = parseSessionId(session.sessionId)
    return enqueue(`session:${id}`, async () => {
      const dir = this.sessionDir(id)
      await atomicJson(join(dir, 'turns.json'), turns)
      await atomicJson(join(dir, 'session.json'), { ...session, updatedAt: new Date().toISOString() })
      if (evaluation !== undefined) await atomicJson(join(dir, 'evaluation.json'), evaluation)
      await this.updateIndex(session, evaluation)
      return this.get(id)
    })
  }
  async updateIndex(session, evaluation = undefined) {
    return enqueue('index', async () => {
      const path = join(this.root, 'index.json')
      const current = await readJson(path, [])
      const summary = {
        sessionId: session.sessionId, role: session.config?.role || '', status: session.status,
        mode: session.mode, inputMode: session.inputMode, createdAt: session.createdAt,
        endedAt: session.endedAt || null, updatedAt: new Date().toISOString(),
        oralAcceptanceEligible: session.oralAcceptanceEligible !== false,
        evaluationStatus: evaluation ? 'ready' : session.evaluationStatus || 'pending',
        mainQuestionCount: session.mainQuestionCount || 0, parentSessionId: session.parentSessionId || null,
      }
      const next = [...current.filter((item) => item.sessionId !== session.sessionId), summary].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      await atomicJson(path, next)
    })
  }
  async list() {
    const items = await readJson(join(this.root, 'index.json'), [])
    return Array.isArray(items) ? items : []
  }
  async knowledge() {
    const items = await readJson(join(this.root, 'knowledge.json'), [])
    return Array.isArray(items) ? normalizeKnowledgeSchedule(items) : []
  }
  async saveKnowledge(items) {
    return enqueue('knowledge', async () => {
      const scheduled = normalizeKnowledgeSchedule(items)
      await atomicJson(join(this.root, 'knowledge.json'), scheduled)
      await atomicJson(join(this.root, 'review-queue.json'), scheduled.filter((item) => item?.nextReviewAt))
      return scheduled
    })
  }
  async listSessionIds() {
    await this.init()
    return (await readdir(join(this.root, 'sessions'), { withFileTypes: true })).filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN_SAFE(entry.name)).map((entry) => entry.name)
  }
}
const SESSION_ID_PATTERN_SAFE = (value) => /^hr-[a-z0-9-]{8,80}$/.test(value)
