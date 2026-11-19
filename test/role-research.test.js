import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicRoleProvider } from '../lib/public-role-sources.js'
import { createRoleResearch, interviewRoleScope, readJobDuties } from '../lib/role-research.js'
import { HRInterviewService } from '../lib/service.js'
import { InterviewStore } from '../lib/store.js'

const computerResume = '计算机本科，Java 后端项目，负责 MCP 和 RAG 接入。测试邮箱 private-resume@example.com。'
const guardJd = '负责物业门岗值守、人员和车辆登记、现场巡查、交接班、异常上报。'
const testSource = 'https://jobs.example.gov.cn/job/announcement.html'
const sourceExcerpt = '门岗值守，人员/车辆登记，现场巡查与安全秩序维护。'
const localQuestion = { id: 'test-local-mcp', rolePack: 'agent', kind: 'project', topic: 'mcp', question: '如何实现 MCP 工具调用？', evidenceLevel: 'first_hand' }

const webPage = (url, content = '', kind = 'html', statusCode = 200) => ({ url, statusCode, body: { kind, content } })

function sourceWeb(calls, page = `<title>保安员招聘公告</title><body><h1>保安员招聘公告</h1><h2>岗位职责</h2><p>${sourceExcerpt}</p><h2>任职要求</h2><p>无要求</p></body>`) {
  return {
    async search({ query }, signal) {
      assert.ok(signal instanceof AbortSignal)
      calls.push(query)
      return { sources: query.includes('招聘') ? [{ url: testSource }, { url: 'http://127.0.0.1/' }] : [] }
    },
    async fetch({ url }, signal) {
      assert.ok(signal instanceof AbortSignal)
      calls.push(url)
      return url === testSource ? webPage(url, page) : webPage(url, '', 'html', 503)
    },
  }
}

test('职责拆分保留一项中的并列对象，隔离任职要求', () => {
  assert.deepEqual(readJobDuties(`${guardJd}任职要求：有工作经验。`), ['物业门岗值守', '人员和车辆登记', '现场巡查', '交接班', '异常上报'])
  assert.deepEqual(readJobDuties('登记来访人员、车辆；处理现场投诉。'), ['登记来访人员、车辆', '处理现场投诉'])
  assert.deepEqual(readJobDuties('接待顾客、点餐上菜、处理顾客投诉。'), ['接待顾客', '点餐上菜', '处理顾客投诉'])
})

test('新岗位的招聘职责保留括号内的规格，排除待遇条款', () => {
  assert.deepEqual(readJobDuties('1、独立撰写（100集，1min/集）新媒体短剧剧本，维护人物小传。\n五险绩效奖金节日礼物岗位晋升'), [
    '独立撰写(100集,1min/集)新媒体短剧剧本', '维护人物小传',
  ])
  assert.deepEqual(readJobDuties('核验来料（包装、温度），记录批次；五险一金、餐补'), ['核验来料(包装、温度)', '记录批次'])
  assert.deepEqual(readJobDuties('五险一金办理，审核员工工资'), ['五险一金办理', '审核员工工资'])
})

test('本地命中职责不出网，仅把缺失职责交给补题连接器', async () => {
  const calls = []
  const research = createRoleResearch(async (request) => { calls.push(request); return new Map() })
  const base = { materials: { role: 'Agent 工程师', jd: 'MCP 工具调用', resume: computerResume }, items: [localQuestion], knowledge: [], cache: {}, durationMinutes: 15 }
  const fromBank = (await research(base)).build()
  assert.equal(fromBank.items[0].basis, 'opening')
  assert.equal(fromBank.items[1].bankItemId, localQuestion.id)
  assert.equal(fromBank.items[1].basis, 'local')
  assert.equal(calls.length, 0)
  await research({ ...base, materials: { ...base.materials, jd: 'MCP 工具调用；发布回滚' } })
  assert.deepEqual(calls[0].duties, ['发布回滚'])
  assert.doesNotMatch(JSON.stringify(calls), /private-resume|计算机本科/)
  const sharedSoftwareQuestion = { ...localQuestion, rolePack: 'shared', question: '如何在 Java 服务的交接班里说明 RAG 故障？' }
  const nonSoftware = await research({ ...base, materials: { role: '保安', jd: '交接班', resume: computerResume }, items: [sharedSoftwareQuestion] })
  assert.equal(nonSoftware.build().items[0].basis, 'simulation')
  assert.doesNotMatch(nonSoftware.build().items[0].question, /Java|RAG/)
})

