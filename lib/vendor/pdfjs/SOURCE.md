# 随包 PDF.js（vendor）

`lib/resume-parser.js` 从这里动态加载 `pdf.mjs`。模块缺席时，仅 PDF 进入受限的内置降级提取器并返回 warning；DOCX、TXT、MD 不依赖 PDF.js。

## 固定版本与完整性

- 包：`pdfjs-dist`
- 版本：**4.10.38**（固定版本，不使用浮动范围）
- 许可证：**Apache-2.0**，`LICENSE` 已按上游原文保存
- 上游：<https://www.npmjs.com/package/pdfjs-dist> / <https://github.com/mozilla/pdf.js>
- 运行环境：Node `^22.19.0 || >=24.0.0`，使用 `legacy/build` ESM

| 本目录文件 | 上游文件 | 期望字节数 | 期望 SHA-256（base64） |
| --- | --- | ---: | --- |
| `pdf.mjs` | `legacy/build/pdf.min.mjs` | 398237 | `ROxvARAn7nd5E4a2bBSHal/CniC/BDPAfGcm//chK3I=` |
| `pdf.worker.mjs` | `legacy/build/pdf.worker.min.mjs` | 1417586 | `vYiAUXiibHKduMAQeltjDLkA7AcPTYx1KaPkVTCv1B0=` |
| `LICENSE` | `LICENSE` | — | Apache-2.0 原文 |

压缩模块仅改了本地文件名，不修改其内容；哈希用于确认下载完整且来源内容一致。

## 当前状态（2026-11-15）

`LICENSE` 与本说明已落盘；两个 `.mjs` 模块仍待完整字节下载。`web_fetch` 对大文本只保留约 100000 字节，不能用它转写或拼接模块。`E:/Dsh_Auto/.tmp/fetch-pdfjs.mjs` 是固定 URL、固定大小和哈希的下载脚本；命令执行器恢复后运行：

```bash
cd E:/Dsh_Auto
node .tmp/fetch-pdfjs.mjs
```

成功判据：两个文件的字节数与 SHA-256 完全符合上表，动态导入打印 `version: 4.10.38`、`getDocument: function`。失败时不写入目标文件，也不把截断内容当完整模块。

## 解析边界

- PDF.js 加载、整篇页提取有总 deadline；内置回退使用独立的有限预算。
- 回退只处理未压缩与 FlateDecode 文本流，严格识别文本操作符，限制流数量、单流/总解压体积与总文本量。
- 加密 PDF 返回 `hr-interview/resume-pdf-encrypted`；字体编码无法可靠恢复时返回 `hr-interview/resume-pdf-encoding`；确实没有文字层时返回 `hr-interview/resume-pdf-scanned`。
- `resumeParserTestHooks.setPdfDeadline(ms)` 与 `setVendoredPdfLoader(fn|null)` 仅供测试，不改变发布运行时的输入边界。

## 发布边界

本目录只允许上述 4 个文件（含本说明应为 4 个：`pdf.mjs`、`pdf.worker.mjs`、`LICENSE`、`SOURCE.md`）。模型权重、个人简历、用户上传样本、缓存和测试 fixture 一律不得进入本目录或安装包。
