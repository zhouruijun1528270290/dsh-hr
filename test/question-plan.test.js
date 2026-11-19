import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildQuestionPlan, detectRolePack, materialsProfile, EMPTY_BANK_CODE, MIN_ACTIVE_ITEMS,
  normalizeSelectionSeed, selectionDiff, SELECTION_SEED_PATTERN,
} from '../lib/question-plan.js'
import { MarketQuestionBank } from '../lib/market-bank.js'

const SEED_FILE = new URL('../lib/data/market-question-bank.json', import.meta.url)
const SEED = JSON.parse(await readFile(SEED_FILE, 'utf8'))
const BANK_ITEMS = SEED.items
const ROLE_PACK_BY_ID = new Map(BANK_ITEMS.map((item) => [item.id, item.rolePack]))

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

const AGENT_MATERIALS = {
  role: 'AI Agent 应用开发工程师',
  resume: [
    '负责公司内部的 Agent 工作流平台，接入 MCP 工具 12 个',
    '搭建 RAG 知识库，召回率从 61% 提升到 88%',
    '做过记忆压缩与上下文管理，单会话 token 成本下降 34%',
  ].join('\n'),
  jd: '要求熟悉 Agent 架构、MCP 工具协议、RAG 检索增强，能做工具调用编排与效果评测。',
  projectNotes: '项目：客服 Agent，接入 8 个工具，日均 3 万会话。',
}

const GENERIC_MATERIALS = {
  role: 'Java 后端开发工程师',
  resume: '负责订单系统重构，QPS 从 800 提到 2400。\n维护支付对账任务。',
  jd: '熟悉 Spring Boot、MySQL、Redis，负责交易链路稳定性。',
  projectNotes: '项目：订单中心重构。',
}

const agentItems = BANK_ITEMS.filter((item) => item.rolePack === 'agent')

const planOf = (patch = {}) => buildQuestionPlan({
  materials: AGENT_MATERIALS,
  durationMinutes: 30,
  knowledge: [],
  items: BANK_ITEMS,
  now: new Date('2026-11-18T00:00:00Z'),
  ...patch,
})

const kindCount = (items, kind) => items.filter((item) => item.kind === kind).length

// ---------------------------------------------------------------- 角色包识别

test('detectRolePack：只看 role/JD 明确关键词，普通技术岗留在 generic', () => {
  assert.equal(detectRolePack(AGENT_MATERIALS), 'agent')
  assert.equal(detectRolePack(GENERIC_MATERIALS), 'generic')
  assert.equal(detectRolePack({ role: '前端开发工程师', jd: '熟悉 React、TypeScript、性能优化。' }), 'generic')
  assert.equal(detectRolePack({ role: '运维工程师', jd: '负责 K8s 集群与监控告警。' }), 'generic')
  assert.equal(detectRolePack({ role: '算法工程师', jd: '熟悉推荐系统召回与排序模型。' }), 'generic')
  // 岗位不是 agent，但 JD 明确点了两项 agent 能力 → 仍算 agent 包
  assert.equal(detectRolePack({
    role: '大模型应用开发',
    jd: '负责 RAG 检索增强与工具调用链路。',
  }), 'agent')
  // 单个泛化词不足以判定
  assert.equal(detectRolePack({ role: '后端开发工程师', jd: '了解 prompt 写法者优先。' }), 'generic')
  assert.equal(detectRolePack({}), 'generic')
  assert.equal(detectRolePack(null), 'generic')
})

// ---------------------------------------------------------------- 材料指纹

test('materialsProfile：字段齐全，profileKey 按约定公式复算一致', () => {
  const profile = materialsProfile(AGENT_MATERIALS)
  assert.deepEqual(Object.keys(profile).sort(), [
    'durationMinutes', 'factFingerprint', 'jdHash', 'packId', 'profileKey',
    'resumeBagHash', 'resumeOrderedHash', 'taxonomyVersion',
  ])
  assert.equal(profile.packId, 'agent')
  assert.equal(profile.durationMinutes, 30)
  assert.equal(profile.taxonomyVersion, '2026-11')
  for (const field of ['resumeOrderedHash', 'resumeBagHash', 'jdHash', 'factFingerprint', 'profileKey']) {
    assert.match(profile[field], /^[0-9a-f]{64}$/, `${field} 应是 sha256`)
  }
  const expected = sha256([
    profile.packId, profile.resumeBagHash, profile.jdHash, profile.factFingerprint,
    profile.durationMinutes, profile.taxonomyVersion,
  ].join('|'))
  assert.equal(profile.profileKey, expected)
})

test('materialsProfile：空白/换行/全半角差异不影响指纹', () => {
  const base = materialsProfile(AGENT_MATERIALS)
  const messy = {
    ...AGENT_MATERIALS,
    role: '  AI   Agent 应用开发工程师  ',
    jd: '要求熟悉 Agent 架构、MCP 工具协议、RAG 检索增强，\r\n能做工具调用编排与效果评测。  ',
    resume: AGENT_MATERIALS.resume.replace(/\n/g, '\r\n').replace(/  /g, ' '),
    projectNotes: `  ${AGENT_MATERIALS.projectNotes}  `,
  }
  const other = materialsProfile(messy)
  assert.equal(other.profileKey, base.profileKey)
  assert.equal(other.jdHash, base.jdHash)
  assert.equal(other.resumeBagHash, base.resumeBagHash)
  const wide = materialsProfile({ ...AGENT_MATERIALS, role: 'ＡＩ　Ａｇｅｎｔ 应用开发工程师' })
  assert.equal(wide.packId, 'agent')
  assert.equal(wide.profileKey, materialsProfile({ ...AGENT_MATERIALS, role: 'ai agent 应用开发工程师' }).profileKey)
})

