import { createHash } from 'node:crypto'
import { projectIntroduction, QUESTION_SEQUENCE_VERSION, requiredMainQuestionContext } from './question-sequence.js'
import { mainQuestionWording } from './main-question-wording.js'
import { remoteFailure } from './contract.js'

export const TAXONOMY_VERSION = '2026-11'
export const EMPTY_BANK_CODE = 'hr-interview/market-bank-empty'
export const MIN_ACTIVE_ITEMS = 5

const KINDS = ['project', 'principle', 'incident', 'evaluation', 'behavioral']

/** 6 条配额：project2/principle1/incident1/evaluation1/behavioral1 */
const QUOTA_SHORT = { project: 2, principle: 1, incident: 1, evaluation: 1, behavioral: 1 }
/** 8 条配额：project2/principle2/incident2/evaluation1/behavioral1 */
const QUOTA_LONG = { project: 2, principle: 2, incident: 2, evaluation: 1, behavioral: 1 }

const AGENT_ROLE_KEYWORDS = [
  'agent', 'ai agent', '智能体', '多智能体', 'ai 应用', 'ai应用', 'ai应用开发', '大模型应用',
  '大模型应用开发', 'llm 应用', 'llm应用', 'rag', 'mcp', '工具调用', 'tool use', 'function calling',
  'langchain', 'langgraph', 'dify', 'coze', '提示词工程', 'prompt 工程', 'prompt工程',
]

const AGENT_JD_KEYWORDS = [
  'agent', '智能体', '多智能体', 'mcp', 'rag', '检索增强', '工具调用', 'tool calling',
  'function calling', 'workflow', '工作流编排', '记忆机制', '上下文管理', '提示词', 'prompt',
  'langchain', 'langgraph', '向量数据库', 'embedding', 'rerank', '评测集', '幻觉', '越狱',
]

/** 明确同义词：只收录行业内可直接互换的说法，不做模糊扩展。 */
const SYNONYMS = [
  ['agent', '智能体'],
  ['工具调用', 'function calling', 'tool calling', 'tool use'],
  ['rag', '检索增强', '检索增强生成'],
  ['mcp', 'model context protocol', '工具协议'],
  ['记忆', 'memory', '上下文'],
  ['评测', '评估', 'evaluation', '评测集'],
  ['幻觉', 'hallucination'],
  ['提示词', 'prompt'],
  ['重排', 'rerank'],
  ['向量', 'embedding', '向量数据库'],
  ['多智能体', 'multi-agent', 'multi agent'],
  ['工作流', 'workflow', '编排'],
  ['降级', 'fallback', '兜底'],
  ['成本', '计费', 'token 成本', 'cost'],
  ['安全', '越狱', '注入', 'prompt injection'],
  ['缓存', 'cache', '缓存命中'],
  ['并发', 'concurrency'],
  ['微服务', 'microservice'],
  ['数据库', 'mysql', 'sql'],
  ['性能优化', '调优'],
]

const EVIDENCE_SCORE = { first_hand: 3, edited: 2, editorial: 1 }
const MATERIAL_WEIGHT = { role: 3, jd: 4, resume: 2, projectNotes: 2 }
const MAX_LIMIT = 200
/** 候选池上限：46 条精选 + 外部来源（msy 岗位题/简历题）都要在截断前留下。 */
const MAX_POOL = 5000
const MAX_SOURCE_REVISION = 128

/**
 * 换题种子：只用来在同一 score 内换顺序，不参与任何过滤或打分。
 * 限长 32，避免调用方把 planKey 拼成任意长串。
 */
export const SELECTION_SEED_PATTERN = /^[a-z0-9]{8,32}$/

/** 非法/缺失的种子一律归一成空串：空串必须继续走旧的确定性路径。 */
export function normalizeSelectionSeed(value) {
  return typeof value === 'string' && SELECTION_SEED_PATTERN.test(value) ? value : ''
}

const emptyBank = (message, details) => remoteFailure(EMPTY_BANK_CODE, message, details)

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

/** 基础规范化：全半角、空白、换行、大小写差异全部抹平。 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 单行规范化：压掉换行与多余空格，并去掉中文/标点两侧的排版空格。 */
export function normalizeSingleLine(value) {
  return normalizeText(value)
    .replace(/\s+/g, ' ')
    .replace(/(?<=[^a-z0-9])\s+(?=[^a-z0-9])/g, '')
    .trim()
}