test('准备和入场使用岗位依据，换岗位时不复用补题缓存和薄弱点', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'role-interview-'))
  const store = new InterviewStore(root)
  const calls = []
  const modelCalls = []
  const model = { async next(context) { modelCalls.push(context); return { action: 'followup', answerQuote: '部署了 RAG', question: '如何优化？' } } }
  const provider = createPublicRoleProvider(() => sourceWeb(calls))
  const service = new HRInterviewService({ store, model, roleResearch: createRoleResearch(provider) })
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  await store.saveMaterials({ role: '保安', resume: computerResume, jd: guardJd, projectNotes: 'MCP private project' })
  await store.saveKnowledge([
    { id: 'guard-skill', title: '门岗交接', roleScope: interviewRoleScope('保安'), mastery: 1 },
    { id: 'dev-skill', title: 'RAG 调优', roleScope: interviewRoleScope('Agent 工程师'), mastery: 1 },
  ])
  const preparation = await service.prepareInterview({ durationMinutes: 30 })
  assert.equal(preparation.dutyPlan, true)
  assert.equal(preparation.questionBudget.main, 6)
  assert.deepEqual(preparation.items.slice(0, 5).map(({ basis }) => basis), ['public-duty', 'public-duty', 'public-duty', 'simulation', 'simulation'])
  assert.equal(preparation.items[0].sourceRefs[0].sourceUrl, testSource)
  assert.match(preparation.items[0].sourceRefs[0].sourceExcerpt, /门岗值守/)
  assert.deepEqual(preparation.items[3].sourceRefs, [])
  assert.doesNotMatch(preparation.items.map(({ question }) => question).join('\n'), /MCP|RAG|P99/i)
  assert.ok(calls.some((url) => url === testSource))
  assert.ok(calls.every((url) => !/127\.0\.0\.1|@example\.com|RAG|MCP/.test(decodeURIComponent(url))))

  const recordedEvidence = await store.roleEvidence()
  assert.equal(Object.keys(recordedEvidence).length, 3)
  assert.doesNotMatch(JSON.stringify(recordedEvidence), /private-resume|private project|计算机本科/)
  const settle = { mode: 'standard', persona: 'professional', durationMinutes: 30, inputMode: 'text' }
  const started = await service.start({ ...settle, preparationId: preparation.preparationId })
  assert.equal(started.turns[0].text, preparation.items[0].question)
  assert.equal(started.turns[0].questionBasis, 'public-duty')
  assert.equal(modelCalls.length, 0)
  const followup = await service.submitText(started.session.sessionId, '我会先确认两件事的紧急程度。')
  assert.match(followup.turns.at(-1).text, /人员和车辆登记/)
  assert.doesNotMatch(followup.turns.at(-1).text, /RAG/)
  assert.deepEqual(modelCalls[0].knowledge.map(({ id }) => id), ['guard-skill'])
  let progress = followup
  for (let index = 0; index < 2; index += 1) progress = await service.control(started.session.sessionId, 'skip')
  assert.equal(progress.turns.at(-1).questionBasis, 'simulation')
  assert.match(progress.turns.at(-1).text, /交接班/)

  const beforeChange = calls.length
  await store.saveMaterials({ role: '仓库管理员', resume: computerResume, jd: '现场巡查；异常上报。' })
  const changed = await service.start(settle)
  assert.ok(calls.length > beforeChange, '与保安同名的职责需要重新验证')
  assert.equal(changed.session.preparation.items.every((item) => item.basis === 'simulation'), true)
  assert.doesNotMatch(changed.session.preparation.items.map(({ question }) => question).join('\n'), /门岗|保安|来访/)
  assert.notEqual(changed.turns[0].knowledgePointId, started.turns[0].knowledgePointId)
})