test('materialsProfile：简历事实重排可复用，顺序不同只改 resumeOrderedHash', () => {
  const base = materialsProfile(AGENT_MATERIALS)
  const lines = AGENT_MATERIALS.resume.split('\n')
  const shuffled = materialsProfile({ ...AGENT_MATERIALS, resume: [lines[2], lines[0], lines[1]].join('\n') })
  assert.equal(shuffled.resumeBagHash, base.resumeBagHash)
  assert.equal(shuffled.profileKey, base.profileKey, '事实重排不应让提纲失效')
  assert.notEqual(shuffled.resumeOrderedHash, base.resumeOrderedHash)
  const withBullet = materialsProfile({
    ...AGENT_MATERIALS,
    resume: lines.map((line) => `- ${line}`).join('\n'),
  })
  assert.equal(withBullet.profileKey, base.profileKey, '条目前缀符号不算事实差异')
})

test('materialsProfile：JD、role、项目补充、时长、版本变化都必须改变 profileKey', () => {
  const base = materialsProfile(AGENT_MATERIALS)
  const variants = [
    { ...AGENT_MATERIALS, jd: `${AGENT_MATERIALS.jd} 有线上 SLA 经验优先。` },
    { ...AGENT_MATERIALS, role: 'AI Agent 平台架构师' },
    { ...AGENT_MATERIALS, projectNotes: '项目：客服 Agent，接入 12 个工具，日均 3 万会话。' },
    { ...AGENT_MATERIALS, resume: `${AGENT_MATERIALS.resume}\n负责灰度发布。` },
  ]
  for (const variant of variants) {
    assert.notEqual(materialsProfile(variant).profileKey, base.profileKey, '材料变化必须换 profileKey')
  }
  assert.notEqual(materialsProfile(AGENT_MATERIALS, { durationMinutes: 15 }).profileKey, base.profileKey)
  assert.notEqual(materialsProfile(AGENT_MATERIALS, { taxonomyVersion: '2027-01' }).profileKey, base.profileKey)
  // role 变化单独也必须生效（不能只靠简历事实）
  const roleOnly = materialsProfile({
    role: 'AI Agent 应用开发工程师（高级）',
    resume: AGENT_MATERIALS.resume,
    jd: AGENT_MATERIALS.jd,
    projectNotes: AGENT_MATERIALS.projectNotes,
  })
  assert.notEqual(roleOnly.factFingerprint, base.factFingerprint)
  assert.notEqual(roleOnly.profileKey, base.profileKey)
})

// ---------------------------------------------------------------- 提纲形状

test('buildQuestionPlan：15 分钟 6 条（4 主 + 2 备），30 分钟 8 条（6 主 + 2 备）', () => {
  const short = planOf({ durationMinutes: 15 })
  assert.equal(short.items.length, 6)
  assert.deepEqual(short.questionBudget, { main: 4, alternates: 2, total: 6 })
  assert.equal(short.items.filter((item) => item.alternate).length, 2)
  assert.equal(short.items.filter((item) => !item.alternate).length, 4)
  assert.equal(short.durationMinutes, 15)

  const long = planOf()
  assert.equal(long.items.length, 8)
  assert.deepEqual(long.questionBudget, { main: 6, alternates: 2, total: 8 })
  assert.equal(long.items.filter((item) => item.alternate).length, 2)

  const twenty = planOf({ durationMinutes: 20 })
  assert.equal(twenty.items.length, 6, '不足 30 分钟仍按短场出 6 条')
  assert.deepEqual(twenty.questionBudget, { main: 4, alternates: 2, total: 6 })
})

test('buildQuestionPlan：返回字段齐全，planItem 结构固定且不含材料原文', () => {
  const plan = planOf()
  assert.deepEqual(Object.keys(plan).sort(), [
    'durationMinutes', 'items', 'packId', 'planKey', 'profileKey', 'questionBudget',
    'selectionSeed', 'taxonomyVersion',
  ])
  assert.equal(plan.selectionSeed, '', '不指定种子时必须是确定性快照')
  assert.equal(plan.packId, 'agent')
  assert.equal(plan.taxonomyVersion, '2026-11')
  assert.match(plan.planKey, /^[0-9a-f]{64}$/)
  assert.equal(plan.profileKey, materialsProfile(AGENT_MATERIALS).profileKey)
  plan.items.forEach((item, index) => {
    assert.deepEqual(Object.keys(item).sort(), [
      'alternate', 'bankItemId', 'expectedPoints', 'followups', 'kind', 'planItemId',
      'question', 'sourceRefs', 'topic',
    ])
    assert.equal(item.planItemId, `plan-${index + 1}`)
    assert.equal(item.sourceRefs.length, 1)
    const [ref] = item.sourceRefs
    assert.deepEqual(Object.keys(ref).sort(), [
      'bankItemId', 'evidenceLevel', 'revision', 'sourceTitle', 'sourceUrl',
    ])
    assert.equal(ref.bankItemId, item.bankItemId)
  })
  const serialized = JSON.stringify(plan)
  for (const line of AGENT_MATERIALS.resume.split('\n')) {
    assert.equal(serialized.includes(line), false, '提纲不得带出简历原文')
  }
  assert.equal(serialized.includes(AGENT_MATERIALS.projectNotes), false)
})

test('buildQuestionPlan：配额按 kind 生效（8 条 2/2/2/1/1）', () => {
  const plan = planOf()
  assert.equal(kindCount(plan.items, 'project'), 2)
  assert.equal(kindCount(plan.items, 'principle'), 2)
  assert.equal(kindCount(plan.items, 'incident'), 2)
  assert.equal(kindCount(plan.items, 'evaluation'), 1)
  assert.equal(kindCount(plan.items, 'behavioral'), 1)
  const short = planOf({ durationMinutes: 15 })
  assert.equal(kindCount(short.items, 'project'), 2)
  assert.equal(kindCount(short.items, 'principle'), 1)
  assert.equal(kindCount(short.items, 'incident'), 1)
  assert.equal(kindCount(short.items, 'evaluation'), 1)
  assert.equal(kindCount(short.items, 'behavioral'), 1)
})

