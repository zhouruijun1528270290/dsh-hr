import { matchesDuty, readJobDuties } from './role-research.js'
import { mainQuestionWording } from './main-question-wording.js'
import { conflictingRoleQuestion, matchProfileDuty, matchTechnicalRole, operationsRole, roleSearchNames } from './role-profile.js'

const MAX_BODY_CHARS = 150_000
const SEARCH_TIMEOUT = 12_000
const READ_TIMEOUT = 12_000
const INTERVIEW_PATHS = {
  'www.nowcoder.com': /^\/(?:discuss\/\d+|feed\/main\/detail\/[a-f0-9]{32})\/?$/i,
  'leetcode.cn': /^\/discuss\/(?:post|topic)\/[a-z0-9-]+\/?$/i,
  'www.zhihu.com': /^\/question\/\d+(?:\/answer\/\d+)?\/?$/i,
  'zhuanlan.zhihu.com': /^\/p\/\d+\/?$/i,
  'juejin.cn': /^\/post\/\d+\/?$/i,
  'blog.csdn.net': /^\/[\w-]+\/article\/details\/\d+\/?$/i,
  'tieba.baidu.com': /^\/p\/\d+\/?$/i,
  'www.xiaohongshu.com': /^\/(?:explore|discovery\/item)\/[a-f0-9]+\/?$/i,
}
const EMPLOYER_HOSTS = new Set(['talent.baidu.com', 'job-boards.greenhouse.io', 'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'jobs.zhaopin.com', 'www.zhaopin.com', 'careers.ihg.com.cn', 'careers.universalbeijingresort.com'])
const PUBLIC_ROLE_SOURCES = [
  {
    role: '保安',
    names: ['保安', '保安员', '门岗保安', '保安门岗', '门岗保安员', '物业保安', '物业门岗保安'],
    urls: [
      'https://www.hys.gov.cn/hysrmzfw/c105708/pc/content/content_2047207148974247936.html',
      'https://www.jmser.gov.cn/p192/wgjyrsj/20260512/436097.html',
    ],
  },
]
const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }
const decode = (value) => String(value).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|quot|apos|lt|gt|nbsp);/gi, (original, name) => {
  if (!name.startsWith('#')) return entities[name.toLowerCase()] || original
  const hex = name[1].toLowerCase() === 'x'
  const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original
})

function pageText(value) {
  return decode(value.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|noscript|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:p|br|li|tr|h[1-6]|div|section|article|td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[^\S\n]+/g, ' ').replace(/\n[\s\n]+/g, '\n').trim()
}

function allowedPage(raw) {
  try {
    const url = new URL(decode(raw))
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.pathname || url.pathname === '/') return null
    if (url.hostname === 'm.nowcoder.com') url.hostname = 'www.nowcoder.com'
    const interview = Object.hasOwn(INTERVIEW_PATHS, url.hostname) && INTERVIEW_PATHS[url.hostname].test(url.pathname)
    if (!interview && !url.hostname.endsWith('.gov.cn') && !url.hostname.endsWith('.edu.cn') && !EMPLOYER_HOSTS.has(url.hostname)) return null
    if (url.hostname === 'www.zhaopin.com' && !/^\/jobdetail\/[^/]+\.htm$/i.test(url.pathname)) return null
    url.hash = ''
    if (interview) {
      url.search = ''
      url.pathname = `${url.pathname.replace(/\/$/, '')}${url.hostname === 'leetcode.cn' ? '/' : ''}`
    }
    return url.href
  } catch { return null }
}

export const withTimeout = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)

async function getDocument(web, candidate, signal) {
  const document = await web.fetch({ url: candidate.url }, withTimeout(signal, READ_TIMEOUT))
  const url = allowedPage(document?.url)
  if (!url || interviewLink(url) !== interviewLink(candidate.url) || !Number.isInteger(document.statusCode)
    || document.statusCode < 200 || document.statusCode >= 300) return null
  const { kind, content } = document.body || {}
  if (typeof content !== 'string' || !content.trim() || !['html', 'text'].includes(kind)) return null
  return { url, kind, content: content.slice(0, MAX_BODY_CHARS), hintTitle: candidate.title }
}

async function searchCandidates(web, queries, matches, signal) {
  const normalized = queries.map((query) => query.replace(/\s+/g, ' ').trim())
  const outcomes = await Promise.allSettled([...new Set(normalized)].map(async (query) => {
    const response = await web.search({ query, maxResults: 8 }, withTimeout(signal, SEARCH_TIMEOUT))
    return (response?.sources || []).map((source) => ({ url: allowedPage(source.url), title: String(source.title || '').slice(0, 140) }))
      .filter((source) => source.url && matches(source.url))
  }))
  signal?.throwIfAborted()
  const groups = outcomes.filter((outcome) => outcome.status === 'fulfilled').map((outcome) => outcome.value)
  const ordered = Array.from({ length: 8 }, (_, index) => groups.map((group) => group[index]).filter(Boolean)).flat()
  const candidates = new Map()
  for (const candidate of ordered) if (!candidates.has(candidate.url)) candidates.set(candidate.url, candidate)
  return [...candidates.values()]
}

