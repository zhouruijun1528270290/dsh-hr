import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HRInterviewService } from '../lib/service.js'
import { InterviewStore } from '../lib/store.js'
import { parsePreparationOptions, parseStartOptions } from '../lib/contract.js'
import { createRoleResearch } from '../lib/role-research.js'

const materials = (overrides = {}) => ({
  role: 'Agent 应用开发工程师',
  resume: '张三\n负责 Agent 平台，使用 MCP 接入工具，并通过 RAG 改进知识检索。',
  jd: '负责 AI Agent、MCP 工具调用、RAG 和工程化落地，要求具备评估与故障排查经验。',
  projectNotes: '解决过工具超时、重试和上下文压缩问题。',
  ...overrides,
})
const speech = { capabilities: () => ({}), currentCapabilities: async () => ({}) }
const options = (preparationId = null) => ({ mode: 'standard', persona: 'professional', durationMinutes: 15, inputMode: 'text', preparationId })
const modelWith = (next) => ({ calls: [], capabilities: () => ({ configured: true }), async next(context) { this.calls.push(context); return next(context, this.calls.length) } })
const baseDecision = (action, question) => ({ action, question, expectedPoints: ['模型补充要点'], sourceRefs: ['material:resume'], knowledgePointId: 'model-kp', questionVariant: 'integration', reason: 'test' })
async function fixture(t, model, extras = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hr-preparation-'))
  const store = new InterviewStore(root)
  const service = new HRInterviewService({ store, model, speech, ...extras })
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  await store.saveMaterials(materials())
  return { root, store, service }
}

const directionSlots = (plan) => plan.items.map(({ duty, opening, alternate }) => [duty, opening, alternate])
const mainDirections = (plan) => plan.items.filter(({ opening, alternate }) => !opening && !alternate).map(({ duty }) => duty)

test('Agent 换题保留所有席位，换方向后重开仍按新提纲换题', async (t) => {
  const { store, service } = await fixture(t, null, { roleResearch: createRoleResearch(async () => new Map()) })
  await store.saveMaterials(materials({ jd: '111' }))
  const initial = await service.prepareInterview({ durationMinutes: 30 })
  const swapped = await service.prepareInterview({ durationMinutes: 30, refresh: true })
  assert.deepEqual(directionSlots(swapped), directionSlots(initial))
  assert.ok(swapped.refresh.mainChanged > 0)
  const switched = await service.prepareInterview(parsePreparationOptions({ durationMinutes: 30, changeDirections: true }))
  assert.equal(switched.directionRefresh.changed, 3)
  assert.equal(mainDirections(switched).filter((duty) => !mainDirections(swapped).includes(duty)).length, 3)
  assert.equal(switched.items[0].bankItemId, initial.items[0].bankItemId)
  const loaded = await service.latestPreparation({ durationMinutes: 30 })
  assert.equal(loaded.preparationId, switched.preparationId)
  const afterReload = await service.prepareInterview({ durationMinutes: 30, refresh: true })
  assert.deepEqual(directionSlots(afterReload), directionSlots(loaded))
  const next = await service.prepareInterview({ durationMinutes: 30, changeDirections: true })
  assert.equal(next.directionRefresh.changed, 3)
  const newDirections = mainDirections(next).filter((duty) => !mainDirections(afterReload).includes(duty))
  assert.ok(newDirections.every((duty) => !mainDirections(initial).includes(duty)))
  assert.equal((await store.materials()).jd, '111')
})

test('短剧编剧按当前 JD 轮换方向，单职责时保留同一份提纲', async (t) => {
  const researchCalls = []
  const provider = async ({ role, duties }) => {
    researchCalls.push({ role, duties })
    return new Map(duties.map((duty) => [duty, { simulationQuestions: [`实际遇到需要${duty}的情况，你会怎么开始？`] }]))
  }
  const { store, service } = await fixture(t, null, { roleResearch: createRoleResearch(provider) })
  const jd = '评估短剧选题；设计人物关系；编写分集大纲；修改场景台词；根据反馈修订剧本；控制拍摄成本；跟踪连载留存。'
  await store.saveMaterials(materials({ role: '短剧编剧', jd }))
  const before = await service.prepareInterview({ durationMinutes: 30 })
  const after = await service.prepareInterview({ durationMinutes: 30, changeDirections: true })
  assert.equal(after.directionRefresh.changed, 1)
  assert.ok(mainDirections(after).every((duty) => jd.includes(duty)))
  assert.equal(mainDirections(after).filter((duty) => !mainDirections(before).includes(duty)).length, 1)
  assert.ok(mainDirections(after).includes('跟踪连载留存'))
  assert.ok(after.items.every(({ basis, sourceRefs }) => basis === 'simulation' && sourceRefs.length === 0))
  assert.equal((await store.materials()).jd, jd)

  await store.saveMaterials(materials({ role: '食品质检员', jd: '核对原料来料的批次标签。' }))
  const narrow = await service.prepareInterview({ durationMinutes: 15 })
  const count = researchCalls.length
  const kept = await service.prepareInterview({ durationMinutes: 15, changeDirections: true })
  assert.equal(kept.directionRefresh.changed, 0)
  assert.equal(kept.preparationId, narrow.preparationId)
  assert.equal(researchCalls.length, count)
})

test('项目介绍后进入旧 RAG 排查题时，以假设情景提问', async (t) => {
  const { store, service } = await fixture(t, modelWith(() => ({ action: 'next_question' })), { roleResearch: createRoleResearch(async () => new Map()) })
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const bank = await service.getMarketBank()
  const current = (await bank.listActive({ rolePack: 'agent', topic: 'rag' })).find(({ id }) => id === 'rag-layer-attribution')
  assert.match(current.question, /^假设一个 RAG 系统给出了错误答案/)
  const legacy = await store.savePreparation({ ...prepared, preparationId: 'prep-legacy-rag-scenario', items: [
    prepared.items[0],
    { ...prepared.items[1], bankItemId: current.id, topic: 'rag', duty: 'rag', contextRequirement: null, question: '答案错了，你怎么判断问题出在切分、召回、重排还是生成？请给出可执行的定位步骤。' },
    ...prepared.items.slice(2),
  ] })
  assert.equal((await store.getPreparation(legacy.preparationId)).items[1].question, current.question)
  const started = await service.start(options(legacy.preparationId))
  // Simulate a session whose frozen outline was created before the upgrade.
  await store.saveSession({ ...started.session, preparation: legacy }, started.turns)
  const result = await service.submitText(started.session.sessionId, '我以前做过一个文档搜索项目，我负责整理需求和接口。')
  assert.equal(result.turns.at(-1).text, current.question)
  assert.equal(result.turns.at(-1).bankItemId, current.id)
  assert.equal(result.turns.at(-1).kind, 'main_question')
  assert.deepEqual(result.turns[0], started.turns[0])
})