test('buildQuestionPlan：候选不足时预算按实际条数收窄，不指向不存在的备选', () => {
  // 30 分钟期望 6 主 + 2 备，但只有 5 条候选：预算必须收窄到 5 主 0 备
  const five = planOf({ items: agentItems.slice(0, 5) })
  assert.equal(five.items.length, 5)
  assert.deepEqual(five.questionBudget, { main: 5, alternates: 0, total: 5 })
  assert.equal(five.items.filter((item) => item.alternate).length, 0)

  const shortFive = planOf({ items: agentItems.slice(0, 5), durationMinutes: 15 })
  assert.deepEqual(shortFive.questionBudget, { main: 4, alternates: 1, total: 5 })

  const six = planOf({ items: agentItems.slice(0, 6) })
  assert.equal(six.items.length, 6)
  assert.deepEqual(six.questionBudget, { main: 6, alternates: 0, total: 6 })

  const seven = planOf({ items: agentItems.slice(0, 7) })
  assert.equal(seven.items.length, 7)
  assert.deepEqual(seven.questionBudget, { main: 6, alternates: 1, total: 7 })
  assert.equal(seven.items.filter((item) => item.alternate).length, 1)
  // alt 标记与 main 边界一致：前 main 条都不是备选
  for (const [index, item] of seven.items.entries()) assert.equal(item.alternate, index >= 6)
})

test('buildQuestionPlan：generic 30 分钟拿到 8 条，2 条备选真实存在', () => {
  const plan = buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 30,
    items: BANK_ITEMS,
    now: new Date('2026-11-18T00:00:00Z'),
  })
  assert.equal(plan.packId, 'generic')
  assert.equal(plan.items.length, 8)
  assert.deepEqual(plan.questionBudget, { main: 6, alternates: 2, total: 8 })
  assert.equal(plan.items.filter((item) => item.alternate).length, 2)
  assert.equal(kindCount(plan.items, 'project'), 2)
  assert.equal(kindCount(plan.items, 'principle'), 2)
  assert.equal(kindCount(plan.items, 'incident'), 2)
  assert.equal(kindCount(plan.items, 'evaluation'), 1)
  assert.equal(kindCount(plan.items, 'behavioral'), 1)
  const planIds = new Set(BANK_ITEMS.map((item) => item.id))
  for (const item of plan.items) assert.ok(planIds.has(item.bankItemId))
})

test('buildQuestionPlan：generic 部分条目到期后仍按确定性补位凑满预算', () => {
  const shared = BANK_ITEMS.filter((item) => item.rolePack === 'shared')
  const build = (items) => buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 30,
    items,
    now: new Date('2026-11-18T00:00:00Z'),
  })
  // 一条 incident 过期：仍有 9 条候选，预算仍是 6 + 2
  const oneExpired = build(shared.map((item) => (
    item.id === 'shared-incident-dependency-timeout' ? { ...item, reviewAfter: '2020-01-01' } : item
  )))
  assert.equal(oneExpired.items.length, 8)
  assert.deepEqual(oneExpired.questionBudget, { main: 6, alternates: 2, total: 8 })
  assert.equal(oneExpired.items.some((item) => item.bankItemId === 'shared-incident-dependency-timeout'), false)

  // 两条 incident 全过期：配额缺口由其它 kind 按确定性顺序补满，仍出 8 条
  const bothExpired = build(shared.map((item) => (
    item.kind === 'incident' ? { ...item, reviewAfter: '2020-01-01' } : item
  )))
  assert.equal(bothExpired.items.length, 8)
  assert.deepEqual(bothExpired.questionBudget, { main: 6, alternates: 2, total: 8 })
  assert.equal(kindCount(bothExpired.items, 'incident'), 0)
  const topics = new Set(bothExpired.items.map((item) => item.topic))
  assert.ok(topics.size >= 2, '补位后仍要保留主题多样性')
})

test('buildQuestionPlan：候选人不足时按确定性顺序补位，且不会塌成同一 topic', () => {
  // 只给 project 题，配额无法满足 → 仍要凑满条数，但不能全同 topic
  const projects = agentItems.filter((item) => item.kind === 'project')
  const sparse = planOf({ items: [...projects, ...BANK_ITEMS.filter((item) => item.rolePack === 'shared')] })
  assert.ok(sparse.items.length >= 5)
  const topics = new Set(sparse.items.map((item) => item.topic))
  assert.ok(topics.size >= 2, '补位后必须有至少两个主题')
  // 同一 topic 的题不能占满整份提纲
  const counts = new Map()
  for (const item of sparse.items) counts.set(item.topic, (counts.get(item.topic) || 0) + 1)
  assert.ok(Math.max(...counts.values()) < sparse.items.length, '不允许所有条目同主题')
})

test('buildQuestionPlan：确定性（同输入同输出，含 planKey）', () => {
  const a = planOf()
  const b = planOf()
  assert.deepEqual(a, b)
  const c = planOf({ items: [...BANK_ITEMS].reverse() })
  assert.deepEqual(c.items.map((item) => item.bankItemId), a.items.map((item) => item.bankItemId),
    '候选顺序不影响选题')
  assert.equal(c.planKey, b.planKey)
})

test('buildQuestionPlan：planKey 覆盖 profileKey 与选中项 revision', () => {
  const base = planOf()
  assert.notEqual(planOf({ durationMinutes: 15 }).planKey, base.planKey)
  const bumped = BANK_ITEMS.map((item) => (item.id === base.items[0].bankItemId ? { ...item, revision: 9 } : item))
  const after = planOf({ items: bumped })
  assert.notEqual(after.planKey, base.planKey)
  assert.equal(after.items[0].sourceRefs[0].revision, 9)
  const renamed = planOf({ materials: { ...AGENT_MATERIALS, jd: `${AGENT_MATERIALS.jd} 加分项：开源贡献。` } })
  assert.notEqual(renamed.planKey, base.planKey)

  // 种子侧把非 editorial 从 1 升到 2 本身就是一次 revision 变更：回退到 1 必须换 planKey
  const seededRevision = new Map(BANK_ITEMS.map((item) => [item.id, item.revision]))
  assert.ok(base.items.some((item) => seededRevision.get(item.bankItemId) === 2), '选中的题应已升版')
  const reverted = planOf({
    items: BANK_ITEMS.map((item) => (item.evidenceLevel === 'editorial' ? item : { ...item, revision: 1 })),
  })
  assert.notEqual(reverted.planKey, base.planKey, 'revision 回退必须换 planKey')
})

// ---------------------------------------------------------------- 换题种子（selectionSeed）

const planIds = (plan) => plan.items.map((item) => item.bankItemId)