const BULLET_PREFIX = /^[-*•·—–]+\s*/
const ENUM_PREFIX = /^\d{1,2}[.)、]\s*/

/** 简历/笔记按行或条目切成有序数组，条目前缀符号被去掉。 */
function toLines(value) {
  const parts = []
  const push = (raw) => {
    const line = normalizeSingleLine(raw).replace(BULLET_PREFIX, '').replace(ENUM_PREFIX, '').trim()
    if (line) parts.push(line)
  }
  const walk = (node) => {
    if (node == null) return
    if (typeof node === 'string') {
      for (const line of node.split('\n')) push(line)
      return
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry)
      return
    }
    if (typeof node === 'object') {
      const pieces = [node.title, node.name, node.text, node.content, node.detail, node.summary, node.value]
      let emitted = false
      for (const piece of pieces) {
        if (typeof piece === 'string' && piece.trim()) {
          push(piece)
          emitted = true
        }
      }
      if (!emitted && Array.isArray(node.items)) walk(node.items)
    }
  }
  walk(value)
  return parts
}

const uniqueSorted = (list) => [...new Set(list)].sort()

const bagHash = (lines) => sha256(uniqueSorted(lines).join('\n'))
const orderedHash = (lines) => sha256(lines.join('\n'))

function materialFacts(materials, roleLine, noteLines, resumeLines) {
  const clauses = new Set()
  // role 恒入事实集：岗位名变化必须改变 profileKey，即使简历与 JD 未动。
  clauses.add(`role=${roleLine}`)
  for (const line of resumeLines) clauses.add(`resume=${line}`)
  for (const line of noteLines) clauses.add(`note=${line}`)
  return sha256([...clauses].sort().join('\n'))
}

/**
 * 角色包判定：只看 role 与 JD 的明确关键词。
 * 普通技术岗（后端/前端/测试/运维…）没有 agent 关键词时一律 generic。
 */
export function detectRolePack(materials = {}) {
  const role = normalizeText(materials?.role)
  const jd = normalizeText(materials?.jd)
  if (AGENT_ROLE_KEYWORDS.some((keyword) => role.includes(keyword))) return 'agent'
  const jdHits = AGENT_JD_KEYWORDS.filter((keyword) => jd.includes(keyword))
  return jdHits.length >= 2 ? 'agent' : 'generic'
}

/** 材料指纹：resumeOrderedHash 反映书写顺序，resumeBagHash 只反映内容集合。 */
export function materialsProfile(materials = {}, options = {}) {
  const packId = normalizeText(options.packId ?? detectRolePack(materials)) === 'agent' ? 'agent' : 'generic'
  const durationMinutes = boundDuration(options.durationMinutes ?? 30)
  const taxonomyVersion = String(options.taxonomyVersion ?? TAXONOMY_VERSION)
  const roleLine = normalizeSingleLine(materials?.role)
  const jdLine = normalizeSingleLine(materials?.jd)
  const resumeLines = toLines(materials?.resume)
  const noteLines = toLines(materials?.projectNotes)
  const resumeOrderedHash = orderedHash(resumeLines)
  const resumeBag = bagHash(resumeLines)
  const jdHash = sha256(jdLine)
  const factFingerprint = materialFacts(materials, roleLine, noteLines, resumeLines)
  const profileKey = sha256([packId, resumeBag, jdHash, factFingerprint, durationMinutes, taxonomyVersion].join('|'))
  return {
    packId, durationMinutes, taxonomyVersion,
    resumeOrderedHash, resumeBagHash: resumeBag, jdHash, factFingerprint, profileKey,
  }
}

function boundDuration(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 30
  return Math.min(120, Math.max(5, Math.round(number)))
}

function planShape(durationMinutes) {
  if (durationMinutes >= 30) {
    return { total: 8, main: 6, alternates: 2, quota: QUOTA_LONG }
  }
  return { total: 6, main: 4, alternates: 2, quota: QUOTA_SHORT }
}

