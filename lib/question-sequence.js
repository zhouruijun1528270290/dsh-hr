import { HR_QUESTION_TOPIC_LABELS } from './contract.js'
import { mainQuestionWording } from './main-question-wording.js'

export const QUESTION_SEQUENCE_VERSION = 7

export function clarifyQuestionScenario(item) {
  if (!item || typeof item.question !== 'string') return item
  const wording = mainQuestionWording(item.question)
  if (wording === item.question) return item
  if (wording) return { ...item, question: wording, contextRequirement: requiredMainQuestionContext(wording),
    ...(item.sourceRefs?.length ? { sourceRefs: item.sourceRefs.map((ref) => ref.sourceExcerpt ? ref : { ...ref, sourceExcerpt: item.question.slice(0, 200) }) } : {}) }
  // A saved round keeps its slots. An unresolved source question gets a simulated replacement for the same duty.
  const label = item.duty || item.topic || ''
  const duty = Object.hasOwn(HR_QUESTION_TOPIC_LABELS, label) ? HR_QUESTION_TOPIC_LABELS[label] : mainQuestionWording(label)
  return { ...item, bankItemId: `scenario-${item.bankItemId || item.planItemId || 'duty'}`, basis: 'simulation',
    question: duty ? `假设你接手一项与「${duty}」相关的任务，你会先确认哪些信息，又怎么验证最后的结果？`
      : '假设你接到一项岗位相关的任务，但需求还不清楚。你会先确认哪些信息，又怎么验证最后的结果？',
    followups: [], expectedPoints: ['确认目标、约束和检查办法'], sourceRefs: [], contextRequirement: null }
}

export const projectIntroduction = {
  bankItemId: 'opening-project-introduction', topic: '项目介绍', kind: 'project', basis: 'opening',
  question: '先介绍一个与你应聘岗位相关的项目或工作经历。它要解决什么问题，你具体负责什么？如果还没有相关经验，可以讲一段最接近的经历。',
  expectedPoints: ['说明项目或工作的目标', '说清自己负责的部分'],
  followups: [], sourceRefs: [], opening: true,
}

const CONTEXT_CUES = [
  ['iteration', [
    /上(?:一个?)?版|旧版|前一版|版本对比|前后两版|previous version|old version/i,
    /(?:改版|迭代|升级|重构|上线)前后|新版.{0,12}(?:更好|提升)|讲一次.{0,8}重构/,
  ]],
  ['production', [
    /(?:讲|说|举).{0,12}(?:线上|生产环境).{0,18}(?:故障|排查|事故)/,
    /你(?:当时|实际).{0,14}(?:线上|生产环境)|(?:线上|生产环境).{0,10}(?:你当时|你怎么止损)/,
    /给.{0,8}(?:线上|生产环境)真实|你们?上线后.{0,16}(?:怎么|多少|数据)/,
  ]],
  ['evaluation', [
    /(?:评测|回归|测试)集.{0,12}(?:多少|几条|怎么来)|谁标注|真实(?:测试|评估|评测)数据|你(?:的|们的)评测集/,
  ]],
  ['project', [
    /你刚(?:才)?(?:提|说)|(?:这个|那个|这套|那套)(?:项目|服务|系统|实现)|在你们?(?:的)?(?:代码|项目|实现|服务)/,
    /你们?(?:的|之前的|项目里|在项目里).{0,23}(?:怎么|如何|为什么|解决了|设计|对应|真实|数字|实现|负责)/,
    /你的(?:代码|项目|Agent|知识库|实现)|你做的知识库|(?:用|给).{0,6}你项目里/i,
    /(?:讲|说|举)(?:一|个)(?:次|个|段)?.{0,24}(?:经历|踩坑|故障|发生|导致|你遇到|你发现|你负责|你实际|你拒绝过)/,
    /(?:挑|选)一个你.{0,8}(?:做过|负责)|你(?:是怎么定的|验证过的)|你当时怎么/,
  ]],
]

export function requiredQuestionContext(question) {
  if (!question || /^(?:假设|假如|设想|如果你将要|如果你要|how would you|suppose)/i.test(question.trim())) return null
  return CONTEXT_CUES.find(([, patterns]) => patterns.some((pattern) => pattern.test(question)))?.[0] || null
}

export function requiredMainQuestionContext(question) {
  return requiredQuestionContext(question) || (/^你是(?:如何|怎么).{2,65}(?:的|了)[。？?，,]?$|^(?:请)?(?:简述|介绍|说说|讲讲)(?:一下)?你是(?:如何|怎么)/u.test(question) ? 'project' : null)
}

const CHECK_QUESTIONS = {
  iteration: '你刚才介绍的项目有没有做过一次你参与的版本迭代？如果有，先说说你改了什么。',
  production: '你刚才介绍的经历里，有没有实际参与过与这项工作相关的线上排查或验证？如果有，你具体负责过哪一部分？',
  evaluation: '你刚才介绍的经历里，有没有做过实际测试或评测？如果有，你负责了哪些验证工作？',
}