test('标准面与压力面出旧题时，朗读与题干使用同一份澄清措辞', async (t) => {
  const spoken = []
  const speechWithCapture = { ...speech, async synthesize(text) { spoken.push(text); return { audioBase64: 'WAV=', mimeType: 'audio/wav' } } }
  const { store, service } = await fixture(t, modelWith((_, count) => count % 2 === 1 ? { action: 'next_question' } :
    { action: 'followup', answerQuote: '对比召回结果', question: '你会怎么选一组用于验证的样本？' }),
    { roleResearch: createRoleResearch(async () => new Map()), speech: speechWithCapture })
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const legacy = await store.savePreparation({ ...prepared, preparationId: 'prep-legacy-recall-evaluation', items: [
    prepared.items[0],
    { ...prepared.items[1], bankItemId: 'rag-recall-up-accuracy-down', basis: 'local', duty: 'rag', contextRequirement: 'project',
      question: '召回率提高了，最终答案准确率反而下降：讲一次你遇到的真实情况，根因和修复是什么？' },
    ...prepared.items.slice(2),
  ] })
  for (const persona of ['professional', 'pressure']) {
    const started = await service.start({ ...options(legacy.preparationId), persona })
    await store.saveSession({ ...started.session, preparation: legacy }, started.turns)
    const next = await service.submitText(started.session.sessionId, '我做过一个用于查文档的系统，我负责检索部分。')
    const turn = next.turns.at(-1)
    assert.match(turn.text, /^假设一个 RAG 系统的检索召回率提高了/)
    assert.equal(turn.kind, 'main_question')
    assert.equal(turn.contextRequirement, undefined)
    await service.speak(started.session.sessionId, turn.id)
    assert.equal(spoken.at(-1), turn.text)
    const followup = await service.submitText(started.session.sessionId, '我会先对比召回结果，确认是不是加入了太多不相关段落。')
    assert.equal(followup.turns.at(-1).kind, 'followup')
    assert.equal(followup.turns.at(-1).questionId, turn.questionId)
    assert.match(followup.turns.at(-1).text, /用于验证的样本/)
  }
})

test('前提不明的旧题在同一席位替换为模拟题，原始提纲仍可供核对', async (t) => {
  const { store, service } = await fixture(t, modelWith(() => ({ action: 'next_question' })), { roleResearch: createRoleResearch(async () => new Map()) })
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const unresolved = '这个 bug 的根因用一句话说是什么？为什么本地一定复现不了？'
  const legacy = await store.savePreparation({ ...prepared, preparationId: 'prep-legacy-missing-context', items: [
    prepared.items[0], { ...prepared.items[1], question: unresolved, basis: 'local', duty: 'rag' }, ...prepared.items.slice(2),
  ] })
  const view = await store.getPreparation(legacy.preparationId)
  assert.equal(view.items[1].duty, 'rag')
  assert.equal(view.items[1].basis, 'simulation')
  assert.match(view.items[1].question, /^假设你接手一项与「RAG 检索」相关的任务/)
  assert.deepEqual(view.items[1].sourceRefs, [])
  const saved = JSON.parse(await readFile(store.preparationPath(legacy.preparationId), 'utf8'))
  assert.equal(saved.items[1].question, unresolved)
})

test('项目介绍后先确认迭代，得到肯定答复才追问新版效果', async (t) => {
  const model = modelWith(() => ({ action: 'next_question' }))
  const research = createRoleResearch(async () => new Map())
  const { store, service } = await fixture(t, model, { roleResearch: research })
  await store.saveMaterials(materials({ jd: '证明 Agent 比上一版好' }))
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(prepared.items[0].opening, true)
  assert.equal(prepared.items[1].bankItemId, 'agent-project-evaluation')
  assert.equal(prepared.items[1].contextRequirement, 'iteration')

  for (const reply of ['有，我把单工具路由改成了按任务类型分流，还没有上线。', '没有做过版本对比。', '有，不过不确定这算不算版本迭代。']) {
    const started = await service.start(options(prepared.preparationId))
    const id = started.session.sessionId
    assert.match(started.turns[0].text, /先介绍一个/)
    assert.doesNotMatch(started.turns[0].text, /新版|评测集|上一版/)
    const check = await service.submitText(id, '我做过一个文档检索 Agent，主要负责路由和工具集成。')
    assert.equal(check.turns.at(-1).questionStage, 'context-check')
    assert.match(check.turns.at(-1).text, /有没有做过一次你参与的版本迭代/)
    assert.doesNotMatch(check.turns.at(-1).text, /新版做得更好/)
    const checked = await service.submitText(id, reply)
    const question = checked.turns.at(-1)
    assert.equal(question.kind, 'followup')
    assert.equal(question.questionId, check.turns.at(-1).questionId)
    assert.equal(checked.session.mainQuestionCount, 2)
    if (reply.startsWith('有，我')) {
      assert.equal(question.questionStage, 'context-probe')
      assert.match(question.text, /新版做得更好/)
    } else {
      assert.equal(question.questionStage, 'context-scenario')
      assert.equal(question.questionBasis, 'simulation')
      assert.doesNotMatch(question.text, /你刚才|新版|上一版/)
    }
  }

  const skipped = await service.start(options(prepared.preparationId))
  const next = await service.control(skipped.session.sessionId, 'skip')
  assert.equal(next.turns.at(-1).questionStage, 'context-scenario')
  assert.doesNotMatch(next.turns.at(-1).text, /你刚才|新版|上一版/)
  assert.equal(model.calls.length, 3)
  assert.ok(model.calls.every(({ planContext }) => planContext.current.stage === 'project-introduction'))
})

test('项目实现题先确认岗位相关经历，旧提纲需刷新才能入场', async (t) => {
  const model = modelWith(() => ({ action: 'next_question' }))
  const { store, service } = await fixture(t, model, { roleResearch: createRoleResearch(async () => new Map()) })
  await store.saveMaterials(materials({ jd: 'MCP 解决了什么用普通 API 或 Function Calling 解决不了的问题' }))
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const old = await store.savePreparation({ ...prepared, questionSequenceVersion: undefined, preparationId: 'prep-old-outline', createdAt: new Date().toISOString() })
  await assert.rejects(service.start(options(old.preparationId)), (error) => error.code === 'hr-interview/preparation-stale')
  const current = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(current.items[1].contextRequirement, 'project')

  const started = await service.start(options(current.preparationId))
  const id = started.session.sessionId
  const check = await service.submitText(id, '做的是内部知识检索，主要负责文档索引。')
  assert.equal(check.turns.at(-1).questionStage, 'context-check')
  const answered = await service.submitText(id, '我没有做过 MCP 工具集成，只用过普通接口。')
  assert.equal(answered.turns.at(-1).questionStage, 'context-scenario')
  assert.match(answered.turns.at(-1).text, /^假设/)
  assert.doesNotMatch(answered.turns.at(-1).text, /你项目里的/)
  assert.equal(model.calls.length, 1)
})

test('语音项目介绍按刚转写的内容追问，主问进度随后继续推进', async (t) => {
  const answer = '我做了文档检索，负责把长文档按章节切分，再根据检索结果补充索引。'
  const quote = '把长文档按章节切分'
  const model = modelWith(({ turns, planContext }, call) => {
    if (call !== 1) return { action: 'next_question' }
    assert.equal(planContext.current.stage, 'project-introduction')
    assert.equal(turns.at(-1).text, answer)
    return { action: 'followup', answerQuote: quote, question: '遇到没有标题的长文档，你会怎么调整切分规则？' }
  })
  const { store, service } = await fixture(t, model, {
    roleResearch: createRoleResearch(async () => new Map()),
    speech: { ...speech, async transcribe() { return { model: 'test-asr', text: answer } } },
  })
  await store.saveMaterials(materials({ jd: '证明 Agent 比上一版好' }))
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const opened = await service.start({ ...options(prepared.preparationId), inputMode: 'voice' })
  const id = opened.session.sessionId
  const heard = await service.submitAudio(id, { audioBase64: 'AA==', mimeType: 'audio/wav', durationMs: 1200 })
  const followup = heard.turns.at(-1)
  assert.equal(heard.session.mainQuestionCount, 1)
  assert.equal(heard.turns.at(-2).asrMeta.model, 'test-asr')
  assert.equal(followup.questionBasis, 'answer')
  assert.equal(followup.questionId, opened.turns[0].questionId)
  assert.ok(followup.text.includes(quote))
  assert.match(followup.text, /没有标题/)
  const next = await service.submitText(id, '我会依据结构和语义边界，再验证检索召回。')
  assert.equal(next.turns.at(-1).questionStage, 'context-check')
  assert.equal(next.session.mainQuestionCount, 2)
  assert.equal(model.calls.length, 1)
})

