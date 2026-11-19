import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import {
  MSY_LIMITS,
  MSY_MAPPING_VERSION,
  OFF_STACK,
  extractAnswerPoints,
  extractResumePoints,
  readMsySource,
} from '../lib/msy-connector.js'

const NOW = new Date('2026-05-04T03:02:01.000Z')
const ROOTS = []

after(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })))
})

/** 建一个临时 fixture 目录；files 以相对路径为键。 */
async function makeRoot(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'msy-connector-'))
  ROOTS.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return root
}

const row = (id, title, tagList = ['Agent'], extra = {}) => JSON.stringify({
  id,
  questionNum: 1,
  title,
  content: '这是正文，不该出现在任何错误信息里。',
  difficulty: '中等',
  tagList,
  hasAnswer: true,
  updateTime: '2026-01-01 00:00:00',
  ...extra,
})

const answerMarkdown = (points, extraHeading = '## 扩展知识\n补充内容。') => [
  '# 题目',
  '',
  '## 题目分析',
  '分析内容。',
  '',
  '## 回答重点',
  ...points.map((point, index) => `${index + 1}）**要点${index + 1}**：${point}`),
  '',
  extraHeading,
].join('\n')

const resumeSource = (entries) => [
  '/**',
  ' * 本地简历深挖题库',
  ' */',
  'export const RESUME_BANK = [',
  ...entries.map((entry) => `  ${JSON.stringify(entry, null, 2).split('\n').join('\n  ')},`),
  '];',
  '',
].join('\n')

async function expectFailure(promise, code) {
  let error
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `期望抛出 ${code}`)
  assert.equal(error.code, code)
  assert.equal(error.isDSHRemoteError, true)
  return error
}

test('readMsySource：Agent 题正常映射，字段与既有 market 条目兼容', async () => {
  const root = await makeRoot({
    'data/questions.ndjson': `${row('q-1001', 'Agent 的记忆机制怎么设计？', ['Agent', '后端', '编程导航'])}\n`,
  })
  const result = await readMsySource({ dir: root, now: NOW })
  assert.equal(result.questions.length, 1)
  const item = result.questions[0]
  assert.deepEqual(item, {
    id: 'msy-q-q-1001',
    rolePack: 'agent',
    topic: 'agent-core',
    kind: 'principle',
    question: 'Agent 的记忆机制怎么设计？',
    followups: [],
    expectedPoints: [],
    sourceTitle: '面试鸭 · Agent 基础',
    sourceUrl: 'https://www.mianshiya.com/question/q-1001',
    evidenceLevel: 'edited',
    collectedAt: '2026-05-04T03:02:01.000Z',
    reviewedAt: '',
    reviewAfter: '',
    revision: item.revision,
    tags: ['后端', '编程导航', 'msy'],
    sourceType: 'msy-question',
    sourceRevision: item.sourceRevision,
  })
  assert.ok(Number.isInteger(item.revision) && item.revision >= 1 && item.revision <= 1_000_000)
  assert.match(item.sourceRevision, /^[0-9a-f]{64}$/)
  assert.equal(item.seedSource, undefined)
  assert.equal(result.resume.length, 0)
  assert.equal(result.stats.mappingVersion, MSY_MAPPING_VERSION)
  assert.equal(result.stats.scanned, 1)
  assert.equal(result.stats.imported, 1)
  assert.equal(result.stats.invalid, 0)
  assert.equal(result.stats.skippedOffTopic, 0)
  assert.equal(result.stats.withAnswer, 0)
  assert.equal(result.stats.resumeStatus, 'degraded')
  assert.equal(result.stats.collectedAt, '2026-05-04T03:02:01.000Z')
  const raw = `${row('q-1001', 'Agent 的记忆机制怎么设计？', ['Agent', '后端', '编程导航'])}\n`
  assert.equal(result.stats.questionHash, createHash('sha256').update(raw).digest('hex'))
  assert.ok(result.stats.warnings.length >= 1)
})