/** 合成同分候选：全部 editorial、题目文本与材料零命中 ⇒ score 恒为 1，只能靠 seed 分先后。 */
const flatItems = (count) => Array.from({ length: count }, (_, index) => ({
  id: `flat-${String(index + 1).padStart(2, '0')}`,
  rolePack: 'shared',
  kind: index < count / 2 ? 'project' : 'principle',
  topic: `zone-${index + 1}`,
  question: `第 ${index + 1} 题：讲讲你如何设计一个高可用系统`,
  followups: [],
  expectedPoints: [],
  tags: [],
  sourceTitle: '合成同分题',
  sourceUrl: '',
  evidenceLevel: 'editorial',
  revision: 1,
}))

test('selectionSeed：只接受 /^[a-z0-9]{8,32}$/，其余一律归一成空串', () => {
  assert.equal(SELECTION_SEED_PATTERN.test('abcdefgh'), true, '8 位小写字母合法')
  assert.equal(SELECTION_SEED_PATTERN.test('0123456789abcdef0123456789abcdef'), true, '32 位合法')
  for (const seed of ['abcdefg', 'ABCDEFGH', 'abcdefgh ', ' abcdefgh', 'abcdefg-h', 'a'.repeat(33), '', null, undefined, 12345678, {}, []]) {
    assert.equal(normalizeSelectionSeed(seed), '', `${String(seed)} 必须归一成空串`)
  }
  assert.equal(normalizeSelectionSeed('abcdefgh'), 'abcdefgh')
})

test('selectionSeed：空种子下 planKey 与引入换题前逐字节一致', () => {
  const plan = planOf()
  const legacyKey = sha256([
    plan.profileKey,
    plan.taxonomyVersion,
    ...plan.items.map((item) => {
      const [ref] = item.sourceRefs
      return `${item.bankItemId}@${ref.sourceRevision || ref.revision}`
    }),
  ].join('|'))
  assert.equal(plan.planKey, legacyKey, '空种子不得多拼任何一段，旧 preparation 必须继续命中')
  assert.equal(plan.selectionSeed, '')
  // 显式空串、非法串都要与「完全不传」逐字段相同
  for (const seed of ['', 'nope', 'ABCDEFGH', 'a'.repeat(33), null, 42]) {
    assert.deepEqual(planOf({ selectionSeed: seed }), plan, `selectionSeed=${String(seed)} 必须退化成确定性路径`)
  }
})

test('selectionSeed：同一 seed 完全确定，候选输入顺序不影响结果', () => {
  const a = planOf({ selectionSeed: 'bbbbbbbb' })
  const b = planOf({ selectionSeed: 'bbbbbbbb' })
  assert.deepEqual(a, b)
  assert.equal(a.selectionSeed, 'bbbbbbbb')
  const reversed = planOf({ selectionSeed: 'bbbbbbbb', items: [...BANK_ITEMS].reverse() })
  assert.deepEqual(planIds(reversed), planIds(a), '候选顺序不参与排序')
  assert.equal(reversed.planKey, a.planKey)
  const short = planOf({ selectionSeed: 'bbbbbbbb', durationMinutes: 15 })
  assert.equal(short.selectionSeed, 'bbbbbbbb', '短场同样带种子')
})

test('selectionSeed：进 planKey，但不进 profileKey', () => {
  const base = planOf()
  const seeded = planOf({ selectionSeed: 'bbbbbbbb' })
  assert.equal(seeded.profileKey, base.profileKey, '换题不得改变材料/岗位/时长身份')
  assert.notEqual(seeded.planKey, base.planKey, '换题必须换 planKey，否则会被当成同一份提纲复用')
  assert.equal(
    planOf({ selectionSeed: 'cccccccc' }).planKey === planOf({ selectionSeed: 'bbbbbbbb' }).planKey,
    planOf({ selectionSeed: 'cccccccc' }).items.map((item) => item.bankItemId).join() === planOf({ selectionSeed: 'bbbbbbbb' }).items.map((item) => item.bankItemId).join(),
    'planKey 是否相同必须与选题是否相同一致',
  )
})

test('selectionSeed：同分候选里真的能换出另一批题（机制有效性）', () => {
  const build = (seed) => buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 30,
    items: flatItems(12),
    now: new Date('2026-11-18T00:00:00Z'),
    selectionSeed: seed,
  })
  const base = build('')
  const picked = new Set(planIds(base))
  const variants = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee', 'ffffffff'].map(build)
  const diffs = variants.map((plan) => selectionDiff(base.items, plan.items))
  assert.ok(diffs.some((diff) => diff.changed > 0), '同分候选足够时，换种子必须换出不同的题')
  assert.ok(new Set(variants.map((plan) => planIds(plan).join())).size >= 2, '至少有两种不同的选题结果')
  for (const plan of variants) {
    assert.equal(plan.items.length, 8, '换题不得改变条数')
    assert.deepEqual(plan.questionBudget, { main: 6, alternates: 2, total: 8 }, '换题不得改变主/备预算')
    assert.equal(plan.items.filter((item) => !picked.has(item.bankItemId)).length, selectionDiff(base.items, plan.items).changed)
  }
})

test('selectionSeed：真实题库上换种子也能换到条目（当前池子只有同分处可动）', () => {
  const base = planOf()
  const seeded = planOf({ selectionSeed: 'bbbbbbbb' })
  const diff = selectionDiff(base.items, seeded.items)
  assert.ok(diff.changed >= 1, '真实池上至少有一条能换出来')
  assert.equal(diff.changedIds.length, diff.changed)
  for (const id of diff.changedIds) {
    assert.equal(base.items.some((item) => item.bankItemId === id), false)
    assert.ok(seeded.items.some((item) => item.bankItemId === id))
  }
})

