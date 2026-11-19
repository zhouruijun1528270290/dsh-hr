const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0))
const iso = (value) => new Date(value).toISOString()
export function deliveryMetrics(text, input = {}) {
  const transcriptCharCount = [...String(text || '').trim()].length
  const answerDurationMs = clamp(input.answerDurationMs, 0, 3600000)
  const fillerWordCount = (String(text || '').match(/(?:嗯+|啊+|呃+|那个|就是|然后|然后嘞|you know|actually)/gi) || []).length
  return {
    responseLatencyMs: clamp(input.responseLatencyMs, 0, 3600000), answerDurationMs,
    transcriptCharCount, charsPerSecond: answerDurationMs > 0 ? Number((transcriptCharCount / (answerDurationMs / 1000)).toFixed(2)) : 0,
    fillerWordCount, restartCount: clamp(input.restartCount, 0, 100), interruptedCount: clamp(input.interruptedCount, 0, 100),
    usedFallback: Boolean(input.usedFallback), processingLatencyMs: clamp(input.processingLatencyMs, 0, 3600000),
  }
}
export function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}
export function normalizeEvaluation(raw, session, turns, generatedAt = new Date().toISOString()) {
  const turnIds = new Set(turns.map((turn) => turn.id))
  const keys = ['relevance', 'accuracy', 'evidence', 'structure', 'expression', 'consistency', 'presence']
  const sourceDimensions = Array.isArray(raw?.dimensions) ? raw.dimensions : []
  const dimensions = keys.map((key) => {
    const found = sourceDimensions.find((item) => item?.key === key) || {}
    const evaluated = found.score !== null && found.score !== '' && Number.isFinite(Number(found.score))
    return {
      key, evaluated, score: evaluated ? Math.round(clamp(found.score, 0, 100)) : null,
      evidenceTurnIds: Array.isArray(found.evidenceTurnIds) ? found.evidenceTurnIds.filter((id) => turnIds.has(id)) : [],
      diagnosis: String(found.diagnosis || '本场没有足够证据评价该维度').slice(0, 1200),
      improvement: String(found.improvement || '在下一次训练中用具体事实补充该维度').slice(0, 1200),
    }
  })
  const answers = turns.filter((turn) => turn.speaker === 'candidate' && turn.kind !== 'no_answer')
  const latencies = answers.map((turn) => turn.deliveryMeta?.processingLatencyMs).filter((value) => value > 0)
  const questionReviews = turns.filter((turn) => turn.speaker === 'hr' && ['main_question', 'followup'].includes(turn.kind)).map((question) => {
    const answerTurnIds = turns.filter((turn) => turn.speaker === 'candidate' && turn.kind !== 'no_answer' && turn.questionId === question.questionId).map((turn) => turn.id)
    const found = Array.isArray(raw?.questionReviews) ? raw.questionReviews.find((item) => item?.questionId === question.questionId) : null
    return {
      questionId: question.questionId, answerTurnIds,
      issues: Array.isArray(found?.issues) ? found.issues.map((item) => String(item).slice(0, 500)).slice(0, 8) : [],
      rewrite: String(found?.rewrite || '').slice(0, 2400), drill: String(found?.drill || '').slice(0, 800),
    }
  })
  return {
    version: 1, summary: String(raw?.summary || '复盘已生成；请结合逐题证据判断，而不是只看总分。').slice(0, 2400),
    overallScore: (() => { const scored = dimensions.filter((item) => item.evaluated); return scored.length ? Math.round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length) : null })(),
    priorities: Array.isArray(raw?.priorities) ? raw.priorities.map((item) => String(item).slice(0, 500)).slice(0, 3) : [],
    dimensions,
    gaps: Array.isArray(raw?.gaps) ? raw.gaps.slice(0, 20).map((item) => ({ kind: String(item?.kind || 'knowledge'), turnIds: Array.isArray(item?.turnIds) ? item.turnIds.filter((id) => turnIds.has(id)) : [], diagnosis: String(item?.diagnosis || '').slice(0, 1000) })) : [],
    consistencyIssues: Array.isArray(raw?.consistencyIssues) ? raw.consistencyIssues.slice(0, 12).map((item) => ({ claim: String(item?.claim || '').slice(0, 500), evidenceRefs: Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.slice(0, 12) : [], turnIds: Array.isArray(item?.turnIds) ? item.turnIds.filter((id) => turnIds.has(id)) : [], recommendation: String(item?.recommendation || '').slice(0, 800) })) : [],
    questionReviews,
    knowledgePoints: Array.isArray(raw?.knowledgePoints) ? raw.knowledgePoints.slice(0, 30).map((item, index) => ({
      id: String(item?.id || `kp-${session.sessionId}-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120),
      domain: String(item?.domain || 'general').slice(0, 80), title: String(item?.title || '待复核知识点').slice(0, 200),
      mastery: Math.round(clamp(item?.mastery, 0, 4)), evidenceRefs: Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.slice(0, 12) : [],
      lastQuestionVariant: String(item?.lastQuestionVariant || '').slice(0, 500), originSessionId: session.sessionId,
    })) : [],
    performance: { latencyCount: latencies.length, latencyP75Ms: percentile(latencies, 0.75), latencyP95Ms: percentile(latencies, 0.95), oralAcceptanceEligible: session.oralAcceptanceEligible !== false },
    generatedAt,
  }
}
export function applyKnowledge(existing, evaluation, now = new Date()) {
  const current = new Map(existing.map((item) => [item.id, item]))
  for (const item of evaluation.knowledgePoints || []) {
    const previous = current.get(item.id) || {}
    const hours = [0, 1, 4, 24, 48][item.mastery] || 0
    current.set(item.id, {
      ...previous, ...item, lastAskedAt: iso(now), updatedAt: iso(now),
      nextReviewAt: hours ? new Date(now.getTime() + hours * 3600000).toISOString() : null,
    })
  }
  return [...current.values()].sort((a, b) => String(a.nextReviewAt || '9999').localeCompare(String(b.nextReviewAt || '9999')))
}