test('资料缓存复用到期前的同岗位职责，过期再查，断网生成模拟题', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'role-evidence-'))
  const store = new InterviewStore(root)
  const calls = []
  const provider = createPublicRoleProvider(() => sourceWeb(calls))
  const research = createRoleResearch(provider)
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = { materials: { role: '保安', jd: '人员和车辆登记', resume: computerResume }, items: [], knowledge: [], durationMinutes: 15 }
  const first = await research({ ...base, cache: {} })
  assert.equal(first.build().items[0].basis, 'public-duty')
  await store.cacheRoleEvidence(first.updates)
  const cached = await store.roleEvidence()
  const count = calls.length
  const second = await research({ ...base, cache: cached })
  assert.equal(second.build().planKey, first.build().planKey)
  assert.equal(calls.length, count)
  const fail = async () => { throw new Error('offline') }
  const offline = createRoleResearch(createPublicRoleProvider(() => ({ search: fail, fetch: fail })))
  const later = await offline({ ...base, cache: cached, now: new Date(Date.now() + 16 * 86400_000) })
  assert.equal(later.build().items[0].basis, 'simulation')
  assert.deepEqual(later.build().items[0].sourceRefs, [])
})

test('岗位名称可直接触发跨平台公开面经检索，只有已读取且匹配的正文能入提纲', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'role-platforms-'))
  const store = new InterviewStore(root)
  const requests = []
  const nowcoderQuestion = '设备驱动开发中，怎么验证时钟与中断配置正确？'
  const leetcodeQuestion = '做硬件联调时，你会如何确定故障是在板上还是软件层？'
  const nowcoder = 'https://www.nowcoder.com/discuss/12345678'
  const leetcode = 'https://leetcode.cn/discuss/post/public-fixture/'
  const irrelevant = 'https://www.zhihu.com/question/123456/answer/654321'
  const shell = 'https://www.nowcoder.com/discuss/12345679'
  const web = {
    async search({ query }) {
      requests.push(query)
      if (query.includes('site:nowcoder.com')) return { sources: [{ url: `${nowcoder}?from=web` }, { url: shell, title: '嵌入式面经', snippet: '仅搜索摘要：如何进行单片机裸机开发？' }] }
      if (query.includes('site:leetcode.cn')) return { sources: [{ url: leetcode }] }
      if (query.includes('site:zhihu.com')) return { sources: [{ url: irrelevant, title: '嵌入式面经' }] }
      return { sources: [] }
    },
    async fetch({ url }) {
      requests.push(url)
      if (url === nowcoder) return webPage(url, `<title>嵌入式软件工程师一面面经</title><div class="nc-slate-editor-content"><p>面试官问了我几道题。</p><p>${nowcoderQuestion}</p><p>为什么不等找到下家再离职？</p></div><div class="js-comment-container"><p>请问你内推找谁？</p></div>`)
      if (url === leetcode) return webPage(url, `# 嵌入式硬件工程师面经\n\n二面面试官问我板卡调试。\n- 为何没有骑驴找马？\n- ${leetcodeQuestion}\n`, 'text')
      if (url === irrelevant) return webPage(url, '<title>财务岗位面经</title><article><p>面试官问我如何检查财务报表？</p></article>')
      if (url === shell) return webPage(url, '<title>嵌入式硬件工程师面经</title><main>登录</main>')
      return webPage(url, '', 'html', 503)
    },
  }
  const provider = createPublicRoleProvider(() => web)
  const service = new HRInterviewService({ store, roleResearch: createRoleResearch(provider) })
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  await store.saveMaterials({ role: '嵌入式工程师', jd: '', resume: '', projectNotes: '' })
  const first = await service.prepareInterview({ durationMinutes: 15 })
  const primary = first.items.filter(({ basis, alternate }) => basis === 'public-interview' && !alternate)
  assert.ok(primary.some(({ question }) => question === nowcoderQuestion))
  assert.ok(primary.some(({ question }) => question === leetcodeQuestion))
  assert.deepEqual(new Set(primary.map(({ sourceRefs }) => sourceRefs[0].sourceUrl)), new Set([nowcoder, leetcode]))
  assert.ok(requests.includes(irrelevant))
  assert.ok(requests.findIndex((entry) => entry.includes('site:leetcode.cn')) > requests.indexOf(shell), '先核对第一批正文，仍缺题时再换平台')
  assert.doesNotMatch(JSON.stringify(first), /财务报表|内推找谁|裸机开发|离职|骑驴找马/)
  assert.ok(first.items.some((item) => item.basis === 'simulation'))
  assert.ok(first.items.filter((item) => item.basis === 'simulation').every((item) => item.sourceRefs.length === 0))
  const count = requests.length
  assert.equal((await service.prepareInterview({ durationMinutes: 15 })).preparationId, first.preparationId)
  assert.equal(requests.length, count)
})