test('readMsySource：白名单外的岗位题、OFF_STACK 题都不导入', async () => {
  const root = await makeRoot({
    'data/questions.ndjson': [
      row('q-1', 'Agent 工具调用失败怎么兜底？', ['Agent']),
      row('q-2', 'Java 线程池参数怎么配？', ['后端', 'Java', '编程导航']),
      row('q-3', 'Android 端 Handler 消息机制？', ['Agent', 'Android']),
      row('q-4', 'RAG 的召回率怎么提升？', ['RAG', '大模型']),
      '',
    ].join('\n'),
  })
  const result = await readMsySource({ dir: root, now: NOW })
  assert.deepEqual(result.questions.map((item) => item.id).sort(), ['msy-q-q-1', 'msy-q-q-4'])
  assert.equal(result.questions.find((item) => item.id === 'msy-q-q-4').topic, 'rag')
  assert.equal(result.stats.scanned, 4)
  assert.equal(result.stats.imported, 2)
  assert.equal(result.stats.skippedOffTopic, 2)
  assert.ok(result.stats.warnings.some((warning) => warning.includes('非 Agent 方向')))
})

test('readMsySource：全部题目都被过滤时按空题库报错，不返回空成功', async () => {
  const root = await makeRoot({
    'data/questions.ndjson': `${row('q-1', 'Java 的 GC 分代怎么划？', ['后端', 'Java'])}\n`,
  })
  const error = await expectFailure(readMsySource({ dir: root, now: NOW }), 'hr-interview/msy-questions-empty')
  assert.equal(error.details.scanned, 1)
})

test('readMsySource：有题解时取「回答重点」最多 3 条，缺题解为 []', async () => {
  const root = await makeRoot({
    'data/questions.ndjson': [
      row('q-1', 'MCP 的工具描述怎么写？', ['MCP']),
      row('q-2', 'LangChain 的 Chain 和 Agent 区别？', ['LangChain']),
      '',
    ].join('\n'),
    'data/answers-cache/q-1.md': answerMarkdown(['先说协议边界', '再说工具粒度', '补失败重试', '这条会被截断']),
  })
  const result = await readMsySource({ dir: root, now: NOW })
  const withAnswer = result.questions.find((item) => item.id === 'msy-q-q-1')
  const withoutAnswer = result.questions.find((item) => item.id === 'msy-q-q-2')
  assert.deepEqual(withAnswer.expectedPoints, ['要点1：先说协议边界', '要点2：再说工具粒度', '要点3：补失败重试'])
  assert.deepEqual(withoutAnswer.expectedPoints, [])
  assert.equal(withAnswer.topic, 'mcp-tools')
  assert.equal(withAnswer.sourceTitle, '面试鸭 · MCP 与工具调用')
  assert.equal(result.stats.withAnswer, 1)
})

test('readMsySource：题解内容变化会改变 revision 与 sourceRevision', async () => {
  const files = {
    'data/questions.ndjson': `${row('q-7', 'Agent 规划能力怎么评估？', ['Agent'])}\n`,
    'data/answers-cache/q-7.md': answerMarkdown(['先给评估集']),
  }
  const root = await makeRoot(files)
  const before = (await readMsySource({ dir: root, now: NOW })).questions[0]
  await writeFile(join(root, 'data/answers-cache/q-7.md'), answerMarkdown(['改成另一套评估口径']), 'utf8')
  const afterEdit = (await readMsySource({ dir: root, now: NOW })).questions[0]
  assert.notEqual(before.sourceRevision, afterEdit.sourceRevision)
  assert.notEqual(before.revision, afterEdit.revision)
  // 题目本身不变时 kind 仍按标题推断：含「评估」→ evaluation
  assert.equal(before.kind, 'evaluation')

  await writeFile(join(root, 'data/answers-cache/q-7.md'), answerMarkdown(['改成另一套评估口径']), 'utf8')
  const stable = (await readMsySource({ dir: root, now: NOW })).questions[0]
  assert.equal(stable.sourceRevision, afterEdit.sourceRevision)
})