const normalizeId = (value) => String(value ?? '').trim()

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = normalizeId(raw.id ?? raw.bankItemId)
  if (!id) return null
  const kind = normalizeText(raw.kind)
  if (!KINDS.includes(kind)) return null
  const rolePack = normalizeText(raw.rolePack) === 'agent' ? 'agent' : 'shared'
  const originalQuestion = String(raw.question ?? '').trim()
  const question = mainQuestionWording(originalQuestion)
  if (!question) return null
  const list = (value) => (Array.isArray(value) ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [])
  const revision = Number.isInteger(Number(raw.revision)) && Number(raw.revision) > 0 ? Number(raw.revision) : 1
  const evidenceLevel = ['first_hand', 'edited', 'editorial'].includes(normalizeText(raw.evidenceLevel))
    ? normalizeText(raw.evidenceLevel)
    : 'editorial'
  const reviewAfter = String(raw.reviewAfter ?? '').slice(0, 10)
  return {
    id, rolePack, kind,
    topic: String(raw.topic ?? '').trim(),
    question,
    followups: list(raw.followups),
    expectedPoints: list(raw.expectedPoints),
    tags: list(raw.tags),
    revision,
    evidenceLevel,
    sourceTitle: String(raw.sourceTitle ?? '').trim(),
    sourceUrl: String(raw.sourceUrl ?? '').trim(),
    sourceExcerpt: (String(raw.sourceExcerpt ?? '').trim() || (question === originalQuestion ? '' : originalQuestion)).slice(0, 200),
    reviewAfter: /^\d{4}-\d{2}-\d{2}$/.test(reviewAfter) ? reviewAfter : '',
    stale: raw.stale === true,
    // 外部来源（msy 岗位题/简历题）才有内容版本；精选包不带这些字段，避免制造空值。
    sourceType: normalizeText(raw.sourceType).slice(0, 32),
    sourceRevision: String(raw.sourceRevision ?? '').trim().slice(0, MAX_SOURCE_REVISION),
  }
}

/** 来源快照：精选包保持原有五个字段，外部来源按需追加类型与内容版本。 */
function sourceRefOf(item) {
  const ref = {
    bankItemId: item.id,
    revision: item.revision,
    sourceTitle: item.sourceTitle,
    sourceUrl: item.sourceUrl,
    evidenceLevel: item.evidenceLevel,
  }
  if (item.sourceType && item.sourceType !== 'seed') ref.sourceType = item.sourceType
  if (item.sourceRevision) ref.sourceRevision = item.sourceRevision
  if (item.sourceExcerpt) ref.sourceExcerpt = item.sourceExcerpt
  return ref
}

const dayOf = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  const stable = Number.isNaN(date.getTime()) ? new Date(0) : date
  return stable.toISOString().slice(0, 10)
}

const isActive = (item, today) => {
  if (item.stale) return false
  if (!item.reviewAfter) return true
  return item.reviewAfter >= today
}

const matchesPack = (item, packId) => (packId === 'agent' ? item.rolePack === 'agent' || item.rolePack === 'shared' : item.rolePack === 'shared')

/** 同义词组展开成一个 term 集合，用于材料与题目之间的直接匹配。 */
function synonymSet(term) {
  for (const group of SYNONYMS) {
    if (group.some((entry) => entry === term || term.includes(entry))) return group
  }
  return [term]
}

function itemTerms(item) {
  const base = [normalizeText(item.topic), ...item.tags.map(normalizeText)]
  const question = normalizeText(item.question)
  for (const group of SYNONYMS) {
    if (group.some((entry) => question.includes(entry))) base.push(group[0])
  }
  return [...new Set(base.filter(Boolean))]
}

function keywordScore(item, sections, sectionCaps) {
  const terms = itemTerms(item)
  let score = 0
  const caps = sectionCaps ?? {}
  for (const [name, rawText] of Object.entries(sections)) {
    const body = normalizeText(rawText)
    if (!body) continue
    let hits = 0
    for (const term of terms) {
      const group = synonymSet(term)
      if (group.some((entry) => entry && body.includes(entry))) hits += 1
    }
    const cap = caps[name] ?? 3
    score += Math.min(cap, hits) * (MATERIAL_WEIGHT[name] ?? 1)
  }
  return score
}

function weaknessScore(item, knowledge) {
  if (!Array.isArray(knowledge) || !knowledge.length) return 0
  const terms = itemTerms(item)
  let best = 0
  for (const entry of knowledge) {
    if (!entry || typeof entry !== 'object') continue
    const mastery = Number(entry.mastery)
    if (!Number.isFinite(mastery) || mastery >= 4) continue
    const label = normalizeText(`${entry.domain ?? ''} ${entry.title ?? ''}`)
    if (!label.trim()) continue
    const hit = terms.some((term) => label.includes(term) || synonymSet(term).some((alias) => alias && label.includes(alias)))
    if (!hit) continue
    const weight = mastery <= 1 ? 5 : mastery <= 2 ? 3 : 1
    if (weight > best) best = weight
  }
  return best
}

