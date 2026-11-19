/**
 * msy-connector.js — 把本机 msy 题库目录读成市场题库条目（只读、离线、不执行）
 *
 * 边界：
 *   · 只读文件；不写、不删、不联网、不读 .mianshiya-cookie。
 *   · 不 import / require / spawn msy 的任何 .mjs；resume-bank.mjs 走 literal-data.js 的受限字面量解析。
 *   · 错误只带 `hr-interview/msy-*` 代码、通用中文文案与计数，绝不回显正文或绝对路径。
 *
 * 受控错误码（目录 / NDJSON 级）：
 *   hr-interview/msy-dir-invalid            目录参数无效（空、非绝对路径）
 *   hr-interview/msy-dir-missing            目录不存在或不是目录
 *   hr-interview/msy-questions-missing      questions.ndjson 不存在
 *   hr-interview/msy-questions-empty        文件为空 / 没有任何可导入的 Agent 题
 *   hr-interview/msy-questions-too-large    超过 32 MiB
 *   hr-interview/msy-questions-too-many-lines 超过 50,000 行
 *   hr-interview/msy-questions-invalid      坏行超过容忍上限
 *   hr-interview/msy-read-failed            其它读取失败（脱敏后的兜底）
 *
 * resume-bank.mjs 的任何失败都不抛错：resume=[]、resumeStatus='degraded' 并附 warning，
 * NDJSON 结果照常返回。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { HR_QUESTION_TOPIC_LABELS, remoteFailure } from './contract.js'
import { LiteralDataError, parseExportedConst } from './literal-data.js'

/** 映射版本：白名单/主题/kind 规则或 hash 口径变化时必须提升，以保证 revision 变化。 */
export const MSY_MAPPING_VERSION = 'msy-agent-v1'

export const MSY_LIMITS = Object.freeze({
  maxQuestionBytes: 32 * 1024 * 1024,
  maxQuestionLines: 50_000,
  maxLineChars: 4 * 1024 * 1024,
  maxResumeBytes: 1024 * 1024,
  maxResumeItems: 200,
  maxAnswerBytes: 512 * 1024,
  maxBadLineRatio: 0.01,
  maxBadLines: 20,
  maxPoints: 3,
  maxTags: 6,
})

/** 真实面试鸭标签里的 Agent/大模型方向：精确等值匹配（NFKC + 小写），不做子串猜测。 */
const TAG_TOPICS = new Map()
const AGENT_TAGS = {
  'agent-core': [
    'Agent', 'Agent开发', 'Agent 开发', 'Agent 原理', 'Agent 智能体', 'AI Agent', 'AI智能体',
    '大模型应用开发', 'AI应用开发', 'AI 应用开发', '大模型应用', 'LLM应用开发', 'LLM应用',
    '大模型', 'AI', 'LLM', 'Prompt', 'Prompt 工程', 'Prompt 设计', 'Prompt 提示词',
    '提示工程', '提示词工程基础', '提示词结构', '提示词模板', '提示词链接', '负面提示词',
    '领域专用提示词', 'System Prompt', 'AI工程', 'AI 赋能', 'AI 能力', 'AI架构', '多模态',
    '微调', '大模型推理', '智能体', '智能体（Agent）', 'Spring AI', 'AIGC', '语言大模型',
    'Token', '推理引导',
  ],
  'mcp-tools': ['MCP', 'AI 工具', 'Function Calling', 'A2A', 'AI基础设施', 'AI基础架构'],
  rag: [
    'RAG', 'RAG 基础', 'RAG 流程', 'RAG 检索增强', 'RAG 评估', 'LangChain', 'LangChain 基础',
    'Chain 链式调用', 'LlamaIndex', '向量数据库', '向量数据库选型', '向量索引', '词向量',
    'Embedding', 'Embedding 模型选择', 'Word Embedding', '混合检索', '检索失败处理',
    'Retriever 检索器', '信息检索',
  ],
  memory: ['Memory 记忆机制', '上下文隔离', '上下文窗口', '上下文管理', '提示词压缩'],
  reliability: ['效果评估', '评估指标', '模型评估'],
}

export const AGENT_TAG_WHITELIST = Object.freeze(
  Object.fromEntries(Object.entries(AGENT_TAGS).map(([topic, tags]) => [topic, Object.freeze([...tags])])),
)

for (const [topic, tags] of Object.entries(AGENT_TAGS)) {
  for (const tag of tags) {
    const key = tag.normalize('NFKC').trim().toLowerCase()
    if (!TAG_TOPICS.has(key)) TAG_TOPICS.set(key, topic)
  }
}
Object.freeze(TAG_TOPICS)