test('压力面明确答不上时只补问验证起点，反应有限度，标准面按原节奏处理', async (t) => {
  const model = modelWith(() => ({ action: 'next_question' }))
  const { service } = await fixture(t, model, {
    roleResearch: createRoleResearch(async () => new Map()),
    speech: { ...speech, async transcribe() { return { model: 'test-asr', text: '我也忘记了。' } } },
  })
  const plan = await service.prepareInterview({ durationMinutes: 30 })
  const settings = { ...options(plan.preparationId), durationMinutes: 30 }
  const opened = await service.start(parseStartOptions({ ...settings, inputMode: 'voice', mode: 'pressure' }))
  assert.equal(opened.session.mode, 'mock')
  assert.equal(opened.session.persona, 'pressure')
  const id = opened.session.sessionId
  let bundle = opened
  for (const [cue, reply] of [['pause', null], ['questioning', '不知道哎，不知道'], ['sigh', '我不知道什么是 HITCO。']]) {
    const current = bundle.turns.at(-1)
    const recovered = reply ? await service.submitText(id, reply)
      : await service.submitAudio(id, { audioBase64: 'AA==', mimeType: 'audio/wav', durationMs: 1000 })
    assert.equal(recovered.turns.at(-1).pressureCue, cue)
    assert.equal(recovered.turns.at(-1).pressureFocus, 'recovery')
    assert.equal(recovered.session.pressureBlackFace, cue !== 'pause')
    assert.equal(recovered.turns.at(-1).questionId, current.questionId)
    assert.match(recovered.turns.at(-1).text, /验证|先查/)
    bundle = await service.submitText(id, '我不知道。')
    assert.equal(bundle.turns.at(-1).kind, 'main_question')
    assert.equal(bundle.turns.at(-1).pressureCue, 'firm')
    assert.match(bundle.turns.at(-1).text, /^(?:这个点先放一放|这题先到这里|换个问题)/)
    assert.doesNotMatch(bundle.turns.at(-1).text, /你刚才介绍的经历|上述经历|agent-core|mcp-tools/)
  }
  assert.equal(model.calls.length, 0, '明确不会与恢复后的推进都能确定性处理')
  const skipped = await service.control(id, 'skip')
  assert.notEqual(skipped.turns.at(-1).pressureFocus, 'recovery')
  assert.equal(skipped.session.pressureBlackFace, true)
  const ambivalent = await service.submitText(id, '我不知道确切数字，但我会按发布日期对比采样结果。')
  assert.notEqual(ambivalent.turns.at(-1).pressureFocus, 'recovery')
  const standard = await service.start(parseStartOptions(settings))
  const ordinary = await service.submitText(standard.session.sessionId, '这道题我答不上。')
  assert.equal(ordinary.turns.at(-1).kind, 'main_question')
  assert.equal(ordinary.session.pressureBlackFace, undefined)
  assert.ok(ordinary.turns.every((turn) => !turn.pressureCue))
})

test('压力面黑脸持续到本轮回答有实质依据，追问额度用完也会评估', async (t) => {
  const model = modelWith(({ assessPressureAnswer, session, turns }) => {
    assert.equal(assessPressureAnswer, true)
    assert.equal(session.pressureBlackFace, true)
    const answer = turns.at(-1).text
    if (answer.includes('时间戳比较')) {
      assert.equal(session.followupCount, session.followupLimit)
      return { action: 'followup', question: '确认了吗？', answerSatisfactory: true, satisfactoryQuote: '请求的时间戳比较' }
    }
    return {
      action: 'followup', answerQuote: '看请求情况', question: '你会看哪一项日志字段来定位问题？',
      answerSatisfactory: true, satisfactoryQuote: '这段引文不在本轮回答里',
    }
  })
  const { store, service } = await fixture(t, model, { roleResearch: createRoleResearch(async () => new Map()) })
  const plan = await service.prepareInterview({ durationMinutes: 30 })
  const opened = await service.start(parseStartOptions({ ...options(plan.preparationId), durationMinutes: 30, mode: 'pressure' }))
  const id = opened.session.sessionId
  await service.submitText(id, '我不知道。')
  await service.submitText(id, '我不知道。')
  const blackFace = await service.submitText(id, '我不知道。')
  assert.equal(blackFace.session.pressureBlackFace, true)
  await service.control(id, 'pause')
  assert.equal((await service.control(id, 'resume')).session.pressureBlackFace, true)
  const vague = await service.submitText(id, '我会先看请求情况，具体待定。')
  assert.equal(vague.session.pressureBlackFace, true)
  assert.equal(vague.turns.at(-1).kind, 'followup')
  const satisfied = await service.submitText(id, '把请求的时间戳比较一下，定位哪一步突然变慢。')
  assert.equal(satisfied.session.pressureBlackFace, false)
  assert.equal(satisfied.turns.at(-1).kind, 'main_question')
  assert.equal((await store.get(id)).session.pressureBlackFace, false)
  assert.equal(model.calls.length, 2)
})

test('压力面追问以本轮回答为依据，考验对照证据和实际约束', async (t) => {
  const model = modelWith(({ turns, session }) => {
    assert.equal(session.persona, 'pressure')
    const last = turns.at(-1).text
    if (last.includes('关键词检索')) return { action: 'next_question' }
    if (last.includes('测了接口 P99')) return {
      action: 'followup', pressureFocus: 'evidence', answerQuote: '测了接口 P99',
      question: '你刚才提到「测了接口 P99」。给出具体对照。你怎么排除流量变化对延迟的影响？',
    }
    return { action: 'followup', pressureFocus: 'constraint', answerQuote: '用相同流量回放',
      question: '根据你的上述经历，假设不能回放真实请求，你会用什么办法构造可比样本？' }
  })
  const { store, service } = await fixture(t, model, { roleResearch: createRoleResearch(async () => new Map()) })
  await store.saveMaterials(materials({ jd: '证明 Agent 比上一版好' }))
  const plan = await service.prepareInterview({ durationMinutes: 15 })
  const settings = parseStartOptions({ ...options(plan.preparationId), mode: 'pressure' })
  const opened = await service.start(settings)
  const id = opened.session.sessionId
  await service.submitText(id, '我负责关键词检索的请求路由。')
  const probe = await service.submitText(id, '有，我把默认检索方式改成了动态路由。')
  assert.equal(probe.turns.at(-1).questionStage, 'context-probe')
  const evidence = await service.submitText(id, '我测了接口 P99，动态路由的延迟下降了。')
  assert.equal(evidence.turns.at(-1).pressureFocus, 'evidence')
  assert.match(evidence.turns.at(-1).text, /给出具体对照/)
  assert.doesNotMatch(evidence.turns.at(-1).text, /你刚才提到|测了接口 P99/)

  // Use a fresh main question to verify the two-stage pressure sequence within its budget.
  const ordinary = await service.start(settings)
  await service.control(ordinary.session.sessionId, 'skip')
  const compared = await service.submitText(ordinary.session.sessionId, '我测了接口 P99，动态路由的延迟下降了。')
  assert.equal(compared.turns.at(-1).pressureFocus, 'evidence')
  const constraint = await service.submitText(ordinary.session.sessionId, '我用相同流量回放，分别测两组延迟。')
  assert.equal(constraint.turns.at(-1).pressureFocus, 'constraint')
  assert.equal(constraint.turns.at(-1).questionId, compared.turns.at(-1).questionId)
  assert.match(constraint.turns.at(-1).text, /^假设不能回放/)
  assert.doesNotMatch(constraint.turns.at(-1).text, /根据你的上述经历|用相同流量回放/)
})

