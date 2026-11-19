import { createHash } from 'node:crypto'
import { buildDutyQuestionPlan, detectRolePack, normalizeSingleLine } from './question-plan.js'
import { backendRole, conflictingRoleQuestion, matchProfileDuty, operationsRole, roleDefaults, roleDutyHint } from './role-profile.js'
import { agentOutlineDirections } from './agent-outline-directions.js'
import { mainQuestionWording } from './main-question-wording.js'

const wordSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
const genericWords = new Set(['负责', '工作', '职责', '岗位', '相关', '进行', '参与', '现场', '日常', '能力', '要求', '完成', '处理', '管理', '工程', '其他', '以及', '配合', '协调', '确保', '及时', 'of', 'and', 'the', 'for', 'with', 'work'])
const identity = (value) => createHash('sha256').update(value).digest('hex')
const INTERVIEW_SEARCH_VERSION = 6
const compact = (value) => normalizeSingleLine(value).replace(/[^\p{L}\p{N}]/gu, '')
const keywords = (value) => [...new Set([...wordSegmenter.segment(normalizeSingleLine(value))]
  .filter(({ segment, isWordLike }) => isWordLike && segment.length > 1 && !genericWords.has(segment))
  .map(({ segment }) => segment))]

function directionTerms(value) {
  return normalizeSingleLine(value)
    .replace(/核验|核实|核对|查验/gu, '检查')
    .replace(/检索增强生成|检索增强|\brag\b/gu, '检索增强')
    .replace(/评测|评估/gu, '评估')
}

export function sameOutlineDirection(left, right) {
  const first = directionTerms(left)
  const second = directionTerms(right)
  if (compact(first) === compact(second)) return true
  const a = keywords(first)
  const b = keywords(second)
  return a.length > 1 && b.length > 1 && a.filter((word) => b.includes(word)).length / new Set([...a, ...b]).size >= 0.8
}

function distinctDirections(values) {
  const result = []
  for (const value of values) if (!result.some((entry) => sameOutlineDirection(value, entry))) result.push(value)
  return result
}

function selectDirections({ previous, candidates, recent = [], jdDuties, limit, families }) {
  const ordered = distinctDirections(candidates)
    .map((direction) => ({ direction, recent: recent.some((entry) => sameOutlineDirection(direction, entry)) }))
    .sort((a, b) => Number(a.recent) - Number(b.recent))
  const count = Math.min(ordered.length, limit, previous.length || limit)
  if (!count) return []
  if (!previous.length) return ordered.slice(0, count).map(({ direction }) => direction)
  const indexOfDuty = (value) => {
    const index = jdDuties.findIndex((duty) => sameOutlineDirection(duty, value))
    return index < 0 ? jdDuties.length : index
  }
  const replace = jdDuties.length
    ? previous.map((duty, index) => ({ index, rank: indexOfDuty(duty) }))
      .sort((a, b) => b.rank - a.rank || b.index - a.index)
      .slice(0, count).map(({ index }) => index).sort((a, b) => a - b)
    : Array.from({ length: count }, (_, index) => (Math.floor(index * previous.length / count) + Math.floor(recent.length / previous.length)) % previous.length)
  const family = (direction) => families.get(direction) || direction
  const covered = new Set(previous.filter((_, index) => !replace.includes(index)).map(family))
  const next = [...previous]
  for (const position of replace) {
    const diverse = ordered.findIndex((entry) => !entry.recent && !covered.has(family(entry.direction)))
    const [{ direction }] = ordered.splice(diverse < 0 ? 0 : diverse, 1)
    next[position] = direction
    covered.add(family(direction))
  }
  return next
}