/** 面试鸭里与候选人技术栈无关的平台专属题；与 msy 的 syllabus.mjs 保持同一套规则。 */
export const OFF_STACK = /Android|synchronized|AsyncTask|Thread\.sleep|ThreadLocal|iOS|Swift|Dart|Flutter|C#|\.NET|Unity|PHP|Ruby|Rust|C\+\+|C语言|数仓|数据仓库/i

/** 标题规则归类：确定性、可复核，默认 principle，永不产出 behavioral。 */
const KIND_RULES = {
  incident: /(?:故障|事故|线上|超时|崩溃|泄漏|OOM|内存溢出|死循环|报错|异常|排查|定位|根因|失败|降级)/,
  evaluation: /(?:评估|评测|衡量|指标|准确率|召回率|效果|怎么证明|如何证明)/,
  project: /(?:项目|实践|落地|上线|你做过|你参与)/,
}

const ANSWER_HEADING = /^#{1,6}\s*回答重点\s*$/
const ANY_HEADING = /^#{1,6}\s/
const LIST_ITEM = /^\s*(?:\d{1,2}[）).、]|[-*•·])\s*(.*)$/
const RESUME_BULLET = /^\s*(?:[·•\-*]|\d{1,2}[）).、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*(.*)$/
const ID_PATTERN = /^[\w:-]{1,80}$/

const INVALID = Symbol('invalid')

const failure = (code, message, details = {}) => remoteFailure(code, message, details)

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

const singleLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

const boundedRevision = (hash) => (Number.parseInt(hash.slice(0, 8), 16) % 1_000_000) + 1

const asDate = (value) => {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  return Number.isNaN(date.getTime()) ? new Date() : date
}

const clampLimit = (value, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.trunc(number)))
}

function boundLimits(overrides = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {}
  return {
    maxQuestionBytes: clampLimit(source.maxQuestionBytes, MSY_LIMITS.maxQuestionBytes),
    maxQuestionLines: clampLimit(source.maxQuestionLines, MSY_LIMITS.maxQuestionLines),
    maxLineChars: clampLimit(source.maxLineChars, MSY_LIMITS.maxLineChars),
    maxResumeBytes: clampLimit(source.maxResumeBytes, MSY_LIMITS.maxResumeBytes),
    maxResumeItems: clampLimit(source.maxResumeItems, MSY_LIMITS.maxResumeItems),
    maxAnswerBytes: clampLimit(source.maxAnswerBytes, MSY_LIMITS.maxAnswerBytes),
    maxBadLineRatio: MSY_LIMITS.maxBadLineRatio,
    maxBadLines: MSY_LIMITS.maxBadLines,
    maxPoints: MSY_LIMITS.maxPoints,
    maxTags: MSY_LIMITS.maxTags,
  }
}

const topicForTags = (tags) => {
  for (const tag of tags) {
    const topic = TAG_TOPICS.get(String(tag ?? '').normalize('NFKC').trim().toLowerCase())
    if (topic) return topic
  }
  return ''
}

const kindForTitle = (title) => {
  for (const kind of ['incident', 'evaluation', 'project']) {
    if (KIND_RULES[kind].test(title)) return kind
  }
  return 'principle'
}

/** 从官方题解的「回答重点」小节机械提取要点：优先列表项，其次段落，最多 maxPoints 条。 */
export function extractAnswerPoints(markdown, maxPoints = MSY_LIMITS.maxPoints) {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return []
  const lines = text.split('\n')
  const start = lines.findIndex((line) => ANSWER_HEADING.test(line.trim()))
  if (start === -1) return []
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (ANY_HEADING.test(lines[index].trim())) break
    body.push(lines[index])
  }
  const withoutCode = []
  let fenced = false
  for (const line of body) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue }
    if (!fenced) withoutCode.push(line)
  }
  const clean = (value) => singleLine(
    String(value ?? '')
      .replace(/`+/g, '')
      .replace(/\*\*|__/g, '')
      .replace(/^\s*>\s?/, ''),
    240,
  )

  const points = []
  const push = (value) => {
    const point = clean(value)
    if (!point || points.includes(point)) return
    points.push(point)
  }

  for (const line of withoutCode) {
    const item = LIST_ITEM.exec(line)
    if (item) push(item[1])
    if (points.length >= maxPoints) return points.slice(0, maxPoints)
  }
  if (points.length) return points.slice(0, maxPoints)

  let paragraph = []
  const flush = () => {
    if (!paragraph.length) return
    push(paragraph.join(' '))
    paragraph = []
  }
  for (const line of withoutCode) {
    if (!line.trim()) { flush(); if (points.length >= maxPoints) break; continue }
    paragraph.push(line.trim())
  }
  flush()
  return points.slice(0, maxPoints)
}

/** 简历题 `a` 的机械要点：只取自带项目符号/序号的句子，不总结、不改写。 */
export function extractResumePoints(answer, maxPoints = MSY_LIMITS.maxPoints) {
  const text = String(answer ?? '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return []
  const points = []
  for (const line of text.split('\n')) {
    const match = RESUME_BULLET.exec(line)
    if (!match) continue
    const point = singleLine(match[1].replace(/`+/g, '').replace(/\*\*|__/g, ''), 240)
    if (!point || points.includes(point)) continue
    points.push(point)
    if (points.length >= maxPoints) break
  }
  return points
}