test('同提纲同回答对照：压力面开场要求证据，标准面首追后推进，压力面继续检验反例', async (t) => {
  const comparison = '我用固定的一组请求做了对照。'
  const model = modelWith(({ turns, reviseFollowup }) => reviseFollowup
    ? { action: 'followup', pressureFocus: 'counterexample', answerQuote: '一组请求做了对照',
        question: '假设这批请求只有低并发样本，高并发时出现什么现象会推翻你对并行路由的判断？' }
    : turns.at(-1).text === comparison
    ? { action: 'followup', pressureFocus: 'evidence', answerQuote: '一组请求做了对照', question: '再说一下你怎么验证的？' }
    : { action: 'followup', pressureFocus: 'evidence', answerQuote: '把路由改成并行', question: '拿什么结果验证了这个改动？' })
  const { service } = await fixture(t, model, { roleResearch: createRoleResearch(async () => new Map()) })
  const plan = await service.prepareInterview({ durationMinutes: 15 })
  const run = async (mode) => {
    const opened = await service.start(parseStartOptions({ ...options(plan.preparationId), mode }))
    const id = opened.session.sessionId
    await service.submitText(id, '我负责文档检索，后来把路由改成并行，降低了延迟。')
    return service.submitText(id, comparison)
  }
  const standard = await run('standard')
  const pressure = await run('pressure')
  assert.match(standard.turns[0].text, /^先介绍/)
  assert.match(pressure.turns[0].text, /亲自做的一个决定.*判断这个决定是否有效/)
  assert.equal(standard.turns[0].planItemId, pressure.turns[0].planItemId)
  assert.equal(standard.turns.at(-1).kind, 'main_question')
  assert.equal(standard.session.mainQuestionCount, 2)
  assert.deepEqual(pressure.turns.filter((turn) => turn.kind === 'followup').map((turn) => turn.pressureFocus), ['evidence', 'counterexample'])
  assert.equal(pressure.turns.at(-1).questionId, pressure.turns[0].questionId)
  assert.match(pressure.turns.at(-1).text, /高并发.*并行路由/)
  assert.doesNotMatch(pressure.turns.at(-1).text, /一组请求|再说一下/)

  const opened = await service.start(parseStartOptions({ ...options(plan.preparationId), mode: 'pressure' }))
  const id = opened.session.sessionId
  const recovery = await service.submitText(id, '这题我记不太清。')
  assert.equal(recovery.turns.at(-1).pressureFocus, 'recovery')
  const recovered = await service.submitText(id, '我先看请求记录，确认是否把路由改成并行。')
  assert.equal(recovered.turns.at(-1).questionStage, 'answer-followup')
  assert.equal(recovered.turns.at(-1).questionId, recovery.turns.at(-1).questionId)
})

test('压力面的两道主问候选追问相同时，只重选一次，仍重复就进入下一道题', async (t) => {
  const repeated = '假设同样的流量下延迟反而增加，你会先查哪一步？'
  const comparisons = ['我用固定流量对照结果。', '我用固定流量复核响应。']
  const model = modelWith(({ turns, reviseFollowup }) => {
    const answer = turns.at(-1).text
    const comparison = comparisons.indexOf(answer)
    if (comparison >= 0) return {
      action: 'followup', pressureFocus: 'constraint', answerQuote: '我用固定流量',
      question: comparison === 0 ? repeated : '假设同样的流量下延迟反而增加，你会先查哪一步!',
    }
    assert.equal(reviseFollowup, undefined)
    return { action: 'followup', pressureFocus: 'evidence', answerQuote: answer,
      question: answer.includes('检索') ? '检索改动之后你怎么验证延迟？' : '你怎么核对上游接口的延迟？' }
  })
  const { store, service } = await fixture(t, model, { roleResearch: createRoleResearch(async () => new Map()) })
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const plan = await store.savePreparation({ ...prepared, preparationId: 'prep-pressure-duplicate-followup', items: [
    prepared.items[0],
    { ...prepared.items[1], question: '假设接口调用变慢，你会怎么查？', contextRequirement: null },
    ...prepared.items.slice(2),
  ] })
  const opened = await service.start(parseStartOptions({ ...options(plan.preparationId), mode: 'pressure' }))
  const id = opened.session.sessionId
  await service.submitText(id, '我给检索加了缓存。')
  const first = await service.submitText(id, comparisons[0])
  assert.equal(first.turns.at(-1).text, repeated)
  await service.submitText(id, '我会先查缓存是否命中。')
  await service.submitText(id, '我用日志对比上游接口。')
  const advanced = await service.submitText(id, comparisons[1])
  assert.equal(advanced.turns.at(-1).kind, 'main_question')
  assert.equal(advanced.session.mainQuestionCount, 3)
  assert.equal(advanced.turns.filter((turn) => turn.speaker === 'hr' && turn.text.includes('假设同样的流量下')).length, 1)
  assert.equal(model.calls.filter((context) => context.reviseFollowup).length, 1)
})

test('动态追问核对同题和跨题同义问法，允许有实质新条件的重写', async (t) => {
  const first = '你用什么数据证明接口延迟降低了？'
  const sameTopic = '什么指标能说明接口变快了？'
  const crossTopic = '用哪个数值能判断这个接口耗时下降了？'
  const repeatedRewrite = '接口变快的证据具体是哪项数据？'
  const newCondition = '如果高并发时 P99 反而上升，你怎么区分连接池排队和重试叠加？'
  const replies = [
    '我把接口的串行请求改成并行。', '我用固定的一组请求对照。', '我先检查连接池排队。',
    '我还是用接口延迟来验证这个改动。',
  ]
  const generated = [first, sameTopic, '', crossTopic]
  const model = modelWith(({ turns, reviseFollowup }) => {
    const answer = turns.at(-1).text
    const index = replies.indexOf(answer)
    assert.ok(index === 0 || index === 1 || index === 3)
    if (reviseFollowup) assert.equal(reviseFollowup.duplicateQuestion, first)
    return {
      action: 'followup', answerQuote: answer,
      pressureFocus: index === 1 ? 'constraint' : 'evidence',
      question: reviseFollowup ? (index === 1 ? newCondition : repeatedRewrite) : generated[index],
    }
  })
  const checks = []
  model.findDuplicateFollowup = async ({ question, history }) => {
    checks.push(question)
    if (question === first) return null
    const original = history.find((turn) => turn.text === first)
    assert.equal(original.questionId, 'q-1')
    assert.equal(original.answerContext, replies[0])
    return question === newCondition ? null : original.id
  }
  const { store, service } = await fixture(t, model, { roleResearch: createRoleResearch(async () => new Map()) })
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const plan = await store.savePreparation({ ...prepared, preparationId: 'prep-pressure-semantic-followup', items: [
    prepared.items[0],
    { ...prepared.items[1], question: '假设要交付一个接口改动，你会怎么检查效果？', contextRequirement: null },
    ...prepared.items.slice(2),
  ] })
  const opened = await service.start(parseStartOptions({ ...options(plan.preparationId), mode: 'pressure' }))
  const id = opened.session.sessionId
  assert.equal((await service.submitText(id, replies[0])).turns.at(-1).text, first)
  const withCondition = await service.submitText(id, replies[1])
  assert.equal(withCondition.turns.at(-1).text, newCondition)
  assert.equal(withCondition.turns.at(-1).questionId, 'q-1')
  await service.submitText(id, replies[2])
  const advanced = await service.submitText(id, replies[3])
  assert.equal(advanced.session.mainQuestionCount, 3)
  assert.equal(advanced.turns.at(-1).kind, 'main_question')
  assert.deepEqual(advanced.turns.filter((turn) => turn.kind === 'followup').map((turn) => turn.text), [first, newCondition])
  assert.deepEqual(checks, [first, sameTopic, newCondition, crossTopic, repeatedRewrite])
  assert.equal(model.calls.filter((context) => context.reviseFollowup).length, 2)
})

