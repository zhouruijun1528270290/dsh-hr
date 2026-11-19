import { inflateRawSync } from 'node:zlib'
import { remoteFailure } from './contract.js'

export const MAX_RESUME_BYTES = 8 * 1024 * 1024
export const MAX_RESUME_CHARACTERS = 60000

const MAX_ZIP_ENTRIES = 2000
const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_ZIP_RATIO = 200
const MAX_PDF_PAGES = 40
const MAX_PDF_BYTES = 4 * 1024 * 1024
const MAX_PDF_STREAMS = 4096
const PDF_DICTIONARY_WINDOW = 4096
const MAX_PDF_TEXT_CHARS = 200000
const DEFAULT_PDF_DEADLINE_MS = 25000
const MAX_NAME_LENGTH = 200
const WARNING_LIMIT = 6

const ENCODING_MESSAGE = '这份 PDF 使用了内嵌字体，暂时无法可靠提取，请上传 DOCX 或另存为文本 PDF'
const TIMEOUT_MESSAGE = 'PDF 解析超时，请稍后重试或改用 DOCX'
const ENCRYPTED_MESSAGE = 'PDF 已加密，请先移除密码再上传'
const SCANNED_MESSAGE = '没有提取到文字，可能是扫描件，需要 OCR 后再上传'

const pdfRuntime = { deadlineMs: DEFAULT_PDF_DEADLINE_MS, loader: null }

/** Test-only seams: production code never touches these. */
export const resumeParserTestHooks = {
  setPdfDeadline(ms) {
    const value = Number(ms)
    pdfRuntime.deadlineMs = Number.isFinite(value) && value > 0 ? value : DEFAULT_PDF_DEADLINE_MS
  },
  setVendoredPdfLoader(loader) {
    pdfRuntime.loader = typeof loader === 'function' ? loader : null
  },
}

const fail = (code, message, details = {}) =>
  remoteFailure(`hr-interview/resume-${code}`, message, details)

const EXTENSIONS = new Map([
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['txt', 'txt'],
  ['md', 'md'],
])

const FORMAT_LABELS = { pdf: 'PDF', docx: 'DOCX', txt: 'TXT', md: 'MD' }

const FAILURE_RANK = {
  'hr-interview/resume-pdf-encrypted': 6,
  'hr-interview/resume-pdf-encoding': 5,
  'hr-interview/resume-pdf-timeout': 4,
  'hr-interview/resume-pdf-unreadable': 3,
  'hr-interview/resume-pdf-scanned': 2,
}

function normalizeLimit(value) {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return MAX_RESUME_CHARACTERS
  return Math.max(1, Math.min(MAX_RESUME_CHARACTERS, Math.floor(limit)))
}

function toBytes(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  throw fail('invalid-data', '文件内容必须是二进制数据')
}

function inspectName(name) {
  const raw = typeof name === 'string' ? name.trim() : ''
  if (!raw) throw fail('invalid-name', '缺少文件名，无法判断文件格式')
  if (raw.length > MAX_NAME_LENGTH) throw fail('invalid-name', '文件名过长')
  const fileName = raw.split(/[\\/]+/).filter(Boolean).pop() || ''
  if (!fileName || fileName === '.' || fileName === '..') throw fail('invalid-name', '文件名无效')
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(fileName)
  const format = match ? EXTENSIONS.get(match[1].toLowerCase()) : undefined
  if (!format) throw fail('unsupported-format', '只支持 PDF、DOCX、TXT、MD 文件')
  return { fileName, format }
}

function pushWarning(warnings, message) {
  if (warnings.length >= WARNING_LIMIT) return
  if (!warnings.includes(message)) warnings.push(message)
}

/* ---------- plain text ---------- */

function swapPairs(bytes, offset) {
  const length = (bytes.length - offset) & ~1
  const out = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 2) {
    out[i] = bytes[offset + i + 1]
    out[i + 1] = bytes[offset + i]
  }
  return out.toString('utf16le')
}

function sniffUtf16(bytes) {
  const length = Math.min(bytes.length, 4096) & ~1
  if (length < 16) return null
  let zeroEven = 0
  let zeroOdd = 0
  for (let i = 0; i < length; i += 2) {
    if (bytes[i] === 0) zeroEven += 1
    if (bytes[i + 1] === 0) zeroOdd += 1
  }
  const pairs = length / 2
  const even = zeroEven / pairs
  const odd = zeroOdd / pairs
  if (even > 0.4 && odd < 0.05) return 'utf-16be'
  if (odd > 0.4 && even < 0.05) return 'utf-16le'
  return null
}