async function resolveRoot(dir) {
  const raw = typeof dir === 'string' ? dir.trim() : ''
  if (!raw || !isAbsolute(raw)) throw failure('hr-interview/msy-dir-invalid', '本地题库目录无效，只接受绝对路径')
  const root = resolve(raw)
  let info
  try {
    info = await stat(root)
  } catch {
    throw failure('hr-interview/msy-dir-missing', '本地题库目录不可用')
  }
  if (!info.isDirectory()) throw failure('hr-interview/msy-dir-missing', '本地题库目录不可用')
  return root
}

/** 依次尝试候选相对路径；只返回真实存在的普通文件，不抛底层错误。 */
async function findFile(root, candidates) {
  for (const relative of candidates) {
    let path = ''
    try {
      path = join(root, relative)
      const info = await stat(path)
      if (info.isFile()) return { path, size: info.size }
    } catch {
      // 缺失即试下一个候选。
    }
  }
  return null
}

/** 流式按行读取并同时算整文件 hash；受字节数与行数上限约束。 */
async function scanLines(path, bound, handleLine) {
  const decoder = new StringDecoder('utf8')
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  const state = { bytes: 0, lines: 0 }
  let carry = ''
  try {
    for await (const chunk of stream) {
      state.bytes += chunk.length
      if (state.bytes > bound.maxQuestionBytes) {
        throw failure('hr-interview/msy-questions-too-large', '本地题库文件超过 32 MiB 上限')
      }
      hash.update(chunk)
      carry += decoder.write(chunk)
      if (carry.length > bound.maxLineChars) {
        throw failure('hr-interview/msy-questions-invalid', '本地题库存在超长数据行')
      }
      let index = carry.indexOf('\n')
      while (index !== -1) {
        const line = carry.slice(0, index).replace(/\r$/, '')
        carry = carry.slice(index + 1)
        state.lines += 1
        if (state.lines > bound.maxQuestionLines) {
          throw failure('hr-interview/msy-questions-too-many-lines', '本地题库行数超过 50,000 行上限')
        }
        handleLine(line)
        index = carry.indexOf('\n')
      }
    }
    carry += decoder.end()
    if (carry.trim()) {
      state.lines += 1
      if (state.lines > bound.maxQuestionLines) {
        throw failure('hr-interview/msy-questions-too-many-lines', '本地题库行数超过 50,000 行上限')
      }
      handleLine(carry.replace(/\r$/, ''))
    }
    return { hash: hash.digest('hex'), lines: state.lines, bytes: state.bytes }
  } finally {
    stream.destroy()
  }
}

async function readAnswerPoints(root, sourceId, bound) {
  for (const relative of [
    join('data', 'answers-cache', `${sourceId}.md`),
    join('answers-cache', `${sourceId}.md`),
  ]) {
    try {
      const path = join(root, relative)
      const info = await stat(path)
      if (!info.isFile() || info.size === 0 || info.size > bound.maxAnswerBytes) continue
      const markdown = await readFile(path, 'utf8')
      return extractAnswerPoints(markdown, bound.maxPoints)
    } catch {
      // 缺题解不阻塞。
    }
  }
  return []
}

const dedupeTags = (tags, maxCount) => {
  const out = []
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = singleLine(tag, 16)
    if (!value || out.includes(value)) continue
    out.push(value)
    if (out.length >= maxCount) break
  }
  return out
}