test('Java 后端占位 JD 先使用真实本地题库，缺题出具体模拟题，简称一致', async (t) => {
  const calls = []
  const root = await mkdtemp(join(tmpdir(), 'hr-java-backend-'))
  const store = new InterviewStore(root)
  const service = new HRInterviewService({
    store, roleResearch: createRoleResearch(async (request) => { calls.push(request); return new Map() }),
  })
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  const titles = ['java后端开发工程师', 'Java 后端', 'Java 服务端']
  const outlines = []
  for (const role of titles) {
    await store.saveMaterials({ role, jd: '123', resume: computerResume })
    const plan = await service.prepareInterview({ durationMinutes: 30 })
    outlines.push(plan)
    assert.ok(plan.items.some((item) => item.basis === 'local' && /重复扣款/.test(item.question)))
    assert.ok(plan.items.some((item) => item.basis === 'local' && /P99/.test(item.question)))
    assert.ok(plan.items.some((item) => item.basis === 'simulation' && /组合索引/.test(item.question)))
    assert.ok(plan.items.some((item) => item.basis === 'simulation' && /参数校验/.test(item.question)))
    assert.doesNotMatch(plan.items.map((item) => item.question).join('\n'), /日常工作|异常情况处理|Android|MCP/)
    assert.equal(plan.roleContextMissing, false)
  }
  assert.deepEqual(calls.map((call) => call.duties), titles.map(() => ['后端 API 开发与联调', '数据库查询与索引优化']))
  assert.doesNotMatch(JSON.stringify(calls), /private-resume|计算机本科/)
  assert.deepEqual(outlines[0].items.map((item) => item.duty), outlines[2].items.map((item) => item.duty))
  await store.saveMaterials({ role: titles[0], jd: '排查 P99 接口延迟' })
  const specific = await service.prepareInterview({ durationMinutes: 15 })
  assert.deepEqual([...new Set(specific.items.filter((item) => !item.opening).map((item) => item.duty))], ['排查 P99 接口延迟'])
  assert.equal(calls.length, titles.length)
})

