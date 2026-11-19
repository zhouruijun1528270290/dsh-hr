import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { remoteFailure } from './contract.js'

const DEFAULT_SEED_PATH = fileURLToPath(new URL('./data/market-question-bank.json', import.meta.url))
const ROLE_PACKS = new Set(['agent', 'shared'])
const KINDS = new Set(['project', 'principle', 'incident', 'evaluation', 'behavioral'])
const EVIDENCE_LEVELS = new Set(['first_hand', 'edited', 'editorial'])
const MAX_LIMIT = 1000
const MAX_SEED_ITEMS = 1000
/** 单个外部来源的条数上限：只挡住事故级数据，不限制真实题库规模。 */
const MAX_EXTERNAL_ITEMS = 4000
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const FTS_OPERATORS = new Set(['and', 'or', 'not', 'near'])

/** 三个互不污染的同步域：1 精选包、2 msy NDJSON、3 msy 简历深挖题。 */
const SOURCE_SEED = 1
const SOURCE_QUESTION = 2
const SOURCE_RESUME = 3
const EXTERNAL_SOURCES = [SOURCE_QUESTION, SOURCE_RESUME]
const SOURCE_TYPE = { [SOURCE_QUESTION]: 'msy-question', [SOURCE_RESUME]: 'msy-resume' }
/** 同 mappingVersion 下条数掉到这个比例以下就判为异常骤减。 */
const SHRINK_RATIO = 0.5

const SOURCES_FILE = 'market-sources.json'
const SOURCES_STATE_VERSION = 1
const STATUSES = new Set(['disabled', 'ok', 'degraded', 'skipped'])
const MAX_WARNINGS = 8

/** 传给 msy 读取器的硬上限；读取器自己也要有同样的兜底。 */
export const EXTERNAL_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxLines: 50_000,
  maxItems: MAX_EXTERNAL_ITEMS,
})

const SCHEMA = `
CREATE TABLE IF NOT EXISTS market_questions (
  id TEXT PRIMARY KEY,
  role_pack TEXT NOT NULL,
  topic TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  review_after TEXT,
  seed_source INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_questions_lookup
  ON market_questions (role_pack, topic, kind, review_after);
CREATE VIRTUAL TABLE IF NOT EXISTS market_questions_fts USING fts5 (id UNINDEXED, body);
`

const unavailable = (message = '本地市场题库暂时不可用，请稍后重试') =>
  remoteFailure('hr-interview/market-bank-error', message)

const closedFailure = () =>
  remoteFailure('hr-interview/market-bank-closed', '市场题库已关闭，请重新初始化后再使用')

const notReadyFailure = () =>
  remoteFailure('hr-interview/market-bank-not-ready', '市场题库尚未初始化')

/** Sanitized rethrow:不把 SQL、种子正文或底层异常文本带给调用方。 */
const guard = (task, message) => {
  try {
    return task()
  } catch (error) {
    if (error?.isDSHRemoteError) throw error
    throw unavailable(message)
  }
}

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const textList = (value, max, itemLimit) => (Array.isArray(value) ? value : [])
  .map((item) => text(item, max))
  .filter(Boolean)
  .slice(0, itemLimit)

function normalizeDate(value, field) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const day = raw.slice(0, 10)
  if (!DATE_ONLY.test(day)) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { field })
  }
  return day
}

/** 校验并收敛一条题目，任何字段异常都只报字段名，不回显内容。 */
function normalizeItem(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index })
  }
  const id = text(raw.id, 120)
  if (!/^[a-z0-9][a-z0-9-]{2,119}$/.test(id)) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'id' })
  }
  const rolePack = text(raw.rolePack, 16)
  if (!ROLE_PACKS.has(rolePack)) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'rolePack' })
  }
  const kind = text(raw.kind, 16)
  if (!KINDS.has(kind)) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'kind' })
  }
  const evidenceLevel = text(raw.evidenceLevel, 16)
  if (!EVIDENCE_LEVELS.has(evidenceLevel)) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'evidenceLevel' })
  }
  const question = text(raw.question, 600)
  const followups = textList(raw.followups, 400, 8)
  const expectedPoints = textList(raw.expectedPoints, 400, 10)
  const tags = textList(raw.tags, 40, 16)
  const topic = text(raw.topic, 64)
  if (!question || !topic) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'question' })
  }
  const revision = Number(raw.revision)
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'revision' })
  }
  const sourceUrl = text(raw.sourceUrl, 600)
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'sourceUrl' })
  }
  if (evidenceLevel === 'editorial' && sourceUrl) {
    throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'sourceUrl' })
  }
  return {
    id, rolePack, topic, kind, question, followups, expectedPoints,
    sourceTitle: text(raw.sourceTitle, 300),
    sourceUrl,
    evidenceLevel,
    collectedAt: normalizeDate(raw.collectedAt, 'collectedAt'),
    reviewedAt: normalizeDate(raw.reviewedAt, 'reviewedAt'),
    reviewAfter: normalizeDate(raw.reviewAfter, 'reviewAfter'),
    revision,
    tags,
  }
}

