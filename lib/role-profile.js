const JAVA = /\bjava\b/i
const SERVER = /后端|服务端|backend|back-end|server[- ]side/i
const ANDROID = /\bandroid\b|安卓/i
const CLIENT = /前端|客户端|前台开发|\bios\b|\bandroid\b|安卓|\bfrontend\b/i
const SERVER_WORK = /spring\s*(?:boot|cloud)|微服务|接口开发|开发接口|服务端接口|后端接口|REST\s*API/i
const GENERIC_SERVER = /^\s*(?:后端|服务端)(?:开发)?(?:工程师)?\s*$/u
const OPERATIONS = /^(?:(?:linux|it|系统|云平台|平台|云计算|k8s|kubernetes|基础设施)\s*)?运维(?:开发)?(?:工程师|专员|岗(?:位)?)?$|^(?:devops|sre|site reliability)(?:\s*(?:工程师|engineer))?$/i
const OPERATIONS_CONTEXT = /(?:linux|系统|平台|云|k8s|容器|基础设施)\s*运维|运维(?:开发|工程师)|\b(?:devops|sre)\b|site reliability|线上值班|故障响应|发布回滚/i
const OPERATIONS_DUTIES = [
  {
    duty: '监控采集与告警排查', hint: 'Prometheus 监控告警', clues: /prometheus|grafana|exporter|告警|监控采集|监控指标|可观测/i, kind: 'incident',
    questions: [
      '假设告警显示请求量突然归零，但业务日志里还有正常请求。你会怎样区分采集链路中断、查询写错和业务真的掉量？',
      '节点 CPU 告警反复触发，但服务延迟基本稳定。你会看哪些指标决定是否需要立即处置，又怎样验证调整告警的效果？',
    ],
    points: ['核对采集链路、业务日志和指标查询', '区分监控异常与真实业务故障'],
  },
  {
    duty: 'Linux 服务与日志排查', hint: 'Linux systemd 日志', clues: /\blinux\b|systemd|journalctl|systemctl|磁盘(?:容量|空间|满)|\binode\b|服务(?:启动|重启)|进程异常/i, kind: 'incident',
    questions: [
      '一台 Linux 服务器重启后服务起不来，应用日志还没生成。你会先检查哪些系统状态和日志，再怎样定位原因？',
      '假设磁盘空间报警，清理了几个大文件后可用空间却没有增加。你会怎样区分文件句柄、挂载点和 inode 等原因？',
    ],
    points: ['分层查看服务状态、系统日志和资源', '说明恢复后的验证办法'],
  },
  {
    duty: '网络连通性与 DNS 排查', hint: 'DNS TCP 连通性', clues: /\bdns\b|域名解析|tcp|udp|网络连通|抓包|路由表|防火墙|连接超时|端口不通|丢包/i, kind: 'incident',
    questions: [
      '假设同一域名在一台机器可以访问，在另一台机器偶尔无法访问。你会怎样区分 DNS 解析、网络连通性和服务端的问题？',
      '服务偶尔连不上下游，直连 IP 有时也超时。你会优先收集什么信息来区分丢包、连接积压和下游不响应？',
    ],
    points: ['分层验证解析、连通性和服务响应', '说明使用什么观测区分不同原因'],
  },
  {
    duty: 'Kubernetes 容器与发布故障', hint: 'Kubernetes Pod 部署', clues: /kubernetes|\bk8s\b|\bpod\b|\bkubelet\b|crashloopbackoff|容器编排|探针检查|镜像拉取/i, kind: 'incident',
    questions: [
      '假设 Kubernetes 中部分 Pod 更新后持续重启。你会先看哪些事件、日志和探针状态，再决定是否回滚？',
      '集群里 Pod 显示运行，但一部分请求仍收不到响应。你会如何检查服务发现、就绪状态与流量分发？',
    ],
    points: ['能用事件、容器日志和探针缩小范围', '说明验证恢复的方法'],
  },
  {
    duty: '发布回滚与自动化运维', hint: 'CI CD 发布 回滚', clues: /发布|回滚|自动化运维|运维脚本|上线流程|ci\s*[/ ]\s*cd|ansible|jenkins|terraform|灰度/i, kind: 'project',
    questions: [
      '假设灰度发布后错误率缓慢上升，变更还改了数据库结构。你会用什么信号决定回滚，并怎样确认回滚后数据与服务兼容？',
      '假设批量运维脚本执行到一半失败。你会怎样记录每台机器的状态，让重试可恢复并避免重复执行已经完成的操作？',
    ],
    points: ['说明止损或重试的具体判断依据', '检查变更状态和恢复结果'],
  },
]

