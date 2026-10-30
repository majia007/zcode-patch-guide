// 缺口说明：ZCode 气泡不显示 token 用量，官方隐藏面板只有轮次粒度且不在气泡旁。
// 本脚本注入 index.html 的 head 闭合标签前，旁路解码 MessagePort 遥测帧，实现三处 UI：
// 1) 流式输出时在加载槽 spin 图标右侧显示 t/s：当前计时段的字符量估算 token ÷ 段时长
//    （首 chunk 起连续计时，簇间间隙摊入分母，防成簇到达把瞬时速率顶虚高）；中断超阈值
//    显示「等待响应」并重置计时，恢复后从新段重算。增量两路汇入：遥测 stream.chunk 的
//    channel 只有 thought/text（host zod 实证），工具调用段（toolCall 输入 JSON 流）只走
//    conversation 行级帧 row.delta（path=inputText；3.14.3 起 payload 无 kind 字段，行级帧
//    按 deltas 数组识别，探针实测一次会话 1391 帧全无 kind）——漏了这路，工具调用流式期速度位无数据
// 2) 回复消息下方常驻一行统计：token 总数 + 缓内/缓外/输出三桶及占比 + 首字（本轮第一段
//    TTFT，先于平均显示）、平均速度、请求次数（流式中显示进行中序号「第 N 次请求…」——用量帧在
//    请求结束时才报、末请求未入账，N 取 started 计数与已完成数+1 较大者）、总耗时/等待/响应/执行、
//    累计。总耗时=turn 墙钟（与官方「工作中/已工作 X」同口径：起点→当前/结束，含请求间
//    执行时间）——流式中从首个请求 started 帧（官方 turnHeader.startedAt 的近似）单调走表，
//    完成取 turn.terminal 帧 durationMs（agent 同源终值，漏帧退帧计三桶和），重开/历史从
//    帧计持久化（r 字段）读回，都无才退 db 墙钟（首请求→末请求，间隙可得）；权威校正按
//    parentID 切组——合成行开新 turn（后台子代理完成注入/AskUserQuestion 应答）即新组，
//    每个可视块一条独立统计（首块时间止于后台任务创建，不含后台等待）；组墙钟更大时取大
//    覆写 durMs（漏帧/陈旧记录兜底）。
//    等待=请求区间内首字等待+尾部静默（db 口径：请求时长-生成段）；响应=生成段合计（各请求
//    首 chunk→末 chunk，与平均 t/s 同分母）；执行=请求间间隙（工具执行/审批，总≈等待+响应+
//    执行，括号内三段对账显示）；
//    平均/等待/首字依赖 readSessionDebug.rounds 的生成段
//    配对（200 轮上限内有效）；累计=到本条消息为止的会话 token——完成 turn 取权威校正
//    按消息序累积的组快照（t.cum），流式 turn 取会话账本现值（usage.delta 增量 + finalize
//    全量覆盖，此刻其增量全属本条），修各条徽标同显一个会话总量的旧缺口（实测：三条同 831k）。
//    流式期由帧计时驱动；turn 终态与会话打开时经双 RPC 权威校正（readSession 的 messages
//    给组归属+请求总时长、readSessionDebug.rounds 给 token 与生成段——token 以 rounds.usage
//    为准，与调试面板同源同值）。注意 rounds 是 agent 进程内存态（探针实测：重启后
//    requestIndex 从 1 重编、重启前轮次物理缺失，db 里虽有 time_to_first_token_ms 但宿主
//    RPC 不暴露）——历史轮次的生成段配对必落空，等待/平均/首字由帧计持久化兜底
//    （turn.terminal 落 localStorage，见 tmSave/tmFind），执行段不依赖帧计：db 消息时间
//    即可得（墙钟−Σ请求时长），applySessionData 权威覆写，重启前后显示一致；并修遥测
//    chunk 帧批量滞后导致的「时间全归等待」，及打开页面前已完成的轮次。部分视图防线：快照落在 turn 中途（组内完成数不全）或该 turn
//    仍在流式时整组不写不锁，否则中途值冻成终值、迟到的 usage.delta 全被丢弃
//    （3.14.1 实测事故：徽标 52.5k/26s vs 面板同轮 194k/2m50s，即中途快照被写死）
// 3) 流式中首个用量帧到达前，统计行位置先显示「第 1 次请求…」占位（此时只知请求已开始）
// 4) 重启/刷新后的历史恢复：触发信号有三——conversation 通知壳帧 topic、turn.terminal、
//    以及外呼嗅探到的页面 readSession 请求（postMessage 只达 host 端不回环，页面打开会话
//    必发 readSession，安静会话无事件帧时靠它触发）；workspace 优先取请求参数自带的
//    workspacePath，其次 listTaskList 响应旁路映射（taskId=sessionId）。
//    数据面：readSession@zcode-session（messageLimit 400）+ readSessionDebug@zcode-agent；
//    帧必须以 Uint8Array 形态 postMessage——ArrayBuffer 被 host 静默丢弃（对照探针实测）
// 多会话/多面板并存：事实流订阅是 workspace 级（bundle cUe/onFact 实证），后台会话与侧板
// 子会话的帧照推、按 sessionId 隔离记账，杜绝并发串数（3.14.x 实测事故：A 会话回复中显示
// B 会话的 1.5m tok/4m30s）。UI 归属完全走 DOM：每个对话面板根节点带 data-session-id
// （通用面板组件，主列/子代理侧板/split/副屏同款，CDP 实证 section 的
// closest('[data-session-id]') 即所属会话）——badge 合法性=所在面板会话===turn.sid；
// 速度位/流式 turn/补挂链/行级桥全部 per-sid（streamTidBySid 等，无全局显示会话位），
// 主会话与子代理面板并发流式时各显示各的。旧 curDomSid 外呼嗅探机制已废：子代理面板打开
// 也会对子会话发订阅外呼（与主会话打开外呼同形，styles 实证），会被劫持成子会话（sniffOut
// 现只做恢复触发与 sid→workspace 映射）。turns 按会话分桶配额（bySid 每会话 200 + 全局
// 1000 兜底），子代理 turn 不再挤占主会话记录；无 turnId 帧按 lastTidBySid 归并（比旧全局
// lastTurnId 精确）。后台完成的 turn 切回后由 per-sid 补挂链定位本会话面板最后一个 section；
// 切会话的 DOM 残留由 500ms 宿主校验移除（含面板归属校验）。
// 重注入：升级后重新解包，再跑 inject/pack.mjs（流程见仓库 guide/common/pipeline.md）。
// 硬红线：本文件任何注释与字符串不得含 script 开闭标签及 head 闭合标签字样、HTML 注释开符号——
// 注入 HTML 后会被解析器当真标签，毁掉整页（pack.mjs 注入前会断言）。
// 协议细节与注入依赖锚点卡见仓库 guide/tok-badge/facts.md。
// ZCode 气泡 token 徽标注入脚本（3.14.1，改版：并入加载指示容器、耗时统计、会话切换重置与占位文案）
// 原理：旁路监听 renderer 的 MessagePort 二进制帧（广播给所有 listener，零请求），
// 解码遥测事实流（usage.delta / stream.chunk / model.request.status / turn.terminal）
// 与 conversation 行级帧（toolCall 输入增量，速度第二路），
// 按 turnId 归组后：速度贴 data-zcode-chat-loading-animate，统计贴 turn 容器末尾。
// 关闭方式：localStorage 'zcode:tok-badge:enabled' = '0'；帧调试：'zcode:tok-badge:debug' = '1'。
(function () {
  var _w = typeof window !== 'undefined' ? window : global;
  if (_w.__zcodeTokBadge) return;
  _w.__zcodeTokBadge = true;
  _w.__tokDbg = { hitMsg: 0, hitTurn: 0, hitBridge: 0, miss: 0, facts: 0 };
/* ==DECODER== */
  var _td = new TextDecoder();
  function readLEB(u8, p) {
    var r = 0, s = 0, b;
    do { b = u8[p++]; r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80);
    return [r, p];
  }
  // 返回 [value, nextPos]；Buffer/VSBuffer 内容不取（返回 null 占位，仅跳过）
  function decVal(u8, p) {
    var t = u8[p++];
    if (t === 0) return [undefined, p];
    if (t === 6) { var v = readLEB(u8, p); return [v[0], v[1]]; }
    if (t === 1) { var l = readLEB(u8, p); return [_td.decode(u8.subarray(l[1], l[1] + l[0])), l[1] + l[0]]; }
    if (t === 2 || t === 3) { var l2 = readLEB(u8, p); return [null, l2[1] + l2[0]]; }
    if (t === 4) {
      var n = readLEB(u8, p), arr = [], p2 = n[1];
      for (var i = 0; i < n[0]; i++) { var e = decVal(u8, p2); arr.push(e[0]); p2 = e[1]; }
      return [arr, p2];
    }
    if (t === 5) {
      var l3 = readLEB(u8, p);
      return [JSON.parse(_td.decode(u8.subarray(l3[1], l3[1] + l3[0]))), l3[1] + l3[0]];
    }
    throw new Error('bad tag ' + t + '@' + p);
  }
  // 两段式帧：第一段 [type, id, ...]，第二段 data。返回 [header, data]。
  function decodeFrame(u8) {
    var h = decVal(u8, 0);
    var d = decVal(u8, h[1]);
    return [h[0], d[0]];
  }
/* ==/DECODER== */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readLEB: readLEB, decVal: decVal, decodeFrame: decodeFrame };
    return;
  }

  var LS_ON = 'zcode:tok-badge:enabled';
  try { if (localStorage.getItem(LS_ON) === '0') return; } catch (e) {}
  var DEBUG = false;
  try { DEBUG = localStorage.getItem('zcode:tok-badge:debug') === '1'; } catch (e) {}
  if (DEBUG) console.log('[tok-badge] debug on');

  /* ---------- turn 状态归组 ---------- */
  // 双 ID 体系（3.14.x 实测）：遥测事实头 turnId 是 turn_ 前缀，
  // DOM section[data-turn-id] 是 msg_ 前缀（= stream.chunk 的 assistantMessageId）。
  // 归组用事实 turnId，DOM 定位用 msgId，两者靠 stream.chunk 关联；
  // conversation 行级帧里 streaming 态 assistantText row 的 turnId 是权威桥。
  var turns = new Map();     // turnId -> T（平铺查找索引；配额逐出按 bySid 会话桶管）
  var bySid = new Map();     // sid -> Map(turnId -> bornAt)：每会话配额逐出 + hasNewerRound 遍历域
  var PER_SID_TURNS = 200;   // 单会话 turn 记录上限（会话间互不挤占：子代理 turn 不再淘掉主会话记录）
  var TOTAL_TURNS = 1000;    // 全局兜底上限（会话数多时防无界累积，跨桶淘最旧、跳过流式中的）
  var lastTidBySid = new Map();  // sid -> 最近事实 turnId（无 turnId 帧的归并锚，按会话精确）
  var lastTermBySid = new Map(); // sid -> 最近 turn.terminal 的 turnId（后台完成补挂链，per-sid）
  var streamTidBySid = new Map();// sid -> 最近流式 turnId（速度位/tail 兜底/行级桥配对，per-sid）
  var streamDomBySid = new Map();// sid -> streaming assistantText 行的 msg 形态 turnId（行级桥，per-sid）
  var sessCum = new Map();   // sid -> {inp,out,cr,tt} 会话累计账本（usage.delta 增量 / finalize 全量覆盖）；流式 turn 的「累计」显示源，完成 turn 改用 t.cum 快照
  var c2t = 3.0;             // 字符→token 比率，随每次 usage.delta 自校准
  var SPEED_STALE_MS = 3000; // 无 chunk 超此值判中断：速度区显示「等待响应」，恢复后重开计时段

  function dropTurn(tid) { // 平铺索引与会话桶同步删（applySessionData 接管/配额逐出共用）
    var v = turns.get(tid);
    if (v && v.sid) { var b = bySid.get(v.sid); if (b) b.delete(tid); }
    turns.delete(tid);
  }
  function T(tid, sid) {
    var t = turns.get(tid);
    if (!t) {
      t = { id: tid, msgId: null, sid: sid || null, ttft: 0, reqs: [], seenReq: new Set(),
            total: { inp: 0, out: 0, cr: 0, tt: 0 },
            chars: 0, active: null, terminal: false, bornAt: Date.now(),
            waitSum: 0, genSum: 0, // 等待=请求发出→首 chunk；生成=首 chunk→末 chunk（逐请求累加）
            reqCnt: 0, reqDurSum: 0, // 请求次数 / Σ请求时长（权威校正时写 db 口径终值）
            reqStarted: 0, // started 帧计数：流式中「第 N 次请求」的序号源（防用量帧滞后少报）
            turnStart: 0, // 本轮墙钟起点=首个请求 started 帧到达时刻（官方 turnHeader.startedAt 的近似）
            gapSum: 0, // 执行时间=请求间间隙累计（工具执行/审批/规划，官方墙钟含它、纯请求口径漏它）
            gapFrom: 0, // 间隙起点（closeActive 时刻），下一次 started / turn.terminal 结清入 gapSum
            durMs: 0, // turn.terminal 帧自带 durationMs（agent 侧算好的 turn 墙钟终值，官方「已工作 X」同口径）
            cum: null }; // 到本条消息为止的会话累计（权威校正按消息序写入；null 时显示走会话账本）
      turns.set(tid, t);
      if (t.sid) { // 会话桶：配额只在本会话内淘最旧（流式中的跳过——会话内 turn 串行，防御性保留）
        var b = bySid.get(t.sid);
        if (!b) { b = new Map(); bySid.set(t.sid, b); }
        b.set(tid, t.bornAt);
        if (b.size > PER_SID_TURNS) {
          var oldest = null, minT = Infinity;
          b.forEach(function (bt, tid2) {
            var v = turns.get(tid2);
            if (v && v.bornAt < minT && (!v.active || v.terminal)) { minT = v.bornAt; oldest = tid2; }
          });
          if (oldest) dropTurn(oldest);
        }
      }
      if (turns.size > TOTAL_TURNS) { // 跨桶兜底：全局淘最旧（跳过流式中的，防误杀在跑 turn）
        var oldest2 = null, minT2 = Infinity;
        turns.forEach(function (v) { if (v.bornAt < minT2 && (!v.active || v.terminal)) { minT2 = v.bornAt; oldest2 = v.id; } });
        if (oldest2) dropTurn(oldest2);
      }
    }
    return t;
  }

  // 结清 active 请求的耗时段：有 chunk 则生成段止于末 chunk（尾部静默不计），
  // 无 chunk 的请求（纯工具轮等）整段计等待；gapFrom 记请求结束时刻，供「执行时间」
  // 结清（closeActive→下一 started / turn.terminal 之间 = 工具执行/审批，官方墙钟含它）
  function closeActive(t, endAt) {
    var a = t.active;
    if (!a) return;
    // 末 chunk→请求结束的尾段计入等待（db 口径：等待=请求总时长-生成段）：工具/审批密集
    // 的轮次尾段是大头，丢弃它 = 流式期总耗时持续偏少，直到终态权威校正才追平
    if (a.firstChunkAt) {
      t.genSum += Math.max(0, a.lastWall - a.firstChunkAt);
      t.waitSum += Math.max(0, endAt - a.lastWall);
    } else t.waitSum += Math.max(0, endAt - a.startedAt);
    if (t.turnStart) t.gapFrom = endAt;
  }
  // 流式增量入账（onFact 的 stream.chunk 与 onConvFrame 的 row.delta inputText 两路共用）：
  // 首增量落定等待段并开计时；长中断后的新簇重开计时段（段计时不含更久的中断，
  // 段内的簇间小间隙仍摊入分母）。thought/text 与工具输入都计（reasoning/tool_use ⊆ output）
  function feedChars(t, n) {
    var now = Date.now();
    if (!t.active) t.active = { startedAt: now, firstChunkAt: 0, segChars: 0, lastWall: 0 };
    var a = t.active;
    if (!a.firstChunkAt) {
      t.waitSum += Math.max(0, now - a.startedAt); a.firstChunkAt = now; a.segChars = 0;
      if (!t.ttft) t.ttft = Math.max(0, now - a.startedAt); // 首字=本轮第一段首增量延迟（帧滞后略高，终态以校正值为准）
    }
    else if (now - a.lastWall > SPEED_STALE_MS) { a.firstChunkAt = now; a.segChars = 0; }
    a.segChars += n;
    t.chars += n;
    a.lastWall = now;
  }
  function onFact(f) {
    if (DEBUG) console.log('[tok-badge] fact', f.kind, f.turnId || '(no turn)');
    _w.__tokDbg.facts++;
    // 事实流是 workspace 级、多会话并发帧交错：无 turnId 的帧归入本会话最近 turn
    // （lastTidBySid 按会话精确归并，其他会话的用量不会记到本会话 turn 头上）
    var tid = f.turnId;
    if (!tid && f.sessionId) {
      var ltTid = lastTidBySid.get(f.sessionId);
      if (ltTid && turns.get(ltTid)) tid = ltTid;
    }
    if (!tid) return;
    if (f.sessionId) lastTidBySid.set(f.sessionId, tid);
    var t = T(tid, f.sessionId);
    // 记账无条件入账：badge/速度位的会话隔离由 ensureBadge/ensureSpeed 按面板
    // data-session-id 判定（无全局显示会话位；后台会话无面板=不上 UI，见头部注释）
    switch (f.kind) {
      case 'model.request.status':
        // completed/failed 为 bundle 实证存在的终态（styles-*.js 内字面串）；即使漏收，
        // 下一个 started / turn.terminal 也会经 closeActive 结清，计时不悬空
        if (f.status === 'model_request_started') {
          closeActive(t, Date.now());
          var now0 = Date.now();
          if (!t.turnStart) t.turnStart = now0; // 墙钟起点只记首个请求（官方 header.startedAt 的近似，帧滞后略晚）
          if (t.gapFrom) { t.gapSum += Math.max(0, now0 - t.gapFrom); t.gapFrom = 0; } // 请求间间隙入「执行」
          t.active = { startedAt: now0, firstChunkAt: 0, segChars: 0, lastWall: 0 };
          t.chars = 0;
          t.reqStarted++;
          if (t.sid) streamTidBySid.set(t.sid, tid);
        } else if (f.status === 'model_request_completed' || f.status === 'model_request_failed') {
          closeActive(t, Date.now());
          t.active = null;
          schedulePaint(tid);
        }
        break;
      case 'stream.chunk': {
        if (t.sid) streamTidBySid.set(t.sid, tid); // 行级增量路由（feedConvDelta）按会话取本映射
        if (f.assistantMessageId && !t.msgId) t.msgId = f.assistantMessageId;
        feedChars(t, f.chunkLength || 0);
        schedulePaint(tid);
        break;
      }
      case 'usage.delta': {
        if (t.authoritative) break; // 已被 RPC 权威值覆盖，迟到/重放帧不再叠加
        // requestId 级幂等：断线恢复重放帧不重复计数
        if (f.requestId) {
          if (t.seenReq.has(f.requestId)) break;
          t.seenReq.add(f.requestId);
        }
        // db 实证口径（model_usage.raw_usage_json）：total = input + output，
        // cacheRead/cacheWrite 均已含在 input 内，reasoning 含在 output 内
        var inp = f.inputTokens | 0, out = f.outputTokens | 0, cr = f.cacheReadTokens | 0;
        t.reqs.push({ inp: inp, out: out, cr: cr, tt: f.totalTokens | 0 });
        t.reqCnt++;
        t.total.inp += inp; t.total.out += out; t.total.cr += cr; t.total.tt += (f.totalTokens | 0) || (inp + out);
        // 会话累计：增量记账（finalize 时被 db 全量覆盖，两种来源不重复计）
        var cumSid = f.sessionId || t.sid;
        if (cumSid) {
          var cum0 = sessCum.get(cumSid);
          if (!cum0) { cum0 = { inp: 0, out: 0, cr: 0, tt: 0 }; sessCum.set(cumSid, cum0); }
          cum0.inp += inp; cum0.out += out; cum0.cr += cr; cum0.tt += (f.totalTokens | 0) || (inp + out);
        }
        if (out > 20 && t.chars > 100) {
          var r = t.chars / out;
          if (r > 0.5 && r < 50) c2t = c2t * 0.7 + r * 0.3;
        }
        schedulePaint(tid);
        break;
      }
      case 'turn.terminal':
        // occurredAt=agent 侧事件发生时刻（探针实证），比帧到达准，用它结算尾段/执行间隙
        var tEnd = (f.occurredAt && f.occurredAt > t.turnStart) ? f.occurredAt : Date.now();
        closeActive(t, tEnd);
        t.terminal = true;
        t.active = null;
        if (t.gapFrom) { t.gapSum += Math.max(0, tEnd - t.gapFrom); t.gapFrom = 0; } // 末请求→turn 结束的收尾段入「执行」
        if (f.durationMs) t.durMs = f.durationMs; // turn 墙钟终值（探针实证=agent turn 开始→结束；
        // 子代理 turn 实测 durationMs 16223 vs 帧序列自算 15965，起点比首请求 started 帧早约 0.25s）
        // 帧计终值落盘：rounds 是进程内存态，重启后这轮的生成段在 RPC 里消失，
        // 重开权威校正只能靠这里读回（db 口径终值产生时会在 applySessionData 里覆盖）
        // r=总耗时墙钟终值（durMs 优先，漏帧退帧计三桶和），p=执行段帧计（db 间隙覆写前兜底），
        // 历史轮次显示总耗时/执行段的来源（applySessionData 会用 db 间隙校正 p）
        if (t.msgId || t.domId) tmSave(t.sid, { m: t.msgId, d: t.domId, g: t.genSum, w: t.waitSum, f: t.ttft, p: t.gapSum, r: t.durMs || (t.genSum + t.waitSum + t.gapSum) });
        if (t.sid) lastTermBySid.set(t.sid, tid); // 补挂链 per-sid：后台完成的 turn 切回本会话面板后补挂
        if (f.sessionId) finalizeSession(f.sessionId); // 权威校正（db 计时/全轮 tokens）
        schedulePaint(tid);
        break;
    }
  }

  /* ---------- 帧分派（结构嗅探，不依赖订阅 id 映射） ---------- */
  // DOM 桥：conversation 行级帧里 streaming 状态的 assistantText row 自带 msg 形态 turnId
  // （与 DOM data-turn-id 同体系），事实流 turnId 是 turn_ 体系，靠这里桥接（per-sid，
  // 多面板并发流式时各会话的桥互不覆盖）。
  function onConvFrame(d, sid) {
    try {
      var p = d.payload;
      // 3.14.3 探针实测：conversation 帧 payload 已无 kind 字段（一次会话 1391 帧全无，
      // 恒等 'conv|(none)'），旧检查 p.kind==='deltas' 恒假=行级第二路整体失效（速度丢工具
      // 输入流、行级桥永不建立）；放宽为只查 deltas 数组，无则返回，无副作用
      if (!p || !p.deltas) return;
      for (var i = 0; i < p.deltas.length; i++) {
        var op = p.deltas[i];
        var row = op && (op.row || null);
        if (row && (op.op === 'row.appended' || op.op === 'row.upserted')) {
          if (row.kind === 'assistantText') {
            if (row.state === 'streaming') { if (row.turnId) streamDomBySid.set(sid, row.turnId); }
            else if (streamDomBySid.get(sid) === row.turnId) streamDomBySid.delete(sid);
          }
        }
        // 只计 inputText（toolCall 输入流）：path=text 与遥测 stream.chunk 重复计，
        // output.text 是工具执行结果（非模型输出），summaryText 是子代理摘要（口径未定不碰）
        if (op && op.op === 'row.delta' && op.path === 'inputText' && op.append)
          feedConvDelta(op.append.length, sid);
      }
    } catch (e) {}
  }
  // 行级帧不带 turnId：按帧 topic 的 sid 喂给该会话自己的流式 turn（streamTidBySid），
  // 跨会话不混入——多面板并发流式时各喂各的计时段
  function feedConvDelta(n, sid) {
    if (!sid) return;
    var tid0 = streamTidBySid.get(sid);
    var t = tid0 && turns.get(tid0);
    if (!t || t.terminal || t.authoritative) return;
    feedChars(t, n);
    schedulePaint(t.id);
  }
  function handleData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.version === 1 && typeof d.eventId === 'string' && typeof d.kind === 'string') return onFact(d);
    // 3.14.1 实测：conversation 完整帧封套是 {topic,subscriptionId,logEpoch,fromSeq,toSeq,sentAt,payload}，
    // 没有 wireVersion/kind 字段（那是 fragment 封套才有的），不能按 3.14.0 的老封套过滤
    if (typeof d.topic !== 'string') return;
    if (d.topic.indexOf('conversation/') === 0) {
      var csid = d.topic.slice('conversation/'.length);
      // 3.14.3 探针实测：payload 无 kind 字段（见 onConvFrame 内注），只按 deltas 数组识别行级帧
      if (d.payload && d.payload.deltas) onConvFrame(d, csid);
      // 3.14.1 实测：conversation 的 EventFire 帧多为通知壳（payload 无数据，行数据由
      // 渲染侧 RPC 拉取），触发权威校正（幂等去抖）。行级订阅切走不退订（后台流式会话的
      // 帧持续到达）——本函数只做 sid 级 finalize，不携带任何显示语义（显示会话归属由
      // ensureBadge/ensureSpeed 按面板 data-session-id 判定，见头部注释）
      finalizeSession(csid);
    }
  }
  var sniffCount = 0;
  function onFrame(u8) {
    try {
      var f = decodeFrame(u8);
      var ty = f[0] && f[0][0];
      if (ty === 204) return handleData(f[1]); // EventFire 才带业务数据
      if ((ty === 201 || ty === 202 || ty === 203) && f[0][1] > 9e6) { // 自呼 RPC 响应
        var cb = rpcPending.get(f[0][1]);
        rpcPending.delete(f[0][1]);
        if (cb) cb(ty === 201 ? null : 'rpc-error', f[1]);
        return;
      }
      // 被动旁路页面 listTaskList 响应（2s 轮询、广播可达）：items[].taskId(=sid)+workspacePath
      // 建立 sid->workspace 精确映射，免去恢复时的候选轮换（轮换在 agent 忙时会长时间排队）
      if (ty === 201 && f[1] && Array.isArray(f[1].items)) {
        for (var li = 0; li < f[1].items.length; li++) {
          var it = f[1].items[li];
          if (it && it.taskId && it.workspacePath) wsBySid.set(it.taskId, it.workspacePath);
        }
      }
    } catch (e) {
      if (DEBUG && sniffCount++ < 5) console.warn('[tok-badge] decode fail', e && e.message);
    }
  }

  /* ---------- 自呼 RPC（重启恢复用）：复用捕获的 port 发请求帧 ----------
     帧格式（模块11实证）：请求 = [100, id, channel, method] + arg 两段 TLV；
     响应 = [201/202/203, id] + data。id 取 9e6+ 与页面递增段错开。 */
  var _te = new TextEncoder();
  function wLEB(out, v) {
    do { var b = v & 0x7f; v = Math.floor(v / 128); out.push(v ? b | 0x80 : b); } while (v);
  }
  function encVal(out, v) {
    if (v === undefined || v === null) { out.push(0); }
    else if (typeof v === 'number') { out.push(6); wLEB(out, v); }
    else if (typeof v === 'string') { var b = _te.encode(v); out.push(1); wLEB(out, b.length); for (var i = 0; i < b.length; i++) out.push(b[i]); }
    else if (Array.isArray(v)) { out.push(4); wLEB(out, v.length); for (var j = 0; j < v.length; j++) encVal(out, v[j]); }
    else { var o = _te.encode(JSON.stringify(v)); out.push(5); wLEB(out, o.length); for (var k = 0; k < o.length; k++) out.push(o[k]); }
  }
  var rpcSeq = 9e6, rpcPending = new Map(), mainPort = null;
  // 帧包装红线：必须 postMessage(Uint8Array)——host 对 ArrayBuffer 形态的入站帧静默丢弃
  //（探针对照实测：同字节内容 Uint8Array 有应答、ArrayBuffer 零应答）
  function rpcCall(ch, method, arg, cb) {
    if (!mainPort) { if (cb) cb('no-port'); return; }
    var id = ++rpcSeq;
    rpcPending.set(id, cb || null);
    var out = [];
    encVal(out, [100, id, ch, method]);
    // 第二段是参数表数组（渲染侧代理 rest 包装，v9 探针字节级实证：arg=[{..}]）——
    // 发裸对象 host 侧 ...args spread 会 TypeError 被静默吞，表现为零响应
    if (arg !== undefined) encVal(out, [arg]);
    try {
      mainPort.postMessage(new Uint8Array(out));
    } catch (e) {
      rpcPending.delete(id);
      if (cb) cb('send-fail');
      return;
    }
    setTimeout(function () {
      if (rpcPending.has(id)) { rpcPending.delete(id); if (cb) cb('timeout'); }
    }, 20000); // readSession/readSessionDebug 由 host 直接应答，实测流式期间也是秒级返回
  }

  /* ---------- 外呼嗅探：页面请求帧只在 postMessage 出口可见 ----------
     postMessage 只送达 host 端、不回环到本端 listener，页面发的请求帧在收帧侧截不到。
     页面打开会话必发 readSession（参数自带 workspacePath+sessionId）——比壳帧更早，
     且安静会话无任何事件帧时是唯一恢复触发源；顺手补全 sid→workspace 精确映射。 */
  function sniffOut(msg) {
    if (!(msg instanceof Uint8Array)) return;
    var f = decodeFrame(msg);
    var h = f[0];
    if (!h || h[0] !== 100 || h.length < 4) return;
    var self = h[1] > 9e6; // 自呼帧（id 9e6+ 段）：只补 workspace 映射；回灌 finalize 会自激成 2s 轮询
    var a0 = f[1];
    if (Array.isArray(a0)) a0 = a0[0];
    if (!a0 || typeof a0 !== 'object') return;
    if (a0.sessionId && a0.workspacePath) {
      wsBySid.set(a0.sessionId, a0.workspacePath);
      if (self) return;
      // 外呼只做恢复触发与 workspace 映射（页面打开会话必发）：显示会话信号不再从这里取——
      // 子代理面板对子会话的订阅外呼与主会话打开外呼同形（styles 实证 subscribeConversationV4
      // 首参数同带 sessionId+workspacePath），曾把 curDomSid 劫持成子会话、主会话统计条整体冻结
      finalizeSession(a0.sessionId);
    }
  }
  function wrapMainPort() {
    if (mainPort.__sniffed) return;
    mainPort.__sniffed = true;
    var op = mainPort.postMessage;
    mainPort.postMessage = function (msg) {
      try { sniffOut(msg); } catch (e) {}
      return op.apply(mainPort, arguments);
    };
  }

  /* ---------- 帧计持久化：readSessionDebug.rounds 是 agent 进程内存态（探针实测重启后
     requestIndex 从 1 重编、重启前轮次缺失），重开权威校对的生成段配对只对重启后轮次有效；
     turn.terminal 时的帧计终值（gen/wait/ttft）落 localStorage，配不上 rounds 的组读回，
     重启前后显示一致。按会话分组保留最近 80 轮、30 个会话，溢出删最旧 ---------- */
  var TM_KEY = 'zcode:tok-badge:tm';
  function tmLoad() {
    try { return JSON.parse(localStorage.getItem(TM_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function tmSave(sid, rec) {
    if (!sid || (!rec.m && !rec.d)) return;
    try {
      var all = tmLoad();
      var arr = all[sid] || (all[sid] = []);
      for (var i = 0; i < arr.length; i++) {
        if ((rec.m && arr[i].m === rec.m) || (rec.d && arr[i].d === rec.d)) { arr.splice(i, 1); break; } // 同轮覆盖（db 口径校正后回存）
      }
      arr.push(rec);
      if (arr.length > 80) arr.splice(0, arr.length - 80);
      var sids = Object.keys(all);
      if (sids.length > 30) delete all[sids[0]];
      localStorage.setItem(TM_KEY, JSON.stringify(all));
    } catch (e) {}
  }
  function tmFind(sid, ids, uid) {
    var arr = tmLoad()[sid];
    if (!arr) return null;
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if ((r.d && r.d === uid) || (r.m && ids.indexOf(r.m) >= 0)) return r;
    }
    return null;
  }

  /* ---------- 权威校正：readSession(messages) + readSessionDebug(rounds) 双 RPC ----------
     遥测帧的到达时刻成簇滞后（首 chunk 帧晚到会把真实生成时间误判成等待），
     终值不走帧计时：readSession@zcode-session 的 messages[].info 给组归属+tokens+
     请求总时长（db 对拍 time.created == model_usage.started_at，一请求一条 assistant
     消息），readSessionDebug@zcode-agent 的 rounds 给 generationDurationMs（host 算
     好的生成段），尾部对齐 zip（rounds 上限 200）后按 parent user 消息分组写回。
     user messageId = DOM section[data-turn-id] 体系（db message 表 id 对拍实证）。
     两个 RPC 都由 host 直接应答，实测流式期间也秒级返回；workspace 必须精确——
     只信外呼参数/listTaskList 的映射，不盲轮换候选（会触发其他 workspace 拉起）。 */
  var wsBySid = new Map();        // sessionId -> workspacePath（外呼请求参数 / listTaskList 响应旁路）
  var appliedAt = new Map();      // sid -> 上次成功应用时刻（去抖只看完成时刻：按请求时刻去抖会把
                                  // turn.terminal 那一发吞掉——流式中先跑过一次，terminal 紧随其后）
  var inflight = new Set();       // sid -> 校正请求进行中（壳帧风暴下防重复排队）
  var rerunReq = new Set();       // in-flight 期间又来了触发请求 → 完成后补跑一次
  var retryCnt = new Map();       // sid -> 部分视图重试次数（有界）
  function finalizeSession(sid) {
    if (!sid) return;
    if (!wsListReady()) { setTimeout(function () { finalizeSession(sid); }, 2000); return; }
    if (inflight.has(sid)) { rerunReq.add(sid); return; }
    var last = appliedAt.get(sid) || 0;
    var dt = Date.now() - last;
    if (dt < 2000) { setTimeout(function () { finalizeSession(sid); }, 2000 - dt + 50); return; } // 排队而非丢弃
    requestSessionData(sid, 0);
  }
  function afterFinalize(sid) {
    if (rerunReq.has(sid)) { rerunReq.delete(sid); setTimeout(function () { finalizeSession(sid); }, 600); }
  }
  function wsListReady() { return wsBySid.size > 0; }
  function requestSessionData(sid, tries) {
    if (inflight.has(sid)) { rerunReq.add(sid); return; }
    // workspace 只信精确映射（外呼参数或 listTaskList 的 taskId 映射）；盲轮换候选会对
    // 其他 workspace 触发 agent 连接/拉起，代价不可控
    var path = wsBySid.get(sid);
    if (!path) {
      if ((tries || 0) < 20) setTimeout(function () { requestSessionData(sid, (tries || 0) + 1); }, 2000);
      else if (DEBUG) console.log('[tok-badge] finalize giveup (no ws map)', sid);
      return;
    }
    inflight.add(sid);
    // readSession@zcode-session：页面打开会话的同款方法，messages[].info 带 tokens/
    // parentMessageId/time（探针实测 201）；readSessionMessages@zcode-agent 实测 202 不可用。
    // token/生成段走 readSessionDebug@zcode-agent（201 实测）。rounds 行 schema（3.14.3
    // host bundle zod 实证）：{eventKey,requestId,requestIndex,recordedAt,usage,hitRate,
    // generationDurationMs,tokensPerSecond}，usage={inputTokens,outputTokens,totalTokens,
    // reasoningTokens,cachedInputTokens,cachedWriteInputTokens}，上限 {rounds:200} 不变；
    // 调试面板列即渲染 usage.*，同源同值
    rpcCall('zcode-session', 'readSession', { workspacePath: path, sessionId: sid, messageLimit: 400 }, function (err, res) {
      var msgs = (!err && res && Array.isArray(res.messages)) ? res.messages : null;
      if (DEBUG) console.log('[tok-badge] finalize', sid, err ? err : ((msgs && msgs.length) + ' msgs'));
      if (!msgs || !msgs.length) { inflight.delete(sid); afterFinalize(sid); return; }
      rpcCall('zcode-agent', 'readSessionDebug', { workspacePath: path, sessionId: sid }, function (err2, dbg) {
        inflight.delete(sid);
        applySessionData(sid, msgs, (!err2 && dbg && Array.isArray(dbg.rounds)) ? dbg.rounds : []);
        appliedAt.set(sid, Date.now());
        afterFinalize(sid);
      });
    });
  }
  function applySessionData(sid, msgs, rounds) {
    if (DEBUG) console.log('[tok-badge] finalize', sid, msgs.length + ' msgs', rounds.length + ' rounds');
    var liveT = new Map(); // assistant messageId -> 实时 T（写回时实时优先）
    turns.forEach(function (lt) { if (lt.msgId) liveT.set(lt.msgId, lt); });
    // 第一遍：组归属 + 完成性统计。
    // 组归属坑（3.14.1 db 实测，曾致长任务徽标数值差一个量级）：消息流里 turn 中间插着
    // synthetic:true + visibility:"model-only" 的 user 行（todo_reminder 等模型侧注入），
    // 按「前最近 user 消息」切组会把同一 turn 拆成 N 组——首组 token 被当整轮、其余组挂
    // 合成行 id 在 DOM 永远 miss。assistant 消息自带 parentID 稳定指向本 turn 的起始
    // user 行（与 model_usage.parent_user_message_id 同值，79 请求全量对拍），
    // parentMessageId 作兼容别名；无 parentID 的旧数据回退「前最近非合成 user 行」。
    // 合成行两种形态（2026-10-15 同会话 db 双实证）：todo 类中段注入不改 parentID
    // （turn_5a204335 的 15:50:18 合成行后各行 parent 不变，续挂同组）；开新 turn 的
    // 合成行（后台子代理完成注入 / AskUserQuestion 应答）后续行 parentID 指向该合成行
    // 本身——组键必须随 parentID 重取，沿用旧 g 会把续跑 turn 并进首组（6 请求/323k
    // 并组事故：首块吞并全部请求与后台等待、续跑可视块无统计条）。
    // 组的 token 汇总只统计已完成请求（rows）；未完成的只进 tkTotal 计数
    var groups = new Map(); // userMsgId -> {rows, tkTotal, ids}
    var seq = [];           // 完成请求行（跨组全局序，供 rounds 尾对齐）
    var cur = null, g = null;
    for (var mi = 0; mi < msgs.length; mi++) {
      var mm = msgs[mi];
      var info = mm && (mm.info || mm); // readSession 形态是 {info,parts} 包装；兼容旧扁平形态
      if (!info || !info.messageId) continue;
      if (info.role === 'user') {
        if (info.synthetic || info.visibility === 'model-only') continue; // 合成行不是轮次边界
        cur = info.messageId; g = null; continue;
      }
      // tokens 全 0 的 assistant 行（系统 timeline_event 等，db 实证 7/8 会话含）不是请求行：
      // 入列会把 rounds zip 顶错一格、±5% 双校验从首对起整链拒绝，重开后等待/平均/首字全写不回
      if (info.role !== 'assistant' || !info.tokens
        || !(info.tokens.total || (info.tokens.input | 0) + (info.tokens.output | 0))) continue;
      var pid = info.parentID || info.parentMessageId || cur;
      if (!pid) continue;
      g = groups.get(pid); // 组键随 parentID 重取（开新 turn 的合成行会换 parentID，见上）
      if (!g) { g = { rows: [], tkTotal: 0, ids: [] }; groups.set(pid, g); }
      g.tkTotal++;
      if (!info.time || !info.time.completed || !info.time.created) continue; // 流式中的末条不完整
      var tk = info.tokens;
      var row = { inp: tk.input | 0, out: tk.output | 0, cr: (tk.cache && tk.cache.read) | 0,
                  tt: tk.total || ((tk.input | 0) + (tk.output | 0)),
                  total: Math.max(0, info.time.completed - info.time.created),
                  c0: info.time.created, c1: info.time.completed, // db 起止（组墙钟/间隙计算用）
                  matched: false, gen: 0, wait: 0 };
      g.rows.push(row); g.ids.push(info.messageId); seq.push(row);
    }
    // 第二遍：rounds 尾部对齐（上限 200，早期轮无计时），out+inp 双校验防 zip 错位。
    // 命中行的 token 换用 rounds.usage——调试面板同源同值，免疫消息侧 tokens 的陈旧快照；
    // 缓存字段名是 cachedInputTokens（非 db/usage.delta 的 cacheReadTokens）。
    // 双校验按 db 实证的精确相等关系收紧（邻轮 input 差远超 5%，错位必被拒）
    var off = Math.max(0, seq.length - rounds.length);
    for (var di = 0; di < seq.length; di++) {
      var ri = di - off;
      if (ri < 0 || ri >= rounds.length) continue;
      var rr = rounds[ri], row2 = seq[di], ru = rr && rr.usage;
      if (!ru || ru.outputTokens == null || rr.generationDurationMs == null) continue;
      if (Math.abs(ru.outputTokens - row2.out) > Math.max(5, row2.out * 0.05)) continue;
      if (ru.inputTokens != null && Math.abs(ru.inputTokens - row2.inp) > Math.max(5, row2.inp * 0.05)) continue;
      row2.gen = Math.min(rr.generationDurationMs, row2.total); // 生成段（db 口径）
      row2.wait = Math.max(0, row2.total - row2.gen);
      row2.inp = ru.inputTokens | 0; row2.out = ru.outputTokens | 0;
      row2.cr = ru.cachedInputTokens | 0; row2.tt = ru.totalTokens || (row2.inp + row2.out);
      row2.matched = true;
    }
    // 会话累计全量覆盖（db 口径：该会话全部已完成请求；之后的 usage.delta 在其上增量，
    // 两来源不重复计）。超过 messageLimit 的极长会话按可见消息计
    var cInp = 0, cOut = 0, cCr = 0, cTt = 0;
    groups.forEach(function (gv2) { // Map 保序：插入序=消息序，逐组累积得「到该组(含)为止」快照
      for (var r3 = 0; r3 < gv2.rows.length; r3++) {
        var rw2 = gv2.rows[r3];
        cInp += rw2.inp; cOut += rw2.out; cCr += rw2.cr; cTt += rw2.tt;
      }
      gv2.cumUpTo = cTt;
    });
    if (cTt > 0) sessCum.set(sid, { inp: cInp, out: cOut, cr: cCr, tt: cTt });
    // 第三遍：组汇总 + 写回。流式中的 turn（实时 T 未 terminal 或仍有 active 请求；组 id 被
    // 未终态 T 的 domId 占用同理）整组跳过——等 turn.terminal 的 finalize 接管，不与遥测抢写
    var needRetry = false;
    groups.forEach(function (gv, uid) {
      var t = null;
      for (var k = 0; k < gv.ids.length; k++) { var lt = liveT.get(gv.ids[k]); if (lt) { t = lt; break; } }
      var streaming = t && (!t.terminal || t.active);
      if (!streaming) {
        turns.forEach(function (lt2) { if (lt2.domId === uid && !lt2.terminal) streaming = true; });
      }
      if (streaming) return;
      if (!gv.rows.length) return; // 全组未完成：无可写（流式恢复期，重试/terminal 兜底）
      if (gv.rows.length < gv.tkTotal) { needRetry = true; return; } // host 落盘滞后：稍后重取，不写半个 turn
      var inp = 0, out = 0, cr = 0, tt = 0, gen = 0, wait = 0, genCnt = 0, dur = 0;
      var minC = 0, maxC = 0;
      for (var r2 = 0; r2 < gv.rows.length; r2++) {
        var rw = gv.rows[r2];
        inp += rw.inp; out += rw.out; cr += rw.cr; tt += rw.tt; dur += rw.total;
        if (!minC || rw.c0 < minC) minC = rw.c0;
        if (rw.c1 > maxC) maxC = rw.c1;
        if (rw.matched) { gen += rw.gen; wait += rw.wait; genCnt++; }
      }
      // db 墙钟=首请求 created→末请求 completed；间隙=墙钟−Σ请求时长（工具执行/审批，
      // 与 rounds 无关、重启前后一致）。帧计 gapSum 不可作恢复源：completed 帧漏收/迟到时
      // 下一个 started 的 closeActive 把间隙整段计入 waitSum（实测 73 请求轮 w+g≈墙钟，
      // 恢复残差≈0 → 执行段恒 0s）；这里用 db 间隙权威覆写，残差只剩 durMs−墙钟的收尾段
      var wall = (minC && maxC) ? Math.max(0, maxC - minC) : 0;
      var gapDb = wall ? Math.max(0, wall - dur) : 0;
      if (t) { // 实时 T 接管：清掉壳帧时先建的恢复 T 及其挂载，防同 section 双 badge
        var els = document.querySelectorAll('[data-zcode-tok-badge="' + uid + '"]');
        for (var q = 0; q < els.length; q++) els[q].remove();
        dropTurn(uid); // 平铺与会话桶同步删
      } else {
        t = T(uid, sid);
      }
      var rec0 = tmFind(sid, gv.ids, uid); // 帧计持久化（db 覆写前的终值；wall 兜底 r）
      t.sid = sid;
      t.total = { inp: inp, out: out, cr: cr, tt: tt };
      t.reqCnt = gv.rows.length;
      t.reqDurSum = dur;
      t.cum = gv.cumUpTo; // 累计快照：本组及其前各组已完成请求的 token 总和
      if (!t.reqs.length) t.reqs.push({ finalized: true });
      t.terminal = true;
      t.authoritative = true;
      if (!t.domId) t.domId = uid;
      t.gapSum = gapDb || (rec0 && rec0.p) || t.gapSum; // db 间隙权威覆写（p 只在 db 时间缺时兜底）
      if (!t.durMs) t.durMs = (rec0 && rec0.r) || wall || 0; // 强退/恢复壳轮：墙钟兜底，不再退 Σ请求
      // 组墙钟取大兜底：漏 terminal 帧（durMs 缺）/陈旧 tm 记录（rec0.r 只盖某段）时以 db
      // 组墙钟覆写；正常组 durationMs 含 turn 首尾 ≥ 组墙钟，不触发。必须独立成行且在上方
      // 赋值之后：rec0.r 优先级高于 wall，并进同一条件会被旧值顶回
      if (wall > t.durMs) t.durMs = wall;
      if (genCnt) { // rounds 命中（重启后产生的轮次）：db 口径覆盖帧计，并回存持久化（更准）
        t.genSum = gen; t.waitSum = wait;
        tmSave(sid, { m: t.msgId, d: uid, g: gen, w: wait, f: gv.rows[0].matched ? gv.rows[0].wait : t.ttft, p: gapDb, r: t.durMs || (rec0 && rec0.r) || wall || 0 });
      } else {
        // 历史轮次：rounds 里没有，读回帧计终值（g/w/f；durMs/gapSum 上面已 db 兜底）。
        // w+g 等比缩放到「总耗时−执行段」（吞间隙把等待顶大/页面未开帧计缺失/帧成簇滞后
        // 爆表/db 时间戳与 agent 墙钟的系统性偏差——帧计与 db 两套时钟，按帧计比例缩放
        // 保三段和=总耗时恒守恒，平均 t/s 随 g 同比例修正）
        if (rec0) {
          var wg = (rec0.g || 0) + (rec0.w || 0);
          var tgt = Math.max(0, t.durMs - gapDb);
          if (wg > 0 && tgt > 0) {
            var sc = tgt / wg;
            t.genSum = (rec0.g || 0) * sc; t.waitSum = (rec0.w || 0) * sc;
          } else { t.genSum = rec0.g; t.waitSum = rec0.w; }
          if (rec0.f) t.ttft = rec0.f;
        }
      }
      if (gv.rows[0].matched) t.ttft = gv.rows[0].wait; // 首字终值 = 首请求等待段（db 口径 ≈ TTFT）
      schedulePaint(t.id);
    });
    // 部分视图重试（有界）：流式中的组跳过不算（terminal 自会触发）
    if (needRetry && (retryCnt.get(sid) || 0) < 5) {
      retryCnt.set(sid, (retryCnt.get(sid) || 0) + 1);
      setTimeout(function () { finalizeSession(sid); }, 3000);
    } else if (!needRetry) {
      retryCnt.delete(sid);
    }
  }

  /* ---------- port 捕获（head 内先于主 bundle 注册，window message 广播） ---------- */
  var attached = new Set();
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.ports || !e.ports[0]) return;
    var ty = e.data && e.data.type;
    if ((ty === 'zcode:service-port' || ty === 'zcode:scoped-service-port') && !attached.has(e.ports[0])) {
      attached.add(e.ports[0]);
      if (!mainPort && ty === 'zcode:service-port') { mainPort = e.ports[0]; wrapMainPort(); } // 自呼 RPC 用（不 start 不 close）
      // 只 addEventListener，不 start()/close()——主代码显式 start 后帧广播给所有 listener
      e.ports[0].addEventListener('message', function (ev) {
        if (ev.data instanceof Uint8Array) onFrame(ev.data);
      });
      if (DEBUG) console.log('[tok-badge] port attached:', ty);
    }
  }, true);

  /* ---------- 样式：只走主题变量，字号 --text-ui-base ---------- */
  var CSS = '[data-zcode-tok-badge]{margin-top:-12px!important;font-size:var(--text-ui-base);'
    + 'color:var(--color-foreground-subtlest);user-select:none;pointer-events:none;font-variant-numeric:tabular-nums;}'
    + '[data-zcode-tok-badge] b{font-weight:500;color:var(--color-foreground-subtle);}'
    + '[data-zcode-tok-badge] [data-zcode-tok-dur]{color:var(--color-foreground-subtlest);}'
    + '[data-zcode-tok-speed]{margin-left:6px;font-size:var(--text-ui-base);white-space:nowrap;'
    + 'color:var(--color-foreground-subtlest);font-variant-numeric:tabular-nums;}';
  function ensureStyle() {
    if (document.getElementById('zcode-tok-badge-style')) return;
    var s = document.createElement('style');
    s.id = 'zcode-tok-badge-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function k(n) { // token 数缩写（上下文大的会话单 turn 总量可破百万，按量级升 k→m）
    if (n == null) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'm';
    if (n >= 100000) return (n / 1000).toFixed(0) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function pct(v, tot) {
    if (!tot) return '0%';
    var p = v / tot * 100;
    return (p >= 10 ? p.toFixed(0) : p.toFixed(1)) + '%';
  }

  /* ---------- 速度：贴加载槽 spin 图标右侧（响应至今平均，非滑窗瞬时） ---------- */
  function speedTextOf(t) {
    if (!t || !t.active) return '';
    var now = Date.now();
    var a = t.active;
    // 首 chunk 前 / 中断期不空置：显示等待文案（下一个 chunk 会重开计时段）
    if (!a.firstChunkAt || now - a.lastWall > SPEED_STALE_MS) return '等待响应';
    var dur = now - a.firstChunkAt;
    if (dur < 600) return '等待响应'; // 段刚起步，读数未稳
    var tps = a.segChars / dur * 1000 / c2t;
    if (tps <= 0) return '等待响应';
    return (tps >= 10 ? tps.toFixed(0) : tps.toFixed(1)) + ' t/s';
  }
  // 逐面板贴速：文档内全部加载槽各贴各的——按槽所在面板（data-session-id）取该会话的
  // 流式 turn，主会话与子代理面板并发流式时互不串台；forceMount 常驻的隐藏 tab
  // （data-state=inactive 祖先）不可见，跳过
  function ensureSpeed() {
    var anims = document.querySelectorAll('[data-zcode-chat-loading-animate]');
    for (var i = 0; i < anims.length; i++) {
      var anim = anims[i];
      if (anim.closest('[data-state="inactive"]')) continue;
      var pane = anim.closest('[data-session-id]');
      var sid = pane && pane.getAttribute('data-session-id');
      var tid = sid && streamTidBySid.get(sid);
      var txt = speedTextOf(tid && turns.get(tid));
      var span = anim.querySelector('[data-zcode-tok-speed]');
      if (!span) {
        if (!txt) continue;
        // React 重渲染可能清掉外来节点：500ms 扫描会重贴
        span = document.createElement('span');
        span.setAttribute('data-zcode-tok-speed', '');
        anim.appendChild(span);
      }
      if (span.__txt !== txt) { span.textContent = txt; span.__txt = txt; }
    }
  }

  /* ---------- 统计行：贴回复消息（turn 容器）下方 ---------- */
  // 耗时格式化：45s / 3m43s / 1h2m3s
  function fmtDur(ms) {
    var s = Math.round(ms / 1000);
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    return (h ? h + 'h' : '') + ((h || m) ? m + 'm' : '') + s + 's';
  }
  function statsText(t) {
    var d = t.total;
    var streaming = t.active && !t.terminal;
    // 用量帧在请求结束时才报，首个用量到达前不空着：流式中先显示进行中序号占位
    if (!t.reqs.length) return streaming ? '第 1 次请求…' : '';
    var fresh = Math.max(0, d.inp - d.cr); // 缓外 = 输入 − 缓内（含缓存写入与新鲜输入）
    var tot = d.tt || (d.inp + d.out);
    var s = '共 <b>' + k(tot) + '</b> tok · 缓内 <b>' + k(d.cr) + '</b> (' + pct(d.cr, tot)
      + ') · 缓外 <b>' + k(fresh) + '</b> (' + pct(fresh, tot)
      + ') · 输出 <b>' + k(d.out) + '</b> (' + pct(d.out, tot) + ')';
    // 首字在前、平均在后：首字先给出本轮第一段 TTFT；平均速度 = 总输出 token ÷ 纯生成耗时
    // （各请求首 chunk→末 chunk 累加，等待不计入，与耗时括号内「响应」段同分母）
    if (t.ttft > 0) s += ' · 首字 <b>' + (t.ttft / 1000).toFixed(1) + '</b>s';
    if (d.out > 0 && t.genSum > 0) {
      var tps = d.out / (t.genSum / 1000);
      s += ' · 平均 <b>' + (tps >= 10 ? tps.toFixed(0) : tps.toFixed(1)) + '</b> t/s';
    }
    var cnt = t.reqCnt || t.reqs.length;
    // 流式中末请求尚未入账：显示进行中序号而非已完成数（N 取 started 计数，帧滞后时已完成数+1 兜底）
    if (streaming) s += ' · 第 ' + Math.max(cnt + 1, t.reqStarted || 0) + ' 次请求…';
    else if (cnt) s += ' · ' + cnt + ' 次请求';
    // 总耗时口径=turn 墙钟（与官方「工作中/已工作 X」一致：起点→当前/结束，含请求间执行
    // 时间）。流式中=起点（首个请求 started 帧到达，官方 header.startedAt 的近似）→now 单调
    // 走表；完成=turn.terminal 帧 durationMs（agent 侧同源终值），漏帧退帧计三桶和（等待+
    // 生成+执行）；重开/历史=tm 持久化读回（r），都无才退 db Σ请求时长（偏少，间隙不可得）。
    // 等待=请求区间内的首字等待+尾部静默（db 口径：请求时长-生成段）；响应=生成段合计
    // （各请求首 chunk→末 chunk，平均 t/s 的分母）；执行=请求间间隙（工具执行/审批/规划）。
    // 三段与总耗时同拍:完成态对账——执行段主体来自 db 间隙权威覆写(gapSum=墙钟−Σ请求
    // 时长,applySessionData 写;帧计 wait 吞间隙的测量误差不再挤进执行段),残差
    // dur−等待−响应只剩墙钟起点偏差+turn 收尾段(并入执行,语义即收尾);流式态实时走表——在途未
    // 入桶时间按当前阶段入桶(首字前→等待;chunk 中:已生成=lastWall−首字、尾静默=now−
    // lastWall 随 db 口径记等待;请求间→执行),口径与 closeActive/结清规则逐条对齐=
    // 立即结清的预览;剩余残差并入活跃桶,保证三段和恒等于总耗时
    var nowMs = Date.now();
    var dur = t.durMs || (t.turnStart && !t.terminal ? nowMs - t.turnStart : 0)
      || ((t.genSum + t.waitSum + t.gapSum) || t.reqDurSum);
    if (dur > 0) {
      s += ' · 总耗时 <b>' + fmtDur(dur) + '</b>';
      var wait = t.waitSum || 0, gen = t.genSum || 0, gap = t.gapSum || 0;
      var a = t.active;
      if (t.terminal) {
        if (wait + gen > 0) gap = Math.max(gap, dur - wait - gen);
      } else {
        if (a && a.firstChunkAt) {
          gen += Math.max(0, a.lastWall - a.firstChunkAt);
          wait += Math.max(0, nowMs - a.lastWall);
        } else if (a) {
          wait += Math.max(0, nowMs - a.startedAt);
        } else if (t.gapFrom) {
          gap += Math.max(0, nowMs - t.gapFrom);
        }
        var r = dur - wait - gen - gap;
        if (r > 0) {
          if (a && a.firstChunkAt) gen += r; else if (a) wait += r; else if (t.gapFrom) gap += r;
        }
      }
      var durParts = '';
      if (wait > 0) durParts += '等待 ' + fmtDur(wait);
      if (gen > 0) durParts += (durParts ? ' · ' : '') + '响应 ' + fmtDur(gen);
      if (gap > 500) durParts += (durParts ? ' · ' : '') + '执行 ' + fmtDur(gap); // <0.5s 不显示：单请求轮无间隙，「执行 0s」只是噪音（fmtDur 同阈值四舍五入为 0s）
      if (durParts) s += ' <span data-zcode-tok-dur>(' + durParts + ')</span>';
    }
    // 累计 = 到本条消息为止的会话消耗：完成 turn 用权威校正按消息序累积的快照（不随后续
    // 轮次增长漂移）；流式 turn 快照未定，用会话账本现值——此刻账本的全部增量都属于本条
    var cum = (t.cum != null) ? t.cum : (sessCum.get(t.sid) || {}).tt;
    if (cum > 0) s += ' · 累计 <b>' + k(cum) + '</b> tok';
    return s;
  }

  // ---------- 会话最后一轮判定（末段钉挂/补挂链/宿主校验宽免共用） ----------
  // 「cum 快照追平会话账本」只证明写快照那刻是最后一轮：sessCum 要等新轮首个请求完成
  // （usage.delta 入账）才增长，新消息发出→首请求完成之间旧轮快照恒追平账本——不查
  // 更晚轮，旧轮徽标每 500ms 被钉到「本会话面板当前挂载最后一段」=漂到新消息下面、
  // 原位统计条消失（实测回归）。更晚轮证据：快照更大（已完成新轮），或仍在流式
  // （terminal 未置/active 悬空——恰好覆盖上述整段窗口），遍历域=本会话桶（bySid）。
  // 不用出生序判更晚：分批恢复可倒序，误拦会让真末轮滚出窗口后无兜底。残余：轮中止
  // 且零用量时账本不涨、旧轮仍钉末段，可接受（该轮本就无统计行可挤占）
  function hasNewerRound(t) {
    var newer = false;
    var b = t.sid && bySid.get(t.sid);
    if (b) b.forEach(function (bt, tid2) {
      var t2 = turns.get(tid2);
      if (!t2 || t2 === t) return;
      if (t2.cum != null && t.cum != null) { if (t2.cum > t.cum) newer = true; }
      else if (!t2.terminal || t2.active) newer = true;
    });
    return newer;
  }
  function isSessLastRound(t) {
    if (!t.authoritative || t.cum == null) return false;
    var sc = sessCum.get(t.sid);
    return !!sc && t.cum >= sc.tt && !hasNewerRound(t);
  }

  // ---------- 面板归属：每个对话面板根节点带 data-session-id（通用面板组件，主列/子代理
  // 侧板/split/副屏同款；CDP 实证 section 的 closest 即所属会话）。侧板 tab 全部
  // forceMount 常驻、以 data-state=inactive 隐藏——取面板/section 时跳过隐藏态 ----------
  function paneEl(sid) {
    var els = document.querySelectorAll('[data-session-id="' + sid + '"]');
    for (var i = 0; i < els.length; i++) if (!els[i].closest('[data-state="inactive"]')) return els[i];
    return els.length ? els[0] : null;
  }
  function paneLastSec(sid) {
    var p = paneEl(sid);
    if (!p) return null;
    var secs = p.querySelectorAll('section[data-turn-id]');
    return secs.length ? secs[secs.length - 1] : null;
  }
  function paneTailSec(sid) {
    var p = paneEl(sid);
    return p ? p.querySelector('[data-v4-running-live-tail] section[data-turn-id]') : null;
  }

  function ensureBadge(tid) {
    var t = turns.get(tid);
    if (!t || !t.sid) return; // 无会话归属的 turn 无从定面板（事实帧 sessionId 必填，防御性）
    var txt = statsText(t);
    // DOM 定位链（id 三体系坑，3.14.1 探针实测：section[data-turn-id] 是 msg_ 形态但不等于
    // assistantMessageId，msgId 直查 miss；conversation 行级桥也只配流式瞬间）：
    // msgId → domId（本 turn 流式期间命中时回填的 section id，虚拟化重建后仍可重挂）
    // → 仅本会话流式 turn 走 live-tail 兜底（防旧 turn 误挂到正在跑的 turn 上）。
    // 全链按会话隔离：兜底只在本会话面板内取 section；精确 id 命中可多点挂靠
    // （同会话多面板同显的罕见形态），跨会话 turn id 不可能命中他面板 section
    var secs = null, via = '';
    if (t.msgId) { secs = document.querySelectorAll('section[data-turn-id="' + t.msgId + '"]'); via = 'msg'; }
    if ((!secs || !secs.length) && t.domId) { secs = document.querySelectorAll('section[data-turn-id="' + t.domId + '"]'); via = 'dom'; }
    var bt = streamDomBySid.get(t.sid);
    if ((!secs || !secs.length) && bt && streamTidBySid.get(t.sid) === tid) {
      secs = document.querySelectorAll('section[data-turn-id="' + bt + '"]'); via = 'bridge';
    }
    if ((!secs || !secs.length) && streamTidBySid.get(t.sid) === tid) {
      var tail = paneTailSec(t.sid);
      if (tail) { secs = [tail]; via = 'tail'; }
    }
    // 后台完成补挂链（per-sid）：该 turn 流式时本会话面板未在渲染（后台会话/面板后开），
    // 终态后按「本会话最近完成」对本会话面板最后一个 section 补挂；更晚轮已在跑时不补挂
    // ——末段已是新轮领地，且宿主校验宽免同判据已失效，硬贴=500ms 删-贴循环。切换瞬间
    // 若误挂旧 DOM，宿主校验（validateBadges）会清掉并于下轮重挂，自愈
    if ((!secs || !secs.length) && t.terminal && !t.domId && lastTermBySid.get(t.sid) === tid && !hasNewerRound(t)) {
      var retro = paneLastSec(t.sid);
      if (retro) { secs = [retro]; via = 'retro'; }
    }
    // 会话最后一轮兜底：渲染侧把超长 turn 拆成多个可视单元（AskUserQuestion 轮次各有
    // section，id 是合成 user 行），组的 domId section 滚出窗口后定位链全 miss——此时贴
    // 本会话面板当前挂载的最后一段，滚到会话底即徽标在底部。判据 isSessLastRound（含更晚
    // 轮守卫，见其注释），validateBadges 有同款宽免防删-贴循环
    if ((!secs || !secs.length) && isSessLastRound(t)) {
      var last0 = paneLastSec(t.sid);
      if (last0) { secs = [last0]; via = 'last'; }
    }
    if (!secs || !secs.length) { _w.__tokDbg.miss++; return; }
    var hitId = secs[0].getAttribute('data-turn-id');
    // domId 只认精确/权威桥命中；live-tail/末段兜底取的可能不是本 turn 的 section，回填会污染
    if (!t.domId && via !== 'tail' && via !== 'last') t.domId = hitId;
    if (hitId === t.msgId) _w.__tokDbg.hitMsg++;
    else _w.__tokDbg.hitBridge = (_w.__tokDbg.hitBridge || 0) + 1;
    // 真·会话最后一轮（isSessLastRound）→ 徽标改钉本会话面板当前挂载的最后一段：渲染侧
    // turn 切分可与 db parentID 归组不一致（超长 turn 尾部的消息被渲染成独立 section，
    // 实测 418 条消息单组会话渲染出两段），钉在组首段会让徽标落在会话中部
    if (isSessLastRound(t)) {
      var pin = paneLastSec(t.sid);
      if (pin) secs = [pin];
    }
    for (var si = 0; si < secs.length; si++) mountBadge(secs[si], txt, tid);
  }
  // 段内唯一 assistant 组贴组尾（常规会话原样）；多组段（巨长 turn）贴段尾——
  // querySelector 取首组会把徽标插到第一条回复后（回归实证），且组随内部虚拟化
  // 挂载、「末组」随滚动漂移，段尾是唯一稳定锚
  function mountBadge(sec, txt, tid) {
    var gs0 = sec.querySelectorAll('[class*="group/assistant-turn"]');
    var host = (gs0.length === 1) ? gs0[0] : sec;
    var el = host.querySelector(':scope > [data-zcode-tok-badge]');
    if (el && el.getAttribute('data-zcode-tok-badge') !== tid) return; // 他 turn 已占用，本轮放弃
    if (!txt) { if (el) el.remove(); return; } // 终态仍无用量：清掉占位，不留空壳
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-zcode-tok-badge', tid);
      host.appendChild(el);
    }
    if (el.__txt !== txt) { el.innerHTML = txt; el.__txt = txt; }
  }
  // 宿主校验：section 槽位被 React 复用换 id（切会话/虚拟化回收）后，残留在新消息容器里的
  // 旧统计在此移除。合法挂靠 = ① section 所在面板显示本 turn 的会话（面板根 data-session-id
  // === t.sid，多面板归属的第一道守卫）且 section id 与 turn 的 domId/msgId 相符，或
  // ② 流式期临时挂靠：本会话流式 turn（streamTidBySid）尚无任何 id 关联，或挂在本会话面板
  // live-tail 首 section（与定位链 tail 兜底一致）——文本行开流前桥接链不可用、domId 无从
  // 习得，而 msgId 已落地时旧宽免(!msgId&&!domId)恒假，统计条被本函数每 500ms 删一次再重贴
  // =闪现/消失循环（CDP MutationObserver 探针实证：删除恰按 500ms 节拍、习得 domId 即止），
  // 或 ③ 会话最后一轮钉本会话面板最后一段（判据与 ensureBadge 定位链一致，防删-贴循环）
  function validateBadges() {
    var els = document.querySelectorAll('[data-zcode-tok-badge]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], tid = el.getAttribute('data-zcode-tok-badge');
      var t = turns.get(tid);
      var s = el.closest('section[data-turn-id]');
      var ok = false;
      if (t && s && t.sid) {
        var pane = s.closest('[data-session-id]');
        if (pane && pane.getAttribute('data-session-id') === t.sid) {
          var sid = s.getAttribute('data-turn-id');
          ok = sid === t.domId || sid === t.msgId
            || (streamTidBySid.get(t.sid) === tid && !t.terminal
                && ((!t.msgId && !t.domId) || s === paneTailSec(t.sid)));
          if (!ok && isSessLastRound(t)) ok = s === paneLastSec(t.sid);
        }
      }
      if (!ok) {
        // 失配≠domId 必已污染：末段钉挂豁免失效（更晚轮开跑）被摘下的徽标，其 domId
        // section 可能仍挂在 DOM——保留它定位链才能当拍回挂原位（恢复轮无 msgId，清掉
        // 要等下一次权威校正才回得来）；domId section 真消失（复用换 id/虚拟化回收）才清
        if (t && t.domId && !document.querySelector('section[data-turn-id="' + t.domId + '"]')) t.domId = null;
        el.remove();
      }
    }
  }

  var pending = new Set(), paintTimer = null;
  function schedulePaint(tid) { pending.add(tid); if (!paintTimer) paintTimer = setTimeout(flushPaint, 200); }
  function flushPaint() { paintTimer = null; ensureStyle(); ensureSpeed(); pending.forEach(ensureBadge); pending.clear(); }

  // 虚拟化列表会卸载/重挂行、React 会清外来节点：500ms 扫描统一重贴（先校验宿主清残留）。
  // 重贴面 = 最近 12 个 turn + 各会话流式中的 turn（多面板并发流式时各会话的活 turn 都保贴）
  setInterval(function () {
    ensureStyle();
    validateBadges();
    ensureSpeed();
    var recent = [];
    turns.forEach(function (t) { recent.push(t); });
    recent.sort(function (a, b) { return b.bornAt - a.bornAt; });
    var pick = recent.slice(0, 12);
    for (var i = 0; i < recent.length; i++) {
      var t = recent[i];
      if (t.active && !t.terminal && pick.indexOf(t) < 0) pick.push(t);
    }
    pick.forEach(function (t) { ensureBadge(t.id); });
  }, 500);
})();