test('preparation contract and persistence accept bounded plans without changing session storage', async (t) => {
  assert.deepEqual(parsePreparationOptions(), { durationMinutes: 30, refresh: false })
  assert.deepEqual(parsePreparationOptions({ durationMinutes: 15, refresh: true }), { durationMinutes: 15, refresh: true })
  assert.equal(parseStartOptions({ preparationId: 'prep-abcdefgh' }).preparationId, 'prep-abcdefgh')
  assert.equal(parseStartOptions({}).preparationId, null)
  assert.throws(() => parsePreparationOptions({ durationMinutes: 20 }), (error) => error.code === 'hr-interview/invalid-duration')
  const root = await mkdtemp(join(tmpdir(), 'hr-preparation-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new InterviewStore(root)
  await assert.rejects(store.getPreparation('../materials'), (error) => error.code === 'hr-interview/invalid-preparation-id')
  const saved = await store.savePreparation({ preparationId: 'prep-abcdefgh', profileKey: 'profile', planKey: 'plan', durationMinutes: 15, createdAt: new Date().toISOString(), items: [{ planItemId: 'plan-1' }] })
  assert.equal(saved.preparationId, 'prep-abcdefgh')
  assert.equal((await store.latestPreparation()).planKey, 'plan')
  assert.deepEqual(await readFile(join(root, 'preparations', 'prep-abcdefgh.json'), 'utf8').then(JSON.parse).then((value) => value.items), [{ planItemId: 'plan-1' }])
})

test('prepareInterview is local, deterministic, reusable and sensitive to material/duration changes', async (t) => {
  const model = modelWith(() => { throw new Error('prepare must not call the model') })
  const { root, service } = await fixture(t, model)
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(prepared.items.length, 6)
  assert.deepEqual(prepared.questionBudget, { main: 4, alternates: 2, total: 6 })
  assert.equal(prepared.profileMatches, true)
  assert.equal(prepared.items.filter((item) => !item.alternate).length, 4)
  assert.equal(model.calls.length, 0)
  assert.equal((await service.latestPreparation({ durationMinutes: 15 })).profileMatches, true)
  assert.equal((await service.latestPreparation({ durationMinutes: 30 })).profileMatches, false)
  const prepared30 = await service.prepareInterview({ durationMinutes: 30 })
  assert.equal(prepared30.items.length, 8)
  const reused = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(reused.preparationId, prepared.preparationId)
  const refreshed = await service.prepareInterview({ durationMinutes: 15, refresh: true })
  assert.notEqual(refreshed.preparationId, prepared.preparationId)
  const reused30 = await service.prepareInterview({ durationMinutes: 30 })
  assert.equal(reused30.preparationId, prepared30.preparationId, '15→30→15 后仍应复用较早的匹配30分钟快照')
  assert.equal((await service.latestPreparation({ durationMinutes: 15 })).preparationId, refreshed.preparationId)
  await service.store.saveMaterials(materials({ role: '后端开发工程师' }))
  assert.equal((await service.latestPreparation({ durationMinutes: 15 })).profileMatches, false)
  await access(join(root, 'market.sqlite'))
  await service.close()
})

test('start validates and freezes the selected preparation, then asks with planContext', async (t) => {
  const model = modelWith((context) => baseDecision('next_question', `自然改写：${context.planContext.next.question}`))
  const { store, service } = await fixture(t, model)
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const bundle = await service.start(options(prepared.preparationId))
  assert.equal(bundle.session.questionBudget, 4)
  assert.equal(bundle.session.preparationId, prepared.preparationId)
  assert.equal(bundle.session.preparation.items.length, 6)
  assert.equal(model.calls.length, 1)
  assert.equal(model.calls[0].planContext.current, null)
  assert.equal(model.calls[0].planContext.next.planItemId, 'plan-1')
  const turn = bundle.turns[0]
  assert.equal(turn.planItemId, 'plan-1')
  assert.equal(turn.bankItemId, prepared.items[0].bankItemId)
  assert.equal(turn.knowledgePointId, `kp-${prepared.items[0].bankItemId}`)
  assert.ok(turn.planSourceRefs.length > 0)
  assert.ok(turn.expectedPoints.includes('模型补充要点'))
  assert.ok(turn.expectedPoints.includes(prepared.items[0].expectedPoints[0]))
  const persisted = await store.get(bundle.session.sessionId)
  assert.equal(persisted.session.preparation.planKey, prepared.planKey)
  await service.close()
})

test('followup inherits the current plan item and the next main question advances exactly once', async (t) => {
  const model = modelWith((context, count) => {
    const action = count === 2 ? 'followup' : 'next_question'
    const item = action === 'followup' ? context.planContext.current : context.planContext.next
    return baseDecision(action, `${action}:${item.question}`)
  })
  const { service } = await fixture(t, model)
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  const started = await service.start(options(prepared.preparationId))
  const id = started.session.sessionId
  const followup = await service.submitText(id, '我负责工具路由、超时控制，并记录每次调用的追踪信息。')
  assert.equal(followup.turns.at(-1).kind, 'followup')
  assert.equal(followup.turns.at(-1).planItemId, 'plan-1')
  assert.equal(followup.session.mainQuestionCount, 1)
  assert.equal(followup.session.followupCount, 1)
  assert.equal(model.calls[1].planContext.current.planItemId, 'plan-1')
  assert.equal(model.calls[1].planContext.next.planItemId, 'plan-2')
  const next = await service.submitText(id, '我们为工具设置超时、幂等键和有限重试，并保留失败现场。')
  assert.equal(next.turns.at(-1).kind, 'main_question')
  assert.equal(next.turns.at(-1).planItemId, 'plan-2')
  assert.equal(next.session.mainQuestionCount, 2)
  assert.equal(next.session.followupCount, 0)
  await service.close()
})

test('stale or missing preparation is rejected before any session or model request is created', async (t) => {
  const model = modelWith(() => baseDecision('next_question', '不应被调用'))
  const { service } = await fixture(t, model)
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  await service.store.saveMaterials(materials({ jd: `${materials().jd}\n新增要求：需要向量数据库经验。` }))
  await assert.rejects(service.start(options(prepared.preparationId)), (error) => error.code === 'hr-interview/preparation-stale')
  assert.deepEqual(await service.store.list(), [])
  assert.equal(model.calls.length, 0)
  await assert.rejects(service.start(options('prep-abcdefgh')), (error) => error.code === 'hr-interview/preparation-not-ready')
  assert.deepEqual(await service.store.list(), [])
  assert.equal(model.calls.length, 0)
  await service.close()
})

test('legacy dynamic start remains independent of preparation and does not create a market database', async (t) => {
  const model = modelWith(() => baseDecision('next_question', '旧动态模式问题'))
  const { root, service } = await fixture(t, model)
  const bundle = await service.start(options())
  assert.equal(bundle.session.questionBudget, 4)
  assert.equal(bundle.session.preparation, undefined)
  assert.equal(bundle.turns[0].planItemId, undefined)
  assert.equal(model.calls[0].planContext, null)
  await assert.rejects(access(join(root, 'market.sqlite')))
  await service.close()
})

test('market bank initialization failure releases the temporary bank and retries cleanly', async (t) => {
  let attempts = 0
  let closes = 0
  const marketBankFactory = async () => ({
    async init() { attempts += 1; if (attempts === 1) throw new Error('temporary database failure') },
    async close() { closes += 1 },
  })
  const { service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')), { marketBankFactory })
  await assert.rejects(service.getMarketBank(), /temporary database failure/)
  assert.equal(service.marketBank, null)
  assert.equal(closes, 1)
  const bank = await service.getMarketBank()
  assert.equal(await service.getMarketBank(), bank)
  assert.equal(attempts, 2)
  assert.equal(closes, 1)
})

test('start rejects a damaged zero-main preparation before creating a session', async (t) => {
  const model = modelWith(() => baseDecision('next_question', '不应调用'))
  const { store, service } = await fixture(t, model)
  await store.savePreparation({ preparationId: 'prep-main-zero', profileKey: 'damaged', planKey: 'damaged', durationMinutes: 15, createdAt: new Date().toISOString(), questionBudget: { main: 0, alternates: 1, total: 1 }, items: [{ planItemId: 'plan-1', alternate: false }] })
  await assert.rejects(service.start(options('prep-main-zero')), (error) => error.code === 'hr-interview/preparation-not-ready')
  assert.deepEqual(await store.list(), [])
  assert.equal(model.calls.length, 0)
})

test('source settings validate a local directory and pass it only to the bank factory', async (t) => {
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')))
  const msyDir = join(root, 'msy')
  await mkdir(join(msyDir, 'data'), { recursive: true })
  await writeFile(join(msyDir, 'data', 'questions.ndjson'), '{}\n')
  // 本组只验证目录设置/版本，不复测连接器语法；连接器有独立有效/坏行用例。
  service.inspectMsyDirectory = async () => ({ agentQuestions: 0, resumeQuestions: 0 })
  await assert.rejects(service.saveSourceSettings({ msyDir: 'relative/msy' }), (error) => error.code === 'hr-interview/invalid-source-dir')
  const seen = []
  let closes = 0
  service.marketBankFactory = async ({ msyDir: value }) => { seen.push(value); return { async init() { return this }, async close() { closes += 1 } } }
  const saved = await service.saveSourceSettings({ msyDir })
  assert.equal(saved.configured, true)
  assert.equal((await service.sourceSettings()).msyDir, msyDir)
  await service.getMarketBank()
  assert.deepEqual(seen, [msyDir])
  const cleared = await service.saveSourceSettings({ msyDir: '' })
  assert.equal(cleared.configured, false)
  assert.equal(closes, 1)
  await service.getMarketBank()
  assert.deepEqual(seen, [msyDir, ''])
})

test('preparation stores bounded source summaries and settings revision without leaking the source path', async (t) => {
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')))
  const msyDir = join(root, 'msy')
  await mkdir(join(msyDir, 'data'), { recursive: true })
  await writeFile(join(msyDir, 'data', 'questions.ndjson'), '{}\n')
  // 本组只验证目录设置/版本，不复测连接器语法；连接器有独立有效/坏行用例。
  service.inspectMsyDirectory = async () => ({ agentQuestions: 0, resumeQuestions: 0 })
  await service.saveSourceSettings({ msyDir })
  const settings = await service.sourceSettings()
  const seed = JSON.parse(await readFile(new URL('../lib/data/market-question-bank.json', import.meta.url), 'utf8')).items
  service.marketBankFactory = async () => ({
    async init() { return this }, async close() {},
    async listActive() { return seed },
    async stats() { return { sources: { msyQuestions: { status: 'ok', imported: 372, scanned: 11184, invalid: 0, skippedOffTopic: 10812, withAnswer: 23 }, msyResume: { status: 'ok', imported: 39 } }, warnings: ['简历题格式部分降级'] } },
  })
  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(prepared.sources.msyQuestions.imported, 372)
  assert.equal(prepared.sources.msyResume.imported, 39)
  assert.deepEqual(prepared.warnings, ['简历题格式部分降级'])
  assert.equal(prepared.sourceSettingsUpdatedAt, settings.updatedAt)
  assert.equal(JSON.stringify(prepared).includes(msyDir), false)
  const reused = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(reused.preparationId, prepared.preparationId)
})

test('prepare does not reuse an outline with a stale source settings revision', async (t) => {
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')))
  const seed = JSON.parse(await readFile(new URL('../lib/data/market-question-bank.json', import.meta.url), 'utf8')).items
  service.marketBankFactory = async () => ({
    async init() { return this }, async close() {},
    async listActive() { return seed },
    async stats() { return { sources: { seed: 46 }, warnings: [] } },
  })
  const first = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(first.sourceSettingsUpdatedAt, null)
  const msyDir = join(root, 'msy')
  await mkdir(join(msyDir, 'data'), { recursive: true })
  await writeFile(join(msyDir, 'data', 'questions.ndjson'), '{}\n')
  // 本组只验证目录设置/版本，不复测连接器语法；连接器有独立有效/坏行用例。
  service.inspectMsyDirectory = async () => ({ agentQuestions: 0, resumeQuestions: 0 })
  await service.saveSourceSettings({ msyDir })
  const settings = await service.sourceSettings()
  const second = await service.prepareInterview({ durationMinutes: 15 })
  assert.notEqual(second.preparationId, first.preparationId)
  assert.equal(second.sourceSettingsUpdatedAt, settings.updatedAt)
  const reused = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(reused.preparationId, second.preparationId)
})

test('refresh really changes questions while ordinary prepare still reuses the deterministic outline', async (t) => {
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')), { selectionSeedFactory: () => 'seed0001' })
  const first = await service.prepareInterview({ durationMinutes: 15 })
  const refreshed = await service.prepareInterview({ durationMinutes: 15, refresh: true })
  assert.notEqual(refreshed.preparationId, first.preparationId)
  assert.notEqual(refreshed.planKey, first.planKey)
  assert.equal(refreshed.selectionSeed, 'seed0001')
  assert.ok(refreshed.refresh.changed >= 1)
  assert.ok(refreshed.refresh.mainChanged >= 1, '有替代题时必须至少换一道主问题')
  assert.equal(refreshed.refresh.exhausted, false)
  assert.equal(refreshed.refresh.attempts, 1, '真实题库上第一枪就换到主问题，不必空转四次')
  assert.equal(refreshed.items.length, 6)
  const reused = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(reused.preparationId, first.preparationId, '普通准备仍回到确定性快照，不持续增殖')
  // refresh 只是这次操作的回执，不写进冻结快照
  const disk = JSON.parse(await readFile(join(root, 'preparations', `${refreshed.preparationId}.json`), 'utf8'))
  assert.equal(Object.hasOwn(disk, 'refresh'), false, '磁盘快照不得包含 refresh 字段')
  assert.equal(disk.planKey, refreshed.planKey)
  assert.equal(Object.hasOwn(reused, 'refresh'), false, '普通准备不带 refresh 回执')
})

test('refresh reports exhausted candidates without creating a duplicate preparation', async (t) => {
  const seed = JSON.parse(await readFile(new URL('../lib/data/market-question-bank.json', import.meta.url), 'utf8')).items.slice(0, 8)
  const marketBankFactory = async () => ({
    async init() { return this }, async close() {},
    async listActive() { return seed },
    async stats() { return { sources: { seed: seed.length }, warnings: [] } },
  })
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')), { marketBankFactory, selectionSeedFactory: () => 'seed0001' })
  const first = await service.prepareInterview({ durationMinutes: 30 })
  assert.equal(first.items.length, 8)
  const before = await readFile(join(root, 'preparations.json'), 'utf8')
  const refreshed = await service.prepareInterview({ durationMinutes: 30, refresh: true })
  assert.equal(refreshed.preparationId, first.preparationId)
  assert.equal(refreshed.refresh.exhausted, true)
  assert.equal(refreshed.refresh.changed, 0)
  assert.match(refreshed.refresh.notice, /可换的题不够/)
  assert.equal(await readFile(join(root, 'preparations.json'), 'utf8'), before)
})

test('source detection is explicit, stores friendly metadata and never requires a typed path', async (t) => {
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')))
  const msyDir = join(root, 'msy')
  await mkdir(join(msyDir, 'data'), { recursive: true })
  await writeFile(join(msyDir, 'data', 'questions.ndjson'), '{}\n')
  // 本组只验证目录设置/版本，不复测连接器语法；连接器有独立有效/坏行用例。
  service.inspectMsyDirectory = async () => ({ agentQuestions: 0, resumeQuestions: 0 })
  service.msyCandidates = [msyDir]
  service.inspectMsyDirectory = async () => ({ agentQuestions: 7, resumeQuestions: 3 })
  const detected = await service.detectMsySource()
  assert.equal(detected.configured, true)
  assert.equal(detected.displayName, 'msy 本地题库')
  assert.deepEqual(detected.sourceSummary, { agentQuestions: 7, resumeQuestions: 3 })
  const settings = await service.sourceSettings()
  assert.equal(settings.msyDir, msyDir)
  assert.deepEqual(settings.sourceSummary, { agentQuestions: 7, resumeQuestions: 3 })
  const cleared = await service.saveSourceSettings({ msyDir: '' })
  assert.equal(cleared.configured, false)
  assert.deepEqual(cleared.sourceSummary, { agentQuestions: 0, resumeQuestions: 0 })
})

// ---------------------------------------------------------------- 自动识别只认显式候选

test('auto detection only uses injected candidates and HR_INTERVIEW_MSY_DIR, never a built-in path', async (t) => {
  const previousEnv = process.env.HR_INTERVIEW_MSY_DIR
  delete process.env.HR_INTERVIEW_MSY_DIR
  t.after(() => {
    if (previousEnv === undefined) delete process.env.HR_INTERVIEW_MSY_DIR
    else process.env.HR_INTERVIEW_MSY_DIR = previousEnv
  })
  const root = await mkdtemp(join(tmpdir(), 'hr-preparation-candidates-'))
  const store = new InterviewStore(root)
  const build = (extras = {}) => new HRInterviewService({ store, model: modelWith(() => baseDecision('next_question', '不应调用')), speech, ...extras })
  const plain = build()
  t.after(async () => { await plain.close(); await rm(root, { recursive: true, force: true }) })
  assert.deepEqual(plain.msyCandidates, [], '没有任何注入时不得存在内置候选目录')
  await assert.rejects(plain.detectMsySource(), (error) => error.code === 'hr-interview/source-not-found', '未配置时明确报 source-not-found，让用户先选目录')

  const msyDir = join(root, 'msy')
  await mkdir(join(msyDir, 'data'), { recursive: true })
  await writeFile(join(msyDir, 'data', 'questions.ndjson'), '{}\n')
  const injected = build({ msyCandidates: [msyDir, 'msy', '', 'relative/msy'] })
  t.after(() => injected.close())
  assert.deepEqual(injected.msyCandidates, [msyDir], '只保留带盘符的绝对路径候选')
  injected.inspectMsyDirectory = async () => ({ agentQuestions: 2, resumeQuestions: 1 })
  const detected = await injected.detectMsySource()
  assert.equal(detected.configured, true)
  assert.equal(detected.sourceSummary.agentQuestions, 2)

  process.env.HR_INTERVIEW_MSY_DIR = 'msy-without-drive'
  const envBare = build()
  t.after(() => envBare.close())
  assert.deepEqual(envBare.msyCandidates, [], '无盘符的裸路径必须被守卫丢掉')
  process.env.HR_INTERVIEW_MSY_DIR = msyDir
  const envAbsolute = build()
  t.after(() => envAbsolute.close())
  assert.deepEqual(envAbsolute.msyCandidates, [msyDir], '环境变量里的绝对目录仍然参与自动识别')
  assert.equal(envAbsolute.msyCandidates.some((value) => /Dsh_Project/i.test(value)), false, '不得内置任何机器相关默认路径')
})

// ---------------------------------------------------------- 同目录重扫不写盘、不 bump 版本

test('rescanning the same source keeps updatedAt, leaves the old preparation valid and reuses its id', async (t) => {
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')))
  const seed = JSON.parse(await readFile(new URL('../lib/data/market-question-bank.json', import.meta.url), 'utf8')).items
  service.marketBankFactory = async () => ({
    async init() { return this }, async close() {},
    async listActive() { return seed },
    async stats() { return { sources: { seed: seed.length }, warnings: [] } },
  })
  const msyDir = join(root, 'msy')
  await mkdir(join(msyDir, 'data'), { recursive: true })
  await writeFile(join(msyDir, 'data', 'questions.ndjson'), '{}\n')
  service.inspectMsyDirectory = async () => ({ agentQuestions: 4, resumeQuestions: 2 })
  const settingsFile = join(root, 'settings.json')
  const first = await service.saveSourceSettings({ msyDir })
  assert.equal(first.configured, true)
  assert.deepEqual(first.sourceSummary, { agentQuestions: 4, resumeQuestions: 2 })
  const before = await readFile(settingsFile, 'utf8')

  const prepared = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(prepared.sourceSettingsUpdatedAt, first.updatedAt)

  const rescanned = await service.saveSourceSettings({ msyDir })
  assert.equal(rescanned.updatedAt, first.updatedAt, '同目录且统计相同：重扫不得 bump updatedAt')
  assert.deepEqual(rescanned.sourceSummary, { agentQuestions: 4, resumeQuestions: 2 })
  assert.equal(await readFile(settingsFile, 'utf8'), before, '同目录重扫不得重写磁盘')
  assert.equal((await service.sourceSettings()).updatedAt, first.updatedAt)

  const reused = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(reused.preparationId, prepared.preparationId, '重扫后旧提纲仍匹配，普通准备继续复用同 id')
  assert.equal((await service.latestPreparation({ durationMinutes: 15 })).profileMatches, true)

  service.inspectMsyDirectory = async () => ({ agentQuestions: 5, resumeQuestions: 2 })
  const changed = await service.saveSourceSettings({ msyDir })
  assert.notEqual(changed.updatedAt, first.updatedAt, '统计真的变了才 bump 版本')
  assert.deepEqual(changed.sourceSummary, { agentQuestions: 5, resumeQuestions: 2 })
})

// -------------------------------------------------- 设置写入与准备共用同一把 prepare 锁

test('saveSourceSettings shares the prepare lock and never closes the bank mid-preparation', async (t) => {
  const seed = JSON.parse(await readFile(new URL('../lib/data/market-question-bank.json', import.meta.url), 'utf8')).items
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let entered
  const inFlight = new Promise((resolve) => { entered = resolve })
  let closes = 0
  const marketBankFactory = async () => ({
    async init() { return this },
    async close() { closes += 1 },
    async listActive() { entered(); await gate; return seed },
    async stats() { return { sources: {}, warnings: [] } },
  })
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')), { marketBankFactory })
  const dirA = join(root, 'msy-a')
  const dirB = join(root, 'msy-b')
  for (const dir of [dirA, dirB]) {
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'questions.ndjson'), '{}\n')
  }
  service.inspectMsyDirectory = async () => ({ agentQuestions: 1, resumeQuestions: 0 })
  await service.saveSourceSettings({ msyDir: dirA })

  const order = []
  const preparing = service.prepareInterview({ durationMinutes: 15 }).then((value) => { order.push('prepare'); return value })
  await inFlight
  const saving = service.saveSourceSettings({ msyDir: dirB }).then((value) => { order.push('settings'); return value })
  assert.equal(closes, 0, '准备进行中不得关掉正在使用的 bank')

  release()
  await preparing
  await saving
  assert.deepEqual(order, ['prepare', 'settings'], '设置写入必须排在准备之后，不并发动 bank')
  assert.equal(closes, 1, '准备结束后才关旧 bank 再重建')
  assert.equal((await service.sourceSettings()).msyDir, dirB)
})

test('同一 Host 由题库 A 切到 B 和停用后都能重新准备', async (t) => {
  const { root, service } = await fixture(t, null, { roleResearch: createRoleResearch(async () => new Map()) })
  const createSource = async (name, titles) => {
    const dir = join(root, name)
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'questions.ndjson'), titles.map((title, index) =>
      JSON.stringify({ id: `${name}-${index}`, title, tagList: ['Agent'] })).join('\n') + '\n')
    return dir
  }
  const dirA = await createSource('msy-a', [
    'Agent 甲库如何处理并发超时？', 'Agent 甲库如何处理状态摘要？',
    'Agent 甲库如何检查工具输出？', 'Agent 甲库如何检查回放日志？',
  ])
  const dirB = await createSource('msy-b', ['Agent 乙库如何设置请求预算？'])
  await service.saveSourceSettings({ msyDir: dirA })
  const first = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(first.sources.msyQuestions.imported, 4)
  await service.saveSourceSettings({ msyDir: dirB })
  assert.equal((await service.latestPreparation({ durationMinutes: 15 })).profileMatches, false)
  await assert.rejects(service.start(options(first.preparationId)), { code: 'hr-interview/preparation-stale' })
  const second = await service.prepareInterview({ durationMinutes: 15, refresh: true })
  assert.equal(second.sources.msyQuestions.imported, 1)
  const bank = await service.getMarketBank()
  const imported = (await bank.listActive({ rolePack: 'agent', limit: 1000 })).filter((item) => item.sourceType === 'msy-question')
  assert.deepEqual(imported.map((item) => item.question), ['Agent 乙库如何设置请求预算？'])
  assert.notEqual(second.preparationId, first.preparationId)
  await service.saveSourceSettings({ msyDir: '' })
  const cleared = await service.prepareInterview({ durationMinutes: 15, refresh: true })
  assert.equal(cleared.sources.msyQuestions.status, 'disabled')
  assert.notEqual(cleared.preparationId, second.preparationId)
})