const JUNK_CODE = (code) => code === 0xfffd || code === 0 || code === 0xfffe || code === 0xffff
  || (code >= 0xfdd0 && code <= 0xfdef)

const LETTER_TEST = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

function countInvalid(text) {
  let bad = 0
  for (let index = 0; index < text.length; index += 1) {
    if (JUNK_CODE(text.charCodeAt(index))) bad += 1
  }
  return bad
}

function printableRatio(text) {
  if (!text.length) return 0
  let ok = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (JUNK_CODE(code)) continue
    if (code === 9 || code === 10 || code === 13) { ok += 1; continue }
    if (code < 32) continue
    ok += 1
  }
  return ok / text.length
}

/** 采样前 8192 个字符估计「像自然语言的程度」，用于在编码候选得分相近时择优。 */
function letterRatio(text) {
  if (!text.length) return 0
  const sample = Math.min(text.length, 8192)
  let letters = 0
  for (let index = 0; index < sample; index += 1) {
    if (LETTER_TEST.test(text.charAt(index))) letters += 1
  }
  return letters / sample
}

function decodePlainText(bytes, warnings) {
  const guardDecoded = (text) => {
    if (!text.length) throw fail('binary-content', '文件包含二进制内容，不是纯文本')
    const bad = countInvalid(text)
    if (bad / text.length > 0.02 || printableRatio(text) < 0.6) {
      throw fail('binary-content', '文件包含二进制内容，不是纯文本')
    }
    return text
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return guardDecoded(bytes.toString('utf8', 3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return guardDecoded(bytes.toString('utf16le', 2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return guardDecoded(swapPairs(bytes, 2))
  }
  const sniffed = sniffUtf16(bytes)
  if (sniffed === 'utf-16le') {
    pushWarning(warnings, '文件没有 BOM，已按 UTF-16 LE 解码')
    return guardDecoded(bytes.toString('utf16le'))
  }
  if (sniffed === 'utf-16be') {
    pushWarning(warnings, '文件没有 BOM，已按 UTF-16 BE 解码')
    return guardDecoded(swapPairs(bytes, 0))
  }

  const asUtf8 = bytes.toString('utf8')
  if (countInvalid(asUtf8) === 0 && !bytes.includes(0)) return asUtf8

  const candidates = [{ encoding: 'utf-8', text: asUtf8 }]
  if (bytes.length >= 16) {
    candidates.push({ encoding: 'utf-16le', text: bytes.toString('utf16le') })
    candidates.push({ encoding: 'utf-16be', text: swapPairs(bytes, 0) })
  }
  let best = null
  for (const candidate of candidates) {
    const bad = countInvalid(candidate.text)
    const score = bad * 2 + (1 - printableRatio(candidate.text)) + (1 - letterRatio(candidate.text)) * 0.5
    if (!best || score < best.score) best = { ...candidate, score, bad }
  }
  const badRatio = best.text.length === 0 ? 1 : best.bad / best.text.length
  if (!best.text.length || badRatio > 0.02 || printableRatio(best.text) < 0.6) {
    throw fail('binary-content', '文件包含二进制内容，不是纯文本')
  }
  if (best.encoding !== 'utf-8') {
    pushWarning(warnings, best.encoding === 'utf-16le' ? '文件没有 BOM，已按 UTF-16 LE 解码' : '文件没有 BOM，已按 UTF-16 BE 解码')
  } else if (best.bad > 0) {
    pushWarning(warnings, '文本里有无法识别的字符，已原样保留')
  }
  return best.text
}

function readPlainText(bytes, warnings) {
  const headLength = Math.min(bytes.length, 1024)
  const head = bytes.toString('latin1', 0, headLength)
  if (head.startsWith('%PDF')) throw fail('extension-mismatch', '文件内容其实是 PDF，请改用 .pdf 扩展名')
  if (head.startsWith('PK\u0003\u0004')) throw fail('extension-mismatch', '文件内容其实是 DOCX 压缩包，请改用 .docx 扩展名')
  return decodePlainText(bytes, warnings)
}

/* ---------- zip (docx container) ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  return (crc ^ -1) >>> 0
}

function findEndOfCentralDirectory(bytes) {
  if (bytes.length < 22) return -1
  const limit = Math.max(0, bytes.length - 66000)
  for (let at = bytes.length - 22; at >= limit; at -= 1) {
    if (bytes.readUInt32LE(at) === 0x06054b50) return at
  }
  return -1
}

function assertSafeEntryName(name) {
  if (!name) throw fail('docx-unsafe-entry', 'DOCX 内含空白文件名，结构异常')
  if (name.includes('\u0000')) throw fail('docx-unsafe-entry', 'DOCX 内含异常文件名')
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw fail('docx-unsafe-entry', 'DOCX 内含绝对路径')
  const segments = name.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) throw fail('docx-unsafe-entry', 'DOCX 内含异常路径')
  if (name.includes('\\')) throw fail('docx-unsafe-entry', 'DOCX 内含异常路径')
}

function readZipDirectory(bytes) {
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) throw fail('docx-not-zip', '文件不是有效的 DOCX（缺少 ZIP 目录）')
  const total = bytes.readUInt16LE(eocd + 10)
  const directorySize = bytes.readUInt32LE(eocd + 12)
  const directoryOffset = bytes.readUInt32LE(eocd + 16)
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw fail('docx-corrupt', '不支持 ZIP64 格式的 DOCX')
  }
  if (total > MAX_ZIP_ENTRIES) throw fail('docx-too-large', 'DOCX 内文件条目过多')
  if (directoryOffset + directorySize > bytes.length) throw fail('docx-corrupt', 'DOCX 目录区损坏')

  const entries = new Map()
  let cursor = directoryOffset
  let totalBytes = 0
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > bytes.length) throw fail('docx-corrupt', 'DOCX 目录区损坏')
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw fail('docx-corrupt', 'DOCX 目录区损坏')
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength > bytes.length) throw fail('docx-corrupt', 'DOCX 目录区损坏')
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) throw fail('docx-encrypted', '加密的 DOCX 无法本地解析，请先取消文档保护')
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw fail('docx-corrupt', '不支持 ZIP64 格式的 DOCX')
    }
    assertSafeEntryName(name)
    const key = name.toLowerCase()
    if (entries.has(key)) throw fail('docx-corrupt', 'DOCX 内含重复部件，结构异常')
    if (size > MAX_ZIP_ENTRY_BYTES) throw fail('docx-too-large', 'DOCX 单个部件解压后过大')
    if (method === 0 && compressedSize !== size) throw fail('docx-corrupt', 'DOCX 部件长度与声明不一致')
    if (compressedSize > 0 && size / compressedSize > MAX_ZIP_RATIO) throw fail('docx-ratio', 'DOCX 压缩比异常，疑似构造文件')
    totalBytes += size
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) throw fail('docx-too-large', 'DOCX 解压后总体积过大')
    entries.set(key, { name, method, compressedSize, size, crc, localOffset })
  }
  return entries
}

function readZipEntry(bytes, entry) {
  const offset = entry.localOffset
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) {
    throw fail('docx-corrupt', 'DOCX 部件头损坏')
  }
  const nameLength = bytes.readUInt16LE(offset + 26)
  const extraLength = bytes.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > bytes.length || start > end) throw fail('docx-corrupt', 'DOCX 部件数据越界')
  const raw = bytes.subarray(start, end)
  const limit = Math.max(1, Math.min(MAX_ZIP_ENTRY_BYTES, entry.size || MAX_ZIP_ENTRY_BYTES))
  let data
  if (entry.method === 0) {
    data = Buffer.from(raw)
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: limit })
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw fail('docx-too-large', 'DOCX 部件解压后超出限制')
      throw fail('docx-corrupt', 'DOCX 部件解压失败')
    }
  } else {
    throw fail('docx-corrupt', 'DOCX 使用了不支持的压缩方式')
  }
  if (data.length !== entry.size) throw fail('docx-corrupt', 'DOCX 部件长度与声明不一致')
  if (crc32(data) !== entry.crc) throw fail('docx-corrupt', 'DOCX 部件校验失败，文件可能已损坏')
  return data
}

/* ---------- docx xml ---------- */

const XML_TOKEN_SOURCE = '<[^>]*>|[^<]+'
const TAG_NAME_SOURCE = '^<\\/?([A-Za-z0-9:._-]+)'
const VAL_ATTRIBUTE = /\bw:val\s*=\s*"([^"]*)"/
const WHITE_COLOR = /^(?:F{6}|F{8})$/i

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(value) {
  if (!value.includes('&')) return value
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
      try { return String.fromCodePoint(code) } catch { return '' }
    }
    return ENTITIES[body] ?? whole
  })
}

