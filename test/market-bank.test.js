import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MarketQuestionBank, sanitizeQueryChunks, segmentForFts } from '../lib/market-bank.js'

const SEED_FILE = new URL('../lib/data/market-question-bank.json', import.meta.url)
const SEED = JSON.parse(await readFile(SEED_FILE, 'utf8'))
const SEED_ITEMS = SEED.items
const revisedIncidents = new Set(['rag-layer-attribution', 'rag-recall-up-accuracy-down', 'memory-compression-failure'])
const revisedEditorial = new Set(['shared-behavioral-failure', 'shared-incident-dependency-timeout'])
const expectedSeedRevision = (item) => revisedIncidents.has(item.id) ? 3 : item.evidenceLevel === 'editorial' && !revisedEditorial.has(item.id) ? 1 : 2

/** 调研报告里出现过的来源；测试硬编码这份白名单，防止种子编造 URL。 */
const ALLOWED_SOURCES = new Set([
  'https://www.nowcoder.com/discuss/921590204903723008',
  'https://www.nowcoder.com/discuss/917353328109944832',
  'https://www.nowcoder.com/discuss/938174747332956160',
  'https://www.nowcoder.com/discuss/941632179652599808',
  'https://www.nowcoder.com/discuss/941713098040221696',
  'https://www.nowcoder.com/discuss/942593751954776064',
  'https://www.nowcoder.com/discuss/944882264687534080',
  'https://www.nowcoder.com/feed/main/detail/0503d45073494879bbe91f5fccd6efbe',
  'https://www.nowcoder.com/feed/main/detail/fc061fe55af84effb8014ed6c60db92d',
  'https://www.nowcoder.com/feed/main/detail/3d3ef7b926394f7ba083d657d5e7c72d',
  'https://www.nowcoder.com/feed/main/detail/73bad9d11163476d8cfce0f26c1c04f5',
  'https://leetcode.cn/discuss/post/QFqU0R/',
  'https://leetcode.cn/discuss/post/3879503/',
  'https://anxforever.cn/blog/interview-real-questions',
  'https://zchary1106.github.io/agent-interview-hub/question-signals.html',
  'https://mj.mianlingai.com/interview/bytedance-agent-development-first-round-939623386806751232/',
  'https://mj.mianlingai.com/interview/bytedance-volcano-engine-agent-autumn-first-round-2923108/',
  'https://interviewx.cn/interview/2056',
  'https://web.reeddaily.com/posts/653181',
  'https://web.reeddaily.com/posts/408432',
  'https://codewd.com/article/z23yryam',
])

const KINDS = new Set(['project', 'principle', 'incident', 'evaluation', 'behavioral'])
const EVENTS = new Set(['first_hand', 'edited', 'editorial'])
const DAY = /^\d{4}-\d{2}-\d{2}$/

const textOf = (item) => [
  item.question, ...item.followups, ...item.expectedPoints, ...item.tags, item.topic, item.sourceTitle,
].join('\n')

/**
 * 每个用例独立的临时空间：种子副本 + 数据根目录都在系统临时目录内，
 * 结束时先 close 连接再删目录（Windows 上未关闭的 sqlite 句柄会阻塞删除）。
 */
