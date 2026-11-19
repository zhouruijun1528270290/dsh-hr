const TRANSCRIPT_BYTES = 24 * 1024
const bytes = (text) => Buffer.byteLength(text, 'utf8')

function encodeTurn(turn, previousQuestion) {
  const { id, sequence, speaker, kind, questionId, deliveryMeta } = turn
  const text = String(turn.text || '')
  const row = {
    id, sequence, speaker, kind, questionId,
    ...(previousQuestion && speaker === 'candidate' ? { prompt: previousQuestion.text } : {}),
    ...(deliveryMeta ? { answerDurationMs: deliveryMeta.answerDurationMs, responseLatencyMs: deliveryMeta.responseLatencyMs } : {}),
  }
  const complete = JSON.stringify({ ...row, text })
  if (bytes(complete) < TRANSCRIPT_BYTES) return [complete]

  const fragments = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 12000)
    let encoded
    for (;;) {
      // Retain the source turn ID for every fragment, and split at a Unicode boundary.
      if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) end -= 1
      encoded = JSON.stringify({ ...row, fragment: fragments.length + 1, text: text.slice(start, end) })
      if (bytes(encoded) < TRANSCRIPT_BYTES) break
      end = start + Math.floor((end - start) / 2)
    }
    fragments.push(encoded)
    start = end
  }
  return fragments
}

export function reviewTranscriptBatches(turns, { maxAnswers = Infinity } = {}) {
  const groups = []
  let previousQuestion
  for (const turn of turns) {
    const key = turn.questionId || turn.id
    if (groups.at(-1)?.key !== key) groups.push({ key, lines: [] })
    if (turn.speaker === 'hr') previousQuestion = { key, text: String(turn.text || '').slice(0, 240) }
    groups.at(-1).lines.push(...encodeTurn(turn, previousQuestion?.key === key ? previousQuestion : null))
  }
  const batches = []
  let lines = []
  let size = 0
  let answers = 0
  const answerCount = (entries) => maxAnswers === Infinity ? 0 : entries.reduce((count, line) => {
    const row = JSON.parse(line)
    return count + Number(row.speaker === 'candidate' && row.kind !== 'no_answer')
  }, 0)
  const add = (entries) => {
    const added = entries.reduce((total, line) => total + bytes(line) + 1, 0)
    const addedAnswers = answerCount(entries)
    if (lines.length && (size + added > TRANSCRIPT_BYTES || answers + addedAnswers > maxAnswers)) {
      batches.push(lines.join('\n'))
      lines = []
      size = 0
      answers = 0
    }
    lines.push(...entries)
    size += added
    answers += addedAnswers
  }
  for (const group of groups) {
    if (bytes(group.lines.join('\n')) < TRANSCRIPT_BYTES && answerCount(group.lines) <= maxAnswers) add(group.lines)
    else for (const line of group.lines) add([line])
  }
  if (lines.length) batches.push(lines.join('\n'))
  return batches
}

export function reviewMaterialExcerpt({ materials, knowledge }) {
  const excerpt = (text, limit) => {
    const value = String(text || '')
    return value.length <= limit ? value : `${value.slice(0, limit)}\n[材料摘录]`
  }
  return JSON.stringify({
    role: materials.role || '',
    resume: excerpt(materials.resume, 5000),
    jd: excerpt(materials.jd, 5000),
    projectNotes: excerpt(materials.projectNotes, 3000),
    knowledge: (knowledge || []).slice(0, 20).map((point) => ({
      id: point?.id, title: excerpt(point?.title, 120), mastery: point?.mastery,
    })),
  })
}