test('公开网页校验 Java 简称、正文后端证据和 Android 隔离，模拟变体不继承公开来源', async () => {
  const requests = []
  const narrow = 'https://www.nowcoder.com/discuss/87654321'
  const broad = 'https://juejin.cn/post/87654321'
  const android = 'https://www.nowcoder.com/discuss/87654322'
  const noBackend = 'https://www.zhihu.com/question/87654321/answer/42'
  const apiQuestion = 'Spring Boot 接口参数校验失败时，怎样设计错误返回？'
  const sqlQuestion = '订单慢 SQL 如何用执行计划判断是否需要索引？'
  const androidQuestion = 'Android 的 Activity 生命周期中，旋转屏幕后怎样恢复状态？'
  const bodies = new Map([
    [narrow, `# Java 后端面经\n面试官问了我：\n- ${apiQuestion}\n- ${androidQuestion}`],
    [broad, `# Java 开发面经\n我投的是负责微服务与接口开发的岗位。面试官问了我：\n- ${sqlQuestion}`],
    [android, `# Java 开发面经\n我投的是 Android 客户端开发。面试官问了我：\n- ${androidQuestion}`],
    [noBackend, '# Java 开发面经\n面试官问了我：\n- Java 的类和对象有什么区别？'],
  ])
  const web = {
    async search({ query }) {
      requests.push(query)
      if (query.includes('site:nowcoder.com')) return { sources: [{ url: narrow }, { url: android }] }
      if (query.includes('site:zhihu.com')) return { sources: [{ url: noBackend }] }
      if (query.includes('site:juejin.cn')) return { sources: [{ url: broad }] }
      return { sources: [] }
    },
    async fetch({ url }) { requests.push(url); return webPage(url, bodies.get(url) || '', 'text') },
  }
  const provider = createPublicRoleProvider(() => web)
  const research = createRoleResearch(provider)
  const bank = JSON.parse(await readFile(new URL('../lib/data/market-question-bank.json', import.meta.url), 'utf8'))
  const base = { items: bank.items, knowledge: [], cache: {}, durationMinutes: 30 }
  const java = (await research({ ...base, materials: { role: 'java后端开发工程师', jd: '111' } })).build()
  assert.ok(requests.some((query) => query.startsWith('Java 后端') && query.includes('site:nowcoder.com')))
  assert.ok(requests.some((query) => query.startsWith('Java 服务端') && query.includes('site:juejin.cn')))
  assert.ok(requests.includes(android) && requests.includes(noBackend))
  const publicItems = java.items.filter((item) => item.basis === 'public-interview')
  assert.deepEqual(publicItems.map((item) => item.question), [apiQuestion, sqlQuestion])
  assert.deepEqual(publicItems.map((item) => item.sourceRefs[0].sourceUrl), [narrow, broad])
  assert.doesNotMatch(java.items.map((item) => item.question).join('\n'), /Activity|类和对象/)
  assert.ok(java.items.some((item) => item.basis === 'simulation' && item.sourceRefs.length === 0))

  const mobile = (await research({ ...base, materials: { role: 'Android 开发工程师', jd: '' } })).build()
  assert.deepEqual(mobile.items.filter((item) => item.basis === 'public-interview').map((item) => item.question), [androidQuestion])
  assert.doesNotMatch(mobile.items.map((item) => item.question).join('\n'), /Spring Boot|慢 SQL|重复扣款/)
})

test('公开资料不可用时嵌入式工程师和餐厅服务员按本岗情景模拟', async () => {
  const research = createRoleResearch(async () => new Map())
  const base = { items: [], knowledge: [], cache: {}, durationMinutes: 15 }
  for (const [role, expected, unrelated] of [
    ['嵌入式工程师', /I²C|驱动时序|看门狗/, /上菜|客诉|重复扣款/],
    ['餐厅服务员', /上错了|售完|等座|值班经理/, /I²C|Spring Boot|重复扣款/],
  ]) {
    const plan = (await research({ ...base, materials: { role, jd: '', resume: computerResume } })).build()
    assert.ok(plan.items.every((item) => item.basis === 'simulation' && item.sourceRefs.length === 0))
    const questions = plan.items.map((item) => item.question).join('\n')
    assert.match(questions, expected)
    assert.doesNotMatch(questions, unrelated)
    assert.equal(plan.roleContextMissing, false)
  }
})