async function makeBank(t, { now, items = SEED_ITEMS, msyDir = '', msyReader = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hr-market-'))
  const seedPath = join(root, 'seed.json')
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(seedPath, JSON.stringify({ ...SEED, items }), 'utf8')
  const bank = new MarketQuestionBank({
    root: join(root, 'data'),
    seedPath,
    ...(now ? { now } : {}),
    ...(msyDir ? { msyDir } : {}),
    ...(msyReader ? { msyReader } : {}),
  })
  t.after(async () => {
    await bank.close()
    await rm(root, { recursive: true, force: true })
  })
  return { bank, root, seedPath }
}

/** 外部来源 fixture：全部走临时目录 + 注入 reader，不碰真实 msy 与真实 market.sqlite。 */
const MSY_HASH = 'a'.repeat(64)
const MSY_RESUME_HASH = 'b'.repeat(64)

function msyQuestionItem(index, overrides = {}) {
  const nativeId = 1000 + index
  return {
    id: `msy-q-${nativeId}`,
    rolePack: 'agent',
    topic: 'rag',
    kind: 'principle',
    question: `外部题 ${index}：检索增强里召回不足时你会怎么兜底与降级？`,
    followups: ['追问一：怎么衡量召回质量', '追问二：失败时怎么回滚'],
    expectedPoints: ['要点一：回退策略', '要点二：监控指标', '要点三：成本上限'],
    tags: ['msy', 'rag'],
    sourceTitle: '面试鸭 · RAG',
    sourceUrl: `https://www.mianshiya.com/question/${nativeId}`,
    evidenceLevel: 'edited',
    collectedAt: '2026-05-01',
    reviewedAt: '2026-05-02',
    reviewAfter: '2027-01-01',
    revision: 1,
    sourceRevision: `sr-q-${index}`,
    ...overrides,
  }
}

function msyResumeItem(index) {
  const nativeId = 2000 + index
  return {
    id: `msy-r-${nativeId}`,
    rolePack: 'shared',
    topic: 'memory',
    kind: 'project',
    question: `简历深挖 ${index}：这个项目的记忆模块你怎么做容量控制的？`,
    followups: ['追问一：淘汰策略', '追问二：一致性'],
    expectedPoints: ['要点一：分层存储', '要点二：淘汰阈值', '要点三：回放验证'],
    tags: ['msy', 'resume'],
    sourceTitle: '面试鸭 · 简历',
    sourceUrl: '',
    evidenceLevel: 'editorial',
    collectedAt: '2026-05-01',
    reviewedAt: '2026-05-02',
    reviewAfter: '2027-01-01',
    revision: 1,
    sourceRevision: `sr-r-${index}`,
  }
}

function msyReaderOf({ questions = [], resume = [], stats = {} } = {}) {
  return async () => ({
    questions,
    resume,
    stats: {
      mappingVersion: 'mapping-1',
      questionHash: MSY_HASH,
      resumeHash: MSY_RESUME_HASH,
      scanned: 40,
      imported: questions.length,
      resumeImported: resume.length,
      invalid: 2,
      skippedOffTopic: 5,
      withAnswer: 3,
      warnings: [],
      resumeStatus: 'ok',
      collectedAt: '2026-05-03',
      ...stats,
    },
  })
}

const msyDirOf = (root) => join(root, 'msy-fixture')

/** 需要多次 init（模拟重启）的用例：自己管 root，单独 close。 */
async function makeExternalBank(t, { reader, now } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hr-market-msy-'))
  const seedPath = join(root, 'seed.json')
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(seedPath, JSON.stringify(SEED), 'utf8')
  const msyDir = msyDirOf(root)
  const banks = []
  const open = (nextReader = reader, { msyDir: dir = msyDir } = {}) => {
    const bank = new MarketQuestionBank({
      root: join(root, 'data'),
      seedPath,
      ...(dir ? { msyDir: dir } : {}),
      ...(nextReader ? { msyReader: nextReader } : {}),
      ...(now ? { now } : {}),
    })
    banks.push(bank)
    return bank
  }
  t.after(async () => {
    for (const bank of banks) await bank.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, seedPath, msyDir, open }
}

async function sourceRows(root) {
  const db = new DatabaseSync(join(root, 'data', 'market.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT seed_source, COUNT(*) AS n FROM market_questions GROUP BY seed_source ORDER BY seed_source').all()
      .map((row) => [Number(row.seed_source), Number(row.n)])
  } finally {
    db.close()
  }
}

async function stampsOf(root, source) {
  const db = new DatabaseSync(join(root, 'data', 'market.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT id, updated_at FROM market_questions WHERE seed_source = ? ORDER BY id').all(source)
      .map((row) => [String(row.id), String(row.updated_at)])
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- 种子 schema

test('种子题库：46 条、36 agent + 10 shared、字段与枚举完整', () => {
  assert.equal(SEED_ITEMS.length, 46)
  assert.equal(SEED_ITEMS.filter((item) => item.rolePack === 'agent').length, 36)
  assert.equal(SEED_ITEMS.filter((item) => item.rolePack === 'shared').length, 10)
  const ids = SEED_ITEMS.map((item) => item.id)
  assert.equal(new Set(ids).size, 46, 'id 必须唯一')
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]{2,119}$/)
  const fields = ['id', 'rolePack', 'topic', 'kind', 'question', 'followups', 'expectedPoints',
    'sourceTitle', 'sourceUrl', 'evidenceLevel', 'collectedAt', 'reviewedAt', 'reviewAfter', 'revision', 'tags']
  for (const item of SEED_ITEMS) {
    for (const field of fields) assert.ok(Object.hasOwn(item, field), `${item.id} 缺字段 ${field}`)
    assert.ok(['agent', 'shared'].includes(item.rolePack), `${item.id} rolePack`)
    assert.ok(KINDS.has(item.kind), `${item.id} kind`)
    assert.ok(EVENTS.has(item.evidenceLevel), `${item.id} evidenceLevel`)
    assert.ok(item.topic && item.question, `${item.id} 主题与题干不能为空`)
    assert.ok(item.question.length >= 12, `${item.id} 题干过短`)
    assert.ok(Array.isArray(item.followups) && item.followups.length >= 2, `${item.id} 追问不足`)
    assert.ok(Array.isArray(item.expectedPoints) && item.expectedPoints.length >= 3, `${item.id} 要点不足`)
    assert.ok(Array.isArray(item.tags) && item.tags.length >= 1, `${item.id} 标签为空`)
    assert.equal(item.revision, expectedSeedRevision(item), `${item.id} revision`)
    for (const field of ['collectedAt', 'reviewedAt', 'reviewAfter']) {
      assert.match(item[field], DAY, `${item.id} ${field} 不是 YYYY-MM-DD`)
    }
    assert.ok(item.collectedAt <= item.reviewedAt, `${item.id} 采集晚于复核`)
    assert.ok(item.reviewedAt <= item.reviewAfter, `${item.id} 复核晚于复审期`)
    // 覆盖度：Agent 六大主题都必须出现
    const blob = textOf(item)
    assert.match(blob, /[\u4e00-\u9fff]/, `${item.id} 需要中文内容`)
  }
  const agentTopics = new Set(SEED_ITEMS.filter((item) => item.rolePack === 'agent').map((item) => item.topic))
  for (const topic of ['agent-core', 'mcp-tools', 'rag', 'memory', 'reliability']) {
    assert.ok(agentTopics.has(topic), `缺主题 ${topic}`)
  }
  const kinds = new Set(SEED_ITEMS.map((item) => item.kind))
  for (const kind of KINDS) assert.ok(kinds.has(kind), `缺 kind ${kind}`)
})

test('种子题库：shared 通用包 10 条，五类 kind 各 2 条留出余量', () => {
  const shared = SEED_ITEMS.filter((item) => item.rolePack === 'shared')
  assert.equal(shared.length, 10)
  const counts = {}
  for (const item of shared) counts[item.kind] = (counts[item.kind] || 0) + 1
  assert.deepEqual(counts, { project: 2, principle: 2, incident: 2, evaluation: 2, behavioral: 2 })
  // 任意一条过期都还有同 kind 的替补，30 分钟大纲不会因为一条失效而缺位
  for (const kind of KINDS) assert.ok(counts[kind] >= 2, `${kind} 至少两条`)
  const topics = new Set(shared.map((item) => item.topic))
  assert.ok(topics.size >= 3, '通用包不能只有一两个主题')
  for (const item of shared) {
    assert.ok(item.question.length >= 12, `${item.id} 题干过短`)
    assert.ok(item.expectedPoints.length >= 3, `${item.id} 要点不足`)
    assert.ok(item.followups.length >= 2, `${item.id} 追问不足`)
  }
})

test('种子题库：真实来源只用调研白名单 URL，editorial 不得带 URL', () => {
  for (const item of SEED_ITEMS) {
    if (item.evidenceLevel === 'editorial') {
      assert.equal(item.sourceUrl, '', `${item.id} editorial 必须无 URL`)
      assert.ok(item.sourceTitle, `${item.id} editorial 仍需来源标题说明`)
      continue
    }
    assert.ok(item.sourceUrl, `${item.id} 真实来源缺 URL`)
    assert.ok(ALLOWED_SOURCES.has(item.sourceUrl), `${item.id} 来源不在白名单：${item.sourceUrl}`)
    assert.ok(item.sourceTitle, `${item.id} 缺来源标题`)
  }
  assert.ok(SEED_ITEMS.some((item) => item.evidenceLevel === 'first_hand'))
  assert.ok(SEED_ITEMS.some((item) => item.evidenceLevel === 'edited'))
  assert.ok(SEED_ITEMS.some((item) => item.evidenceLevel === 'editorial'))
})

test('种子题库：revision 稳定且同一 id 的题干指纹唯一', () => {
  const seen = new Map()
  for (const item of SEED_ITEMS) {
    assert.equal(seen.has(item.id), false, `重复 id ${item.id}`)
    seen.set(item.id, item.question)
  }
  const questions = SEED_ITEMS.map((item) => item.question)
  assert.equal(new Set(questions).size, 46, '题干不应重复')
})

test('种子题库：6 条量级/枚举题面已原创化，题面与结构一起钉住', () => {
  const PINNED = {
    'memory-large-tool-result': {
      topic: 'memory',
      kind: 'incident',
      question: '工具返回了几十万字符的结果，你怎么处理？请说清分页、落盘、引用和回灌策略。',
    },
    'mcp-100-tools-routing': {
      topic: 'mcp-tools',
      kind: 'principle',
      question: '工具数量到上百个时，你怎么让模型选对？请说清筛选、路由和误选处理。',
    },
    'mcp-skill-progressive-loading': {
      topic: 'mcp-tools',
      kind: 'principle',
      followupIndex: 1,
      followup: '工具描述全部塞进系统提示，上百个工具大概占多少 token？你算过吗？',
    },
    'shared-fundamentals-cache': {
      topic: 'fundamentals',
      kind: 'principle',
      question: '一个接口的 P99 突然从几十毫秒涨到秒级，你会按什么顺序排查？请说清每一步能排除什么。',
    },
    'rag-format-slicing': {
      topic: 'rag',
      kind: 'incident',
      question: '扫描件 PDF、大表格、无标题 Markdown，你分别怎么切？讲一个切坏了导致答错的例子。',
    },
    'mcp-param-error-handling': {
      topic: 'mcp-tools',
      kind: 'incident',
      question: '工具参数不合法、返回的 JSON 无法解析、调用超时，你的处理链分别是什么？讲一次真实踩坑。',
    },
  }
  assert.equal(Object.keys(PINNED).length, 6)
  for (const [id, pinned] of Object.entries(PINNED)) {
    const item = SEED_ITEMS.find((row) => row.id === id)
    assert.ok(item, `缺条目 ${id}`)
    // id/topic/kind/expectedPoints/followups 结构不变，只换文本
    assert.equal(item.topic, pinned.topic, `${id} topic 不应改变`)
    assert.equal(item.kind, pinned.kind, `${id} kind 不应改变`)
    assert.equal(item.expectedPoints.length, 4, `${id} expectedPoints 结构不应改变`)
    assert.equal(item.followups.length, 3, `${id} followups 结构不应改变`)
    if (pinned.question) assert.equal(item.question, pinned.question, `${id} 题干应已原创化`)
    if (pinned.followupIndex !== undefined) {
      assert.equal(item.followups[pinned.followupIndex], pinned.followup, `${id} 指定追问应已原创化`)
    }
    // 不再靠具体量级/枚举立题
    const blob = [item.question, ...item.followups].join('\n')
    for (const marker of ['100 个', '200ms', '2s', '20 万字符']) {
      assert.equal(blob.includes(marker), false, `${id} 仍残留具体量级 ${marker}`)
    }
  }
})

test('种子题库：补全场景的题目更新修订号', () => {
  const counts = new Map()
  for (const item of SEED_ITEMS) {
    assert.equal(item.revision, expectedSeedRevision(item), `${item.id} revision`)
    counts.set(item.revision, (counts.get(item.revision) || 0) + 1)
  }
  assert.deepEqual([...counts.entries()].sort((left, right) => left[0] - right[0]), [[1, 3], [2, 40], [3, 3]])
})

test('种子题库：来源标题不再指认公司或平台，按 evidenceLevel 归一', () => {
  const GENERIC_TITLES = { first_hand: '公开面经参考', edited: '公开资料汇编参考' }
  const EDITORIAL_TITLE = '内部通用训练题（editorial，无外部来源）'
  const MARKERS = ['得物', '蚂蚁', '字节', '百度', '美团', '快手', '理想', '千问', '作业帮', '即剪',
    '牛客', '力扣', 'nowcoder', 'leetcode', '腾讯', '阿里', '华为', '京东', '拼多多', '小红书',
    '滴滴', '小米', '网易', '知乎', '一面', '二面', '三面', '终面', '秋招', '社招', '实习']
  for (const item of SEED_ITEMS) {
    if (item.evidenceLevel === 'editorial') {
      assert.equal(item.sourceTitle, EDITORIAL_TITLE, `${item.id} editorial 标题应保持内部训练题`)
      assert.equal(item.sourceUrl, '', `${item.id} editorial 不得带 URL`)
      continue
    }
    assert.equal(item.sourceTitle, GENERIC_TITLES[item.evidenceLevel],
      `${item.id} 来源标题应按 evidenceLevel 归一`)
    for (const marker of MARKERS) {
      assert.equal(item.sourceTitle.includes(marker), false, `${item.id} 来源标题仍指认 ${marker}`)
    }
    // URL 与审计用元数据照旧保留
    assert.ok(item.sourceUrl, `${item.id} 内部审计 URL 不应被删`)
    assert.ok(ALLOWED_SOURCES.has(item.sourceUrl), `${item.id} 来源不在白名单：${item.sourceUrl}`)
  }
})

// ---------------------------------------------------------------- 初始化与幂等

test('init：建出 market.sqlite、统计与 46 条一致', async (t) => {
  const { bank, root } = await makeBank(t)
  await bank.init()
  const stats = await bank.stats()
  assert.equal(stats.total, 46)
  assert.equal(stats.active, 46)
  assert.equal(stats.stale, 0)
  assert.deepEqual(stats.byRolePack, { agent: 36, shared: 10 })
  assert.equal(stats.byKind.project + stats.byKind.principle + stats.byKind.incident
    + stats.byKind.evaluation + stats.byKind.behavioral, 46)
  assert.equal(stats.seed.count, 46)
  assert.match(stats.today, DAY)
  const probe = new DatabaseSync(join(root, 'data', 'market.sqlite'), { readOnly: true })
  try {
    const row = probe.prepare('SELECT COUNT(*) AS n FROM market_questions').get()
    assert.equal(Number(row.n), 46)
    const fts = probe.prepare('SELECT COUNT(*) AS n FROM market_questions_fts').get()
    assert.equal(Number(fts.n), 46)
  } finally {
    probe.close()
  }
})

test('init：重复调用幂等，不重复插入也不丢种子', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  await bank.init()
  await bank.init()
  const stats = await bank.stats()
  assert.equal(stats.total, 46)
  const all = await bank.getByIds(SEED_ITEMS.map((item) => item.id))
  assert.equal(all.length, 46)
})

test('init：并发调用被串行化，close 后不留旧连接与未释放句柄', async (t) => {
  const { bank, root } = await makeBank(t)
  await Promise.all([bank.init(), bank.init(), bank.init()])
  assert.equal((await bank.stats()).total, 46)
  await bank.close()
  // close 之后目录能删干净，说明没有第二个 sqlite 连接还占着文件
  await rm(root, { recursive: true, force: true })
  await assert.rejects(readFile(join(root, 'data', 'market.sqlite')), (error) => {
    assert.equal(error.code, 'ENOENT')
    return true
  })
})

test('init：种子删条后重同步会清掉残留 id，恢复后又能补回', async (t) => {
  const { bank, seedPath } = await makeBank(t)
  await bank.init()
  const dropped = SEED_ITEMS[0].id
  const trimmed = SEED_ITEMS.filter((item) => item.id !== dropped)
  await writeFile(seedPath, JSON.stringify({ ...SEED, items: trimmed }), 'utf8')
  await bank.init()
  assert.equal((await bank.stats()).total, 45)
  assert.deepEqual(await bank.getByIds([dropped]), [])
  await bank.init()
  assert.equal((await bank.stats()).total, 45, '重入不应凭空复制')
  await writeFile(seedPath, JSON.stringify({ ...SEED, items: SEED_ITEMS }), 'utf8')
  await bank.init()
  assert.equal((await bank.stats()).total, 46)
  assert.equal((await bank.getByIds([dropped])).length, 1)
})

test('init：种子文件损坏时给出受控错误且不泄漏路径', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hr-market-bad-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, '{ not json', 'utf8')
  const bank = new MarketQuestionBank({ root: join(root, 'data'), seedPath })
  t.after(async () => {
    await bank.close()
    await rm(root, { recursive: true, force: true })
  })
  await assert.rejects(bank.init(), (error) => {
    assert.equal(error.code, 'hr-interview/market-bank-seed-invalid')
    assert.equal(error.message.includes(root), false)
    assert.equal(error.message.includes('not json'), false)
    return true
  })
})