// ---------------------------------------- refresh 重试循环：跑满四次并留下最优解

test('refresh retries the seed four times and keeps the best candidate instead of stopping at the first', async (t) => {
  const { materialsProfile, detectRolePack, selectionDiff } = await import('../lib/question-plan.js')
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')))
  const baseIds = ['b-1', 'b-2', 'b-3', 'b-4', 'b-5', 'b-6']
  const itemsOf = (ids) => ids.map((id, index) => ({
    planItemId: `plan-${index + 1}`,
    bankItemId: id,
    topic: `topic-${index}`,
    kind: index < 2 ? 'project' : 'principle',
    question: `问题 ${id}`,
    followups: [],
    expectedPoints: [],
    alternate: index >= 4,
    sourceRefs: [{ bankItemId: id, revision: 1, sourceTitle: '合成题', sourceUrl: '', evidenceLevel: 'seed' }],
  }))
  // 每次 seed 给一版：只有备选席位变动 ⇒ mainChanged 恒为 0，changed 依次是 1/2/1/1
  const variantIds = {
    0: baseIds,
    1: [...baseIds.slice(0, 5), 'v1-a'],
    2: [...baseIds.slice(0, 4), 'v2-a', 'v2-b'],
    3: [...baseIds.slice(0, 5), 'v3-a'],
    4: [...baseIds.slice(0, 5), 'v4-a'],
  }
  const seeds = []
  service.selectionSeedFactory = () => `seed000${seeds.length + 1}`
  service.getPlanLib = async () => ({
    materialsProfile,
    detectRolePack,
    selectionDiff,
    buildQuestionPlan: (input) => {
      if (input.selectionSeed) seeds.push(input.selectionSeed)
      const variant = input.selectionSeed ? Number(String(input.selectionSeed).slice(-1)) : 0
      return {
        packId: 'agent',
        taxonomyVersion: '2026-11',
        profileKey: materialsProfile(input.materials, { durationMinutes: input.durationMinutes }).profileKey,
        planKey: `plan-${variant}`,
        durationMinutes: input.durationMinutes,
        questionBudget: { main: 4, alternates: 2, total: 6 },
        selectionSeed: input.selectionSeed || '',
        items: itemsOf(variantIds[variant]),
      }
    },
  })

  const first = await service.prepareInterview({ durationMinutes: 15 })
  assert.equal(first.planKey, 'plan-0')
  assert.equal(Object.hasOwn(first, 'refresh'), false)

  const refreshed = await service.prepareInterview({ durationMinutes: 15, refresh: true })
  assert.deepEqual(seeds, ['seed0001', 'seed0002', 'seed0003', 'seed0004'], '必须真的跑满四次，不是第一次就 break')
  assert.equal(refreshed.refresh.attempts, 4)
  assert.equal(refreshed.refresh.changed, 2, '取 changed 最大的那一版')
  assert.equal(refreshed.refresh.mainChanged, 0)
  assert.equal(refreshed.refresh.exhausted, false, '有题可换就不该报候选不足')
  assert.equal(refreshed.planKey, 'plan-2')
  assert.deepEqual(refreshed.items.map((item) => item.bankItemId), variantIds[2])

  const disk = JSON.parse(await readFile(join(root, 'preparations', `${refreshed.preparationId}.json`), 'utf8'))
  assert.equal(Object.hasOwn(disk, 'refresh'), false, '落盘快照不含 refresh，只有 RPC 回执带它')
  assert.equal(disk.planKey, 'plan-2')
  const index = JSON.parse(await readFile(join(root, 'preparations.json'), 'utf8'))
  assert.equal(JSON.stringify(index).includes('refresh'), false, '索引摘要同样不得出现 refresh')
})