test('selectionSeed：不改变 kind 配额、topic 多样性、薄弱知识与岗位过滤', () => {
  const base = planOf()
  const seeded = planOf({ selectionSeed: 'bbbbbbbb' })
  for (const plan of [base, seeded]) {
    assert.equal(kindCount(plan.items, 'project'), 2)
    assert.equal(kindCount(plan.items, 'principle'), 2)
    assert.equal(kindCount(plan.items, 'incident'), 2)
    assert.equal(kindCount(plan.items, 'evaluation'), 1)
    assert.equal(kindCount(plan.items, 'behavioral'), 1)
    assert.ok(new Set(plan.items.map((item) => item.topic)).size >= 2, '换题后仍要保留主题多样性')
  }
  const shortSeeded = planOf({ selectionSeed: 'bbbbbbbb', durationMinutes: 15 })
  assert.equal(kindCount(shortSeeded.items, 'project'), 2)
  assert.equal(kindCount(shortSeeded.items, 'principle'), 1)
  assert.equal(shortSeeded.items.length, 6)
  assert.deepEqual(shortSeeded.questionBudget, { main: 4, alternates: 2, total: 6 })

  // 薄弱知识在换题后依然优先：同一 seed 下，带 rag 弱项不应比不带更少
  const weakSeeded = planOf({ selectionSeed: 'bbbbbbbb', knowledge: [{ id: 'k-1', domain: 'rag', title: '混合检索与召回', mastery: 0 }] })
  const rag = (plan) => plan.items.filter((item) => item.topic === 'rag').length
  assert.ok(rag(weakSeeded) >= rag(seeded), '弱项主题不得被换题挤掉')
  assert.ok(rag(weakSeeded) >= 1)
  const masteredSeeded = planOf({ selectionSeed: 'bbbbbbbb', knowledge: [{ id: 'k-2', domain: 'rag', title: '混合检索与召回', mastery: 4 }] })
  assert.deepEqual(planIds(masteredSeeded), planIds(seeded), '已掌握的知识点不改变换题结果')

  // 岗位隔离：generic 包在换题下也只出 shared
  const genericSeeded = buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 30,
    items: BANK_ITEMS,
    now: new Date('2026-11-18T00:00:00Z'),
    selectionSeed: 'bbbbbbbb',
  })
  assert.equal(genericSeeded.packId, 'generic')
  for (const item of genericSeeded.items) assert.equal(ROLE_PACK_BY_ID.get(item.bankItemId), 'shared')
})

test('selectionDiff：区分主问题与备选的变化', () => {
  const base = planOf()
  assert.deepEqual(selectionDiff(base.items, base.items), { changed: 0, mainChanged: 0, changedIds: [] })
  assert.deepEqual(selectionDiff(null, base.items).changed, base.items.length, '没有上一版时全部算新增')
  assert.equal(selectionDiff(base.items, []).changed, 0)

  const swapMain = base.items.map((item, index) => (
    index === 0 ? { ...item, bankItemId: 'synthetic-main', alternate: false } : item
  ))
  const mainDiff = selectionDiff(base.items, swapMain)
  assert.equal(mainDiff.changed, 1)
  assert.equal(mainDiff.mainChanged, 1, '主问题席位换人必须计入 mainChanged')
  assert.deepEqual(mainDiff.changedIds, ['synthetic-main'])

  const swapAlternate = base.items.map((item, index) => (
    index === base.items.length - 1 ? { ...item, bankItemId: 'synthetic-alt', alternate: true } : item
  ))
  const altDiff = selectionDiff(base.items, swapAlternate)
  assert.equal(altDiff.changed, 1)
  assert.equal(altDiff.mainChanged, 0, '只动备选不算换了主问题')

  // 同一道题从主问题降级成备选：题没换，主席位换了
  const demoted = base.items.map((item, index) => (
    index === 0 ? { ...item, alternate: true } : index === base.items.length - 1 ? { ...item, alternate: false } : item
  ))
  const demoteDiff = selectionDiff(base.items, demoted)
  assert.equal(demoteDiff.changed, 0, '题目集合没变')
  assert.equal(demoteDiff.mainChanged, 1, '主席位被备选题占了一个')
})

test('selectionDiff：真实换种子时主/备分别计数', () => {
  const base = planOf()
  const seeded = planOf({ selectionSeed: 'bbbbbbbb' })
  const diff = selectionDiff(base.items, seeded.items)
  const expectedMain = seeded.items.filter((item) => item.alternate !== true && !base.items.some((prev) => prev.alternate !== true && prev.bankItemId === item.bankItemId)).length
  assert.equal(diff.mainChanged, expectedMain)
  assert.ok(diff.mainChanged <= diff.changed)
})

// -------------------------------------------------- 换一批题（avoidItemIds）

/** 合成候选池：每个 kind 都有配额之外的备用条目，用于验证 avoidItemIds 能真的换题。 */
const mixedPool = (perKind = 3) => {
  const kinds = ['project', 'principle', 'incident', 'evaluation', 'behavioral']
  const pool = []
  for (const kind of kinds) {
    for (let index = 0; index < perKind; index += 1) {
      pool.push({
        id: `${kind}-${index + 1}`,
        rolePack: 'shared',
        kind,
        topic: `${kind}-topic-${index + 1}`,
        question: `第 ${kind} ${index + 1} 题：讲讲你如何处理这类问题`,
        followups: [],
        expectedPoints: [],
        tags: [],
        sourceTitle: '合成岗位题',
        sourceUrl: '',
        evidenceLevel: index === 0 ? 'first_hand' : 'editorial',
        revision: 1,
      })
    }
  }
  return pool
}

const poolPlan = (patch = {}) => buildQuestionPlan({
  materials: AGENT_MATERIALS,
  durationMinutes: 15,
  items: mixedPool(3),
  now: new Date('2026-11-18T00:00:00Z'),
  ...patch,
})