test('init：editorial 条目带 URL 会被拒绝（不让伪造来源进库）', async (t) => {
  const broken = SEED_ITEMS.map((item) => (item.id === 'shared-behavioral-conflict'
    ? { ...item, sourceUrl: 'https://example.com/fake' }
    : item))
  const root = await mkdtemp(join(tmpdir(), 'hr-market-fake-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ ...SEED, items: broken }), 'utf8')
  const bank = new MarketQuestionBank({ root: join(root, 'data'), seedPath })
  t.after(async () => {
    await bank.close()
    await rm(root, { recursive: true, force: true })
  })
  await assert.rejects(bank.init(), (error) => {
    assert.equal(error.code, 'hr-interview/market-bank-seed-invalid')
    assert.equal(error.message.includes('example.com'), false)
    return true
  })
})

test('种子文件本身不被改写', async (t) => {
  const { bank, seedPath } = await makeBank(t)
  const before = await readFile(seedPath, 'utf8')
  await bank.init()
  await bank.listActive({ query: '面经' })
  const after = await readFile(seedPath, 'utf8')
  assert.equal(after, before)
})

// ---------------------------------------------------------------- 查询

test('listActive：agent 包拿到 agent + shared，含全部 46 条', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  const rows = await bank.listActive({ limit: 100 })
  assert.equal(rows.length, 46)
  assert.ok(rows.some((item) => item.rolePack === 'agent'))
  assert.ok(rows.some((item) => item.rolePack === 'shared'))
  for (const row of rows) {
    assert.equal(row.stale, false)
    assert.ok(Array.isArray(row.followups))
    assert.ok(Array.isArray(row.sourceUrl === undefined ? [] : row.tags))
  }
})

test('listActive：generic 只看 shared，不会混入 agent 题', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  const rows = await bank.listActive({ rolePack: 'generic', limit: 100 })
  assert.equal(rows.length, 10)
  for (const row of rows) assert.equal(row.rolePack, 'shared')
  const agentOnly = await bank.listActive({ rolePack: 'agent', limit: 100 })
  assert.ok(agentOnly.some((row) => row.rolePack === 'agent'))
})