const interviewLink = (url) => Object.hasOwn(INTERVIEW_PATHS, new URL(url).hostname)
const interviewTitle = /面经|面试复盘|面试记录|面试经验|interview experience/i
const interviewRecall = /面试官.{0,16}(?:问|让我|要求)|(?:问到的|被问|面试中.{0,12}问|问了我|题目如下|面试题目|一面的问题|问题记录|面试问题)|我.{0,10}(?:参加|面了|投递|答了)|秋招.{0,14}(?:拿|投|结束)|二面.{0,10}问|(?:they|interviewer) asked|i (?:interviewed|was asked)/i
const resumeReview = /(?:帮(?:我|忙)?.{0,4}(?:看看|看下|看一下|看一看|点评|评估|改).{0,12}简历|简历.{0,12}(?:求点评|求指导|能不能过筛|能过筛吗))/u
const questionSignal = /[?？]|怎么|如何|为什么|有哪些|区别|说说|讲讲|介绍一下|做过|排查|有什么|^(?:describe|explain|tell me)\b/i
const shortRole = (role) => role.replace(/\s*(?:工程师|从业者|工作人员|员工|岗位|专员|engineer|specialist)\s*$/i, '').trim() || role

export function readInterviewBody(document, { wholeBody = false } = {}) {
  const { url, content, kind } = document
  const html = kind === 'html' ? content : ''
  const title = kind === 'html'
    ? pageText(/<title\b[^>]*>([^<]{1,400})<\/title>/i.exec(html)?.[1] || '').slice(0, 140)
    : (/^\s*#{1,4}\s+([^\r\n]+)/m.exec(content)?.[1] || '').slice(0, 140)
  const host = new URL(url).hostname
  const nowcoderBody = /\bclass="[^"]*(?:nc-slate-editor-content|feed-dynamic-root-content)[^"]*"[^>]*>/i.exec(html)
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1]
  const body = wholeBody && /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1]
  const nowcoder = nowcoderBody ? html.slice(nowcoderBody.index + nowcoderBody[0].length).split(/class="[^\"]*(?:js-comment-container|comment-list)/i)[0].slice(0, 40_000) : ''
  const post = (kind === 'text' ? content : pageText((host === 'www.nowcoder.com' ? nowcoder || article : article || main) || body || ''))
    .split(/\n\s*(?:#{1,6}\s*)?(?:全部评论|评论区|相关推荐|相关文章|Comments|Related Posts)(?:[ \t]*[（(]\d+[）)])?[ \t]*(?:\r?\n|$)/i)[0].slice(0, 48_000)
  return { title, post }
}

function interviewQuestions(document, role) {
  if (!document) return []
  const { url } = document
  const host = new URL(url).hostname
  const { title, post } = readInterviewBody(document)
  const introduction = `${title} ${post.slice(0, 3000)}`
  if (!post || resumeReview.test(`${title} ${post.slice(0, 180)}`) || !interviewTitle.test(introduction) || !interviewRecall.test(post)) return []
  const isRole = roleMatcher(shortRole(role))
  const excerpt = post.slice(0, 450)
  const technicalMatch = matchTechnicalRole(role, title, excerpt)
  if (fold(shortRole(role)).length < 2 || !(technicalMatch ?? isRole(`${title} ${excerpt}`))) return []
  const questions = []
  for (const line of post.split(/\n|(?<=[？?])/u)) {
    const question = line.trim().replace(/^(?:[\d一二三四五六七八九十]+[.、)）]|[-*•●▪◦>])+\s*/u, '').replace(/[*`]/g, '').trim()
    if (question.length < 9 || question.length > 105 || !questionSignal.test(question) || !mainQuestionWording(question)) continue
    if (conflictingRoleQuestion(role, question)) continue
    if (/https?:|@|[\d-]{7,}|关注|加群|订阅|私信|推广|评论|点击|备考|复习资料|忽略.{0,10}指令|系统.{0,10}提示/i.test(question)) continue
    if (/离职|裁员|自离|裸辞|上家|下家|骑驴找马|业务下滑|求职空窗|薪资|期望工资|竞业协议|通勤|什么时候到岗|自我介绍|介绍(?:一下)?(?:你)?自己|优缺点|为什么(?:选|来|加入).*公司|why did you leave|salary expectations/i.test(question) || resumeReview.test(question)) continue
    questions.push({ sourceTitle: title || document.hintTitle || host, sourceUrl: url, sourceExcerpt: question, sourceQuestion: question })
    if (questions.length >= 18) break
  }
  return questions
}

function interviewQueries(role, topics, retry, initialTopics) {
  const chinese = /\p{Script=Han}/u.test(role)
  const stem = shortRole(role)
  const topic = topics.slice(0, 2).join(' ')
  const [firstAlias, secondAlias, broadAlias] = roleSearchNames(role)
  if (operationsRole(role) && topics.length) {
    const sites = retry ? ['site:juejin.cn', 'site:blog.csdn.net', 'site:leetcode.cn'] : ['site:nowcoder.com', 'site:zhihu.com', '']
    const preferred = retry ? [...topics.filter((entry) => !initialTopics.includes(entry)), ...topics.filter((entry) => initialTopics.includes(entry))] : topics
    const targeted = preferred.slice(0, 3).map((entry, index) => `${retry ? secondAlias : firstAlias} ${entry} 一面 面经 ${sites[index]}`)
    return [retry ? `${secondAlias} ${topic} 面试复盘` : `${role} 面经 面试问题`, ...targeted]
  }
  if (firstAlias) return retry
    ? [`${secondAlias} ${topic} 面试 被问`, `${secondAlias} 面经 site:juejin.cn`, `${broadAlias || firstAlias} 面经 site:leetcode.cn`]
    : [`${role} 面经 面试问题`, `${firstAlias} 一面 面经 site:nowcoder.com`, `${firstAlias} 面试经验 site:zhihu.com`]
  if (!retry) return chinese
    ? [`${role} 面经 面试问题`, `${stem} 一面 面经 site:nowcoder.com`, `${role} 面试经验 实际被问 site:zhihu.com`]
    : [`${role} interview experience questions asked`, `${role} interview experience site:leetcode.cn`]
  if (/服务员|餐饮|零售|客房|前台|导购|门岗|保安|店员/u.test(role)) {
    const alternate = role.replace('餐厅', '餐饮')
    return [`${alternate} ${topic} 面试 面试官问了`, `${alternate} 应聘 面试经历 site:tieba.baidu.com`, `${alternate} 面试经验 被问 site:xiaohongshu.com`]
  }
  return chinese
    ? [`${stem} ${topic} 面试 被问 面试复盘`, `${stem} 面经 site:leetcode.cn`, `${stem} ${topics[0] || ''} 面试经历 site:juejin.cn`]
    : [`${stem} ${topic} interviewer asked my interview experience`, `${role} interview experience site:zhihu.com`]
}

const coversDuty = (role, duty, text) => matchProfileDuty(role, duty, text) ?? matchesDuty(duty, text, { publicSource: true })

async function findInterviewQuestions(web, { role, duties, queryTopics, signal }) {
  const seen = new Set()
  const result = new Map()
  const perSource = new Map()
  const seenQuestions = new Set()
  const initialTopics = queryTopics.filter(Boolean).slice(0, 3)
  for (const retry of [false, true]) {
    const topics = queryTopics.filter((topic, index) => topic && !result.has(duties[index]))
    const found = await searchCandidates(web, interviewQueries(role, topics, retry, initialTopics), interviewLink, signal)
    const candidates = found.filter(({ url }) => !seen.has(url)).slice(0, 4)
    for (const { url } of candidates) seen.add(url)
    const pages = await Promise.allSettled(candidates.map(async (candidate) => interviewQuestions(await getDocument(web, candidate, signal), role)))
    signal?.throwIfAborted()
    for (const page of pages) {
      if (page.status !== 'fulfilled') continue
      for (const candidate of page.value) {
        const questionKey = fold(candidate.sourceQuestion)
        if ((perSource.get(candidate.sourceUrl) || 0) >= 2 || seenQuestions.has(questionKey)) continue
        const topic = candidate.sourceQuestion.split(/[，,？?。]/u)[0].slice(0, 50).trim()
        const covered = duties.length ? duties.filter((entry) => coversDuty(role, entry, candidate.sourceQuestion)) : [topic]
        const duty = covered.find((entry) => entry && !result.has(entry))
          || (duties.length ? covered.find((entry) => (result.get(entry)?.relatedQuestions?.length || 0) < 2) : null)
        if (!duty) continue
        const existing = result.get(duty)
        result.set(duty, existing ? { ...existing, relatedQuestions: [...(existing.relatedQuestions || []), candidate] } : candidate)
        seenQuestions.add(questionKey)
        perSource.set(candidate.sourceUrl, (perSource.get(candidate.sourceUrl) || 0) + 1)
      }
    }
    if (result.size >= (duties.length || 4)) break
  }
  return result
}

const fold = (value) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

function roleMatcher(role) {
  const label = fold(role)
  const pieces = role.split(/\s+/).map(fold).filter((piece) => piece.length > 1)
  const restaurantServer = /^(?:餐厅|餐饮|餐馆)服务员$/u.test(label)
  // Keep positional variants of a multiword role (e.g. “保安 门岗” and “门岗保安”).
  return (text) => {
    const normalized = fold(text)
    return normalized.includes(label)
      || (restaurantServer && normalized.includes('服务员') && /餐厅|餐饮|餐馆|点餐|上菜/u.test(normalized))
      || (pieces.length > 1 && pieces.every((piece) => normalized.includes(piece)))
  }
}

const dutyHeading = /(?:岗位职责|工作职责|主要职责|工作内容|职位描述|岗位描述|你的职责|日常职责|responsibilities)\s*[:：]?/i
const nextHeading = /(?:任职条件|岗位条件|任职要求|职位要求|岗位要求|任职资格|招聘条件|报名条件|工作时间|薪资待遇|薪资福利|qualifications|requirements)\s*[:：]?/i

function pageEvidence(document, role) {
  if (!document) return null
  const { url, kind, content } = document
  const title = kind === 'html' ? pageText(/<title\b[^>]*>([^<]{1,400})<\/title>/i.exec(content)?.[1] || '').slice(0, 140)
    : (/^\s*#{1,4}\s+([^\r\n]+)/m.exec(content)?.[1] || '').slice(0, 140)
  const body = kind === 'html' ? pageText(/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(content)?.[1] || content) : content
  const isRole = roleMatcher(role)
  const headingMatches = matchTechnicalRole(role, title, '') ?? isRole(title)
  const dutyLines = []
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = dutyHeading.exec(line)
    if (!match) continue
    const nearby = lines.slice(Math.max(0, index - 8), index + 1).join(' ')
    if (!(matchTechnicalRole(role, title, nearby) ?? (headingMatches || isRole(nearby)))) continue
    const section = [line.slice(match.index + match[0].length), ...lines.slice(index + 1, index + 7)].join('\n').split(nextHeading)[0]
    dutyLines.push(...section.split(/[。\n；;]/u).map((item) => item.trim()).filter((item) => item.length >= 4 && item.length <= 400))
  }
  // Some announcements place role, work duties and requirements in one paragraph/table cell.
  if (!dutyLines.length) {
    dutyLines.push(...lines.filter((line) => line.length >= 8 && line.length <= 400 && isRole(line)
      && /负责|登记|巡查|值守|maintain|perform|support|develop|manage/i.test(line)))
  }
  return { sourceTitle: title || new URL(url).hostname, sourceUrl: url, dutyLines }
}

export function createPublicRoleProvider(getWeb, researchWithAgent = null) {
  return async ({ role, duties, queryTopics = [], previousDirections = [], signal }) => {
    const web = getWeb()
    if (typeof web?.search !== 'function' || typeof web?.fetch !== 'function') return new Map()
    if (researchWithAgent) {
      return await researchWithAgent({ role, duties, queryTopics, previousDirections, web, signal }) || new Map()
    }
    const questions = await findInterviewQuestions(web, { role, duties, queryTopics, signal })
    if (questions.size >= (duties.length || 4)) return questions
    const registered = PUBLIC_ROLE_SOURCES.filter((source) => source.names.some((name) => fold(name) === fold(role)))
      .flatMap((source) => source.urls.map((url) => ({ url: allowedPage(url), role: source.role }))).filter(({ url }) => url)
    const roleLabel = /\p{Script=Han}/u.test(role) ? '招聘 岗位职责' : 'job responsibilities'
    const missingTopics = queryTopics.filter((_, index) => !questions.has(duties[index])).slice(0, 2).join(' ')
    const [shortName] = roleSearchNames(role)
    const found = await searchCandidates(web, [`${role} ${roleLabel}`, `${shortName || role} ${missingTopics} ${roleLabel}`], (url) => !interviewLink(url), signal)
    const candidates = [...registered, ...found.filter(({ url }) => !registered.some((source) => source.url === url)).map((entry) => ({ ...entry, role }))].slice(0, 4)
    const pages = await Promise.allSettled(candidates.map(async (candidate) => pageEvidence(await getDocument(web, candidate, signal), candidate.role)))
    signal?.throwIfAborted()
    const records = new Map()
    for (const page of pages) {
      if (page.status !== 'fulfilled' || !page.value) continue
      const { dutyLines, sourceTitle, sourceUrl } = page.value
      for (const line of dutyLines) {
        const topics = duties.length ? duties.filter((duty) => coversDuty(role, duty, line)) : readJobDuties(line)
        for (const topic of topics) {
          if (!records.has(topic)) records.set(topic, { sourceTitle, sourceUrl, sourceExcerpt: line.slice(0, 200) })
        }
      }
    }
    return new Map([...questions, ...[...records].filter(([duty]) => !questions.has(duty))])
  }
}