/** 单条 NDJSON 记录 → 草稿（不含 revision），或 OFF_TOPIC / INVALID。 */
function draftQuestion(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return INVALID
  const sourceId = String(record.id ?? '').trim()
  if (!ID_PATTERN.test(sourceId)) return INVALID
  const title = singleLine(record.title, 600)
  if (!title) return INVALID
  const rawTags = Array.isArray(record.tagList) ? record.tagList : []
  const topic = topicForTags(rawTags)
  if (!topic) return null
  if (OFF_STACK.test(title)) return null
  const reserved = new Set(AGENT_TAGS[topic].map((tag) => tag.normalize('NFKC').trim().toLowerCase()))
  const tags = dedupeTags(rawTags.filter((tag) => !reserved.has(String(tag ?? '').normalize('NFKC').trim().toLowerCase())), MSY_LIMITS.maxTags - 1)
  // 白名单标签本身就是主题信息，不需要再作为自由标签重复保留。
  tags.push('msy')
  const sourceTopic = HR_QUESTION_TOPIC_LABELS[topic] ?? topic
  return {
    sourceId,
    draft: {
      id: `msy-q-${sourceId}`,
      topic,
      kind: kindForTitle(title),
      question: title,
      sourceTitle: `面试鸭 · ${sourceTopic}`,
      sourceUrl: `https://www.mianshiya.com/question/${sourceId}`,
      tags,
    },
  }
}

function finalizeQuestion(draft, points, collectedAt) {
  const contentHash = sha256([
    MSY_MAPPING_VERSION, draft.id, draft.topic, draft.kind, draft.question,
    draft.tags.join('|'), points.join('|'), draft.sourceTitle, draft.sourceUrl,
  ].join('\n'))
  return {
    // 字段顺序与既有 market 条目一致，便于 bank 直接 upsert。
    id: draft.id,
    rolePack: 'agent',
    topic: draft.topic,
    kind: draft.kind,
    question: draft.question,
    followups: [],
    expectedPoints: points,
    sourceTitle: draft.sourceTitle,
    sourceUrl: draft.sourceUrl,
    evidenceLevel: 'edited',
    collectedAt,
    reviewedAt: '',
    reviewAfter: '',
    revision: boundedRevision(contentHash),
    tags: [...draft.tags],
    sourceType: 'msy-question',
    sourceRevision: contentHash,
  }
}

async function readAnswers(root, records, bound) {
  const items = new Array(records.length)
  let withAnswer = 0
  let cursor = 0
  const workers = Array.from({ length: Math.min(8, records.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= records.length) return
      const entry = records[index]
      const points = await readAnswerPoints(root, entry.sourceId, bound)
      if (points.length) withAnswer += 1
      items[index] = { points }
    }
  })
  await Promise.all(workers)
  return { points: items.map((entry) => entry.points), withAnswer }
}

function degraded(warnings, message) {
  if (message) warnings.push(message)
  return { items: [], hash: '', status: 'degraded' }
}

function literalReason(error) {
  return error instanceof LiteralDataError ? error.reason : 'unknown'
}

/** resume-bank.mjs → 简历深挖题；任何失败只降级，NDJSON 结果不受影响。 */
async function loadResume(root, collectedAt, bound, warnings) {
  const file = await findFile(root, ['resume-bank.mjs', join('data', 'resume-bank.mjs')])
  if (!file) return degraded(warnings, '未找到 resume-bank.mjs，已跳过本地简历深挖题')
  if (file.size === 0) return degraded(warnings, 'resume-bank.mjs 为空，已跳过本地简历深挖题')
  if (file.size > bound.maxResumeBytes) {
    return degraded(warnings, 'resume-bank.mjs 超过 1 MiB 上限，已跳过本地简历深挖题')
  }
  let source
  try {
    source = await readFile(file.path, 'utf8')
  } catch {
    return degraded(warnings, 'resume-bank.mjs 读取失败，已跳过本地简历深挖题')
  }
  let parsed
  try {
    parsed = parseExportedConst(source, 'RESUME_BANK')
  } catch (error) {
    return degraded(warnings, `resume-bank.mjs 未通过受限字面量校验（${literalReason(error)}），已跳过本地简历深挖题`)
  }
  if (!Array.isArray(parsed)) return degraded(warnings, 'resume-bank.mjs 结构不是数组，已跳过本地简历深挖题')
  if (parsed.length > bound.maxResumeItems) {
    return degraded(warnings, 'resume-bank.mjs 条目超过 200 条上限，已跳过本地简历深挖题')
  }

  const items = []
  const seen = new Set()
  let invalid = 0
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { invalid += 1; continue }
    const rawId = singleLine(entry.id, 80).toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(rawId)) { invalid += 1; continue }
    const question = singleLine(entry.q, 600)
    if (!question) { invalid += 1; continue }
    const id = `msy-r-${rawId}`
    if (seen.has(id)) { invalid += 1; continue }
    seen.add(id)
    const module = /^[a-z][a-z0-9-]{0,31}$/.test(singleLine(entry.module, 32)) ? singleLine(entry.module, 32) : 'resume'
    const points = extractResumePoints(entry.a, bound.maxPoints)
    const tags = dedupeTags([module, 'resume', 'msy'], bound.maxTags)
    const contentHash = sha256([
      MSY_MAPPING_VERSION, id, module, 'project', question, points.join('|'), module,
    ].join('\n'))
    items.push({
      id,
      // 个人项目深挖与具体岗位无关：进 shared 池，普通岗位按 JD/简历关键词取用。
      rolePack: 'shared',
      topic: module,
      kind: 'project',
      question,
      followups: [],
      expectedPoints: points,
      sourceTitle: `本地简历深挖 · ${module}`,
      sourceUrl: '',
      evidenceLevel: 'editorial',
      collectedAt,
      reviewedAt: '',
      reviewAfter: '',
      revision: boundedRevision(contentHash),
      tags,
      sourceType: 'msy-resume',
      sourceRevision: contentHash,
    })
  }
  if (invalid) warnings.push(`resume-bank.mjs 有 ${invalid} 条结构无效，已跳过`)
  if (!items.length) return degraded(warnings, 'resume-bank.mjs 没有可导入的题目，已跳过本地简历深挖题')
  return { items, hash: sha256(source), status: 'ok' }
}