test('listActive：generic 有 10 条可用，30 分钟所需的 8 条余量真实存在', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  const rows = await bank.listActive({ rolePack: 'generic', limit: 8 })
  assert.equal(rows.length, 8)
  const kinds = new Set(rows.map((row) => row.kind))
  assert.ok(kinds.size >= 4, `8 条只覆盖了 ${kinds.size} 类 kind`)
  const topics = new Set(rows.map((row) => row.topic))
  assert.ok(topics.size >= 2, 'generic 提纲不该只有单一主题')
})

test('listActive：未来部分到期只排除不删除，仍留够 5 条以上', async (t) => {
  // 2027-06-01：first_hand（2027-05-17）与 edited（2027-02-17）已过复核期，editorial 还在有效期内
  const { bank } = await makeBank(t, { now: () => new Date('2027-06-01T00:00:00Z') })
  await bank.init()
  const rows = await bank.listActive({ rolePack: 'generic', limit: 100 })
  assert.equal(rows.length, 5)
  for (const row of rows) assert.equal(row.evidenceLevel, 'editorial')
  const stats = await bank.stats()
  assert.equal(stats.total, 46, '过期条目不得硬删')
  assert.equal(stats.active, 5)
  assert.equal(stats.stale, 41)
  const all = await bank.getByIds(SEED_ITEMS.map((item) => item.id))
  assert.equal(all.length, 46, '过期条目仍可按 id 取回')
})