test('avoidItemIds：有替代时能把主问题整批换掉，且不动形状与配额', () => {
  const base = poolPlan({ items: mixedPool(4) })
  const mainIds = base.items.filter((item) => item.alternate !== true).map((item) => item.bankItemId)
  assert.equal(mainIds.length, 4)
  const refreshed = poolPlan({ items: mixedPool(4), avoidItemIds: planIds(base) })
  const diff = selectionDiff(base.items, refreshed.items)

  assert.ok(diff.mainChanged >= 1, '有替代时主问题必须换')
  assert.equal(
    refreshed.items.filter((item) => item.alternate !== true && mainIds.includes(item.bankItemId)).length,
    0,
    '每个 kind 都有富余候选时，旧提纲里的题不得继续占主问题席位',
  )
  assert.equal(refreshed.items.length, 6, '换题不得改变条数')
  assert.deepEqual(refreshed.questionBudget, { main: 4, alternates: 2, total: 6 })
  assert.equal(kindCount(refreshed.items, 'project'), 2)
  assert.equal(kindCount(refreshed.items, 'principle'), 1)
  assert.equal(kindCount(refreshed.items, 'incident'), 1)
  assert.equal(kindCount(refreshed.items, 'evaluation'), 1)
  assert.equal(kindCount(refreshed.items, 'behavioral'), 1)
  assert.ok(new Set(refreshed.items.map((item) => item.topic)).size >= 2, '换题仍要保留主题多样性')
  assert.equal(refreshed.profileKey, base.profileKey, '换题不得改变材料/岗位/时长身份')
  assert.notEqual(refreshed.planKey, base.planKey, 'selected ids 变了 planKey 必须变')
})

test('avoidItemIds：候选不足时保留必要旧题，不删题、不报错、不缩水', () => {
  // 6 条候选刚好填满 15 分钟的 2/1/1/1/1 配额
  const pool = mixedPool(1).concat({
    id: 'project-extra',
    rolePack: 'shared',
    kind: 'project',
    topic: 'project-topic-extra',
    question: '第 project extra 题：补一个项目',
    followups: [],
    expectedPoints: [],
    tags: [],
    sourceTitle: '合成岗位题',
    sourceUrl: '',
    evidenceLevel: 'edited',
    revision: 1,
  })
  const base = poolPlan({ items: pool })
  assert.equal(base.items.length, 6)
  assert.deepEqual(base.questionBudget, { main: 4, alternates: 2, total: 6 })

  const refreshed = poolPlan({ items: pool, avoidItemIds: planIds(base) })
  assert.deepEqual(planIds(refreshed), planIds(base), '没有替代时只能原样返回，而不是假换')
  assert.deepEqual(refreshed.questionBudget, base.questionBudget)
  assert.deepEqual(selectionDiff(base.items, refreshed.items), { changed: 0, mainChanged: 0, changedIds: [] })

  // 回避全部候选 + 只有 5 条（低于 6 席）：照常收窄预算，不抛错
  const five = pool.slice(0, 5)
  const narrow = poolPlan({ items: five, avoidItemIds: planIds(base) })
  assert.equal(narrow.items.length, 5)
  assert.deepEqual(narrow.questionBudget, { main: 4, alternates: 1, total: 5 })
})

test('avoidItemIds：空值/非法值与不传逐字段相同（旧 preparation 零迁移）', () => {
  const base = planOf()
  for (const value of [[], null, undefined, 'nope', ['', ''], [1, 2, {}], ['不存在的题']]) {
    assert.deepEqual(planOf({ avoidItemIds: value }), base, `avoidItemIds=${JSON.stringify(value)} 必须退化成确定性路径`)
  }
  assert.equal(poolPlan({ avoidItemIds: [] }).planKey, poolPlan().planKey)
})

test('avoidItemIds：真实题库上确实换得动主问题，且仍守岗位隔离', () => {
  const base = planOf()
  const refreshed = planOf({ avoidItemIds: planIds(base) })
  const diff = selectionDiff(base.items, refreshed.items)
  const baseMains = new Set(base.items.filter((item) => item.alternate !== true).map((item) => item.bankItemId))
  assert.ok(diff.mainChanged >= 1, `真实池上主问题必须能换（实测 mainChanged=${diff.mainChanged}）`)
  for (const item of refreshed.items) {
    if (item.alternate === true) continue
    assert.equal(baseMains.has(item.bankItemId), false, '换出来的主问题必须是没见过的')
  }
  assert.equal(kindCount(refreshed.items, 'project'), 2)
  assert.equal(kindCount(refreshed.items, 'principle'), 2)
  assert.equal(kindCount(refreshed.items, 'incident'), 2)
  assert.equal(kindCount(refreshed.items, 'evaluation'), 1)
  assert.equal(kindCount(refreshed.items, 'behavioral'), 1)

  // generic 包只收 shared，回避也不能把别的岗位题拉进来
  const genericBase = buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 30,
    items: BANK_ITEMS,
    now: new Date('2026-11-18T00:00:00Z'),
  })
  const genericRefreshed = buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 30,
    items: BANK_ITEMS,
    now: new Date('2026-11-18T00:00:00Z'),
    avoidItemIds: planIds(genericBase),
  })
  assert.equal(genericRefreshed.packId, 'generic')
  for (const item of genericRefreshed.items) assert.equal(ROLE_PACK_BY_ID.get(item.bankItemId), 'shared')
  assert.equal(genericRefreshed.items.length, 8, 'generic 包只有 10 选 8，回避后也不得缺条目')
})

// -------------------------------------------- 外部来源：来源快照与内容版本

const withSourceRevision = (items, patch = () => ({})) => items.map((item) => ({
  ...item,
  sourceType: 'msy-question',
  sourceRevision: `sr-${item.id}`,
  ...patch(item),
}))

test('sourceRefs：精选包不多出 sourceType/sourceRevision，也不带 null 字段', () => {
  const plan = planOf()
  for (const item of plan.items) {
    const [ref] = item.sourceRefs
    assert.deepEqual(Object.keys(ref).sort(), [
      'bankItemId', 'evidenceLevel', 'revision', 'sourceTitle', 'sourceUrl',
    ])
    assert.equal(Object.hasOwn(ref, 'sourceType'), false)
    assert.equal(Object.hasOwn(ref, 'sourceRevision'), false)
    for (const value of Object.values(ref)) assert.notEqual(value, null)
  }
})