test('readMsySource：坏行在容忍度内跳过，超过容忍度报错', async () => {
  const good = Array.from({ length: 398 }, (_, index) => row(`q-${index}`, `Agent 问题 ${index}`, ['Agent']))
  const bad = [
    '{"id": "q-bad-1", "title": ',           // 坏 JSON
    '{"id": "bad id!", "title": "x", "tagList": ["Agent"]}', // 坏 id
  ]
  const tolerated = await makeRoot({
    'data/questions.ndjson': `${[...good, ...bad].join('\n')}\n`,
  })
  const ok = await readMsySource({ dir: tolerated, now: NOW })
  assert.equal(ok.stats.scanned, 400)
  assert.equal(ok.stats.imported, 398)
  assert.equal(ok.stats.invalid, 2)
  assert.ok(ok.stats.warnings.some((warning) => warning.includes('2 行无法解析')))

  const strictRows = Array.from({ length: 50 }, (_, index) => row(`q-s-${index}`, `Agent 问题 ${index}`, ['Agent']))
  const strictRoot = await makeRoot({
    'data/questions.ndjson': `${[...strictRows, '不是 JSON 的一行'].join('\n')}\n`,
  })
  const error = await expectFailure(
    readMsySource({ dir: strictRoot, now: NOW }),
    'hr-interview/msy-questions-invalid',
  )
  assert.deepEqual(error.details, { invalid: 1, scanned: 51 })
  assert.ok(!error.message.includes(strictRoot))
  assert.ok(!error.message.includes('questions.ndjson'))
  assert.ok(!error.message.includes('不是 JSON 的一行'))
})

test('readMsySource：字节上限与行数上限都是受控错误', async () => {
  assert.equal(MSY_LIMITS.maxQuestionBytes, 32 * 1024 * 1024)
  assert.equal(MSY_LIMITS.maxQuestionLines, 50_000)

  const root = await makeRoot({
    'data/questions.ndjson': `${row('q-1', 'Agent 问题', ['Agent'])}\n`,
  })
  await expectFailure(
    readMsySource({ dir: root, now: NOW, limits: { maxQuestionBytes: 32 } }),
    'hr-interview/msy-questions-too-large',
  )

  const many = await makeRoot({
    'data/questions.ndjson': `${Array.from({ length: 50_001 }, () => '{}').join('\n')}\n`,
  })
  await expectFailure(
    readMsySource({ dir: many, now: NOW }),
    'hr-interview/msy-questions-too-many-lines',
  )
})

test('readMsySource：目录与文件缺失、空文件、非法目录都是受控错误', async () => {
  await expectFailure(readMsySource({ dir: '', now: NOW }), 'hr-interview/msy-dir-invalid')
  await expectFailure(readMsySource({ dir: 'relative/dir', now: NOW }), 'hr-interview/msy-dir-invalid')
  await expectFailure(readMsySource({ now: NOW }), 'hr-interview/msy-dir-invalid')
  await expectFailure(
    readMsySource({ dir: join(tmpdir(), 'msy-connector-definitely-missing'), now: NOW }),
    'hr-interview/msy-dir-missing',
  )

  const emptyDir = await makeRoot({ 'keep.txt': 'x' })
  await expectFailure(readMsySource({ dir: emptyDir, now: NOW }), 'hr-interview/msy-questions-missing')

  const emptyFile = await makeRoot({ 'data/questions.ndjson': '' })
  await expectFailure(readMsySource({ dir: emptyFile, now: NOW }), 'hr-interview/msy-questions-empty')
})