test('listActive：limit 有界，非法 limit 不会放大结果', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  assert.equal((await bank.listActive({ limit: 5 })).length, 5)
  assert.equal((await bank.listActive({ limit: 100000 })).length, 46)
  assert.equal((await bank.listActive({ limit: 0 })).length, 1)
  assert.equal((await bank.listActive({ limit: -8 })).length, 1)
  assert.equal((await bank.listActive({ limit: 'abc' })).length, 46, '垃圾 limit 走默认 50 条上限内的 46')
})

test('listActive：topic 与 kind 走明确元数据过滤', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  const rag = await bank.listActive({ topic: 'rag', limit: 100 })
  assert.ok(rag.length >= 5)
  for (const row of rag) assert.equal(row.topic, 'rag')
  const incidents = await bank.listActive({ kind: 'incident', limit: 100 })
  assert.ok(incidents.length >= 5)
  for (const row of incidents) assert.equal(row.kind, 'incident')
  const none = await bank.listActive({ topic: '不存在的主题', limit: 100 })
  assert.deepEqual(none, [])
  const upper = await bank.listActive({ topic: 'RAG', limit: 100 })
  assert.equal(upper.length, rag.length, '主题匹配应忽略大小写')
})

test('listActive：两字中文关键词命中（面经/缓存）', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  for (const word of ['面经', '缓存']) {
    const rows = await bank.listActive({ query: word, limit: 100 })
    assert.ok(rows.length >= 1, `${word} 应至少命中一条`)
    for (const row of rows) {
      assert.ok(textOf(row).toLowerCase().includes(word), `${row.id} 不含 ${word} 却被返回`)
    }
    const expected = SEED_ITEMS
      .filter((item) => textOf(item).toLowerCase().includes(word))
      .map((item) => item.id)
      .sort()
    assert.deepEqual(rows.map((row) => row.id).sort(), expected)
  }
})