test('运维占位 JD 按不同职责补题，Prometheus 与 Kubernetes 不重复占位，换题优先使用面经', async () => {
  const requests = []
  const monitoring = 'https://www.nowcoder.com/discuss/717441'
  const linux = 'https://www.zhihu.com/question/717442/answer/31'
  const kubernetes = 'https://juejin.cn/post/717443'
  const release = 'https://blog.csdn.net/example/article/details/717444'
  const unrelated = 'https://www.nowcoder.com/discuss/717445'
  const pages = new Map([
    [monitoring, '# 运维工程师一面面经\n面试官问了我以下问题。\n- Prometheus 的信息采集原理？\n- Prometheus 采集 K8S 是哪个接口？'],
    [linux, '# Linux 运维面经\n面试官问了我：\n- Linux 上 systemd 服务启动失败，怎么查看 journalctl 日志？'],
    [kubernetes, '# 容器运维面试复盘\n面试官问了我：\n- Kubernetes 的 Pod 持续重启怎么排查？'],
    [release, '# 系统运维面试记录\n面试官问了我：\n- 自动化运维脚本失败后，怎样检查回滚是否完成？'],
    [unrelated, '# Java 后端开发面经\n面试官问了我：\n- TCP 和 UDP 有哪些区别？'],
  ])
  const web = {
    async search({ query }) {
      requests.push(query)
      if (query.includes('Prometheus')) return { sources: [{ url: monitoring }] }
      if (query.includes('systemd')) return { sources: [{ url: linux }] }
      if (query.includes('Kubernetes')) return { sources: [{ url: kubernetes }] }
      if (query.includes('回滚')) return { sources: [{ url: release }] }
      if (query.includes('DNS')) return { sources: [{ url: unrelated }] }
      return { sources: [] }
    },
    async fetch({ url }) {
      requests.push(url)
      return webPage(url, pages.get(url) || '', 'text')
    },
  }
  const research = createRoleResearch(createPublicRoleProvider(() => web))
  const materials = { role: '运维工程师', jd: '111', resume: computerResume }
  const study = await research({ materials, items: [], knowledge: [], cache: {}, durationMinutes: 30 })
  const plan = study.build()
  const topics = [...new Set(plan.items.map((item) => item.duty))]
  assert.deepEqual(topics, ['监控采集与告警排查', 'Linux 服务与日志排查', '网络连通性与 DNS 排查', 'Kubernetes 容器与发布故障', '发布回滚与自动化运维'])
  assert.ok(['Prometheus', 'systemd', 'DNS', 'Kubernetes', '回滚'].every((keyword) => requests.some((query) => query.includes(keyword))))
  assert.doesNotMatch(JSON.stringify(requests), /private-resume|计算机本科/)
  const monitoringItems = plan.items.filter((item) => item.duty === topics[0] && item.basis === 'public-interview')
  assert.equal(monitoringItems.length, 2)
  assert.equal(plan.items.find((item) => item.duty === topics[3]).sourceRefs[0].sourceUrl, kubernetes)
  assert.ok(plan.items.some((item) => item.duty === topics[2] && item.basis === 'simulation' && /DNS 解析/.test(item.question)))
  assert.doesNotMatch(JSON.stringify(plan.items), /刚接手「Prometheus|TCP 和 UDP 有哪些区别/)
  const replacement = study.build({ selectionSeed: 'ops-fixture-seed', avoidItemIds: [monitoringItems[0].bankItemId] })
  assert.equal(replacement.items.find((item) => item.duty === topics[0]).bankItemId, monitoringItems[1].bankItemId)
  assert.equal(replacement.items.find((item) => item.duty === topics[0]).basis, 'public-interview')
})

test('只有可核实的面经题问法时，保留原题且不把题干套成同题模拟变体', async () => {
  const question = '出现列车调度交接信息不一致时，你会先核对哪份记录？'
  const research = createRoleResearch(async () => new Map([
    ['出现列车调度交接信息不一致时', { sourceQuestion: question, sourceTitle: '合成面经', sourceUrl: 'https://example.gov.cn/interview', sourceExcerpt: question }],
  ]))
  const study = await research({ materials: { role: '列车调度员', jd: '' }, items: [], knowledge: [], cache: {}, durationMinutes: 30 })
  assert.deepEqual(study.build().items.map(({ basis, question }) => [basis, question]), [['public-interview', question]])
})