const dutyTerms = [
  ['门岗值守', '门卫值守', '门岗值班', '门卫值班', '门卫执勤'],
  ['巡查', '巡检', '巡逻', '巡视'],
  ['交接班', '交接', '换班'],
  ['异常上报', '异常报告', '及时上报', '及时报告', '情况上报', '情况报告', '报告异常'],
  ['点餐上菜', '点餐及上菜', '点餐和上菜', '点餐与上菜'],
  ['处理顾客投诉', '处理客诉', '处理客户投诉', '处理客人投诉'],
  ['访客', '来访', '外来人员'],
  ['登记', '核验', '核查', '查验'],
  ['工具调用', 'tool calling', 'function calling', 'tool use'],
  ['检索增强', 'rag'],
  ['评测集', '评测', '评估'],
]
const dutyAction = /值守|值班|登记|接待|点餐|上菜|清洁|维护|巡查|巡检|巡逻|交接|上报|报告|负责|保障|检查|核实|管理|操作|装配|设计|开发|测试|联调|定位|排障|部署|运行|评估|审核|处理|记录|沟通|协调|分析|使用|服务|跟进|编制|组织|支持|执行|培训|研发/u
const compensationOnly = /^(?:(?:[五六七]险(?:一金)?|绩效奖(?:金)?|年终奖(?:金)?|带薪年假|节日(?:福利|礼品|礼物)|岗位晋升|晋升机会|餐补|交通补贴|住房补贴)[\s、+，,/]*)+$/u

function splitJobClauses(value, separators) {
  const clauses = []
  let depth = 0
  let start = 0
  for (const { 0: token, index } of value.matchAll(separators)) {
    if ('([【'.includes(token)) depth += 1
    else if (')]】'.includes(token)) depth = Math.max(0, depth - 1)
    else if (!depth || token === '\n' || token === '\r') {
      clauses.push(value.slice(start, index))
      start = index + token.length
      depth = 0
    }
  }
  return [...clauses, value.slice(start)]
}

function separateDuties(part) {
  const pieces = []
  const chunks = splitJobClauses(part, /[()[\]【】、]/gu)
  let combined = ''
  for (const [index, chunk] of chunks.entries()) {
    combined = combined ? `${combined}、${chunk}` : chunk
    const next = chunks[index + 1]
    if (next && !dutyAction.test(next) && /登记|核验|核查|检查|清点|维护|审核/.test(combined)) continue
    if (dutyAction.test(chunk)) {
      pieces.push(combined)
      combined = ''
    }
  }
  if (combined) pieces.push(combined)
  return pieces
}

/** A full duty, a specific action, or multiple distinct terms. A generic noun alone does not cover a duty. */
export function matchesDuty(duty, text, { publicSource = false } = {}) {
  const target = compact(duty)
  const candidate = compact(text)
  if (target.length > 1 && candidate.includes(target)) return true
  const hits = keywords(duty).filter((word) => candidate.includes(compact(word)))
  if (hits.length >= 2 || hits.some((word) => /^[a-z][a-z0-9]{2,}$/.test(word) && target === word)) return true
  return dutyTerms.some((group) => {
    // Registration/verification needs its object as well. Otherwise any unrelated registration would count.
    const actions = group[0] === '登记' ? group.slice(0, 1) : group
    const matchingAction = actions.find((term) => target.includes(compact(term)))
    if (!matchingAction || !actions.some((term) => candidate.includes(compact(term)))) return false
    const remaining = keywords(target.replace(compact(matchingAction), '')).filter((word) => word !== '物业')
    if (group[0] === '登记') return !remaining.length || remaining.some((word) => candidate.includes(compact(word)))
    return publicSource || !remaining.length || remaining.some((word) => candidate.includes(compact(word)))
  })
}