test('readMsySource：错误信息不泄露绝对路径与题目正文', async () => {
  const root = await makeRoot({
    'data/questions.ndjson': `${JSON.stringify({ id: 'q-java', title: 'Java 的 GC 分代怎么划？', tagList: ['后端', 'Java'] })}\n`,
  })
  const error = await expectFailure(readMsySource({ dir: root, now: NOW }), 'hr-interview/msy-questions-empty')
  assert.ok(!error.message.includes(root))
  assert.ok(!error.message.includes('questions.ndjson'))
  assert.ok(!error.message.includes('tmp'))

  const bad = await makeRoot({ 'data/questions.ndjson': '{"id": ' })
  const invalid = await expectFailure(readMsySource({ dir: bad, now: NOW }), 'hr-interview/msy-questions-invalid')
  assert.ok(!invalid.message.includes(bad))
  assert.equal(invalid.details.scanned, 1)

  const body = '这是正文，不该出现在任何错误信息里。'
  const leaky = await makeRoot({
    'data/questions.ndjson': `${Array.from({ length: 50 }, (_, index) => row(`q-${index}`, `问题 ${index}`)).join('\n')}\n${JSON.stringify({ id: 'q-x', title: body, tagList: 'not-an-array' })}\n`,
  })
  const ok = await readMsySource({ dir: leaky, now: NOW })
  assert.equal(ok.questions.length, 50)
  assert.equal(ok.stats.skippedOffTopic, 1)
})

test('readMsySource：resume-bank.mjs 正常映射为简历深挖题', async () => {
  const root = await makeRoot({
    'data/questions.ndjson': `${row('q-1', 'Agent 上下文怎么裁剪？', ['Agent'])}\n`,
    'resume-bank.mjs': resumeSource([
      {
        id: 'R-CAS-1',
        module: 'cas',
        level: 1,
        checklist: '一',
        q: '你项目里的 CAS 重试怎么做的？',
        a: '· 先讲预期值比较\n· 再讲失败重试上限\n· 最后讲监控告警\n· 这条不进要点',
      },
      {
        id: 'r-redis-2',
        module: 'redis',
        q: 'Redis 热点 key 怎么处理？',
        a: '没有项目符号的口述内容，不应被机械提取。',
      },
    ]),
  })
  const result = await readMsySource({ dir: root, now: NOW })
  assert.equal(result.stats.resumeStatus, 'ok')
  assert.equal(result.stats.resumeImported, 2)
  assert.match(result.stats.resumeHash, /^[0-9a-f]{64}$/)
  assert.equal(result.resume.length, 2)

  const cas = result.resume.find((item) => item.topic === 'cas')
  assert.deepEqual(cas, {
    id: 'msy-r-r-cas-1',
    // 个人项目深挖与岗位无关：进 shared 池，普通岗位按关键词取用。
    rolePack: 'shared',
    topic: 'cas',
    kind: 'project',
    question: '你项目里的 CAS 重试怎么做的？',
    followups: [],
    expectedPoints: ['先讲预期值比较', '再讲失败重试上限', '最后讲监控告警'],
    sourceTitle: '本地简历深挖 · cas',
    sourceUrl: '',
    evidenceLevel: 'editorial',
    collectedAt: '2026-05-04T03:02:01.000Z',
    reviewedAt: '',
    reviewAfter: '',
    revision: cas.revision,
    tags: ['cas', 'resume', 'msy'],
    sourceType: 'msy-resume',
    sourceRevision: cas.sourceRevision,
  })
  assert.ok(Number.isInteger(cas.revision) && cas.revision >= 1 && cas.revision <= 1_000_000)
  assert.match(cas.sourceRevision, /^[0-9a-f]{64}$/)
  const redis = result.resume.find((item) => item.topic === 'redis')
  assert.deepEqual(redis.expectedPoints, [])
})

test('readMsySource：resume-bank.mjs 含可执行语法时降级，NDJSON 结果仍可用', async () => {
  const root = await makeRoot({
    'data/questions.ndjson': `${row('q-1', 'Agent 提示词怎么压缩？', ['Agent'])}\n`,
    'resume-bank.mjs': "export const RESUME_BANK = [{ id: 'r-1', module: 'cas', q: loadFromDisk('secret-path'), a: 'x' }];\n",
  })
  const result = await readMsySource({ dir: root, now: NOW })
  assert.equal(result.questions.length, 1)
  assert.deepEqual(result.resume, [])
  assert.equal(result.stats.resumeStatus, 'degraded')
  assert.equal(result.stats.resumeImported, 0)
  assert.equal(result.stats.resumeHash, '')
  const warning = result.stats.warnings.find((entry) => entry.includes('resume-bank.mjs'))
  assert.ok(warning.includes('unsupported-identifier'))
  assert.ok(!warning.includes('loadFromDisk'))
  assert.ok(!warning.includes('secret-path'))
  assert.ok(!warning.includes(root))
})