function scoreItem(item, sections, knowledge, caps) {
  return keywordScore(item, sections, caps) + (EVIDENCE_SCORE[item.evidenceLevel] ?? 1) + weaknessScore(item, knowledge)
}

const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

const byScoreThenId = (a, b) => (b.score - a.score) || compareKeys(a.item.id, b.item.id)

/**
 * 排序器：三层，越靠前越优先。
 * 1) 本轮还没见过的候选优先（avoidItemIds）—— 只是排到后面，不删除，所以候选够时主问题会换、
 *    候选不够时旧题仍然补得上，不会因此报空库；
 * 2) score 降序（岗位匹配 / 薄弱知识 / 证据等级都算在里面）；
 * 3) seed 决定同分之间谁先谁后；seed 为空时退回按 id 升序。
 * 空 seed + 空 avoid 时返回的正是 byScoreThenId —— 与引入换题前逐字节等价。
 */
const rankComparator = (seed, avoid) => {
  if (!seed && !avoid.size) return byScoreThenId
  const tie = seed
    ? (a, b) => compareKeys(sha256(`${seed}|${a.item.id}`), sha256(`${seed}|${b.item.id}`))
    : (a, b) => compareKeys(a.item.id, b.item.id)
  return (a, b) => (avoid.has(a.item.id) ? 1 : 0) - (avoid.has(b.item.id) ? 1 : 0)
    || (b.score - a.score)
    || tie(a, b)
}

const normalizeAvoidIds = (value) => new Set(
  (Array.isArray(value) ? value : [])
    .filter((id) => typeof id === 'string' && id)
    .slice(0, MAX_POOL),
)

const distinctTopics = (entries) => new Set(entries.map((entry) => entry.item.topic || entry.item.id)).size

/**
 * 选题：先按 kind 配额，再按确定性顺序补位；补位不得让整份提纲塌成同一 topic。
 */
function selectItems(ranked, quota, total) {
  const picked = []
  const used = new Set()
  for (const kind of KINDS) {
    const want = quota[kind] ?? 0
    let got = 0
    for (const entry of ranked) {
      if (got >= want) break
      if (used.has(entry.item.id)) continue
      if (entry.item.kind !== kind) continue
      picked.push(entry)
      used.add(entry.item.id)
      got += 1
    }
  }
  for (const entry of ranked) {
    if (picked.length >= total) break
    if (used.has(entry.item.id)) continue
    picked.push(entry)
    used.add(entry.item.id)
  }
  if (picked.length > 1 && distinctTopics(picked) === 1) {
    const sameTopic = picked[0].item.topic || picked[0].item.id
    const replacement = ranked.find((entry) => !used.has(entry.item.id) && (entry.item.topic || entry.item.id) !== sameTopic)
    if (replacement) {
      picked[picked.length - 1] = replacement
      used.add(replacement.item.id)
    } else {
      // 全部候选同 topic：与已选条目内部换一条不同 topic 的（若存在）也做不到，就保持确定性降级。
    }
  }
  return picked
}

/**
 * 生成面试提纲：纯函数、确定性，不读取时间以外的任何外部状态。
 * 15 分钟 → 6 条（4 主 + 2 备），30 分钟及以上 → 8 条（6 主 + 2 备）。
 * selectionSeed 只打散同分条目的顺序（用于「换一批题」）；为空时输出与旧版完全一致。
 * avoidItemIds 是本轮「已经见过」的 bankItemId 列表：只降权不删除，用于 refresh 时优先换新题。
 */
