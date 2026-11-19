import { REVIEW_DIMENSION_KEYS, reviewDimensionScore, summarizeReviewScores } from './contract.js'

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0))
const iso = (value) => new Date(value).toISOString()
const masteryLevel = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim()))
  && Number.isFinite(Number(value)) ? Math.round(clamp(value, 0, 4)) : null
const reviewIntervals = [0, 1, 4, 24, 48]
export function normalizeKnowledgeSchedule(items, now = new Date()) {
  return items.map((item) => {
    if (item?.mastery !== 0 || item.nextReviewAt) return item
    const lastReview = Date.parse(item.lastAskedAt || item.updatedAt)
    return { ...item, nextReviewAt: iso(Number.isFinite(lastReview) ? Math.min(lastReview, now.getTime()) : now) }
  }).sort((a, b) => String(a?.nextReviewAt || '9999').localeCompare(String(b?.nextReviewAt || '9999')))
}
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
  const answers = turns.filter((turn) => turn.speaker === 'candidate' && turn.kind !== 'no_answer')
  const answerIds = new Set(answers.map((turn) => turn.id))
  const sourceDimensions = Array.isArray(raw?.dimensions) ? raw.dimensions : []
  const dimensions = REVIEW_DIMENSION_KEYS.map((key) => {
    const found = sourceDimensions.find((item) => item?.key === key) || {}
    const score = reviewDimensionScore(found)
    return {
      key, evaluated: score !== null, score,
      evidenceTurnIds: Array.isArray(found.evidenceTurnIds) ? [...new Set(found.evidenceTurnIds.filter((id) => answerIds.has(id)))] : [],
      diagnosis: String(found.diagnosis || '本场没有足够证据评价该维度').slice(0, 1200),
      improvement: String(found.improvement || '在下一次训练中用具体事实补充该维度').slice(0, 1200),
    }
  })
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
    version: 1, summary: String(raw?.summary || '复盘已生成，可查看分项和逐题反馈。').slice(0, 2400),
    ...summarizeReviewScores(dimensions),
    priorities: Array.isArray(raw?.priorities) ? raw.priorities.map((item) => String(item).slice(0, 500)).slice(0, 3) : [],
    dimensions,
    gaps: Array.isArray(raw?.gaps) ? raw.gaps.slice(0, 20).map((item) => ({ kind: String(item?.kind || 'knowledge'), turnIds: Array.isArray(item?.turnIds) ? item.turnIds.filter((id) => turnIds.has(id)) : [], diagnosis: String(item?.diagnosis || '').slice(0, 1000) })) : [],
    consistencyIssues: Array.isArray(raw?.consistencyIssues) ? raw.consistencyIssues.slice(0, 12).map((item) => ({ claim: String(item?.claim || '').slice(0, 500), evidenceRefs: Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.slice(0, 12) : [], turnIds: Array.isArray(item?.turnIds) ? item.turnIds.filter((id) => turnIds.has(id)) : [], recommendation: String(item?.recommendation || '').slice(0, 800) })) : [],
    questionReviews,
    knowledgePoints: Array.isArray(raw?.knowledgePoints) ? raw.knowledgePoints.slice(0, 30).map((item, index) => ({
      id: String(item?.id || `kp-${session.sessionId}-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120),
      domain: String(item?.domain || 'general').slice(0, 80), title: String(item?.title || '待复核知识点').slice(0, 200),
      mastery: masteryLevel(item?.mastery), evidenceRefs: Array.isArray(item?.evidenceRefs) ? item.evidenceRefs.slice(0, 12) : [],
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
    const hours = reviewIntervals[item.mastery]
    current.set(item.id, {
      ...previous, ...item, lastAskedAt: iso(now), updatedAt: iso(now),
      mastery: hours === undefined ? previous.mastery ?? null : item.mastery,
      nextReviewAt: hours === undefined ? previous.nextReviewAt ?? null : iso(now.getTime() + hours * 3600000),
    })
  }
  return normalizeKnowledgeSchedule([...current.values()], now)
}