test('readMsySource：resume 模板插值、外部语句、超量都降级', async () => {
  const template = await makeRoot({
    'data/questions.ndjson': `${row('q-1', 'Agent 记忆怎么检索？', ['Agent'])}\n`,
    'resume-bank.mjs': 'export const RESUME_BANK = [{ id: `r-${x}`, q: "q", a: "a" }];\n',
  })
  const injected = await readMsySource({ dir: template, now: NOW })
  assert.equal(injected.stats.resumeStatus, 'degraded')
  assert.ok(injected.stats.warnings.some((entry) => entry.includes('template-interpolation')))

  const extraStatement = await makeRoot({
    'data/questions.ndjson': `${row('q-1', 'Agent 记忆怎么检索？', ['Agent'])}\n`,
    'resume-bank.mjs': `export const RESUME_BANK = [{ id: 'r-1', module: 'cas', q: 'q', a: 'a' }];\nconsole.log('side effect');\n`,
  })
  const external = await readMsySource({ dir: extraStatement, now: NOW })
  assert.equal(external.stats.resumeStatus, 'degraded')
  assert.ok(external.stats.warnings.some((entry) => entry.includes('unexpected-token')))

  const tooMany = await makeRoot({
    'data/questions.ndjson': `${row('q-1', 'Agent 记忆怎么检索？', ['Agent'])}\n`,
    'resume-bank.mjs': resumeSource(
      Array.from({ length: 201 }, (_, index) => ({ id: `r-${index}`, module: 'cas', q: `问题 ${index}`, a: '要点' })),
    ),
  })
  const overflow = await readMsySource({ dir: tooMany, now: NOW })
  assert.equal(overflow.stats.resumeStatus, 'degraded')
  assert.deepEqual(overflow.resume, [])
  assert.ok(overflow.stats.warnings.some((entry) => entry.includes('200')))
})

test('extractAnswerPoints / extractResumePoints：机械提取且有上限', () => {
  const markdown = [
    '## 回答重点',
    '先给结论。',
    '',
    '1. 第一点',
    '- 第二点',
    '* 第三点',
    '## 扩展知识',
    '1. 不该被取到',
  ].join('\n')
  // 有列表就只取列表项（段落是概述，不算要点），且最多 3 条。
  assert.deepEqual(extractAnswerPoints(markdown), ['第一点', '第二点', '第三点'])

  const paragraphs = ['## 回答重点', '先说结论。', '', '再说权衡。', '## 扩展知识', '尾巴'].join('\n')
  assert.deepEqual(extractAnswerPoints(paragraphs), ['先说结论。', '再说权衡。'])
  assert.deepEqual(extractAnswerPoints('没有回答重点小节'), [])
  assert.deepEqual(extractAnswerPoints('', 3), [])

  const answer = '① 第一条\n② 第二条\n③ 第三条\n④ 第四条\n普通句子'
  assert.deepEqual(extractResumePoints(answer), ['第一条', '第二条', '第三条'])
  assert.deepEqual(extractResumePoints('没有项目符号'), [])
})

test('OFF_STACK 与白名单常量形状稳定', () => {
  assert.equal(OFF_STACK.test('Android 的 Binder 机制'), true)
  assert.equal(OFF_STACK.test('C++ 的虚函数表'), true)
  assert.equal(OFF_STACK.test('Agent 的工具调用'), false)
  assert.equal(MSY_LIMITS.maxResumeBytes, 1024 * 1024)
  assert.equal(MSY_LIMITS.maxResumeItems, 200)
  assert.equal(MSY_LIMITS.maxPoints, 3)
  assert.equal(MSY_LIMITS.maxTags, 6)
})