function readWordProcessingText(xml) {
  const parts = []
  const alternates = []
  const tokenSource = new RegExp(XML_TOKEN_SOURCE, 'g')
  const tagName = new RegExp(TAG_NAME_SOURCE)
  let inText = false
  let currentRun = null
  let inRunProperties = false
  let match

  const skipping = () => alternates.some((entry) => entry.skipping === true)
  const hidden = () => currentRun !== null && currentRun.hidden === true
  const push = (value) => {
    if (skipping() || hidden()) return
    parts.push(value)
  }

  while ((match = tokenSource.exec(xml)) !== null) {
    const token = match[0]
    if (token.charCodeAt(0) !== 60) {
      if (inText) push(decodeEntities(token))
      continue
    }
    const nameMatch = tagName.exec(token)
    const name = nameMatch ? nameMatch[1] : ''
    const closing = token.charCodeAt(1) === 47
    const selfClosing = !closing && token.endsWith('/>')

    if (name === 'mc:AlternateContent') {
      if (closing) {
        if (alternates.length > 0) alternates.pop()
      } else if (!selfClosing) {
        alternates.push({ choiceSeen: false, skipping: false })
      }
      continue
    }
    if (name === 'mc:Choice') {
      const current = alternates[alternates.length - 1]
      if (!current) continue
      if (closing) {
        current.skipping = false
      } else if (current.choiceSeen) {
        current.skipping = true
      } else {
        current.choiceSeen = true
        current.skipping = false
      }
      continue
    }
    if (name === 'mc:Fallback') {
      const current = alternates[alternates.length - 1]
      if (!current) continue
      if (closing) current.skipping = false
      else current.skipping = current.choiceSeen
      continue
    }
    if (name === 'w:r') {
      if (closing) {
        currentRun = null
        inRunProperties = false
      } else if (!selfClosing) {
        currentRun = { hidden: false }
        inRunProperties = false
      }
      continue
    }
    if (name === 'w:rPr') {
      inRunProperties = !closing && currentRun !== null
      continue
    }
    if (inRunProperties && currentRun !== null && !closing) {
      if (name === 'w:vanish' || name === 'w:specVanish') {
        const value = VAL_ATTRIBUTE.exec(token)
        const text = value ? value[1].toLowerCase() : ''
        if (!(text === '0' || text === 'false' || text === 'off')) currentRun.hidden = true
        continue
      }
      if (name === 'w:color') {
        const value = VAL_ATTRIBUTE.exec(token)
        if (value && WHITE_COLOR.test(value[1])) currentRun.hidden = true
        continue
      }
    }
    if (name === 'w:t') {
      inText = !closing && !selfClosing
      continue
    }
    if (name === 'w:instrText' || name === 'w:delText') {
      inText = false
      continue
    }
    if (name === 'w:tab' && !closing) push('\t')
    else if ((name === 'w:br' || name === 'w:cr') && !closing) push('\n')
    else if (name === 'w:p' && closing) push('\n')
    else if (name === 'w:tc' && closing) push('\t')
    else if (name === 'w:tr' && closing) push('\n')
  }
  return parts.join('')
}

