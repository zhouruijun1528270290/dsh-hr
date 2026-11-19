// Reviewed delivery wording. Imported and retrieved questions retain their original source text.
const reviewedWording = new Map([
  ['答案错了，你怎么判断问题出在切分、召回、重排还是生成？请给出可执行的定位步骤。',
    '假设一个 RAG 系统给出了错误答案，你怎么判断问题出在切分、召回、重排还是生成？请给出可执行的定位步骤。'],
  ['召回率提高了，最终答案准确率反而下降：讲一次你遇到的真实情况，根因和修复是什么？',
    '假设一个 RAG 系统的检索召回率提高了，但最终答案的准确率反而下降。你会怎么定位原因并修复？如果遇到过类似情况，可以结合实际经历说明。'],
  ['压缩失真导致任务做错，讲一次：怎么发现的、怎么恢复、怎么回滚？',
    '假设一次会话压缩失真，导致系统做错了任务。你会怎么发现问题、恢复任务，并判断什么时候需要回滚？'],
  ['讲一次你负责的事情失败了：你的判断错在哪，代价是什么，之后怎么避免同类问题？',
    '如果你负责过一项未达到预期的工作，可以讲讲你当时的判断、实际影响和后续改进。如果没有类似经历，可以说说你会怎样复盘一次未达到预期的工作。'],
  ['某个下游依赖开始变慢，你的服务跟着雪崩，你当时怎么先稳住线上再定位？',
    '假设下游依赖响应变慢，导致你负责的服务出现大量请求失败。你会怎样先稳住服务，再定位故障？'],
  ['你是如何使用 AIGC 来生成指定格式的 json 的？请简述整个过程。',
    '如果你用过 AIGC 生成指定格式的 JSON，请简述过程。如果没有，可以说明你会怎样做。'],
  ['简述一下你是怎么实现的高并发采集',
    '如果不使用 Scrapy，你会怎样实现高并发采集？如果有相关项目经历，也可以结合实际做法说明。'],
  ['你的网站，你觉得如果访问量上去了，最先出现瓶颈问题的点是哪？怎么优化？',
    '假设一个网站的访问量明显增加，你会怎样判断哪里最可能先出现瓶颈？确认之后会怎么优化？'],
  ['发现列表接口在数据量涨到 10 万条后响应从 200ms 变成 8s，你用哪些手段定位是 N+1 查询还是慢 SQL？',
    '假设一个列表接口在数据量涨到 10 万条后，响应时间从 200ms 增加到 8s。你会怎样判断是 N+1 查询还是慢 SQL？'],
])

const precedingAnswer = /^(?:(?:(?:你(?:刚才)?的|这个|上一个)?(?:答案|回答|结论|方案)|你(?:刚才)?(?:答|说|做)|这样|这么做)\s*(?:是|还|有点)?\s*(?:错了|错误|不对|不正确|不成立|不够|不行|有问题|有误|没说清)|(?:答错了|做错了|错了|不对|再答|重新回答|我问的是)(?:[，,。；;：:\s]|$))/u
const unresolvedReference = /^(?:你(?:刚才|刚刚|前面|上面|之前)?(?:提到|提了|说到|说过|说了|说这是|说[「“"‘'])|(?:根据|结合|接着|回到)(?:你)?(?:刚才|之前|上述|上面|前面|你的回答)|(?:刚才|上述|上面|上一题|前面)(?:的|那个|这个|那种|提到的)|(?:这|那)(?:个|套|种|道)?(?:\s*bug\b|做法|解法|方案|答案|结论)(?![：:]\s*[^，。]+))/iu
const unspecifiedIncident = /^(?:答案|输出|结果|系统|服务|接口)(?:突然)?(?:变差了|出错了|错误了|挂了|失败了|断了|卡住了)[，,。；;：:]/u
const assumedProjectFact = /^(?:你(?:在|们?的?)?(?:项目|系统|服务)(?:里|中)(?:有|已经|用了)|订阅连接断了怎么办[？?]\s*你的重连逻辑)|[，,。；;：:？！?!——]\s*你(?:刚才)?说(?:项目里|这是|[「“"‘'])/u
const englishReference = /^(?:that(?:'s| is) (?:wrong|not (?:right|correct))|(?:your|the previous) (?:answer|conclusion) (?:is|was) (?:wrong|incorrect)|as you (?:just )?(?:said|mentioned)\b|based on your previous answer\b)/iu

// Null means the main question needs context from its source before it can be selected.
export function mainQuestionWording(value) {
  if (typeof value !== 'string') return null
  const question = value.trim()
  if (!question) return null
  const wording = reviewedWording.get(question)
  if (wording) return wording
  const judgment = precedingAnswer.exec(question)
  if (judgment && !/^(?:时|的情况下)/u.test(question.slice(judgment[0].length))) return null
  if ([unresolvedReference, unspecifiedIncident, assumedProjectFact, englishReference].some((pattern) => pattern.test(question))) return null
  return question
}