export function readJobDuties(value, limit = 6) {
  const jd = String(value ?? '').normalize('NFKC').slice(0, 5000)
    .replace(/(?:任职资格|任职要求|岗位要求|福利待遇|招聘条件|qualifications)\s*[:：][\s\S]*$/iu, '')
    .replace(/(?:岗位职责|工作职责|主要职责|职位描述|工作内容|responsibilities)\s*[:：]/giu, '')
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '')
  const duties = []
  const clauses = splitJobClauses(jd, /[()[\]【】\r\n;；。!！|,，]|\.\s+(?=[A-Z])/gu)
  for (const part of clauses.flatMap(separateDuties)) {
    const duty = part.trim()
      .replace(/^(?:\s*[-*•·]|\s*[\d一二三四五六七八九十]{1,2}[.、)）])+\s*/u, '')
      .replace(/^(?:主要)?(?:负责|参与|协助|承担|做好|包括)\s*/u, '')
      .replace(/[。.!！；;]+$/u, '').trim()
    if (duty.length < 2 || duty.length > 120 || (!keywords(duty).length && !dutyAction.test(duty)) || !/\p{L}/u.test(duty)) continue
    if (compensationOnly.test(duty) || /^(?:具备|要求|我们|招聘|熟悉|精通|熟练|优先|学历|专业|薪资|待遇|联系人|电话|地址|年龄|身高|性别)/u.test(duty)) continue
    if (!duties.some((existing) => compact(existing) === compact(duty))) duties.push(duty)
    if (duties.length >= limit) break
  }
  return duties
}

const verifiedVariants = (record) => [record, ...(record?.relatedQuestions || [])].filter((entry) => mainQuestionWording(entry?.sourceQuestion))
const sourceIsFresh = (record, now) => typeof record?.sourceUrl === 'string' && typeof record.reviewAfter === 'string' && Date.parse(record.reviewAfter) > now.getTime()
  && (!record.sourceQuestion || verifiedVariants(record).length > 0)