function readDocx(bytes, warnings) {
  const head = bytes.toString('latin1', 0, Math.min(bytes.length, 8))
  if (!head.startsWith('PK')) throw fail('docx-not-zip', '文件不是有效的 DOCX（缺少 ZIP 头）')
  const entries = readZipDirectory(bytes)
  const contentTypes = entries.get('[content_types].xml')
  const documentPart = entries.get('word/document.xml')
  if (!contentTypes || !documentPart) throw fail('docx-missing-part', 'DOCX 缺少必要的文档部件')
  if (entries.size > 400) pushWarning(warnings, 'DOCX 内含较多部件，已只读取正文')
  const xml = readZipEntry(bytes, documentPart).toString('utf8')
  if (!xml.includes('<w:document') && !xml.includes('<w:body')) throw fail('docx-corrupt', 'DOCX 正文部件结构异常')
  return readWordProcessingText(xml)
}

/* ---------- pdf ---------- */

function withDeadline(promise, deadlineAt, code, message) {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) return Promise.reject(fail(code, message))
  let timer
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(fail(code, message)), remaining)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

function asFailure(error) {
  if (error?.isDSHRemoteError) return error
  if (error?.name === 'PasswordException') return fail('pdf-encrypted', ENCRYPTED_MESSAGE)
  return fail('pdf-unreadable', 'PDF 无法解析，文件可能已损坏或被加密')
}

function pickSpecificFailure(current, next) {
  if (!current) return next
  if (!next) return current
  const currentRank = FAILURE_RANK[current.code] ?? 1
  const nextRank = FAILURE_RANK[next.code] ?? 1
  return nextRank > currentRank ? next : current
}

const PDF_WHITESPACE = new Set([0, 9, 10, 12, 13, 32])
const PDF_DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

const isPdfWhitespace = (code) => PDF_WHITESPACE.has(code)
const isPdfDelimiter = (code) => PDF_DELIMITER.has(code)