// ------------------------- 真实 msy fixture：不打桩，验证导入计数走的是真字段名

test('real msy directory reports imported question and resume counts without stubbing the inspector', async (t) => {
  const { root, service } = await fixture(t, modelWith(() => baseDecision('next_question', '不应调用')))
  const msyDir = join(root, 'msy-real')
  await mkdir(join(msyDir, 'data'), { recursive: true })
  const row = (id, title, tags = ['Agent']) => JSON.stringify({ id, title, tagList: tags })
  await writeFile(join(msyDir, 'data', 'questions.ndjson'), [
    row('q-1', 'Agent 的记忆机制怎么设计？'),
    row('q-2', 'MCP 工具调用怎么做幂等？', ['MCP']),
    row('q-3', 'RAG 召回率怎么提升？', ['RAG']),
  ].join('\n') + '\n')
  // 受限字面量解析只认纯数据：用 JSON 字面量写法，别塞转义或表达式。
  const resumeEntries = [
    { id: 'r-1', module: 'agent-platform', q: '这个平台你在项目里怎么落地的？', a: '· 负责编排' },
    { id: 'r-2', module: 'rag', q: '召回率是怎么提上去的？', a: '· 换向量模型' },
  ]
  await writeFile(join(msyDir, 'resume-bank.mjs'), [
    'export const RESUME_BANK = [',
    ...resumeEntries.map((entry) => `  ${JSON.stringify(entry)},`),
    '];',
    '',
  ].join('\n'))
  // 故意不打桩 inspectMsyDirectory：走真实 readMsySource，字段名写错就会显示 0/0。
  assert.equal(typeof service.inspectMsyDirectory, 'function')
  const { readMsySource } = await import('../lib/msy-connector.js')
  const raw = await readMsySource({ dir: msyDir })
  assert.equal(raw.stats.imported, 3, 'connector 的真实计数字段是 imported')
  assert.equal(Object.hasOwn(raw.stats, 'filteredAccepted'), false, '没有任何 filteredAccepted 字段，读错名字只会得到 0')
  assert.equal(raw.resume.length, 2)

  const saved = await service.saveSourceSettings({ msyDir })
  assert.equal(saved.configured, true)
  assert.equal(saved.msyDir, msyDir)
  assert.deepEqual(saved.sourceSummary, { agentQuestions: 3, resumeQuestions: 2 })

  const rescanned = await service.saveSourceSettings({ msyDir })
  assert.deepEqual(rescanned.sourceSummary, { agentQuestions: 3, resumeQuestions: 2 }, '真实目录重扫仍读到同样的导入数')
  assert.equal(rescanned.updatedAt, saved.updatedAt)

  // 自动识别也必须给出真实计数（不是 0/0）。
  service.msyCandidates = [msyDir]
  const detected = await service.detectMsySource()
  assert.equal(detected.configured, true)
  assert.deepEqual(detected.sourceSummary, { agentQuestions: 3, resumeQuestions: 2 })

  // 磁盘上的设置与视图一致，避免只对了返回值。
  const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.sourceSummary, { agentQuestions: 3, resumeQuestions: 2 })
})
