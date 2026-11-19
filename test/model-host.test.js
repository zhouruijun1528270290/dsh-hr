import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelGateway } from '../lib/model-gateway.js'

test('压力面的模型提示优先检验证据和反例，标准面沿用普通追问提示', async () => {
  const gateway = new ModelGateway()
  const prompts = []
  gateway.complete = async (_system, prompt) => { prompts.push(prompt); return { action: 'next_question' } }
  const context = {
    materials: { role: '后端工程师' },
    turns: [{ speaker: 'hr', pressureFocus: 'evidence', text: '你怎么验证？' }, { speaker: 'candidate', text: '我用固定流量对比。' }],
    planContext: { dutyPlan: true, current: { question: '你怎么验证？' } },
    session: { mode: 'mock', persona: 'professional' },
  }
  await gateway.next(context)
  await gateway.next({ ...context, session: { mode: 'mock', persona: 'pressure' } })
  await gateway.next({ ...context, session: { mode: 'drill', persona: 'pressure' } })
  await gateway.next({ ...context, assessPressureAnswer: true, session: { mode: 'mock', persona: 'pressure' } })
  await gateway.next({ ...context, assessPressureAnswer: true })
  await gateway.next({ ...context, reviseFollowup: { rejectedQuestion: '再怎么验证？', requireChallenge: true },
    session: { mode: 'mock', persona: 'pressure' } })
  assert.doesNotMatch(prompts[0], /【压力面追问】|pressureFocus/)
  assert.match(prompts[1], /考察角度为 evidence/)
  assert.match(prompts[1], /反例（counterexample）或实际约束（constraint）/)
  assert.match(prompts[1], /固定流量对比/)
  assert.match(prompts[1], /引文仅供校验/)
  assert.doesNotMatch(prompts[1], /回答已经清楚时进入下一道主问/)
  assert.doesNotMatch(prompts[2], /【压力面追问】|pressureFocus/)
  assert.doesNotMatch(prompts[1], /answerSatisfactory/)
  assert.match(prompts[3], /【评估本轮回答】/)
  assert.match(prompts[3], /评估独立于 action/)
  assert.match(prompts[3], /"answerSatisfactory":false,"satisfactoryQuote":""/)
  assert.doesNotMatch(prompts[4], /answerSatisfactory/)
  assert.match(prompts[5], /【重新选择追问】.*再怎么验证/)
  assert.match(prompts[5], /对照本场面试记录.*具体反例/)
})

test('追问语义核对提供本场问题和代称上下文，只接受本场问题 ID', async () => {
  const gateway = new ModelGateway()
  const history = [{
    id: 't-original', questionId: 'q-1', text: '你怎么验证这项改动？', answerContext: '我把接口改成并行。',
  }]
  const input = { question: '哪些数据能证明接口变快了？', answer: '我统计了接口耗时。', history }
  let decision = { duplicateId: 't-original', reason: '都追问并行接口效果的依据。' }
  gateway.complete = async (system, prompt) => {
    assert.match(system, /不同主问/)
    assert.match(system, /会改变答案的具体条件/)
    assert.deepEqual(JSON.parse(prompt.split('\n')[1]), { question: input.question, answer: input.answer, previous: history })
    return decision
  }
  assert.equal(await gateway.findDuplicateFollowup(input), 't-original')
  decision = { duplicateId: null, reason: '候选题提出新的条件。' }
  assert.equal(await gateway.findDuplicateFollowup(input), null)
  decision = { duplicateId: 't-other-session' }
  await assert.rejects(gateway.findDuplicateFollowup(input), { code: 'hr-interview/followup-check' })
})

const llmFrom = (outputs, calls) => ({
  stream(options) {
    calls.push(options)
    const output = typeof outputs[0] === 'function' ? outputs.shift() : outputs.shift()
    return (async function* () {
      if (output?.error) { yield { type: 'finish', reason: { kind: 'error', failure: output.error } }; return }
      yield { type: 'text-delta', text: output.text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
})

test('Host model uses the signed-in account and assembles streamed JSON', async () => {
  const calls = []; const llm = llmFrom([{ text: '{"action":"next_question","question":"请开始。"}' }], calls)
  const gateway = new ModelGateway({}, fetch, { llm })
  assert.deepEqual(gateway.capabilities(), { configured: true, model: 'deepseek-flash', baseUrl: 'host:deepseek-account' })
  const result = await gateway.complete('system', 'user')
  assert.equal(result.action, 'next_question'); assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'deepseek-account'); assert.equal(calls[0].reasoningEffort, 'off'); assert.equal(calls[0].messages[0].content[0].text, 'user')
})

test('Host model retries malformed JSON once and surfaces terminal failures', async () => {
  const calls = []; const llm = llmFrom([{ text: 'not-json' }, { text: '```json\n{"ok":true}\n```' }], calls)
  const gateway = new ModelGateway({}, fetch, { llm })
  assert.deepEqual(await gateway.complete('system', 'user'), { ok: true }); assert.equal(calls.length, 2)
  const failed = new ModelGateway({}, fetch, { llm: llmFrom([{ error: { code: 'RATE_LIMIT', message: 'busy' } }], []) })
  await assert.rejects(failed.complete('system', 'user'), (error) => error.code === 'RATE_LIMIT' && error.message === 'busy')
})

test('planned prompts expose only public question metadata and use canonical actions', async () => {
  const calls = []
  const llm = llmFrom([{ text: '{"action":"next_question","question":"请说明工具超时治理。"}' }], calls)
  const gateway = new ModelGateway({}, fetch, { llm })
  await gateway.next({
    session: { mainQuestionCount: 0, followupCount: 0, followupLimit: 2, questionBudget: 4 },
    turns: [], knowledge: [],
    materials: { role: 'Agent 工程师', resume: 'MCP 工具调用', jd: 'Agent 工程化', projectNotes: '' },
    planContext: { current: null, next: { id: 'bank-tool', topic: 'tools', kind: 'principle', question: '工具超时怎么办？', expectedPoints: ['隐藏答案点'], followups: ['隐藏追问'], sourceUrl: 'https://example.invalid/private' } },
  })
  const prompt = calls[0].messages[0].content[0].text
  assert.match(prompt, /工具超时怎么办？/)
  assert.match(prompt, /action=next_question/)
  assert.match(prompt, /wrap_up/)
  assert.doesNotMatch(prompt, /隐藏答案点|隐藏追问|example\.invalid|action=next\s|wrapup/)
})