/** 外部来源条目：复用同一套字段规则，另带来源类型与内容版本；坏条目只丢弃该条。 */
function normalizeExternalItem(raw, source) {
  try {
    const item = normalizeItem(raw, 0)
    return {
      ...item,
      sourceType: SOURCE_TYPE[source],
      sourceRevision: text(raw?.sourceRevision, 128),
    }
  } catch {
    return null
  }
}

const emptySourceState = () => ({
  status: 'disabled',
  questionStatus: 'disabled',
  resumeStatus: 'disabled',
  mappingVersion: '',
  hash: '',
  resumeHash: '',
  count: 0,
  resume: 0,
  counters: { scanned: 0, invalid: 0, skippedOffTopic: 0, withAnswer: 0 },
  warnings: [],
  collectedAt: '',
})

const boundedCount = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.min(10_000_000, Math.trunc(number))
}

/** 落盘状态只认白名单字段：不写目录、不写题面与答案。 */
function normalizeStoredState(parsed) {
  const msy = parsed && typeof parsed === 'object' && parsed.msy && typeof parsed.msy === 'object' ? parsed.msy : null
  if (!msy) return emptySourceState()
  const status = text(msy.status, 16)
  const questionStatus = text(msy.questionStatus, 16)
  const resumeStatus = text(msy.resumeStatus, 16)
  const counters = msy.counters && typeof msy.counters === 'object' ? msy.counters : {}
  return {
    status: STATUSES.has(status) ? status : 'degraded',
    questionStatus: STATUSES.has(questionStatus) ? questionStatus : (status === 'ok' ? 'ok' : 'degraded'),
    resumeStatus: STATUSES.has(resumeStatus) ? resumeStatus : 'degraded',
    mappingVersion: text(msy.mappingVersion, 40),
    hash: /^[0-9a-f]{16,128}$/.test(text(msy.hash, 128)) ? text(msy.hash, 128) : '',
    resumeHash: /^[0-9a-f]{16,128}$/.test(text(msy.resumeHash, 128)) ? text(msy.resumeHash, 128) : '',
    count: Number.isInteger(Number(msy.count)) && Number(msy.count) > 0 ? Number(msy.count) : 0,
    resume: Number.isInteger(Number(msy.resume)) && Number(msy.resume) > 0 ? Number(msy.resume) : 0,
    counters: {
      scanned: boundedCount(counters.scanned),
      invalid: boundedCount(counters.invalid),
      skippedOffTopic: boundedCount(counters.skippedOffTopic),
      withAnswer: boundedCount(counters.withAnswer),
    },
    warnings: (Array.isArray(msy.warnings) ? msy.warnings : []).map((entry) => text(entry, 120)).filter(Boolean).slice(0, MAX_WARNINGS),
    collectedAt: DATE_ONLY.test(text(msy.collectedAt, 10)) ? text(msy.collectedAt, 10) : '',
  }
}