test('sourceRefs：外部条目带 sourceType 与 sourceRevision，两者都非空', () => {
  const plan = planOf({ items: withSourceRevision(BANK_ITEMS) })
  for (const item of plan.items) {
    const [ref] = item.sourceRefs
    assert.deepEqual(Object.keys(ref).sort(), [
      'bankItemId', 'evidenceLevel', 'revision', 'sourceRevision', 'sourceTitle', 'sourceType', 'sourceUrl',
    ])
    assert.equal(ref.sourceType, 'msy-question')
    assert.equal(ref.sourceRevision, `sr-${item.bankItemId}`)
    const seedItem = BANK_ITEMS.find((row) => row.id === item.bankItemId)
    assert.ok(seedItem, `题库里找不到 ${item.bankItemId}`)
    assert.equal(ref.revision, seedItem.revision, `${item.bankItemId} revision 应取自题库当前版本`)
  }
})

test('planKey：外部内容版本变化即换 key，profileKey 不变；revision 让位 sourceRevision', () => {
  const base = planOf()
  const withRev = planOf({ items: withSourceRevision(BANK_ITEMS) })
  assert.equal(withRev.profileKey, base.profileKey, '来源版本不影响材料指纹')
  assert.notEqual(withRev.planKey, base.planKey, '外部来源进入 planKey')

  const targetId = withRev.items[0].bankItemId
  const contentChanged = withSourceRevision(BANK_ITEMS, (item) => (
    item.id === targetId ? { sourceRevision: 'sr-content-v2' } : {}
  ))
  const after = planOf({ items: contentChanged })
  assert.equal(after.profileKey, withRev.profileKey)
  assert.notEqual(after.planKey, withRev.planKey, '内容版本变了 planKey 必须变')
  assert.equal(after.items[0].sourceRefs[0].sourceRevision, 'sr-content-v2')

  // 有 sourceRevision 时 revision 只作展示，不参与 planKey（沿用 sourceRevision || revision 规则）
  const revisionBump = withSourceRevision(BANK_ITEMS, (item) => (item.id === targetId ? { revision: 9 } : {}))
  const bumped = planOf({ items: revisionBump })
  assert.equal(bumped.planKey, withRev.planKey, 'sourceRevision 存在时 planKey 走内容版本')
  assert.equal(bumped.items[0].sourceRefs[0].revision, 9)
})

// ---------------------------------------------------------------- 过滤与隔离

test('buildQuestionPlan：generic 包只用 shared，agent 题不会混入', () => {
  const plan = buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 30,
    items: BANK_ITEMS,
    now: new Date('2026-11-18T00:00:00Z'),
  })
  assert.equal(plan.packId, 'generic')
  assert.ok(plan.items.length >= MIN_ACTIVE_ITEMS)
  for (const item of plan.items) {
    assert.equal(ROLE_PACK_BY_ID.get(item.bankItemId), 'shared', `${item.bankItemId} 不属于 shared`)
  }
})

// ------------------------- 简历深挖题（shared 池）对普通岗位的关键词门槛

const resumeItems = (topics) => topics.map((topic, index) => ({
  id: `msy-r-${topic}`,
  rolePack: 'shared',
  topic,
  kind: 'project',
  question: `简历里写的 ${topic} 项目具体怎么做？第 ${index} 条`,
  followups: [],
  expectedPoints: ['讲清目标', '讲清方案', '讲清效果'],
  tags: [topic, 'resume', 'msy'],
  sourceTitle: `本地简历深挖 · ${topic}`,
  sourceUrl: '',
  evidenceLevel: 'editorial',
  revision: 1,
  sourceType: 'msy-resume',
  sourceRevision: `sr-${topic}`,
}))

const RELEVANT_RESUME_TOPICS = ['redis-cache', 'redis-cluster', 'redis-pipeline', 'mysql-index', 'mysql-lock', 'mysql-shard']
const UNRELATED_RESUME_TOPICS = ['cas-retry', 'dubbo-spi', 'jvm-gc', 'rocksdb-compaction', 'raft-election', 'quic-loss']

const UNRELATED_MATERIALS = {
  role: '财务分析师',
  resume: '负责月度结账、费用报销审核与预算跟踪。',
  jd: '熟悉财务报表、税务申报、预算管理与审计配合。',
  projectNotes: '项目：季度预算模型。',
}

test('简历深挖题：普通岗位相关时能进提纲，且带来源版本', () => {
  const items = BANK_ITEMS.concat(resumeItems(RELEVANT_RESUME_TOPICS))
  const plan = buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 30,
    items,
    now: new Date('2026-11-18T00:00:00Z'),
  })
  assert.equal(plan.packId, 'generic')
  const picked = plan.items.filter((item) => item.bankItemId.startsWith('msy-r-'))
  assert.ok(picked.length >= 1, 'JD 命中 Redis/MySQL 时，相关项目深挖题应被选中')
  for (const item of picked) {
    const [ref] = item.sourceRefs
    assert.equal(ref.sourceType, 'msy-resume')
    assert.match(ref.sourceRevision, /^sr-/)
  }
  for (const item of plan.items) {
    if (item.bankItemId.startsWith('msy-r-')) continue
    assert.equal(ROLE_PACK_BY_ID.get(item.bankItemId), 'shared')
  }
})

test('简历深挖题：无关岗位（财务）不会被塞进来', () => {
  // 只留 5 条 shared seed，正好卡在可用下限：没有门槛时补位一定会把 msy-r-* 拉进来。
  const seedShared = BANK_ITEMS.filter((item) => item.rolePack === 'shared').slice(0, 5)
  const items = seedShared.concat(resumeItems(UNRELATED_RESUME_TOPICS))
  const plan = buildQuestionPlan({
    materials: UNRELATED_MATERIALS,
    durationMinutes: 30,
    items,
    now: new Date('2026-11-18T00:00:00Z'),
  })
  assert.equal(plan.packId, 'generic')
  assert.equal(plan.items.some((item) => item.bankItemId.startsWith('msy-r-')), false, '零命中的简历题不得串岗')
  assert.equal(plan.items.length, 5, '无关简历题被挡掉后按实际可用 5 条收窄预算')
})

test('简历深挖题：agent 包不做关键词门槛，行为不回归', () => {
  const items = resumeItems(UNRELATED_RESUME_TOPICS)
  const plan = buildQuestionPlan({
    materials: AGENT_MATERIALS,
    durationMinutes: 30,
    items,
    now: new Date('2026-11-18T00:00:00Z'),
  })
  assert.equal(plan.packId, 'agent')
  assert.equal(plan.items.length, UNRELATED_RESUME_TOPICS.length, 'agent 包仍可用全部简历深挖题')
  assert.ok(plan.items.every((item) => item.bankItemId.startsWith('msy-r-')))
  assert.ok(plan.items.every((item) => item.sourceRefs[0].sourceType === 'msy-resume'))
})