const PRESSURE_CHECKS = {
  iteration: '有亲自参与过版本迭代吗？有的话，直接说改了什么。',
  production: '有实际处理过这类上线验证或线上问题吗？有的话，说清你负责的部分。',
  evaluation: '有参与过这类测试或评测吗？有的话，说说你亲自验证了什么。',
}

const PRESSURE_SCENARIOS = {
  'agent-core': '假设一个 Agent 连续调用工具却始终没推进任务。你会先看哪段运行记录，再怎么验证它有没有卡在同一步？',
  'mcp-tools': '假设客户端能列出 MCP 工具，但调用总是超时。你会先检查哪一段请求，再怎么缩小问题范围？',
  rag: '假设检索能找到相关文章，模型回答却引用了错误段落。你会先核对什么来判断问题在哪一步？',
}

export function contextCheckQuestion(context, duty, pressure = false) {
  if (pressure) return PRESSURE_CHECKS[context] || `有做过「${duty}」相关的工作吗？有的话，直接说你负责哪一部分。`
  return CHECK_QUESTIONS[context] || `你刚才介绍的经历里，有没有实际做过和「${duty}」相关的工作？如果有，可以先说说你负责的部分。`
}

export function scenarioQuestion(context, duty, pressureTopic = null) {
  if (context === 'project' && Object.hasOwn(PRESSURE_SCENARIOS, pressureTopic)) return PRESSURE_SCENARIOS[pressureTopic]
  if (context === 'iteration') return '假设你刚做完一项与岗位相关的功能，你会选哪些测试场景，又会用什么标准判断它是否达到了预期？'
  if (context === 'evaluation') return `假设你要验证「${duty}」的效果，你会选什么测试场景，又会用什么标准判断它是否达到预期？`
  if (context === 'production') return `假设「${duty}」相关的服务出现异常，你会先核实什么，再怎么验证问题已经解决？`
  return `假设你负责「${duty}」，你会从哪一步做起，怎么检查工作结果？`
}

export function confirmedContextAnswer(value, context) {
  const text = String(value || '').trim()
  if (!text || /^(?:没有(?:[，,。！!\s]|$)|没做过|没参加|没参与|没接触|不清楚|不确定|不知道|记不清|不记得|不太了解|否|no\b)/i.test(text)) return false
  if (/(?:我|本人)(?:还|并)?(?:没有|没|未)(?:参与|负责|做过)|(?:只(?:是)?|仅仅)(?:听说|看过|了解)|不是我(?:负责|做的|参与的)/u.test(text)) return false
  if (context === 'iteration' && /(?:没有|没做过|未做过|不涉及|不确定|不算)[^，,。]{0,8}(?:迭代|改版|版本对比|重构|上一版|旧版)|(?:没(?:有)?|未)(?:直接|实际)?(?:参与|迭代|改版|重构)/u.test(text)) return false
  if (context === 'production' && /(?:没有|未|没)(?:正式)?上线/u.test(text)) return false
  if (/^(?:有(?:过|的)?(?:[，,。！!、\s]|$)|是(?:[，,。！!\s]|$)|做过|参与过|负责过|我们做过|yes\b)/i.test(text)) return true
  if (context === 'iteration') return /(?:我|我们|团队).{0,30}(?:做过.{0,12}迭代|迭代过|重构过|升级过|从.{2,22}(?:改成|换成|升级到|切到)|把.{2,25}(?:改成|换成|升级到)|(?:在|做)了.{0,12}(?:第二版|新版))/u.test(text)
  if (context === 'production') return /(?:我|我们).{0,36}(?:生产环境.{0,18}(?:排查|验证|定位)|(?:处理|排查|验证|定位)过.{0,12}(?:线上|故障|生产环境))/u.test(text)
  if (context === 'evaluation') return /(?:我|我们).{0,36}(?:做了|负责|参与|跑了|建立|编写).{0,26}(?:测试|评估|评测|用例)/u.test(text)
  return /(?:我|我们).{0,36}(?:负责|参与|实现|开发|交付|接手|完成|设计|处理|做过|做了)|(?:主要|具体|本人|个人).{0,6}(?:负责|参与|实现)/u.test(text)
}

export function contextProbeQuestion(context, original) {
  if (context === 'iteration') return '就你刚才说的那次迭代，新版做得更好的地方是什么？你怎么比较前后的效果？如果上线过，也可以说说实际使用的数据。'
  if (context === 'evaluation') return '就你刚才说的验证工作，你怎么选测试场景，怎么判断结果是否达标？如果有专门的评测集，可以说说它怎么建的。'
  return original
}

export function introducedProject(turns) {
  const opening = turns.find((turn) => turn.questionStage === 'project-introduction')
  return Boolean(opening && turns.some((turn) => turn.speaker === 'candidate' && turn.kind !== 'no_answer'
    && turn.questionId === opening.questionId && !/^(?:有|有过|做过|参与过|负责过|是|我有|我做过)[，,。！!、\s]*$/u.test(turn.text.trim())
    && confirmedContextAnswer(turn.text, 'project')))
}