/** 中文按字切分建立 unigram + bigram，ASCII 按词；用于 FTS 索引体。 */
export function segmentForFts(value) {
  const normalized = String(value ?? '').normalize('NFKC').toLowerCase()
  const tokens = []
  let ascii = ''
  const flushAscii = () => {
    if (ascii.length >= 2) tokens.push(ascii)
    ascii = ''
  }
  let run = ''
  const flushRun = () => {
    if (!run) return
    for (let i = 0; i < run.length; i += 1) {
      tokens.push(run[i])
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
    run = ''
  }
  for (const char of normalized) {
    if (CJK.test(char)) { flushAscii(); run += char; continue }
    flushRun()
    if (/[a-z0-9_]/.test(char)) ascii += char
    else flushAscii()
  }
  flushRun()
  flushAscii()
  return tokens.join(' ')
}

/** 查询切块：去掉 FTS 语法字符与操作符，中文保留原词块。 */
export function sanitizeQueryChunks(value) {
  const normalized = String(value ?? '').normalize('NFKC').toLowerCase()
  const raw = normalized
    .replace(/["'`*^:(){}[\]~\\?<>#&|!+=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  if (!raw) return []
  const chunks = []
  for (const piece of raw.split(' ')) {
    if (!piece) continue
    if (FTS_OPERATORS.has(piece)) continue
    if (!chunks.includes(piece)) chunks.push(piece)
    if (chunks.length >= 8) break
  }
  return chunks
}

/** 查询块到 FTS token（与索引体同规则）。 */
function ftsTokensForChunk(chunk) {
  const tokens = []
  for (const part of chunk.split(/[^a-z0-9_\u3400-\u9fff]+/)) {
    if (!part) continue
    if (CJK.test(part)) {
      let run = ''
      const flush = () => {
        if (!run) return
        if (run.length === 1) tokens.push(run)
        else for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2))
        run = ''
      }
      for (const char of part) {
        if (CJK.test(char)) run += char
        else { flush(); if (char.length) tokens.push(char) }
      }
      flush()
    } else if (part.length >= 2) tokens.push(part)
  }
  return tokens
}

function buildMatchExpression(chunks) {
  const tokens = []
  for (const chunk of chunks) for (const token of ftsTokensForChunk(chunk)) if (!tokens.includes(token)) tokens.push(token)
  if (!tokens.length) return ''
  return tokens.slice(0, 16).map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const matchAllChunks = (haystack, chunks) => chunks.every((chunk) => haystack.includes(chunk))

const itemHaystack = (item) => `${item.question}\n${item.followups.join('\n')}\n${item.expectedPoints.join('\n')}\n${item.tags.join('\n')}\n${item.topic}\n${item.sourceTitle}`.normalize('NFKC').toLowerCase()

const clone = (value) => structuredClone(value)

const dateOnly = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  const iso = Number.isNaN(date.getTime()) ? new Date() : date
  return iso.toISOString().slice(0, 10)
}

const boundLimit = (value, fallback = 50) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(number)))
}

const packScope = (rolePack) => (text(rolePack, 16).toLowerCase() === 'agent' ? ['agent', 'shared'] : ['shared'])

const withStaleFlag = (item, today) => ({ ...clone(item), stale: Boolean(item.reviewAfter && item.reviewAfter < today) })

/** 与库内同域的 upsert：绝不把别的域的行改成自己的。 */
const placeholders = (count) => new Array(count).fill('?').join(',')

const ftsBody = (item) => segmentForFts([
  item.question, ...item.followups, ...item.expectedPoints, ...item.tags, item.topic, item.kind, item.sourceTitle,
].join('\n'))

const UPSERT = `
  INSERT INTO market_questions (id, role_pack, topic, kind, revision, review_after, seed_source, payload, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    role_pack = excluded.role_pack,
    topic = excluded.topic,
    kind = excluded.kind,
    revision = excluded.revision,
    review_after = excluded.review_after,
    payload = excluded.payload,
    updated_at = excluded.updated_at
  WHERE market_questions.seed_source = excluded.seed_source
`

export class MarketQuestionBank {
  #db = null
  #closed = false
  #initChain = Promise.resolve()
  #readerPromise = null

  constructor({ root, now = () => new Date(), seedPath = DEFAULT_SEED_PATH, msyDir = '', msyReader = null } = {}) {
    const resolved = resolve(String(root ?? ''))
    if (!root || resolved.length < 4) throw new TypeError('A bounded market data root is required')
    this.root = resolved
    this.now = typeof now === 'function' ? now : () => new Date(now)
    this.seedPath = resolve(String(seedPath))
    this.path = join(this.resolvedRoot(), 'market.sqlite')
    this.sourcesPath = join(this.resolvedRoot(), SOURCES_FILE)
    // 空目录 = 关闭外部来源，行为与本轮之前完全一致。
    const configured = resolve(String(msyDir ?? '').trim() || '.')
    this.msyDir = String(msyDir ?? '').trim() && configured.length >= 4 ? configured : ''
    this.msyReader = typeof msyReader === 'function' ? msyReader : null
    this.seedInfo = { version: '', count: 0 }
    this.sourceState = emptySourceState()
  }

  resolvedRoot() { return this.root }