test('listActive：FTS 特殊字符不炸库，也不当语法执行', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  const hostile = [
    '面试 AND', 'agent AND (mcp', '"', '*', '（）', 'NEAR/2', 'OR OR', 'a"b*c',
    '100%', '%_', '\\\\', '^\u0000', '"; DROP TABLE market_questions; --',
    'agent:*', '{cache}:1',
  ]
  for (const query of hostile) {
    const rows = await bank.listActive({ query, limit: 100 })
    assert.ok(Array.isArray(rows), `${query} 应返回数组`)
  }
  // 注入没有造成破坏
  assert.equal((await bank.stats()).total, 46)
  const injection = await bank.listActive({ query: '"; DROP TABLE market_questions; --', limit: 100 })
  assert.equal(injection.length, 0)
  // 单字符 ASCII 无法进 FTS token，必须由 LIKE 兜底后再经 JS 精过滤
  const single = await bank.listActive({ query: 'm', limit: 100 })
  assert.ok(single.length >= 5, 'LIKE 兜底应能命中单字符查询')
  for (const row of single) assert.ok(textOf(row).toLowerCase().includes('m'), `${row.id} 不含 m`)
})

test('listActive：`面经 AND` 按关键词命中而不是报错', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  const rows = await bank.listActive({ query: '面经 AND', limit: 100 })
  assert.ok(rows.length >= 1)
  const plain = await bank.listActive({ query: '面经', limit: 100 })
  assert.deepEqual(rows.map((row) => row.id), plain.map((row) => row.id))
})

test('sanitizeQueryChunks / segmentForFts：运算符被剥离，中文出 bigram', () => {
  assert.deepEqual(sanitizeQueryChunks('面试 AND'), ['面试'])
  assert.deepEqual(sanitizeQueryChunks('  Agent   OR  mcp '), ['agent', 'mcp'])
  assert.deepEqual(sanitizeQueryChunks('"*()"'), [])
  assert.deepEqual(sanitizeQueryChunks(''), [])
  const tokens = segmentForFts('缓存命中 mcp').split(' ')
  assert.ok(tokens.includes('缓存'))
  assert.ok(tokens.includes('存命'))
  assert.ok(tokens.includes('mcp'))
})

test('stale：过期项查询时排除，但记录仍在、getByIds 仍可取到', async (t) => {
  const { bank } = await makeBank(t, { now: () => new Date('2029-01-01T00:00:00Z') })
  await bank.init()
  const rows = await bank.listActive({ limit: 100 })
  assert.deepEqual(rows, [])
  const stats = await bank.stats()
  assert.equal(stats.total, 46, 'stale 不得硬删')
  assert.equal(stats.stale, 46)
  const byId = await bank.getByIds(['agent-workflow-boundary'])
  assert.equal(byId.length, 1)
  assert.equal(byId[0].stale, true)
})

test('stale：未过期时按 reviewAfter 边界判定', async (t) => {
  const boundary = SEED_ITEMS.find((item) => item.evidenceLevel === 'edited')
  const { bank } = await makeBank(t, { now: () => new Date(`${boundary.reviewAfter}T12:00:00Z`) })
  await bank.init()
  const rows = await bank.listActive({ limit: 100 })
  assert.ok(rows.some((row) => row.id === boundary.id), '当天仍算有效')
  const after = new MarketQuestionBank({
    root: join(tmpdir(), `hr-market-boundary-${process.pid}-${Date.now()}`),
    seedPath: join(tmpdir(), 'not-used.json'),
    now: () => new Date('2099-01-01T00:00:00Z'),
  })
  assert.ok(after.root.length > 4)
  await after.close()
})

test('getByIds：保持入参顺序、跳过未知 id、去重', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  const ids = ['mcp-lifecycle', 'agent-loop-detection', 'mcp-lifecycle', 'no-such-item']
  const rows = await bank.getByIds(ids)
  assert.deepEqual(rows.map((row) => row.id), ['mcp-lifecycle', 'agent-loop-detection'])
  assert.deepEqual(await bank.getByIds([]), [])
  assert.deepEqual(await bank.getByIds(['../etc/passwd', "'; --"]), [])
})

test('返回值是深拷贝：改结果不会污染库里的记录', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  const [first] = await bank.listActive({ limit: 1 })
  first.followups.push('注入的追问')
  first.tags.push('注入的标签')
  first.question = '被改写的题干'
  const [again] = await bank.listActive({ limit: 1 })
  assert.notEqual(again.question, '被改写的题干')
  assert.equal(again.followups.includes('注入的追问'), false)
  assert.equal(again.tags.includes('注入的标签'), false)
  const [direct] = await bank.getByIds([again.id])
  assert.equal(direct.question, again.question)
  assert.equal(direct.followups.includes('注入的追问'), false)
})

test('close：幂等关闭，关闭后查询与统计都给受控错误', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  await bank.close()
  await bank.close()
  for (const call of [
    () => bank.listActive({}),
    () => bank.getByIds(['mcp-lifecycle']),
    () => bank.stats(),
  ]) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.code, 'hr-interview/market-bank-closed')
      assert.equal(error.isDSHRemoteError, true)
      return true
    })
  }
})

test('close：关闭后再 init 能重新打开并可用', async (t) => {
  const { bank } = await makeBank(t)
  await bank.init()
  await bank.close()
  await bank.init()
  assert.equal((await bank.stats()).total, 46)
  assert.ok((await bank.listActive({ limit: 3 })).length === 3)
})