function safeQueryPart(value, max) {
  return String(value ?? '').normalize('NFKC').replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '')
    .replace(/(?:\+?\d[ -]?){5,}/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function questionVariants(duty) {
  const scenario = [
    [/门岗.*值守|门卫.*值班/u, `做${duty}时，一名访客正在等你核实登记，这时又有人反映门口秩序异常。你会先处理哪件事，怎么安排等候的访客？`],
    [/(?:人员|访客|来访).*登记/u, `做${duty}时，来访人员说有预约，但现场提供的信息和已有记录对不上。你会怎样核实，暂时核实不了时怎么处理？`],
    [/点餐|上菜/u, `做${duty}时，客人说上错了菜，厨房也在催另一桌取餐。你会先做什么，怎么核对并告知客人？`],
    [/顾客投诉|客诉/u, `做${duty}时，客人表示等了很久并要求你当场给出处理方案。你会先核实什么，可以当场确认哪些事？`],
    [/登记|核验|查验|registration|verify/i, `做${duty}时，现场提供的信息和已有记录对不上。你会怎样核实，暂时无法核实的内容怎么处理？`],
    [/巡查|巡检|巡逻|inspection|patrol/i, `做${duty}时，你发现一处与以往不同的情况。你会先检查什么，怎么记录并决定是否需要后续处理？`],
    [/交接|handover|handoff/i, `做${duty}时，上一班还有一件事没处理完，记录也不完整。你会确认哪些信息，怎样避免后续遗漏？`],
    [/上报|报告|报告异常|escalat/i, `遇到需要${duty}的情况，但细节还没完全核实。你会先做什么，汇报哪些信息，之后怎么补充？`],
    [/值守|值班|接待|front desk/i, `做${duty}时，两件需要你处理的事同时发生。你会如何分清轻重缓急，并让暂时需要等待的人知道下一步？`],
  ].find(([pattern]) => pattern.test(duty))?.[1]
  const alternative = [
    [/门岗.*值守|门卫.*值班/u, `做${duty}时，一位来访者希望先进去再补登记，现场同事暂时联系不上。你会怎么回应并处理？`],
    [/巡查|巡检|巡逻|inspection|patrol/i, `你在${duty}中连续两次发现同一个问题。你会留下哪些记录，怎样确认问题得到处理？`],
    [/交接|handover|handoff/i, `做${duty}时，你发现两份记录对同一件事的描述不一致。你打算向谁核实，怎么向接班的人说明？`],
  ].find(([pattern]) => pattern.test(duty))?.[1]
  return [scenario || `假设你刚接手「${duty}」。如果发现一处容易出错的环节，你会怎么处理，又怎么确认结果符合要求？`,
    alternative || `在「${duty}」这项工作中，遇到超出自己权限或判断范围的问题，你会先核实什么，如何记录并交接给适合的人？`]
}

const researchId = (role, duty) => identity(`${compact(role)}|${compact(duty)}`)
export const interviewRoleScope = (role) => identity(compact(role)).slice(0, 16)
const softwareRole = /软件(?:工程|开发|测试)|(?:计算机|系统)软件|(?:前端|后端|全栈)(?:研发|开发|工程师)|(?:测试|运维)开发|devops|\bsre\b|\bsoftware (?:engineer|developer)\b/i
const broadRole = /^(?:(?:初级|中级|高级|资深|实习)\s*)?(?:工程师|技术员|技术支持|专员|助理|实习生|经理|主管|工作人员|员工|运营|短剧|影视|新媒体|电商|直播|engineer|technician|specialist|assistant|intern|manager)$/iu

function scopedLocalItems(role, items, today) {
  const agent = detectRolePack({ role }) === 'agent'
  // The existing shared pack is shared by software roles. It is not a multi-occupation bank.
  if (!agent && !backendRole(role) && !operationsRole(role) && !softwareRole.test(role)) return []
  return items.filter((item) => (agent || item.rolePack === 'shared') && item.sourceType !== 'msy-resume'
    && !item.stale && (!item.reviewAfter || item.reviewAfter >= today) && !conflictingRoleQuestion(role, item.question) && mainQuestionWording(item.question))
}

function supplementItem(role, duty, record, index, question, scenario, generated = false) {
  const basis = record?.sourceQuestion ? 'public-interview' : record ? 'public-duty' : 'simulation'
  return {
    id: `role-${identity(`${researchId(role, duty)}|${basis}|${record?.sourceQuestion || (generated ? compact(question) : index)}`).slice(0, 22)}`,
    topic: duty,
    kind: scenario?.kind || 'behavioral',
    question,
    followups: [`针对「${duty}」，你会根据什么判断需要请同事或主管协助？`],
    expectedPoints: scenario?.points || ['说明处理顺序和判断依据', '说明如何核实、记录或向相关人员交接'],
    sourceType: basis,
    evidenceLevel: record ? 'edited' : 'editorial',
    ...(record ? {
      sourceTitle: record.sourceTitle,
      sourceUrl: record.sourceUrl,
      sourceExcerpt: record.sourceExcerpt,
      reviewAfter: record.reviewAfter.slice(0, 10),
      sourceRevision: identity(`${record.sourceUrl}|${record.sourceExcerpt}`).slice(0, 24),
    } : {}),
  }
}

export function createRoleResearch(provider) {
  return async ({ materials, items, knowledge, durationMinutes, cache, refresh = false, fixedDirections = null,
    fixedRoleContextMissing = false, previousDirections = null, previousQuestionIds = [], recentDirections = [], now = new Date(), signal }) => {
    const role = safeQueryPart(materials.role, 48)
    let duties = readJobDuties(materials.jd, previousDirections ? 12 : 6)
    if (previousDirections) duties = distinctDirections(duties)
    const jdDuties = [...duties]
    const suppliedDuties = new Set(jdDuties)
    const needsRoleContext = !duties.length && broadRole.test(role)
    const defaults = roleDefaults(role)
    const inferredKey = researchId(role, '')
    const inferred = cache[inferredKey]
    if (!duties.length && (backendRole(role) || operationsRole(role))) duties = defaults.map(({ duty }) => duty)
    if (!needsRoleContext && !duties.length && Array.isArray(inferred?.duties) && inferred.interviewSearchVersion === INTERVIEW_SEARCH_VERSION
      && Date.parse(inferred.reviewAfter) > now.getTime()) duties = inferred.duties
    const today = now.toISOString().slice(0, 10)
    const active = scopedLocalItems(role, items, today)
    const localDirections = !suppliedDuties.size && detectRolePack({ role }) === 'agent'
    if (!duties.length && localDirections) {
      const topics = [...new Set(active.filter((item) => item.rolePack === 'agent'
        || (previousDirections && item.topic === 'project-general')).map((item) => item.topic).filter(Boolean))]
      duties = previousDirections ? topics : topics.slice(0, 6)
    }
    const isNewDirection = (duty) => !previousDirections?.some((prior) => sameOutlineDirection(prior, duty))
    let prefetched = new Map()
    if (fixedDirections) duties = fixedDirections
    else if (previousDirections) {
      const limit = durationMinutes >= 30 ? 3 : 2
      const localTopics = new Map(active.map(({ id, topic }) => [id, topic]))
      const oldIds = new Set(previousQuestionIds)
      const families = new Map([...agentOutlineDirections].map(([direction, ids]) => [direction, ids.map((id) => localTopics.get(id)).find(Boolean)]))
      const fineDirections = [...agentOutlineDirections].filter(([direction, ids]) => families.get(direction) && !ids.some((id) => oldIds.has(id)))
      const candidates = (localDirections ? [...fineDirections.map(([direction]) => direction), ...duties] : duties).filter(isNewDirection)
      if (candidates.length < limit && !suppliedDuties.size && !needsRoleContext && role) {
        // With no explicit JD, let the host Agent find other real work areas for the role.
        prefetched = await provider({ role, duties: [], queryTopics: [], previousDirections, signal })
        candidates.push(...[...prefetched.keys()].filter(isNewDirection))
      }
      duties = selectDirections({ previous: previousDirections, candidates, recent: recentDirections, jdDuties, limit, families })
      if (!duties.length) return { directionChangeUnavailable: true }
    }
    const reservedIds = new Set(duties.flatMap((duty) => agentOutlineDirections.get(duty) || []))
    const fromLocal = (duty) => active.filter((item) => {
      const dedicated = agentOutlineDirections.get(duty)
      if (dedicated) return dedicated.includes(item.id)
      if (reservedIds.has(item.id)) return false
      const hints = [item.topic, item.question, ...(item.tags || [])].join(' ')
      return matchProfileDuty(role, duty, hints) ?? matchesDuty(duty, hints)
    })
    const records = new Map()
    const agentSimulations = new Map()
    const missing = duties.filter((duty) => {
      if (fromLocal(duty).length) return false
      const cached = cache[researchId(role, duty)]
      if (cached?.interviewSearchVersion === INTERVIEW_SEARCH_VERSION && Date.parse(cached.reviewAfter) > now.getTime()) {
        if (cached.simulationQuestions?.length) agentSimulations.set(duty, cached.simulationQuestions)
        if (sourceIsFresh(cached, now)) records.set(duty, cached)
      }
      if (prefetched.has(duty) || (previousDirections?.includes(duty) && agentSimulations.has(duty))) return false
      return !records.has(duty) || (refresh && !cached.relatedQuestions?.length)
    })
    const updates = {}
    if (prefetched.size || (role && !needsRoleContext && (missing.length || !duties.length))) {
      const researched = missing.length || !duties.length
        ? await provider({ role, duties: missing, queryTopics: missing.map((duty) => roleDutyHint(role, duty) || safeQueryPart(duty, 16)), signal })
        : new Map()
      const result = new Map([...prefetched, ...researched])
      const reviewAfter = new Date(now.getTime() + 14 * 86400_000).toISOString()
      if (!duties.length && result.size) {
        duties = [...result.keys()].slice(0, 6)
        updates[inferredKey] = { duties, reviewAfter, interviewSearchVersion: INTERVIEW_SEARCH_VERSION }
      }
      for (const [duty, record] of result) {
        if (!duties.includes(duty)) continue
        const key = researchId(role, duty)
        const { simulationQuestions, ...evidence } = record
        if (simulationQuestions?.length) agentSimulations.set(duty, simulationQuestions)
        const current = records.get(duty)
        const simulationCache = agentSimulations.has(duty) ? { simulationQuestions: agentSimulations.get(duty) } : {}
        if (!evidence.sourceUrl || (evidence.sourceQuestion && !verifiedVariants(evidence).length) || (current?.sourceQuestion && !evidence.sourceQuestion)) {
          if (simulationQuestions?.length) updates[key] = { reviewAfter, interviewSearchVersion: INTERVIEW_SEARCH_VERSION, ...current, ...simulationCache }
          continue
        }
        const verified = evidence.sourceQuestion ? [evidence, ...(evidence.relatedQuestions || [])] : []
        if (evidence.sourceQuestion && current?.sourceQuestion) {
          for (const candidate of [current, ...(current.relatedQuestions || [])]) {
            if (verified.length >= 3) break
            if (!verified.some((entry) => compact(entry.sourceQuestion) === compact(candidate.sourceQuestion))) {
              const { relatedQuestions: _discarded, ...entry } = candidate
              verified.push(entry)
            }
          }
        }
        const stored = { ...evidence, ...simulationCache, ...(verified.length > 1 ? { relatedQuestions: verified.slice(1, 3) } : {}), reviewAfter, interviewSearchVersion: INTERVIEW_SEARCH_VERSION }
        records.set(duty, stored)
        updates[key] = stored
      }
    }
    if (!duties.length && defaults.length) duties = defaults.map(({ duty }) => duty)
    if (!fixedDirections && !previousDirections && !suppliedDuties.size && defaults.length) {
      const covered = new Set(duties.map((duty) => defaults.find((entry) => entry.duty === duty)?.duty
        || defaults.find(({ clues }) => clues.test(records.get(duty)?.sourceQuestion || duty))?.duty))
      duties = [...duties, ...defaults.map(({ duty }) => duty).filter((duty) => !covered.has(duty))].slice(0, 6)
    }
    const roleContextMissing = !duties.length || (fixedDirections !== null && fixedRoleContextMissing)
    if (!duties.length) duties = [`${role || '目标岗位'}的日常工作`, `${role || '目标岗位'}的异常情况处理`]
    const groups = duties.map((duty) => {
      const local = fromLocal(duty)
      if (local.length) return { duty, basis: 'local', items: local }
      const record = records.get(duty)
      const scenario = defaults.find((entry) => entry.duty === duty)
        || ((!record?.sourceQuestion || suppliedDuties.has(duty)) ? defaults.find((entry) => entry.clues.test(duty)) : undefined)
      const generated = (agentSimulations.get(duty) || []).filter(mainQuestionWording)
      const questions = generated.length ? generated : scenario?.questions || questionVariants(duty)
      let variants
      if (record?.sourceQuestion) {
        const verified = verifiedVariants(record)
        variants = verified.map((source, index) => supplementItem(role, duty, { ...source, reviewAfter: record.reviewAfter }, index, source.sourceQuestion, scenario))
        // A retrieved question can name a topic. It is insufficient on its own to create a new workplace scenario.
        if (generated.length || scenario || suppliedDuties.has(duty)) variants.push(supplementItem(role, duty, null, 0, questions[0], scenario, generated.length > 0))
      } else variants = questions.map((question, index) => supplementItem(role, duty, record, index, question, scenario, generated.length > 0))
      return {
        duty,
        basis: record?.sourceQuestion ? 'public-interview' : record ? 'public-duty' : 'simulation',
        items: variants,
      }
    })
    return {
      build: (options = {}) => ({
        ...buildDutyQuestionPlan({ groups, materials, knowledge: knowledge.filter((point) => point?.roleScope === interviewRoleScope(materials.role)), durationMinutes,
          mainPriorityDirections: previousDirections ? duties.filter(isNewDirection) : [], ...options }),
        roleContextMissing,
      }),
      updates,
    }
  }
}