function readLiteralToken(source, start) {
  const bytes = []
  let index = start + 1
  let depth = 1
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (code === 0x5c) {
      const next = source.charCodeAt(index + 1)
      index += 2
      if (Number.isNaN(next)) break
      if (next === 0x6e) bytes.push(10)
      else if (next === 0x72) bytes.push(13)
      else if (next === 0x74) bytes.push(9)
      else if (next === 0x62) bytes.push(8)
      else if (next === 0x66) bytes.push(12)
      else if (next >= 0x30 && next <= 0x37) {
        let octal = next - 0x30
        let steps = 0
        while (steps < 2) {
          const digit = source.charCodeAt(index)
          if (digit < 0x30 || digit > 0x37) break
          octal = octal * 8 + (digit - 0x30)
          index += 1
          steps += 1
        }
        bytes.push(octal & 0xff)
      } else if (next === 0x0d) {
        if (source.charCodeAt(index) === 0x0a) index += 1
      } else if (next !== 0x0a) {
        bytes.push(next & 0xff)
      }
      continue
    }
    if (code === 0x28) {
      depth += 1
      bytes.push(0x28)
      index += 1
      continue
    }
    if (code === 0x29) {
      depth -= 1
      index += 1
      if (depth === 0) break
      bytes.push(0x29)
      continue
    }
    bytes.push(code & 0xff)
    index += 1
  }
  return { bytes: Buffer.from(bytes), next: index }
}

function readHexToken(source, start) {
  const end = source.indexOf('>', start + 1)
  if (end < 0) return { bytes: Buffer.alloc(0), next: source.length }
  const body = source.slice(start + 1, end).replace(/[^0-9A-Fa-f]/g, '')
  const bytes = Buffer.alloc(Math.floor(body.length / 2))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16)
  }
  return { bytes, next: end + 1 }
}

function skipDictionary(source, start) {
  let depth = 0
  let index = start
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (code === 0x3c && source.charCodeAt(index + 1) === 0x3c) { depth += 1; index += 2; continue }
    if (code === 0x3e && source.charCodeAt(index + 1) === 0x3e) {
      depth -= 1
      index += 2
      if (depth <= 0) return index
      continue
    }
    index += 1
  }
  return source.length
}

function decodeRunBytes(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: swapPairs(buffer, 2) }
  }
  let zeros = 0
  for (let index = 0; index < buffer.length; index += 1) if (buffer[index] === 0) zeros += 1
  if (buffer.length >= 2 && buffer.length % 2 === 0 && zeros / buffer.length > 0.25) return { cid: true }
  return { text: buffer.toString('latin1') }
}

/**
 * Only explicit Tj / TJ / ' / " text operators are treated as resume text.
 * Image XObjects never reach this function, and CID-shaped byte runs are
 * counted instead of being pasted in as latin1 garbage.
 */
function readContentText(source, maxChars = MAX_PDF_TEXT_CHARS) {
  const pieces = []
  const operands = []
  const arrays = []
  let ops = 0
  let pendingBreak = false
  let emitted = 0
  let truncated = false
  let index = 0

  const remember = (operand) => {
    if (arrays.length > 0) arrays[arrays.length - 1].items.push(operand)
    else operands.push(operand)
  }
  const emit = (buffer) => {
    const decoded = decodeRunBytes(buffer)
    if (decoded.cid) return
    const value = decoded.text
    if (!value) return
    if (emitted >= maxChars) { truncated = true; return }
    if (pendingBreak && pieces.length > 0) pieces.push('\n')
    pendingBreak = false
    const room = maxChars - emitted
    const clipped = value.length > room ? value.slice(0, room) : value
    if (clipped.length < value.length) truncated = true
    pieces.push(clipped)
    emitted += clipped.length
  }

  while (index < source.length) {
    if (emitted >= maxChars) { truncated = true; break }
    const code = source.charCodeAt(index)
    if (code === 0x28) {
      const token = readLiteralToken(source, index)
      remember({ type: 'bytes', value: token.bytes })
      index = token.next
      continue
    }
    if (code === 0x3c && source.charCodeAt(index + 1) === 0x3c) {
      operands.length = 0
      arrays.length = 0
      index = skipDictionary(source, index)
      continue
    }
    if (code === 0x3c) {
      const token = readHexToken(source, index)
      remember({ type: 'bytes', value: token.bytes })
      index = token.next
      continue
    }
    if (code === 0x5b) {
      const array = { type: 'array', items: [] }
      remember(array)
      arrays.push(array)
      index += 1
      continue
    }
    if (code === 0x5d) {
      if (arrays.length > 0) arrays.pop()
      index += 1
      continue
    }
    if (code === 0x2f) {
      let end = index + 1
      while (end < source.length && !isPdfWhitespace(source.charCodeAt(end)) && !isPdfDelimiter(source.charCodeAt(end))) end += 1
      remember({ type: 'name', value: source.slice(index + 1, end) })
      index = end
      continue
    }
    if (code === 0x25) {
      while (index < source.length) {
        const commentCode = source.charCodeAt(index)
        if (commentCode === 0x0a || commentCode === 0x0d) break
        index += 1
      }
      continue
    }
    if (isPdfWhitespace(code) || code === 0x7b || code === 0x7d) {
      index += 1
      continue
    }
    let end = index
    while (end < source.length && !isPdfWhitespace(source.charCodeAt(end)) && !isPdfDelimiter(source.charCodeAt(end))) end += 1
    if (end === index) { index += 1; continue }
    const token = source.slice(index, end)
    index = end
    if (/^[-+]?\d*\.?\d+$/.test(token)) {
      remember({ type: 'number', value: Number(token) })
      continue
    }
    if (token === 'Tj' || token === "'" || token === '"') {
      ops += 1
      if (token !== 'Tj' && pieces.length > 0) pieces.push('\n')
      const last = operands[operands.length - 1]
      if (last && last.type === 'bytes') emit(last.value)
      operands.length = 0
      continue
    }
    if (token === 'TJ') {
      ops += 1
      const last = operands[operands.length - 1]
      if (last && last.type === 'array') {
        for (const item of last.items) {
          if (item.type === 'bytes') emit(item.value)
          else if (item.type === 'number' && item.value < -200) pendingBreak = true
        }
      }
      operands.length = 0
      continue
    }
    if (token === 'Td' || token === 'TD' || token === 'TM' || token === 'Tm' || token === 'T*') {
      pendingBreak = true
      operands.length = 0
      continue
    }
    operands.length = 0
    arrays.length = 0
  }
  return { text: pieces.join(''), ops, truncated }
}