test('buildQuestionPlan：stale 与 reviewAfter 过期条目被排除', () => {
  const today = '2026-11-18'
  const poisoned = BANK_ITEMS.map((item) => {
    if (item.id === 'rag-hybrid-fusion') return { ...item, reviewAfter: '2020-01-01' }
    if (item.id === 'mcp-lifecycle') return { ...item, stale: true }
    if (item.id === 'agent-loop-detection') return { ...item, reviewAfter: today }
    return item
  })
  const plan = planOf({ items: poisoned })
  const ids = plan.items.map((item) => item.bankItemId)
  assert.equal(ids.includes('rag-hybrid-fusion'), false, '过期项不得进入提纲')
  assert.equal(ids.includes('mcp-lifecycle'), false, 'stale 标记项不得进入提纲')
  for (const item of plan.items) {
    assert.ok(item.sourceRefs[0].bankItemId, '每条都要带来源快照')
  }
})

test('buildQuestionPlan：历史薄弱知识点优先', () => {
  const without = planOf()
  const weak = planOf({ knowledge: [{ id: 'k-1', domain: 'rag', title: '混合检索与召回', mastery: 0 }] })
  const countTopic = (plan, topic) => plan.items.filter((item) => item.topic === topic).length
  assert.ok(countTopic(weak, 'rag') >= countTopic(without, 'rag'), '薄弱主题不应被挤掉')
  assert.ok(countTopic(weak, 'rag') >= 1)
  // mastery 高（已掌握）不应改变选题
  const mastered = planOf({ knowledge: [{ id: 'k-2', domain: 'rag', title: '混合检索与召回', mastery: 4 }] })
  assert.deepEqual(mastered.items.map((item) => item.bankItemId), without.items.map((item) => item.bankItemId))
  // 无关知识点不改变提纲
  const unrelated = planOf({ knowledge: [{ id: 'k-3', domain: '前端性能优化', title: '首屏渲染', mastery: 0 }] })
  assert.deepEqual(unrelated.items.map((item) => item.bankItemId), without.items.map((item) => item.bankItemId))
})

// ---------------------------------------------------------------- 空库与错误

test('buildQuestionPlan：无候选时抛可控错误 market-bank-empty', () => {
  for (const items of [[], null, undefined, BANK_ITEMS.map((item) => ({ ...item, stale: true }))]) {
    assert.throws(() => planOf({ items }), (error) => {
      assert.equal(error.code, EMPTY_BANK_CODE)
      assert.equal(error.isDSHRemoteError, true)
      assert.equal(error.message.includes('Error'), false)
      return true
    })
  }
})

test('buildQuestionPlan：可用题不足 5 条时同样拒绝', () => {
  const onlyFour = agentItems.slice(0, 4)
  assert.throws(() => planOf({ items: onlyFour }), (error) => {
    assert.equal(error.code, EMPTY_BANK_CODE)
    assert.equal(error.details.active, 4)
    return true
  })
  const exactlyFive = agentItems.slice(0, 5)
  const plan = planOf({ items: exactlyFive })
  assert.equal(plan.items.length, 5)
})

test('buildQuestionPlan：错误不带简历/JD 内容', () => {
  assert.throws(() => planOf({ items: [] }), (error) => {
    const blob = `${error.message}${JSON.stringify(error.details ?? {})}`
    assert.equal(blob.includes(AGENT_MATERIALS.resume.slice(0, 12)), false)
    assert.equal(blob.includes('召回率'), false)
    return true
  })
})

// ---------------------------------------------------------------- 快照隔离

test('buildQuestionPlan：followups/expectedPoints 是副本，改动提纲不影响原始条目', () => {
  const source = BANK_ITEMS.map((item) => ({ ...item }))
  const plan = planOf({ items: source })
  const first = plan.items[0]
  first.followups.push('篡改')
  first.expectedPoints.push('篡改')
  first.sourceRefs[0].sourceTitle = '篡改'
  const original = source.find((item) => item.id === first.bankItemId)
  assert.equal(original.followups.includes('篡改'), false)
  assert.equal(original.expectedPoints.includes('篡改'), false)
  assert.notEqual(original.sourceTitle, '篡改')
  const again = planOf({ items: source })
  assert.deepEqual(again.items[0].followups, original.followups)
})

// ---------------------------------------------------------------- 与题库联调

test('联调：MarketQuestionBank.listActive 的输出能直接喂给 buildQuestionPlan', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hr-plan-integration-'))
  const bank = new MarketQuestionBank({ root, now: () => new Date('2026-11-18T00:00:00Z') })
  t.after(async () => {
    await bank.close()
    await rm(root, { recursive: true, force: true })
  })
  await bank.init()
  const items = await bank.listActive({ rolePack: 'agent', limit: 100 })
  assert.equal(items.length, 46)
  const plan = buildQuestionPlan({
    materials: AGENT_MATERIALS,
    durationMinutes: 30,
    items,
    now: new Date('2026-11-18T00:00:00Z'),
  })
  assert.equal(plan.items.length, 8)
  const bankIds = new Set(items.map((item) => item.id))
  for (const entry of plan.items) {
    assert.ok(bankIds.has(entry.bankItemId), `${entry.bankItemId} 不在题库返回结果里`)
    const original = items.find((item) => item.id === entry.bankItemId)
    assert.equal(entry.sourceRefs[0].revision, original.revision)
    assert.equal(entry.sourceRefs[0].evidenceLevel, original.evidenceLevel)
    assert.equal(entry.question, original.question)
  }
  const generic = buildQuestionPlan({
    materials: GENERIC_MATERIALS,
    durationMinutes: 15,
    items: await bank.listActive({ rolePack: 'generic', limit: 100 }),
    now: new Date('2026-11-18T00:00:00Z'),
  })
  assert.equal(generic.packId, 'generic')
  assert.equal(generic.items.length, 6)
})
