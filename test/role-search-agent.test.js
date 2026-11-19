import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshRoleResearch, createRoleSearchTask } from '../lib/role-search-agent.js'
import { createRoleResearch } from '../lib/role-research.js'

test('Agent 可更换查询及平台，只收录从实际正文找到的面试经历和题干', async () => {
  const url = 'https://story-craft.org/interviews/first-round'
  const blocked = 'https://jobs.career-site.org/interview/recent'
  const eventQuote = '我面试了竖屏短剧编剧，面试官让我完成试稿。'
  const quote = '前三集的反转和结尾钩子要怎么安排？'
  const genericRecall = '问到我最难忘的一次工作经历或者说是客户投诉经历。'
  const simulation = '如果制片说第二集冲突来得太晚，你会先改哪场戏？'
  const calls = []
  const web = {
    async search({ query }) {
      calls.push(query)
      return { sources: query.includes('story-craft.org') ? [{ url, title: '短剧编剧面试复盘' }] : [
        { url: blocked, title: '候选面经', snippet: '面试官让我完成试稿。' },
        { url: 'https://127.0.0.1/interview', title: '不应打开' },
      ] }
    },
    async fetch({ url: target }) {
      return { url: target, statusCode: target === blocked ? 403 : 200, body: { kind: 'text', content: `# 短剧编剧面试复盘\n${eventQuote}\n${quote}\n${genericRecall}\n这是第一轮试稿，还要说明试稿和大纲的关系。\n全部评论(10)\n第三集怎么给不同人加感情线？` } }
    },
  }
  const task = createRoleSearchTask({ role: '短剧编剧', duties: [], queryTopics: [], web })
  const run = async (name, args) => JSON.parse(await task.tools.find((entry) => entry.name === name).execute(args, {}))
  assert.equal((await run('hr_search', { queries: ['短剧编剧 面经'] })).state, 'plan-first')
  await run('hr_plan', { directions: [{ duty: '分集剧本创作', simulations: [simulation] }] })
  const initial = await run('hr_search', { queries: ['短剧编剧 面经'] })
  assert.deepEqual(initial.results[0].sources.map((source) => source.url), [blocked])
  assert.equal((await run('hr_read', { ids: [1] }))[0].state, 'unreadable')
  assert.equal((await run('hr_record', { id: 1, eventQuote, roleQuote: '竖屏短剧编剧', questions: [] })).state, 'read-body-first')
  const second = await run('hr_search', { queries: ['竖屏分集剧本 试稿 site:story-craft.org'] })
  const [{ id }] = second.results[0].sources
  await run('hr_read', { ids: [id] })
  const evidence = { id, eventQuote, roleQuote: '竖屏短剧编剧' }
  const entry = { duty: '分集剧本创作', quote, question: quote }
  assert.equal((await run('hr_record', { ...evidence, eventQuote: '这是没有出现在正文里的假证据', questions: [entry] })).state, 'missing-firsthand-interview-or-role-evidence')
  assert.deepEqual((await run('hr_record', { ...evidence, questions: [{ ...entry, quote: '第三集怎么给不同人加感情线？' }] })).accepted, [])
  assert.deepEqual((await run('hr_record', { ...evidence, questions: [{ ...entry, quote: genericRecall, question: '你怎样处理观众的投诉？' }] })).accepted, [])
  assert.deepEqual((await run('hr_record', { ...evidence, questions: [entry] })).accepted, ['分集剧本创作'])
  const result = task.results().get('分集剧本创作')
  assert.equal(result.sourceUrl, url)
  assert.equal(result.sourceExcerpt, quote)
  assert.deepEqual(result.simulationQuestions, [simulation])
  assert.equal(task.needsRetry(), false)
  assert.equal(calls.length, 2)
})

test('Agent 只找到了模拟题时不写入面经证据，换题仍再次检索', async () => {
  const duty = '舞台灯光调试'
  const questions = ['彩排还有十分钟，一盏摇头灯没有响应，你会按什么顺序排查？', '灯光台和现场编组不同，你会怎么核对通道、灯位和提示表？']
  let calls = 0
  const research = createRoleResearch(async () => {
    calls += 1
    return new Map([[duty, { simulationQuestions: questions }]])
  })
  const base = { materials: { role: '舞台灯光师', jd: '' }, items: [], knowledge: [], cache: {}, durationMinutes: 15 }
  const first = await research(base)
  assert.deepEqual(first.build().items.map(({ question }) => question), questions)
  assert.ok(first.build().items.every((item) => item.basis === 'simulation' && item.sourceRefs.length === 0))
  assert.ok(Object.values(first.updates).every((record) => !record.sourceUrl))
  await research({ ...base, cache: first.updates, refresh: true })
  assert.equal(calls, 2)
})

test('原生 Agent 读完网页遇到输出上限，可以继续核验已读正文', async () => {
  const duty = '客舱沟通'
  const url = 'https://cabin-journal.org/interview'
  const eventQuote = '我面试了空乘乘务员，面试官问了我一道客舱情景题。'
  const quote = '在飞机上如果有乘客向你要手机号你要怎么处理？'
  const web = {
    async search() { return { sources: [{ url }] } },
    async fetch() { return { url, statusCode: 200, body: { kind: 'text', content: `# 空乘乘务员面经\n${eventQuote}\n${quote}\n` } } },
  }
  const events = []
  const messages = []
  const tools = new Map()
  const use = (name, args) => tools.get(name).execute(args, {})
  const agent = {
    session: { get seq() { return events.length }, eventAt: (index) => events[index] },
    followup(message) { messages.push(message.content[0].text) },
    async whenIdle() {
      if (messages.length === 1) {
        await use('hr_plan', { directions: [{ duty, simulations: [] }] })
        await use('hr_search', { queries: ['空乘乘务员 面经'] })
        await use('hr_search', { queries: ['乘务员电话 情景面试'] })
        await use('hr_read', { ids: [1] })
      } else await use('hr_record', { id: 1, eventQuote, roleQuote: '空乘乘务员', questions: [{ duty, quote }] })
      events.push({ type: 'turn/end', data: { reason: { kind: messages.length === 1 ? 'max-tokens' : 'completed' } } })
    },
  }
  let disposed = false
  const scope = { tools: { restrict: (mask) => assert.deepEqual(mask, { allow: [] }), register: (entry) => tools.set(entry.name, entry), definitions: () => [...tools.values()] }, systemPrompt: { section() {}, suppressRuntimeContext() {} } }
  const research = createDshRoleResearch(() => ({ get: () => null, agents: { async create({ setup }) { setup(scope, agent); return { agent, async dispose() { disposed = true } } } } }))
  const result = await research({ role: '空乘乘务员', duties: [], queryTopics: [], web })
  assert.equal(result.get(duty).sourceQuestion, quote)
  assert.match(messages[1], /已经读取的网页/)
  assert.equal(disposed, true)
})