/**
 * 读取本机 msy 题库目录。
 * @param {{ dir?: string, now?: Date|string|number, limits?: object }} options
 * @returns {Promise<{ questions: object[], resume: object[], stats: object }>}
 */
export async function readMsySource({ dir, now = new Date(), limits = {} } = {}) {
  const bound = boundLimits(limits)
  const collectedAt = asDate(now).toISOString()
  const warnings = []
  const root = await resolveRoot(dir)

  const ndjson = await findFile(root, [join('data', 'questions.ndjson'), 'questions.ndjson'])
  if (!ndjson) throw failure('hr-interview/msy-questions-missing', '本地题库缺少 questions.ndjson')
  if (ndjson.size === 0) throw failure('hr-interview/msy-questions-empty', '本地题库 questions.ndjson 为空')

  let scanned = 0
  let invalid = 0
  let skippedOffTopic = 0
  const records = []
  const seen = new Set()
  let questionHash = ''

  try {
    const result = await scanLines(ndjson.path, bound, (line) => {
      if (!line.trim()) return
      scanned += 1
      let record
      try {
        record = JSON.parse(line)
      } catch {
        invalid += 1
        return
      }
      const mapped = draftQuestion(record)
      if (mapped === INVALID) { invalid += 1; return }
      if (!mapped) { skippedOffTopic += 1; return }
      if (seen.has(mapped.draft.id)) { invalid += 1; return }
      seen.add(mapped.draft.id)
      records.push(mapped)
    })
    questionHash = result.hash
  } catch (error) {
    if (error?.isDSHRemoteError) throw error
    throw failure('hr-interview/msy-read-failed', '本地题库读取失败')
  }

  const tolerated = Math.min(bound.maxBadLines, Math.floor(scanned * bound.maxBadLineRatio))
  if (invalid > tolerated) {
    throw failure('hr-interview/msy-questions-invalid', '本地题库异常行超过容忍上限', { invalid, scanned })
  }
  if (!records.length) {
    throw failure('hr-interview/msy-questions-empty', '本地题库没有可导入的 Agent 题目', { scanned })
  }

  const answers = await readAnswers(root, records, bound)
  const questions = records.map((entry, index) => finalizeQuestion(entry.draft, answers.points[index], collectedAt))

  const resume = await loadResume(root, collectedAt, bound, warnings)

  if (invalid) warnings.push(`questions.ndjson 有 ${invalid} 行无法解析，已跳过`)
  if (skippedOffTopic) warnings.push(`questions.ndjson 有 ${skippedOffTopic} 条非 Agent 方向题目，已跳过`)

  return {
    questions,
    resume: resume.items,
    stats: {
      mappingVersion: MSY_MAPPING_VERSION,
      questionHash,
      resumeHash: resume.items.length ? resume.hash : '',
      scanned,
      imported: questions.length,
      resumeImported: resume.items.length,
      invalid,
      skippedOffTopic,
      withAnswer: answers.withAnswer,
      warnings,
      resumeStatus: resume.status,
      collectedAt,
    },
  }
}