test('未初始化就查询：给出 not-ready 而不是崩溃', async (t) => {
  const { bank } = await makeBank(t)
  await assert.rejects(bank.listActive({}), (error) => {
    assert.equal(error.code, 'hr-interview/market-bank-not-ready')
    return true
  })
})

// ------------------------------------------------- msy 外部来源（注入 reader，全临时目录）

test('未配置 msyDir：行为与之前一致，状态为 disabled 且不写来源状态文件', async (t) => {
  const { bank, root } = await makeBank(t)
  await bank.init()
  const stats = await bank.stats()
  assert.equal(stats.total, 46)
  assert.deepEqual(stats.sources.msyQuestions, {
    status: 'disabled', imported: 0, scanned: 0, invalid: 0, skippedOffTopic: 0, withAnswer: 0,
  })
  assert.deepEqual(stats.sources.msyResume, { status: 'disabled', imported: 0 })
  assert.deepEqual(stats.warnings, [])
  assert.equal((await bank.listActive({ limit: 1000 })).length, 46)
  await assert.rejects(readFile(join(root, 'data', 'market-sources.json'), 'utf8'), '未启用外部来源时不应产生状态文件')
})

test('三域隔离：seed/题目/简历各写各的域，46 条 seed 全在池里，shared 不混入外部行', async (t) => {
  const { root, open } = await makeExternalBank(t, {
    reader: msyReaderOf({ questions: [msyQuestionItem(1), msyQuestionItem(2)], resume: [msyResumeItem(1)] }),
  })
  const bank = open()
  await bank.init()

  assert.deepEqual(await sourceRows(root), [[1, 46], [2, 2], [3, 1]])

  const pool = await bank.listActive({ limit: 1000 })
  const seedIds = new Set(SEED_ITEMS.map((item) => item.id))
  const gotSeed = pool.filter((item) => seedIds.has(item.id))
  assert.equal(gotSeed.length, 46, '46 条 seed 必须全部留在 limit 1000 的候选里')
  assert.ok(pool.some((item) => item.id === 'msy-q-1001'))
  assert.ok(pool.some((item) => item.id === 'msy-r-2001'))

  const shared = await bank.listActive({ rolePack: 'shared', limit: 1000 })
  const seedShared = shared.filter((item) => seedIds.has(item.id))
  assert.equal(seedShared.length, 10, '普通岗位原有 10 条 shared seed 不变')
  assert.ok(shared.every((item) => item.rolePack === 'shared'))
  assert.ok(shared.some((item) => item.id === 'msy-r-2001'), '简历深挖题进 shared 池，普通岗位可按关键词取用')
  assert.ok(shared.every((item) => !item.id.startsWith('msy-q-')), 'msy 题目仍只属 agent 包，不得混进普通岗位')

  const stats = await bank.stats()
  assert.equal(stats.sources.msyQuestions.status, 'ok')
  assert.equal(stats.sources.msyQuestions.imported, 2)
  assert.equal(stats.sources.msyQuestions.scanned, 40)
  assert.equal(stats.sources.msyQuestions.invalid, 2)
  assert.equal(stats.sources.msyQuestions.skippedOffTopic, 5)
  assert.equal(stats.sources.msyResume.imported, 1)
  assert.equal(stats.sources.seed.count, 46)

  // 状态文件只留有限元数据：不含目录、不含题面。
  const state = await readFile(join(root, 'data', 'market-sources.json'), 'utf8')
  assert.equal(state.includes(root), false, '状态文件不得写入本机路径')
  assert.equal(state.includes('检索增强里召回不足'), false, '状态文件不得写入题面正文')
  const parsed = JSON.parse(state)
  assert.equal(parsed.msy.status, 'ok')
  assert.equal(parsed.msy.count, 2)
  assert.equal(parsed.msy.resume, 1)
})

test('外部失败只降级：上次成功的行保留并继续参与候选，seed 不受影响', async (t) => {
  const { open } = await makeExternalBank(t, {
    reader: msyReaderOf({ questions: [msyQuestionItem(1)], resume: [msyResumeItem(1)] }),
  })
  const ok = open()
  await ok.init()
  assert.equal((await ok.stats()).sources.msyQuestions.imported, 1)
  await ok.close()

  const broken = open(async () => { throw new Error('reader exploded') })
  await broken.init()
  const stats = await broken.stats()
  assert.equal(stats.sources.msyQuestions.status, 'degraded')
  assert.equal(stats.sources.msyQuestions.imported, 1, '失败不删旧行')
  assert.ok(stats.warnings.includes('msy-read-failed'))
  assert.equal(stats.sources.seed.count, 46)
  assert.equal(stats.total, 46 + 2, 'seed 与上次成功的外部行都还在')
  const pool = await broken.listActive({ limit: 1000 })
  assert.ok(pool.some((item) => item.id === 'msy-q-1001'), '降级后旧外部行仍可用')
  const seedIds = new Set(SEED_ITEMS.map((item) => item.id))
  assert.equal(pool.filter((item) => seedIds.has(item.id)).length, 46)
})