export function buildQuestionPlan({
  materials = {},
  durationMinutes = 30,
  knowledge = [],
  items = [],
  now = new Date(),
  taxonomyVersion = TAXONOMY_VERSION,
  selectionSeed = '',
  avoidItemIds = [],
} = {}) {
  const duration = boundDuration(durationMinutes)
  const seed = normalizeSelectionSeed(selectionSeed)
  const avoid = normalizeAvoidIds(avoidItemIds)
  const packId = detectRolePack(materials)
  const profile = materialsProfile(materials, { packId, durationMinutes: duration, taxonomyVersion })
  const today = dayOf(now)
  const pool = (Array.isArray(items) ? items : [])
    .slice(0, MAX_POOL)
    .map(normalizeItem)
    .filter(Boolean)
    .filter((item) => matchesPack(item, packId))

  const sections = {
    role: materials?.role,
    jd: materials?.jd,
    resume: Array.isArray(materials?.resume) ? toLines(materials.resume).join('\n') : materials?.resume,
    projectNotes: toLines(materials?.projectNotes).join('\n'),
  }
  const caps = { role: 3, jd: 4, resume: 3, projectNotes: 3 }

  // 简历深挖题（shared 池）进普通岗位是有条件的：必须命中 role/JD/简历里的关键词，
  // 否则财务、运营这类无关岗位会把别人的项目题带进提纲。
  const relevantEnough = (item) => packId === 'agent'
    || item.sourceType !== 'msy-resume'
    || keywordScore(item, sections, caps) > 0

  const active = pool.filter((item) => isActive(item, today) && relevantEnough(item))
  if (!active.length) {
    throw emptyBank('当前岗位包没有可用的市场题目，请先同步题库或更换岗位包', { packId })
  }
  if (active.length < MIN_ACTIVE_ITEMS) {
    throw emptyBank('可用市场题目不足 5 条，无法生成面试提纲', { packId, active: active.length })
  }

  const ranked = active
    .map((item) => ({ item, score: scoreItem(item, sections, knowledge, caps) }))
    .sort(rankComparator(seed, avoid))

  const shape = planShape(duration)
  const picked = selectItems(ranked, shape.quota, shape.total)

  // 候选不足时预算按实际选中的条数收窄，避免 UI 展示不存在的备选
  const budget = {
    main: Math.min(shape.main, picked.length),
    total: picked.length,
  }
  budget.alternates = Math.max(0, budget.total - budget.main)

  const items2 = picked.map((entry, index) => ({
    planItemId: `plan-${index + 1}`,
    bankItemId: entry.item.id,
    topic: entry.item.topic,
    kind: entry.item.kind,
    question: entry.item.question,
    followups: [...entry.item.followups],
    expectedPoints: [...entry.item.expectedPoints],
    alternate: index >= budget.main,
    sourceRefs: [sourceRefOf(entry.item)],
  }))

  // 外部分内容版本优先：题库内容变化必须能改变 planKey，profileKey 只跟材料走。
  // 换题种子只在非空时追加一段：空种子下哈希输入与引入换题前逐字节相同，旧 preparation 不必迁移。
  const keyParts = [
    profile.profileKey,
    taxonomyVersion,
    ...items2.map((entry) => {
      const [ref] = entry.sourceRefs
      return `${entry.bankItemId}@${ref.sourceRevision || ref.revision}`
    }),
  ]
  if (seed) keyParts.push(`seed:${seed}`)
  const planKey = sha256(keyParts.join('|'))

  return {
    packId,
    taxonomyVersion,
    profileKey: profile.profileKey,
    planKey,
    selectionSeed: seed,
    durationMinutes: duration,
    questionBudget: budget,
    items: items2,
  }
}