  /** 建库并幂等同步种子；种子同步完成后串行同步外部来源，外部失败只降级。 */
  init() {
    // 串行化并发 init：后一次等前一次结束，避免两个连接同时持有同一个库文件。
    const previous = this.#initChain
    const next = previous.then(() => this.#initOnce(), () => this.#initOnce())
    this.#initChain = next.then(() => undefined, () => undefined)
    return next
  }

  async #initOnce() {
    await mkdir(this.resolvedRoot(), { recursive: true })
    this.#closeDb()
    this.#closed = false
    const seed = await this.#readSeed()
    const db = guard(() => new DatabaseSync(this.path), '本地市场题库无法打开')
    try {
      db.exec(SCHEMA)
      this.#db = db
      this.#syncSeed(db, seed)
      this.seedInfo = { version: text(seed.version, 40), count: seed.items.length }
      await this.#syncExternalSources(db)
      return this
    } catch (error) {
      this.#closeDb()
      if (error?.isDSHRemoteError) throw error
      throw unavailable('本地市场题库初始化失败')
    }
  }

  /** 候选只来自当前启用的来源：精选包恒在；msy 目录为空时旧外部行保留但不参与候选。 */
  #activeSources() {
    return this.msyDir ? [SOURCE_SEED, ...EXTERNAL_SOURCES] : [SOURCE_SEED]
  }

  async listActive({ rolePack = 'agent', topic = '', kind = '', query = '', limit = 50 } = {}) {
    const db = this.#handle()
    const today = dateOnly(this.now())
    const scope = packScope(rolePack)
    const topicKey = text(topic, 64).toLowerCase()
    const kindKey = text(kind, 32).toLowerCase()
    const chunks = sanitizeQueryChunks(query)
    const bounded = boundLimit(limit)
    const sources = this.#activeSources()
    return guard(() => {
      const rows = this.#candidates(db, chunks, sources)
      const out = []
      for (const row of rows) {
        const item = this.#parseRow(row)
        if (!item) continue
        if (!scope.includes(item.rolePack)) continue
        if (topicKey && item.topic.toLowerCase() !== topicKey) continue
        if (kindKey && item.kind.toLowerCase() !== kindKey) continue
        if (item.reviewAfter && item.reviewAfter < today) continue
        if (chunks.length && !matchAllChunks(itemHaystack(item), chunks)) continue
        out.push(withStaleFlag(item, today))
        if (out.length >= bounded) break
      }
      return out
    })
  }

  async getByIds(ids) {
    const db = this.#handle()
    const wanted = (Array.isArray(ids) ? ids : [])
      .map((id) => text(id, 120))
      .filter((id) => id && /^[a-z0-9][a-z0-9-]{2,119}$/.test(id))
    const unique = [...new Set(wanted)].slice(0, MAX_LIMIT)
    if (!unique.length) return []
    const today = dateOnly(this.now())
    const sources = this.#activeSources()
    return guard(() => {
      const rows = db.prepare(`
        SELECT payload FROM market_questions
        WHERE seed_source IN (${placeholders(sources.length)}) AND id IN (${placeholders(unique.length)})
      `).all(...sources, ...unique)
      const byId = new Map()
      for (const row of rows) {
        const item = this.#parseRow(row)
        if (item) byId.set(item.id, withStaleFlag(item, today))
      }
      return unique.map((id) => byId.get(id)).filter(Boolean)
    })
  }

  async stats() {
    const db = this.#handle()
    const today = dateOnly(this.now())
    const sources = this.#activeSources()
    return guard(() => {
      const rows = db.prepare(`
        SELECT seed_source, role_pack, topic, kind, review_after
        FROM market_questions
        WHERE seed_source IN (${placeholders(sources.length)})
        ORDER BY id
      `).all(...sources)
      const byRolePack = { agent: 0, shared: 0 }
      const byTopic = {}
      const byKind = {}
      let stale = 0
      for (const row of rows) {
        const rolePack = String(row.role_pack)
        const topic = String(row.topic)
        const kind = String(row.kind)
        if (!ROLE_PACKS.has(rolePack)) continue
        byRolePack[rolePack] = (byRolePack[rolePack] || 0) + 1
        byTopic[topic] = (byTopic[topic] || 0) + 1
        byKind[kind] = (byKind[kind] || 0) + 1
        if (row.review_after && String(row.review_after) < today) stale += 1
      }
      const total = byRolePack.agent + byRolePack.shared
      const counts = this.#domainCounts(db)
      const state = this.sourceState
      const enabled = Boolean(this.msyDir)
      const aggregated = enabled ? state.status : 'disabled'
      const questionStatus = enabled ? (state.questionStatus === 'degraded' ? 'degraded' : 'ok') : 'disabled'
      const resumeStatus = enabled ? (state.resumeStatus === 'degraded' ? 'degraded' : 'ok') : 'disabled'
      return {
        total, active: total - stale, stale,
        byRolePack, byTopic, byKind,
        seed: { version: this.seedInfo.version, count: this.seedInfo.count },
        sources: {
          seed: { count: this.seedInfo.count },
          msyQuestions: {
            status: questionStatus,
            // 来源关闭时对外一律 0：旧行还在库里，但不代表当前可用。
            imported: enabled ? counts.question : 0,
            scanned: state.counters.scanned,
            invalid: state.counters.invalid,
            skippedOffTopic: state.counters.skippedOffTopic,
            withAnswer: state.counters.withAnswer,
          },
          msyResume: {
            status: resumeStatus,
            imported: enabled ? counts.resume : 0,
          },
          msy: {
            enabled,
            status: aggregated,
            mappingVersion: state.mappingVersion,
            hash: state.hash,
            resumeHash: state.resumeHash,
            collectedAt: state.collectedAt,
          },
        },
        warnings: enabled ? [...state.warnings] : [],
        today,
      }
    })
  }

  /** 显式关闭；重复调用安全。关闭后任何查询都返回受控错误。 */
  async close() {
    this.#closeDb()
    this.#closed = true
  }

  #closeDb() {
    const db = this.#db
    this.#db = null
    if (!db) return
    try {
      db.close()
    } catch {
      // 关闭失败不向外抛出：连接引用已丢弃，库文件锁由 GC 最终释放。
    }
  }

  #handle() {
    if (this.#db) return this.#db
    if (this.#closed) throw closedFailure()
    throw notReadyFailure()
  }

  #nowIso() {
    const value = this.now()
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
  }

  async #readSeed() {
    let raw
    try {
      raw = await readFile(this.seedPath, 'utf8')
    } catch {
      throw remoteFailure('hr-interview/market-bank-seed-missing', '本地市场题库种子文件缺失')
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效')
    }
    const list = parsed && Array.isArray(parsed.items) ? parsed.items : null
    if (!list || !list.length || list.length > MAX_SEED_ITEMS) {
      throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效')
    }
    const items = []
    const seen = new Set()
    for (let index = 0; index < list.length; index += 1) {
      const item = normalizeItem(list[index], index)
      if (seen.has(item.id)) {
        throw remoteFailure('hr-interview/market-bank-seed-invalid', '本地市场题库种子数据无效', { index, field: 'id' })
      }
      seen.add(item.id)
      items.push(item)
    }
    return { version: text(parsed.version, 40), items }
  }

  #syncSeed(db, seed) {
    const nowIso = this.#nowIso()
    guard(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = new Set(db.prepare('SELECT id FROM market_questions WHERE seed_source = 1').all().map((row) => String(row.id)))
        const incoming = new Set(seed.items.map((item) => item.id))
        const dropFts = db.prepare('DELETE FROM market_questions_fts WHERE id = ?')
        for (const id of existing) if (!incoming.has(id)) dropFts.run(id)
        const upsert = db.prepare(UPSERT)
        const insertFts = db.prepare('INSERT INTO market_questions_fts (id, body) VALUES (?, ?)')
        for (const item of seed.items) {
          upsert.run(item.id, item.rolePack, item.topic, item.kind, item.revision, item.reviewAfter || null, SOURCE_SEED, JSON.stringify(item), nowIso)
          dropFts.run(item.id)
          insertFts.run(item.id, ftsBody(item))
        }
        const keep = [...incoming]
        if (keep.length) {
          db.prepare(`DELETE FROM market_questions WHERE seed_source = 1 AND id NOT IN (${placeholders(keep.length)})`).run(...keep)
        }
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* 事务已结束 */ }
        throw error
      }
    }, '本地市场题库同步失败')
  }

  #domainCounts(db) {
    const counts = { question: 0, resume: 0, total: 0 }
    const rows = db.prepare('SELECT seed_source, COUNT(*) AS n FROM market_questions WHERE seed_source IN (?, ?) GROUP BY seed_source')
      .all(SOURCE_QUESTION, SOURCE_RESUME)
    for (const row of rows) {
      const source = Number(row.seed_source)
      const count = Number(row.n) || 0
      if (source === SOURCE_QUESTION) counts.question = count
      else if (source === SOURCE_RESUME) counts.resume = count
    }
    counts.total = counts.question + counts.resume
    return counts
  }

  /** 注入的读取器优先；没有注入时按文件名动态加载，缺失即降级，绝不 import 顶层有副作用的东西。 */
  #resolveReader() {
    if (this.msyReader) return Promise.resolve(this.msyReader)
    if (!this.#readerPromise) {
      this.#readerPromise = import('./msy-connector.js')
        .then((module) => (typeof module?.readMsySource === 'function' ? module.readMsySource : null))
        .catch(() => null)
    }
    return this.#readerPromise
  }

  async #readPersistedState() {
    try {
      const raw = await readFile(this.sourcesPath, 'utf8')
      return normalizeStoredState(JSON.parse(raw))
    } catch {
      return emptySourceState()
    }
  }

  /** 只落有限状态：status / warnings / hash / count / 映射版本 / 采集日；不含目录与正文。 */
  async #persistSourceState(state) {
    const warnings = (Array.isArray(state.warnings) ? state.warnings : [])
      .map((entry) => text(entry, 120))
      .filter((entry) => entry && !/[\\/]/.test(entry) && !(this.msyDir && entry.includes(this.msyDir)))
      .slice(0, MAX_WARNINGS)
    const payload = {
      version: SOURCES_STATE_VERSION,
      updatedAt: this.#nowIso(),
      msy: {
        status: STATUSES.has(state.status) ? state.status : 'degraded',
        questionStatus: STATUSES.has(state.questionStatus) ? state.questionStatus : 'degraded',
        resumeStatus: STATUSES.has(state.resumeStatus) ? state.resumeStatus : 'degraded',
        mappingVersion: text(state.mappingVersion, 40),
        hash: text(state.hash, 128),
        resumeHash: text(state.resumeHash, 128),
        count: Math.max(0, Math.trunc(Number(state.count) || 0)),
        resume: Math.max(0, Math.trunc(Number(state.resume) || 0)),
        counters: {
          scanned: boundedCount(state.counters?.scanned),
          invalid: boundedCount(state.counters?.invalid),
          skippedOffTopic: boundedCount(state.counters?.skippedOffTopic),
          withAnswer: boundedCount(state.counters?.withAnswer),
        },
        warnings,
        collectedAt: DATE_ONLY.test(text(state.collectedAt, 10)) ? text(state.collectedAt, 10) : '',
      },
    }
    const body = `${JSON.stringify(payload, null, 2)}\n`
    const tmpPath = `${this.sourcesPath}.tmp`
    try {
      await writeFile(tmpPath, body, 'utf8')
      await rename(tmpPath, this.sourcesPath)
    } catch {
      // 状态文件写不进去不影响题库存量：仅本进程内状态为准。
    }
    return payload.msy
  }

  async #syncExternalSources(db) {
    if (!this.msyDir) {
      this.sourceState = emptySourceState()
      return
    }
    const directory = process.platform === 'win32' ? this.msyDir.toLowerCase() : this.msyDir
    const sourceKey = createHash('sha256').update(directory).digest('hex')
    db.exec('CREATE TABLE IF NOT EXISTS market_external_source (slot INTEGER PRIMARY KEY CHECK (slot = 1), source_key TEXT NOT NULL)')
    const owner = db.prepare('SELECT source_key FROM market_external_source WHERE slot = 1').get()
    const sameSource = owner?.source_key === sourceKey
    if (!sameSource) {
      // Switch both external domains together. A degraded load can only retain rows from this directory.
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('DELETE FROM market_questions_fts WHERE id IN (SELECT id FROM market_questions WHERE seed_source IN (?, ?))').run(...EXTERNAL_SOURCES)
        db.prepare('DELETE FROM market_questions WHERE seed_source IN (?, ?)').run(...EXTERNAL_SOURCES)
        db.prepare('INSERT OR REPLACE INTO market_external_source (slot, source_key) VALUES (1, ?)').run(sourceKey)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    const previous = sameSource ? await this.#readPersistedState() : emptySourceState()
    const keepPrevious = async (status, warnings, extra = {}) => {
      const counts = guard(() => this.#domainCounts(db), '本地市场题库统计失败')
      this.sourceState = await this.#persistSourceState({
        ...previous,
        status,
        questionStatus: extra.questionStatus ?? status,
        resumeStatus: extra.resumeStatus ?? status,
        counters: { ...previous.counters, ...(extra.counters || {}) },
        warnings,
        count: counts.question,
        resume: counts.resume,
      })
      return this.sourceState
    }

    const reader = await this.#resolveReader()
    if (typeof reader !== 'function') {
      return keepPrevious('degraded', ['msy-reader-unavailable'])
    }

    let result
    try {
      result = await reader({ dir: this.msyDir, now: this.now(), limits: { ...EXTERNAL_LIMITS } })
    } catch {
      // 受控或非受控错误一律降级：旧行保留、继续可用。
      return keepPrevious('degraded', ['msy-read-failed'])
    }

    const questions = this.#collectExternal(result?.questions, SOURCE_QUESTION)
    const resume = this.#collectExternal(result?.resume, SOURCE_RESUME)
    const remoteStats = result?.stats && typeof result.stats === 'object' ? result.stats : {}
    const mappingVersion = text(remoteStats.mappingVersion, 40)
    const questionHash = text(remoteStats.questionHash, 128)
    const resumeHash = text(remoteStats.resumeHash, 128)
    const collectedAt = DATE_ONLY.test(text(remoteStats.collectedAt, 10)) ? text(remoteStats.collectedAt, 10) : ''
    const warnings = (Array.isArray(remoteStats.warnings) ? remoteStats.warnings : [])
      .map((entry) => text(entry, 120))
      .filter(Boolean)
      .slice(0, MAX_WARNINGS)

    let counts = guard(() => this.#domainCounts(db), '本地市场题库统计失败')

    // shrink guard：空来源或同 mappingVersion 下条数腰斩时保留旧行，本次不写。
    const grew = (incoming, current) => incoming.length > 0 && incoming.length >= Math.ceil(current * SHRINK_RATIO)
    const guardedQuestion = counts.question > 0 && !grew(questions.items, counts.question)
    const guardedResume = counts.resume > 0 && !grew(resume.items, counts.resume)
    if (guardedQuestion) warnings.push(questions.items.length ? 'msy-question-shrink-kept' : 'msy-question-empty-kept')
    if (guardedResume) warnings.push(resume.items.length ? 'msy-resume-shrink-kept' : 'msy-resume-empty-kept')
    if (questions.dropped) warnings.push('msy-question-invalid-dropped')
    if (resume.dropped) warnings.push('msy-resume-invalid-dropped')

    const sameVersion = mappingVersion === previous.mappingVersion
    const questionUnchanged = sameVersion
      && Boolean(questionHash) && questionHash === previous.hash
      && counts.question === previous.count
    const resumeUnchanged = sameVersion
      && Boolean(resumeHash) && resumeHash === previous.resumeHash
      && counts.resume === previous.resume

    let wrote = 0
    if (!guardedQuestion && !questionUnchanged) {
      if (questions.items.length || counts.question) {
        wrote += guard(() => this.#writeExternalDomain(db, SOURCE_QUESTION, questions.items), '本地题库来源同步失败')
      }
    }
    if (!guardedResume && !resumeUnchanged) {
      if (resume.items.length || counts.resume) {
        wrote += guard(() => this.#writeExternalDomain(db, SOURCE_RESUME, resume.items), '本地题库来源同步失败')
      }
    }

    counts = guard(() => this.#domainCounts(db), '本地市场题库统计失败')
    const questionStatus = guardedQuestion ? 'degraded' : 'ok'
    const resumeStatus = guardedResume || remoteStats.resumeStatus === 'degraded' ? 'degraded' : 'ok'
    const status = questionStatus === 'ok' && resumeStatus === 'ok'
      ? (wrote === 0 && (questionUnchanged || resumeUnchanged) ? 'skipped' : 'ok')
      : 'degraded'
    // 被拒的收缩不推进 hash/采集时间：否则下一次会被误判成 unchanged 而永远不应用删除。
    const anyGuarded = guardedQuestion || guardedResume
    this.sourceState = await this.#persistSourceState({
      status,
      questionStatus,
      resumeStatus,
      mappingVersion,
      hash: guardedQuestion ? previous.hash : questionHash || previous.hash,
      resumeHash: guardedResume ? previous.resumeHash : resumeHash || previous.resumeHash,
      collectedAt: anyGuarded ? previous.collectedAt : collectedAt || previous.collectedAt,
      counters: {
        scanned: boundedCount(remoteStats.scanned),
        invalid: boundedCount(remoteStats.invalid),
        skippedOffTopic: boundedCount(remoteStats.skippedOffTopic),
        withAnswer: boundedCount(remoteStats.withAnswer),
      },
      warnings,
      count: counts.question,
      resume: counts.resume,
    })
    return this.sourceState
  }

  #collectExternal(list, source) {
    const items = []
    const seen = new Set()
    let dropped = 0
    for (const raw of Array.isArray(list) ? list : []) {
      const item = normalizeExternalItem(raw, source)
      if (!item || seen.has(item.id)) { dropped += 1; continue }
      seen.add(item.id)
      items.push(item)
      if (items.length >= MAX_EXTERNAL_ITEMS) break
    }
    return { items, dropped }
  }

  /** 外部来源的独立写域：只动自己的行，绝不覆盖精选包或另一个外部域。 */
  #writeExternalDomain(db, source, items) {
    const nowIso = this.#nowIso()
    db.exec('BEGIN IMMEDIATE')
    try {
      const dropFts = db.prepare('DELETE FROM market_questions_fts WHERE id = ?')
      const owner = db.prepare('SELECT seed_source FROM market_questions WHERE id = ?')
      const upsert = db.prepare(UPSERT)
      const insertFts = db.prepare('INSERT INTO market_questions_fts (id, body) VALUES (?, ?)')
      const keep = []
      let written = 0
      for (const item of items) {
        const current = owner.get(item.id)
        if (current && Number(current.seed_source) !== source) continue
        keep.push(item.id)
        upsert.run(item.id, item.rolePack, item.topic, item.kind, item.revision, item.reviewAfter || null, source, JSON.stringify(item), nowIso)
        dropFts.run(item.id)
        insertFts.run(item.id, ftsBody(item))
        written += 1
      }
      const gone = keep.length
        ? db.prepare(`SELECT id FROM market_questions WHERE seed_source = ? AND id NOT IN (${placeholders(keep.length)})`).all(source, ...keep)
        : db.prepare('SELECT id FROM market_questions WHERE seed_source = ?').all(source)
      for (const row of gone) dropFts.run(String(row.id))
      if (keep.length) {
        db.prepare(`DELETE FROM market_questions WHERE seed_source = ? AND id NOT IN (${placeholders(keep.length)})`).run(source, ...keep)
      } else {
        db.prepare('DELETE FROM market_questions WHERE seed_source = ?').run(source)
      }
      db.exec('COMMIT')
      return written
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 事务已结束 */ }
      throw error
    }
  }

  /** 候选 SQL 必须自带 LIMIT，并且精选包排在外部来源前面，保证 46 条不被挤出。 */
  #candidates(db, chunks, sources) {
    const scope = `seed_source IN (${placeholders(sources.length)})`
    const all = () => db.prepare(`
      SELECT payload FROM market_questions
      WHERE ${scope}
      ORDER BY seed_source, id
      LIMIT ?
    `).all(...sources, MAX_LIMIT)
    if (!chunks.length) return all()
    try {
      const expression = buildMatchExpression(chunks)
      if (expression) {
        const rows = db.prepare(`
          SELECT q.payload AS payload
          FROM market_questions_fts
          JOIN market_questions q ON q.id = market_questions_fts.id
          WHERE market_questions_fts MATCH ?
            AND q.seed_source IN (${placeholders(sources.length)})
          ORDER BY q.seed_source, q.id
          LIMIT ?
        `).all(expression, ...sources, MAX_LIMIT)
        if (rows.length) return rows
      }
    } catch {
      // MATCH 语法或分词异常：落到 LIKE 兜底，再交给 JS 精确过滤。
    }
    try {
      const rows = db.prepare(`
        SELECT payload FROM market_questions
        WHERE payload LIKE ? ESCAPE '\\' AND ${scope}
        ORDER BY seed_source, id
        LIMIT ?
      `).all(`%${escapeLike(chunks[0])}%`, ...sources, MAX_LIMIT)
      if (rows.length) return rows
    } catch {
      // LIKE 也不可用时退回本来源范围内的一页：结果仍由 JS 过滤。
    }
    return all()
  }

  #parseRow(row) {
    try {
      const item = JSON.parse(String(row?.payload ?? ''))
      return item && typeof item === 'object' ? item : null
    } catch {
      return null
    }
  }
}