const backendDuties = [
  {
    duty: '后端 API 开发与联调', clues: /接口(?:设计|开发|联调)|开发(?:后端)?接口|\bapi\b|\brest(?:ful)?\b|spring\s*boot|controller/i,
    kind: 'project',
    questions: [
      '假设你要新增一个订单查询接口。客户端有时会漏传参数，旧版客户端也还在使用。你会怎么设计参数校验、错误响应和兼容测试？',
      '假设新接口的联调环境能返回数据，上线后部分请求却得到空结果。你会怎么区分是输入、权限、数据问题还是接口实现有误？',
    ],
    points: ['说明接口约定、参数约束和兼容性', '说明会验证的成功与失败场景'],
  },
  {
    duty: '数据库查询与索引优化', clues: /慢\s*sql|慢查询|索引|执行计划|\bexplain\b|数据库查询/i,
    kind: 'incident',
    questions: [
      '订单列表按用户和时间查询，上线一段时间后变慢。你会先看哪些执行计划和数据分布，再决定要不要加组合索引？',
      '给订单查询加索引后，测试环境变快了，但写入变慢了。你会怎么验证索引的整体收益，并决定保留还是回滚？',
    ],
    points: ['区分查询计划、数据分布和索引选择', '能验证读写开销及优化前后差异'],
  },
  {
    duty: '接口重试、事务与幂等', clues: /幂等|事务|隔离级别|重复提交|重复扣|重复下单|\btransaction\b/i,
    kind: 'principle',
    questions: [
      '假设订单创建请求已写入数据库，但客户端超时后又发了一遍。你会怎么识别同一笔请求，并保证订单只创建一次？',
      '假设订单写入成功后，通知下游失败了。你会怎么处理重试和状态记录，并验证重复通知不会造成额外操作？',
    ],
    points: ['解释如何识别重复请求和处理并发', '提出超时、中途失败与重试的验证办法'],
  },
  {
    duty: '并发性能与服务故障排查', clues: /并发|P99|线程池|\bjvm\b|\bgc\b|雪崩|排障|延迟|下游.{0,8}(?:变慢|超时)|\blatency\b/i,
    kind: 'incident',
    questions: [
      '流量上涨后接口的 P99 延迟突然增加，CPU 占用却没有明显变化。你会查看哪些监控和日志，怎样判断是应用、数据库还是下游慢？',
      '下游服务偶发超时，应用的线程池开始排队。你会先采取什么措施减轻影响，再用什么指标判断服务是否恢复？',
    ],
    points: ['能用服务指标和依赖链路缩小故障范围', '说明止损动作及恢复验证'],
  },
]

const androidDuties = [
  {
    duty: 'Android 页面状态与生命周期', clues: /生命周期|activity|viewmodel|页面状态/i, kind: 'project',
    questions: [
      '用户正在填表，旋转屏幕后表单内容丢了。你会怎样判断状态应该存在哪一层，并验证旋转和进程被系统回收后的恢复行为？',
      '假设用户很快退出并重新打开页面，上一轮网络回调又晚到了一次。你会怎样防止旧结果覆盖新状态？',
    ],
    points: ['区分页面重建和进程回收', '说明状态恢复与过期回调的验证方法'],
  },
  {
    duty: 'Android 卡顿与崩溃排查', clues: /崩溃|卡顿|\bANR\b|主线程/i, kind: 'incident',
    questions: [
      '应用在少数设备上打开列表会卡住，但开发机上正常。你会收集哪些设备和线程信息，再怎样缩小问题范围？',
      '新版本的列表滑动偶尔掉帧。你会怎样量化卡顿，并验证原因在布局、图片处理还是主线程工作？',
    ],
    points: ['检查主线程、设备差异和失败现场', '说明怎样复现并验证修复'],
  },
]

const embeddedDuties = [
  {
    duty: '外设驱动与板卡联调', clues: /驱动|板卡|联调|I[2²]C|SPI|UART|总线/i, kind: 'incident',
    questions: [
      '一块新板通过 I²C 读不到传感器。你会按什么顺序检查供电、引脚配置、总线波形和设备地址？',
      '传感器偶尔丢一次采样，重新上电后又能读。你会用哪些观测区分硬件信号问题和驱动时序问题？',
    ],
    points: ['分层验证供电、信号和软件配置', '说明如何保留可复现的证据'],
  },
  {
    duty: '固件实时性与故障定位', clues: /固件|中断|实时|看门狗|采样/i, kind: 'incident',
    questions: [
      '固件升级后设备在高负载下偶发重启。你会怎样保留复位原因，区分看门狗超时、电源波动和代码异常？',
      '假设定时采样任务偶尔错过周期，你会怎样测量实际调度延迟，并判断是否与中断处理时间有关？',
    ],
    points: ['记录异常时序和复位线索', '给出高负载复现与验证方法'],
  },
]