test('换一批题时会为只有一道面经的职责查备选，并保留已核实的旧题', async () => {
  const duty = '监控采集与告警排查'
  const original = 'Prometheus 告警未发送时，你会先排查哪部分？'
  const alternate = '监控指标突然消失时，你会先怎样检查 exporter？'
  let calls = 0
  const research = createRoleResearch(async () => {
    const question = ++calls === 1 ? original : alternate
    return new Map([[duty, { sourceTitle: '合成运维面经', sourceUrl: `https://www.nowcoder.com/discuss/7174${calls}`, sourceQuestion: question, sourceExcerpt: question }]])
  })
  const base = { materials: { role: '运维工程师', jd: duty }, items: [], knowledge: [], durationMinutes: 15 }
  const first = await research({ ...base, cache: {} })
  await research({ ...base, cache: first.updates })
  assert.equal(calls, 1)
  const refreshed = await research({ ...base, cache: first.updates, refresh: true })
  assert.equal(calls, 2)
  assert.deepEqual(refreshed.build().items.filter((item) => item.basis === 'public-interview').map((item) => item.question), [alternate, original])
})

test('公开面经补齐已确认的前提，保留原文来源并停用无法独立理解的题', async () => {
  const original = '你的网站，你觉得如果访问量上去了，最先出现瓶颈问题的点是哪？怎么优化？'
  const unclear = '刚才那个方案的瓶颈是什么？'
  const url = 'https://example.com/interview/site-performance'
  const asEvidence = (question) => ({ sourceQuestion: question, sourceExcerpt: question, sourceTitle: '网站运维面经', sourceUrl: url })
  const research = createRoleResearch(async () => new Map([
    ['网站性能排查', { ...asEvidence(original), relatedQuestions: [asEvidence(unclear)] }],
    ['网站内容管理', asEvidence('这样不对，你再说一遍？')],
  ]))
  const result = await research({ materials: { role: '网站管理员', jd: '网站性能排查；网站内容管理' }, items: [], knowledge: [], cache: {}, durationMinutes: 15 })
  const plan = result.build()
  const verified = plan.items.filter((item) => item.basis === 'public-interview')
  assert.equal(verified.length, 1)
  assert.match(verified[0].question, /^假设一个网站的访问量明显增加/)
  assert.equal(verified[0].sourceRefs[0].sourceExcerpt, original)
  assert.equal(verified[0].sourceRefs[0].sourceUrl, url)
  assert.ok(plan.items.some((item) => item.duty === '网站内容管理' && item.basis === 'simulation'))
  assert.ok(plan.items.every((item) => !/刚才那个方案|这样不对/.test(item.question)))
})

test('岗位未提供 JD 时从 Agent 补充方向，近义的旧方向不计入轮换', async () => {
  const previous = ['核对寄存行李牌', '处理顾客投诉', '计费与交接']
  const calls = []
  const simulate = (duty) => ({ simulationQuestions: [`办理${duty}时，记录不完整你会怎么确认？`] })
  const research = createRoleResearch(async (input) => {
    calls.push(input)
    const directions = input.previousDirections ? ['核验寄存行李牌', '破损行李处理', '失物认领流程'] : previous
    return new Map(directions.map((duty) => [duty, simulate(duty)]))
  })
  const input = { materials: { role: '行李寄存员', jd: '' }, items: [], knowledge: [], durationMinutes: 15, cache: {} }
  const first = await research(input)
  const next = await research({ ...input, cache: first.updates, previousDirections: previous })
  const chosen = [...new Set(next.build().items.filter((item) => !item.alternate).map((item) => item.duty))]
  assert.deepEqual(calls[1].previousDirections, previous)
  assert.ok(chosen.includes('破损行李处理') && chosen.includes('失物认领流程'))
  assert.ok(!chosen.includes('核验寄存行李牌'))
  assert.equal(calls.length, 2, '已用 Agent 找过的候选不重复检索')
})