function inflatePdfStream(raw) {
  const attempts = [raw]
  if (raw.length > 2) attempts.push(raw.subarray(0, raw.length - 1))
  if (raw.length > 4) attempts.push(raw.subarray(0, raw.length - 2))
  for (const attempt of attempts) {
    try { return inflateRawSync(attempt, { maxOutputLength: MAX_PDF_BYTES }) } catch { /* try next trim */ }
  }
  return null
}

const ENCRYPTION_WINDOW = 8192

/**
 * /Encrypt is only meaningful inside the cross-reference trailer. Scanning the
 * whole file would let ordinary body text (an "/Encrypt <<" written as a
 * string) be mistaken for an encrypted document.
 */
function findEncryption(raw) {
  const marker = raw.lastIndexOf('startxref')
  const tailEnd = marker >= 0 ? marker : raw.length
  const tail = raw.slice(Math.max(0, tailEnd - ENCRYPTION_WINDOW), tailEnd)
  let dictionary = tail
  const trailerAt = tail.lastIndexOf('trailer')
  if (trailerAt >= 0) {
    dictionary = tail.slice(trailerAt)
  } else {
    const xrefAt = tail.lastIndexOf('/Type /XRef')
    if (xrefAt >= 0) dictionary = tail.slice(Math.max(0, xrefAt - ENCRYPTION_WINDOW))
  }
  return /\/Encrypt\s*(?:<<|\d+\s+\d+\s+R\b)/.test(dictionary)
}

const PDF_IMAGE_SUBTYPE = /\/Subtype\s*\/Image\b/
const PDF_FLATE = /\/FlateDecode\b/

/**
 * `stream` must be a standalone keyword. A blind indexOf also matches the tail
 * of `endstream`, so a stray "endstream" in the preamble used to be read as a
 * stream start and shift every later stream by one.
 */
function findStreamKeyword(raw, from) {
  let at = raw.indexOf('stream', from)
  while (at >= 0) {
    const before = at === 0 ? 0 : raw.charCodeAt(at - 1)
    const after = raw.charCodeAt(at + 6)
    const isWordChar = (before >= 0x30 && before <= 0x39)
      || (before >= 0x41 && before <= 0x5a)
      || (before >= 0x61 && before <= 0x7a)
    const validAfter = Number.isNaN(after) || after === 0x09 || after === 0x0a || after === 0x0d || after === 0x20
    if (!isWordChar && validAfter) return at
    at = raw.indexOf('stream', at + 6)
  }
  return -1
}