const restaurantDuties = [
  {
    duty: '点餐、核单与上菜', clues: /点餐|上菜|核单|传菜|报菜/i, kind: 'behavioral',
    questions: [
      '忙时两桌同时催餐，其中一桌说菜品上错了。你会先核对什么，怎么和厨房交接，再怎样向两桌客人反馈？',
      '厨房告诉你客人刚点的一道菜售完了，你会怎么解释、介绍备选，并核对订单是否已更新？',
    ],
    points: ['先核实桌号、菜品和订单状态', '让客人知道下一步和预计等待时间'],
  },
  {
    duty: '接待与等座安排', clues: /接待|等座|排队/i, kind: 'behavioral',
    questions: [
      '一位客人等座时发现后来的人先入座了，表示不满。你会核对哪些信息，又怎么解释和协调？',
      '两组客人同时到店，一组有预约，另一组已经在门口等了一会儿。你会怎么核对安排，并向双方说明预计等待时间？',
    ],
    points: ['核对预订、排队顺序和桌位状态', '清楚告知安排和预计等待时间'],
  },
  {
    duty: '投诉与服务补救', clues: /投诉|客诉/i, kind: 'behavioral',
    questions: [
      '客人说菜品和菜单描述不符，并希望立即处理。你会先确认什么，哪些情况需要请值班经理协助？',
      '客人结账时认为有一道菜重复收费。你会怎么核对订单和账单，并向客人说明后续处理？',
    ],
    points: ['核实事实并回应客人的核心诉求', '说明可处理范围和后续交接'],
  },
]

export function backendRole(role) {
  return SERVER.test(role) && !CLIENT.test(role)
}

export function operationsRole(role) {
  return OPERATIONS.test(role)
}

export function roleDefaults(role) {
  if (operationsRole(role)) return OPERATIONS_DUTIES
  if (backendRole(role)) return backendDuties
  if (ANDROID.test(role)) return androidDuties
  if (/嵌入式|单片机|\bfirmware\b/i.test(role)) return embeddedDuties
  if (/^(?:(?:餐厅|餐饮|餐馆)\s*)?服务员(?:\s*岗位)?$/u.test(role)) return restaurantDuties
  return []
}

export function matchProfileDuty(role, duty, text) {
  const entry = roleDefaults(role).find((item) => item.duty === duty)
  if (!entry) return null
  // A Prometheus question mentioning Kubernetes still belongs to monitoring.
  if (operationsRole(role)) return OPERATIONS_DUTIES.find((item) => item.clues.test(text))?.duty === duty
  return entry.clues.test(text) ? true : null
}

export function roleDutyHint(role, duty) {
  return roleDefaults(role).find((entry) => entry.duty === duty)?.hint || ''
}

export function roleSearchNames(role) {
  if (operationsRole(role)) return ['Linux 运维', '系统运维', '运维工程师']
  if (JAVA.test(role) && backendRole(role)) return ['Java 后端', 'Java 服务端', 'Java 开发']
  if (GENERIC_SERVER.test(role)) return ['后端开发', '服务端开发']
  return []
}

export function matchTechnicalRole(role, heading, introduction) {
  const context = `${heading} ${introduction}`
  if (operationsRole(role)) {
    if (/^(?:运维|云平台运维)\s*(?:面经|面试|一面|二面)/u.test(heading)) return true
    return !/Android|前端开发|后端开发|Java\s*开发|服务员/i.test(heading) && (OPERATIONS_CONTEXT.test(context) || OPERATIONS.test(heading.trim()))
  }
  const javaBackend = JAVA.test(role) && backendRole(role)
  if (javaBackend || GENERIC_SERVER.test(role)) {
    const backendEvidence = SERVER.test(heading) || (!ANDROID.test(introduction) && (SERVER.test(context) || SERVER_WORK.test(context)))
    return !CLIENT.test(heading) && backendEvidence && (!javaBackend || JAVA.test(context))
  }
  if (ANDROID.test(role)) return !SERVER.test(heading) && ANDROID.test(context)
  return null
}

export function conflictingRoleQuestion(role, question) {
  if (backendRole(role)) return ANDROID.test(question) || /AndroidManifest|\bActivity\b.{0,12}生命周期|\bJetpack\b|小程序|组件渲染/i.test(question)
  if (ANDROID.test(role)) return SERVER.test(question) && !ANDROID.test(question)
  return false
}