/** Choose one main question per covered duty before filling remaining slots. */
export function buildDutyQuestionPlan({ groups, materials, knowledge, durationMinutes, selectionSeed = '', avoidItemIds = [], previousItems = null,
  previousReviewAfter = null, keepOpening = false, mainPriorityDirections = [] }) {
  const shape = planShape(boundDuration(durationMinutes))
  const profile = materialsProfile(materials, { durationMinutes })
  const seed = normalizeSelectionSeed(selectionSeed)
  const avoid = normalizeAvoidIds(avoidItemIds)
  const compare = rankComparator(seed, avoid)
  const used = new Set()
  const usedQuestions = new Set()
  const picked = []
  const reviewDates = []
  const pools = groups.map(({ duty, basis, items }) => {
    const ranked = items.map(normalizeItem).filter(Boolean)
      .map((item) => ({ item, key: normalizeSingleLine(item.question), score: (EVIDENCE_SCORE[item.evidenceLevel] ?? 1) + weaknessScore(item, knowledge) }))
    if (basis === 'public-interview') {
      ranked.sort((a, b) => Number(b.item.sourceType === 'public-interview') - Number(a.item.sourceType === 'public-interview')
        || (seed || avoid.size ? compare(a, b) : 0))
    } else if (basis === 'local' || seed || avoid.size) ranked.sort(compare)
    return { duty, basis, ranked }
  })
  const add = ({ duty, basis }, { item, key }) => {
    const questionBasis = item.sourceType === 'simulation' ? 'simulation' : basis
    used.add(item.id)
    usedQuestions.add(key)
    if (item.reviewAfter) reviewDates.push(item.reviewAfter)
    picked.push({
      bankItemId: item.id, topic: item.topic || duty, duty, basis: questionBasis,
      kind: item.kind, question: item.question, followups: [...item.followups], expectedPoints: [...item.expectedPoints],
      contextRequirement: requiredMainQuestionContext(item.question),
      sourceRefs: questionBasis === 'simulation' ? [] : [sourceRefOf(item)],
    })
  }
  const available = ({ item, key }) => !used.has(item.id) && !usedQuestions.has(key)
  if (previousItems) {
    const previousIds = new Set(previousItems.map((item) => item.bankItemId))
    const previousQuestions = new Set(previousItems.map((item) => normalizeSingleLine(item.question)))
    const hasOpening = previousItems.some((item) => item.opening)
    for (const previous of previousItems) {
      const pool = pools.find(({ duty }) => duty === previous.duty)
      const candidate = !previous.opening && pool?.ranked.find((entry) => available(entry)
        && !previousIds.has(entry.item.id) && !previousQuestions.has(entry.key)
        && (previous.basis !== 'public-interview' || entry.item.sourceType === 'public-interview')
        && (hasOpening || !requiredMainQuestionContext(entry.item.question)))
      if (candidate) add(pool, candidate)
      else {
        picked.push(previous)
        if (previousReviewAfter && previous.sourceRefs?.length) reviewDates.push(previousReviewAfter)
      }
    }
  } else {
    while (picked.length < shape.total) {
      const previousCount = picked.length
      for (const pool of pools) {
        const candidate = pool.ranked.find(available)
        if (candidate) add(pool, candidate)
        if (picked.length >= shape.total) break
      }
      if (picked.length === previousCount) break
    }
  }
  const sequence = !previousItems && picked.length && (keepOpening || profile.packId === 'agent' || picked.some((item) => item.contextRequirement))
    ? [projectIntroduction, ...picked].slice(0, shape.total) : picked
  const main = previousItems ? previousItems.filter((item) => !item.alternate).length : Math.min(shape.main, sequence.length)
  const priority = new Set(mainPriorityDirections)
  for (let index = main; index < sequence.length && priority.size; index += 1) {
    const item = sequence[index]
    const visible = sequence.slice(0, main)
    if (!priority.has(item.duty) || visible.some((entry) => entry.duty === item.duty)) continue
    const replace = visible.findLastIndex((entry) => !entry.opening && !priority.has(entry.duty))
    if (replace >= 0) [sequence[replace], sequence[index]] = [item, sequence[replace]]
  }
  const items = sequence.map((item, index) => ({ ...item, planItemId: `plan-${index + 1}`, alternate: index >= main }))
  const planKey = sha256([profile.profileKey, `duty-plan-v${QUESTION_SEQUENCE_VERSION}`, seed, ...items.map((entry) =>
    `${entry.duty}|${entry.bankItemId}|${entry.sourceRefs[0]?.sourceRevision || entry.sourceRefs[0]?.revision || entry.question}`)].join('\n'))
  return {
    packId: profile.packId, taxonomyVersion: profile.taxonomyVersion, profileKey: profile.profileKey,
    planKey, selectionSeed: seed, durationMinutes: profile.durationMinutes, dutyPlan: true, questionSequenceVersion: QUESTION_SEQUENCE_VERSION,
    reviewAfter: reviewDates.sort()[0] || null,
    questionBudget: { main, total: items.length, alternates: items.length - main }, items,
  }
}

/**
 * 两次选题的差异：changed = 新提纲里有多少条是上一次没有的题；
 * mainChanged = 有多少个主问题席位（alternate !== true）坐着「上一次不在主问题里」的题。
 * 两个口径互相独立：同一批题在主席位与备选席位之间挪动时 changed 为 0，但主问题确实换了。
 */
export function selectionDiff(previousItems, nextItems) {
  const previous = Array.isArray(previousItems) ? previousItems : []
  const next = Array.isArray(nextItems) ? nextItems : []
  const previousAll = new Set(previous.map((entry) => String(entry?.bankItemId ?? '')).filter(Boolean))
  const previousMain = new Set(
    previous.filter((entry) => entry?.alternate !== true)
      .map((entry) => String(entry?.bankItemId ?? ''))
      .filter(Boolean),
  )
  const changedIds = []
  let mainChanged = 0
  for (const entry of next) {
    const id = String(entry?.bankItemId ?? '')
    if (!id) continue
    if (!previousAll.has(id)) changedIds.push(id)
    if (entry?.alternate !== true && !previousMain.has(id)) mainChanged += 1
  }
  return { changed: changedIds.length, mainChanged, changedIds }
}