function extractPdfTextFallback(bytes, deadlineAt) {
  const raw = bytes.toString('latin1')
  const collected = []
  let streams = 0
  let textOps = 0
  let collectedChars = 0
  let truncated = false
  let cursor = 0

  while (streams < MAX_PDF_STREAMS) {
    if (Date.now() > deadlineAt) throw fail('pdf-timeout', TIMEOUT_MESSAGE)
    const at = findStreamKeyword(raw, cursor)
    if (at < 0) break
    const windowStart = Math.max(0, at - PDF_DICTIONARY_WINDOW)
    const window = raw.slice(windowStart, at)
    const marker = window.lastIndexOf('<<')
    const dictionary = marker >= 0 ? window.slice(marker) : ''
    let start = at + 6
    if (raw.charCodeAt(start) === 0x0d) start += 1
    if (raw.charCodeAt(start) === 0x0a) start += 1
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    cursor = end + 9
    streams += 1
    if (PDF_IMAGE_SUBTYPE.test(dictionary)) continue
    let data = Buffer.from(raw.slice(start, end), 'latin1')
    if (PDF_FLATE.test(dictionary)) {
      const inflated = inflatePdfStream(data)
      if (!inflated) continue
      data = inflated
    }
    if (data.length > MAX_PDF_BYTES) continue
    const content = data.toString('latin1')
    if (!content.includes('Tj') && !content.includes('TJ')) continue
    const parsed = readContentText(content, MAX_PDF_TEXT_CHARS - collectedChars)
    textOps += parsed.ops
    const value = parsed.text.trim() ? parsed.text : ''
    if (value) {
      const room = MAX_PDF_TEXT_CHARS - collectedChars
      const slice = value.length > room ? value.slice(0, room) : value
      if (slice.length < value.length) truncated = true
      collected.push(slice)
      collectedChars += slice.length
    }
    if (parsed.truncated) truncated = true
    if (truncated) break
    if (collected.length >= MAX_PDF_PAGES) break
  }
  return { text: collected.join('\n\n'), streams, textOps, truncated }
}