test('shrink guard：同映射版本下条数腰斩则保留旧行并记降级', async (t) => {
  const many = Array.from({ length: 12 }, (_, index) => msyQuestionItem(index + 1))
  const { open } = await makeExternalBank(t, { reader: msyReaderOf({ questions: many }) })
  const first = open()
  await first.init()
  assert.equal((await first.stats()).sources.msyQuestions.imported, 12)
  await first.close()

  const shrunk = open(msyReaderOf({ questions: [msyQuestionItem(1)], stats: { questionHash: 'c'.repeat(64) } }))
  await shrunk.init()
  const stats = await shrunk.stats()
  assert.equal(stats.sources.msyQuestions.imported, 12, '骤减时保留旧行')
  assert.equal(stats.sources.msyQuestions.status, 'degraded')
  assert.ok(stats.warnings.includes('msy-question-shrink-kept'))
  assert.equal((await shrunk.listActive({ limit: 1000 })).filter((item) => item.id.startsWith('msy-q-')).length, 12)
})

test('shrink guard 不推进 hash/采集日：被拒的收缩下次仍会重试而不是 skipped', async (t) => {
  const many = Array.from({ length: 40 }, (_, index) => msyQuestionItem(index + 1))
  const { root, open } = await makeExternalBank(t, { reader: msyReaderOf({ questions: many }) })
  const first = open()
  await first.init()
  assert.equal((await first.stats()).sources.msyQuestions.imported, 40)
  await first.close()
  const firstState = JSON.parse(await readFile(join(root, 'data', 'market-sources.json'), 'utf8')).msy
  assert.equal(firstState.status, 'ok')

  const shrunkItems = many.slice(0, 10)
  const shrinkHash = 'c'.repeat(64)
  const shrunk = open(msyReaderOf({
    questions: shrunkItems,
    stats: { questionHash: shrinkHash, collectedAt: '2026-09-09' },
  }))
  await shrunk.init()
  const afterGuard = await shrunk.stats()
  assert.equal(afterGuard.sources.msyQuestions.imported, 40, '被拒收缩不删行')
  assert.equal(afterGuard.sources.msyQuestions.status, 'degraded')
  assert.equal((await sourceRows(root)).find(([source]) => source === 2)[1], 40, '库里仍是 40 条')
  await shrunk.close()

  const guardedState = JSON.parse(await readFile(join(root, 'data', 'market-sources.json'), 'utf8')).msy
  assert.equal(guardedState.hash, firstState.hash, '被拒的收缩不得推进 hash')
  assert.equal(guardedState.collectedAt, firstState.collectedAt, '被拒的收缩不得推进采集日')
  assert.equal(guardedState.count, 40)

  // 重启后同一条被拒来源必须重新判断，不能因为 hash 一致就落 skipped 而永远不应用删除。
  const again = open(msyReaderOf({
    questions: shrunkItems,
    stats: { questionHash: shrinkHash, collectedAt: '2026-09-09' },
  }))
  await again.init()
  const stats = await again.stats()
  assert.equal(stats.sources.msy.status, 'degraded', '第二次仍应降级重试')
  assert.notEqual(stats.sources.msy.status, 'skipped')
  assert.ok(stats.warnings.includes('msy-question-shrink-kept'))
  assert.equal(stats.sources.msyQuestions.imported, 40)
})

test('hash 未变：外部行零写入且状态为 skipped', async (t) => {
  const items = [msyQuestionItem(1), msyQuestionItem(2)]
  const { root, open } = await makeExternalBank(t, { reader: msyReaderOf({ questions: items }) })
  const first = open()
  await first.init()
  const before = await stampsOf(root, 2)
  await first.close()

  const second = open(msyReaderOf({ questions: items }))
  await second.init()
  assert.deepEqual(await stampsOf(root, 2), before, 'hash 未变不应重写外部行')
  assert.equal((await second.stats()).sources.msy.status, 'skipped')
})

test('外部行不覆盖 seed：同 id 冲突时跳过并保留精选包内容', async (t) => {
  const clashing = msyQuestionItem(1, {
    id: 'mcp-lifecycle',
    question: '这条外部题试图顶掉同 id 的精选包题目，应该被忽略。',
  })
  const { root, open } = await makeExternalBank(t, { reader: msyReaderOf({ questions: [clashing] }) })
  const bank = open()
  await bank.init()
  const [row] = await bank.getByIds(['mcp-lifecycle'])
  assert.notEqual(row.question, clashing.question)
  assert.deepEqual(await sourceRows(root), [[1, 46]])
})

test('关掉 msyDir 后：旧外部行留在库里但不参与候选，统计回到 disabled', async (t) => {
  const { root, open } = await makeExternalBank(t, {
    reader: msyReaderOf({ questions: [msyQuestionItem(1), msyQuestionItem(2)], resume: [msyResumeItem(1)] }),
  })
  const withMsy = open()
  await withMsy.init()
  assert.equal((await withMsy.stats()).total, 46 + 3)
  await withMsy.close()

  const without = open(null, { msyDir: '' })
  await without.init()
  const stats = await without.stats()
  assert.equal(stats.total, 46, '未启用时统计只看 seed')
  assert.equal(stats.sources.msyQuestions.status, 'disabled')
  assert.equal(stats.sources.msyQuestions.imported, 0, '来源关闭时不能对外报「已导入」')
  assert.equal(stats.sources.msyResume.status, 'disabled')
  assert.equal(stats.sources.msyResume.imported, 0)
  assert.deepEqual(await sourceRows(root), [[1, 46], [2, 2], [3, 1]], '外部行保留但不使用')
  const pool = await without.listActive({ limit: 1000 })
  assert.equal(pool.length, 46)
  assert.ok(pool.every((item) => !item.id.startsWith('msy-')), '未启用时外部行不得进入候选')
})