test('宽泛岗位需要职责才能做定向检索，具体 JD 仍可用于补题', async () => {
  const calls = []
  const research = createRoleResearch(async (request) => { calls.push(request); return new Map() })
  const base = { items: [localQuestion], knowledge: [], cache: {}, durationMinutes: 30 }
  for (const role of ['工程师', '运营', '技术支持', '短剧']) {
    const result = await research({ ...base, materials: { role, jd: '', resume: computerResume } })
    const plan = result.build()
    assert.equal(plan.roleContextMissing, true)
    assert.ok(plan.items.every((item) => item.basis === 'simulation'))
  }
  assert.equal(calls.length, 0)
  const result = await research({ ...base, materials: { role: '技术支持', jd: '企业软件安装部署；客户故障排查' } })
  assert.equal(result.build().roleContextMissing, false)
  assert.deepEqual(calls[0].duties, ['企业软件安装部署', '客户故障排查'])
})

test('面经题干不充当模拟职责，餐厅的接待、点餐和投诉情景具备独立题干', async () => {
  const question = 'PM2.5 传感器采样周期是多少？'
  const topic = 'PM2.5 传感器采样周期'
  const research = createRoleResearch(async ({ role }) => role.includes('嵌入式') ? new Map([
    [topic, { sourceQuestion: question, sourceTitle: '嵌入式面经', sourceUrl: 'https://juejin.cn/post/90142', sourceExcerpt: question }],
  ]) : new Map())
  const base = { items: [], knowledge: [], cache: {}, durationMinutes: 30 }
  const embedded = (await research({ ...base, materials: { role: '嵌入式工程师', jd: '' } })).build()
  assert.deepEqual(embedded.items.filter((item) => item.duty === topic).map((item) => item.basis), ['public-interview'])
  assert.ok(embedded.items.some((item) => item.duty === '外设驱动与板卡联调' && item.basis === 'simulation'))
  const restaurant = await research({ ...base, materials: { role: '餐厅服务员', jd: '接待顾客、点餐上菜、处理顾客投诉、处理客诉' } })
  for (const selectionSeed of ['', 'restaurant-refresh']) {
    const { items } = restaurant.build({ selectionSeed })
    assert.equal(new Set(items.map(({ question }) => question)).size, items.length)
    assert.match(items.find((item) => item.duty === '接待顾客').question, /等座|预约/)
    assert.match(items.find((item) => /投诉|客诉/.test(item.duty)).question, /菜品和菜单|重复收费/)
  }
})

test('带计数的评论区及求简历点评不按面经收录，换题可查到真实面经', async () => {
  const misleading = 'https://www.nowcoder.com/feed/main/detail/0123456789abcdef0123456789abcdef'
  const comments = 'https://www.nowcoder.com/feed/main/detail/1123456789abcdef0123456789abcdef'
  const legitimate = 'https://www.nowcoder.com/discuss/997342'
  const question = '保安员遇到预约登记信息不符时，会怎么处理？'
  const web = sourceWeb([])
  const search = web.search
  const fetch = web.fetch
  let includeInterview = false
  web.search = async (request, signal) => request.query.includes('招聘') ? search(request, signal) : {
    sources: [{ url: misleading }, { url: comments }, ...(includeInterview ? [{ url: legitimate }] : [])],
  }
  web.fetch = async (request, signal) => {
    if (request.url === misleading) return webPage(misleading, '# 保安员面试经验交流\n佬，帮忙看看我的简历，能不能过筛啊？\n面试问题：登记表上应该填什么？', 'text')
    if (request.url === comments) return webPage(comments, '# 保安员面经\n有人知道明天招几个人吗？\n\n全部评论(184)\n\n面试官问我登记表上应该填什么？\n- 登记的信息和预约不一致怎么办？', 'text')
    if (request.url === legitimate) return webPage(legitimate, `# 保安员面经\n面试官问了我：\n- ${question}`, 'text')
    return fetch(request, signal)
  }
  const research = createRoleResearch(createPublicRoleProvider(() => web))
  const base = { materials: { role: '保安员', jd: '登记' }, items: [], knowledge: [], cache: {}, durationMinutes: 30 }
  const first = await research(base)
  assert.ok(first.build().items.every((item) => item.basis === 'public-duty'))
  includeInterview = true
  const next = await research({ ...base, cache: first.updates, refresh: true })
  assert.equal(next.build().items[0].basis, 'public-interview')
  assert.equal(next.build().items[0].question, question)
})
