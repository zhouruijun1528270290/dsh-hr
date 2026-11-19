import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseResumeFile } from '../lib/resume-parser.js'

const vendor = (name) => fileURLToPath(new URL(`../lib/vendor/pdfjs/${name}`, import.meta.url))

function buildToUnicodePdf() {
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <5F20>
<0002> <4E09>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`
  const content = 'BT /F1 12 Tf 72 720 Td <00010002> Tj ET'
  const objects = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticCID /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticCID /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /CIDToGIDMap /Identity >>',
    `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /FontDescriptor /FontName /SyntheticCID /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(source, 'latin1')
    source += `${index} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(source, 'latin1')
  source += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let index = 1; index < objects.length; index += 1) source += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  source += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(source, 'latin1')
}

test('PDF.js vendor 文件完整，实际模块版本固定为 4.10.38', async () => {
  assert.ok(existsSync(vendor('pdf.mjs')) && existsSync(vendor('pdf.worker.mjs')), 'PDF.js vendor 未落盘；先执行 .tmp/fetch-pdfjs.mjs')
  const source = await readFile(vendor('pdf.mjs'))
  const worker = await readFile(vendor('pdf.worker.mjs'))
  assert.equal(source.length, 398237)
  assert.equal(worker.length, 1417586)
  const pdfjs = await import(pathToFileURL(vendor('pdf.mjs')).href)
  assert.equal(pdfjs.version, '4.10.38')
  assert.equal(typeof pdfjs.getDocument, 'function')
})

test('真实 PDF.js 通过 ToUnicode CMap 提取 Identity-H 中文，而非依赖降级猜测', async () => {
  assert.ok(existsSync(vendor('pdf.mjs')) && existsSync(vendor('pdf.worker.mjs')), 'PDF.js vendor 未落盘；先执行 .tmp/fetch-pdfjs.mjs')
  const result = await parseResumeFile({ name: 'synthetic-cid.pdf', data: buildToUnicodePdf() })
  assert.equal(result.format, 'pdf')
  assert.match(result.text, /张三/)
  assert.equal(result.truncated, false)
})