function judgeExtractedText(text, textOps, raw) {
  const meaningful = text.replace(/\s+/g, '')
  if (meaningful) {
    const letters = (text.match(/[A-Za-z\u00C0-\u024F\u0370-\u03FF\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
    // A readable body wins over the Identity-font hint: a symbol/icon subset
    // in the same file must not invalidate text that is plainly legible.
    if (letters > 0 && letters / meaningful.length >= 0.4) return text
  }
  const embeddedIdentity = Boolean(raw)
    && /\/Encoding\s*\/Identity-[HV]\b/.test(raw)
    && !/\/ToUnicode\b/.test(raw)
  if (embeddedIdentity) throw fail('pdf-encoding', ENCODING_MESSAGE)
  if (!meaningful) {
    if (textOps === 0) throw fail('pdf-scanned', SCANNED_MESSAGE)
    throw fail('pdf-encoding', ENCODING_MESSAGE)
  }
  throw fail('pdf-encoding', ENCODING_MESSAGE)
}

function isMissingModule(error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return true
  return /Cannot find (module|package)/.test(String(error?.message || ''))
}

async function loadVendoredPdfjs() {
  if (pdfRuntime.loader) return await pdfRuntime.loader()
  let module
  try {
    module = await import(new URL('./vendor/pdfjs/pdf.mjs', import.meta.url).href)
  } catch (error) {
    if (isMissingModule(error)) return null
    throw fail('pdfjs-broken', 'PDF 解析组件加载失败，请上传 DOCX 或 TXT')
  }
  if (!module || typeof module.getDocument !== 'function') {
    throw fail('pdfjs-broken', 'PDF 解析组件不可用，请上传 DOCX 或 TXT')
  }
  return module
}

async function extractPdfTextWithPdfjs(pdfjs, bytes, deadlineAt) {
  try {
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href
    }
  } catch { /* fake worker fallback is handled by the deadline */ }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const task = pdfjs.getDocument({
    data: copy,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  })
  const dispose = (value) => {
    try {
      const pending = typeof value === 'function' ? value() : null
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch { /* ignore */ }
  }
  let document = null
  try {
    document = await withDeadline(task.promise, deadlineAt, 'pdf-timeout', TIMEOUT_MESSAGE)
    const totalPages = Number(document.numPages) || 0
    const pages = Math.min(totalPages, MAX_PDF_PAGES)
    const parts = []
    let collected = 0
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      if (Date.now() >= deadlineAt) throw fail('pdf-timeout', TIMEOUT_MESSAGE)
      const page = await withDeadline(document.getPage(pageNumber), deadlineAt, 'pdf-timeout', TIMEOUT_MESSAGE)
      const content = await withDeadline(page.getTextContent(), deadlineAt, 'pdf-timeout', TIMEOUT_MESSAGE)
      let text = ''
      for (const item of content.items || []) {
        if (typeof item?.str !== 'string') continue
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      const room = MAX_PDF_TEXT_CHARS - collected
      parts.push(text.length > room ? text.slice(0, room) : text)
      collected += Math.min(text.length, room)
      try { page.cleanup() } catch { /* ignore */ }
      if (collected >= MAX_PDF_TEXT_CHARS) break
    }
    return { text: parts.join('\n\n'), pages: totalPages, parsedPages: parts.length }
  } finally {
    dispose(() => document?.destroy())
    dispose(() => task?.destroy())
  }
}

async function readPdf(bytes, warnings) {
  const head = bytes.toString('latin1', 0, Math.min(bytes.length, 8))
  if (!head.includes('%PDF-')) throw fail('pdf-header-missing', '不是有效的 PDF 文件（缺少 %PDF 头）')
  const raw = bytes.toString('latin1')
  if (findEncryption(raw)) throw fail('pdf-encrypted', ENCRYPTED_MESSAGE)

  // One bounded request budget, with time reserved for the built-in fallback.
  // PDF.js cannot consume the entire allowance and leave a second unbounded pass.
  const overallDeadline = Date.now() + pdfRuntime.deadlineMs
  const pdfjsDeadline = Math.min(overallDeadline, Date.now() + Math.max(10, Math.floor(pdfRuntime.deadlineMs * 0.8)))
  let bestError = null
  let pdfjs = null

  try {
    pdfjs = await loadVendoredPdfjs()
  } catch (error) {
    bestError = asFailure(error)
  }

  if (pdfjs) {
    try {
      const result = await extractPdfTextWithPdfjs(pdfjs, bytes, pdfjsDeadline)
      const text = judgeExtractedText(result.text, result.text.trim() ? 1 : 0, raw)
      if (result.pages > MAX_PDF_PAGES) {
        pushWarning(warnings, `PDF 共 ${result.pages} 页，只解析了前 ${MAX_PDF_PAGES} 页`)
      }
      return text
    } catch (error) {
      const failure = asFailure(error)
      if (failure.code === 'hr-interview/resume-pdf-encrypted') throw failure
      bestError = pickSpecificFailure(bestError, failure)
      pushWarning(warnings, failure.code === 'hr-interview/resume-pdf-timeout'
        ? 'PDF.js 解析超时，已改用内置文本提取'
        : 'PDF.js 解析未完成，已改用内置文本提取')
    }
  } else if (!bestError) {
    pushWarning(warnings, '未随包 PDF.js，已使用内置降级解析，复杂排版可能丢失')
  }

  try {
    if (Date.now() >= overallDeadline) throw fail('pdf-timeout', TIMEOUT_MESSAGE)
    const fallback = extractPdfTextFallback(bytes, overallDeadline)
    if (fallback.streams === 0) throw fail('pdf-unreadable', 'PDF 内容损坏，没有可读取的页面数据')
    if (fallback.truncated) {
      pushWarning(warnings, `PDF 文字量过大，只保留了前 ${MAX_PDF_TEXT_CHARS} 字`)
    }
    const text = judgeExtractedText(fallback.text, fallback.textOps, raw)
    if (bestError) pushWarning(warnings, '已改用内置降级解析，复杂排版可能丢失')
    return text
  } catch (error) {
    throw pickSpecificFailure(bestError, asFailure(error))
  }
}

/* ---------- shared output shaping ---------- */

function normalizeText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/\uFEFF/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\t */g, '\t')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
}

export async function parseResumeFile({ name, data, maxCharacters = MAX_RESUME_CHARACTERS } = {}) {
  try {
    const limit = normalizeLimit(maxCharacters)
    const bytes = toBytes(data)
    if (bytes.length === 0) throw fail('empty-file', '文件是空的，请重新选择')
    if (bytes.length > MAX_RESUME_BYTES) throw fail('file-too-large', '文件超过 8 MiB，请压缩后再试')
    const { fileName, format } = inspectName(name)
    const warnings = []

    let raw = ''
    if (format === 'txt' || format === 'md') raw = readPlainText(bytes, warnings)
    else if (format === 'docx') raw = readDocx(bytes, warnings)
    else raw = await readPdf(bytes, warnings)

    const text = normalizeText(raw)
    if (!text) throw fail('empty-text', `没有从${FORMAT_LABELS[format]}里解析出可用文字`)
    const truncated = text.length > limit
    const output = truncated ? text.slice(0, limit).replace(/\s+$/g, '') : text
    if (truncated) pushWarning(warnings, `原文超出 ${limit} 字上限，已截断保留前 ${limit} 字`)
    return {
      text: output,
      fileName,
      format,
      characters: output.length,
      truncated,
      warnings,
    }
  } catch (error) {
    if (error?.isDSHRemoteError) throw error
    throw fail('internal', '简历解析失败，请换一个文件再试')
  }
}
