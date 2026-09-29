/**
 * AI 搜索引擎
 *
 * 采用：迭代加深 + Negamax Alpha-Beta 剪枝 + 静态搜索(Quiescence)
 *       + 置换表(Transposition Table, Zobrist 哈希)
 *       + 杀手走法(Killer Move) + 历史启发(History Heuristic) + MVV-LVA 排序
 *
 * 中国象棋规则中"无子可动"（将死与困毙）均判负，因此搜索里
 * 生成不到合法走法即直接返回负杀分值，无需区分是否被将军。
 */

var C = require('./constants.js');
var MG = require('./movegen.js');
var EV = require('./evaluate.js');
var BOOK = require('./book.js');
var Position = require('./position.js');

var INF = 1000000;
var MATE = 100000;
var MAX_PLY = 40;
var MAX_QPLY = 14;
// 走法排序在 orderMoves 里对整个走法列表排序（不再只排前几手）：
// 排序质量直接决定 alpha-beta 的剪枝量，也是后续做剪枝的前提。
//
// 晚走法削减（LMR）：排序做扎实之后才敢开——靠后的安静走法先减一层搜，
// 只有抬升了 alpha 才按原深度补搜。上一轮在没有全排序时开它，等时对抗
// 0 胜 4 负（好棋排在乱序里被随机砍掉）；全排序后重新验证 4 胜 2 负。
var LMR_MIN_DEPTH = 4;
var LMR_MIN_MOVES = 4;
var LMR_REDUCTION = 1;
// 削减层数随"第几手"与"节点深度"递增（对数式）：越靠后、越深的安静走法越不可能好。
// 2026-09-28 实测（对比固定减 1 层）：节点 -40%、墙钟 -36%；固定深度对抗 d6 净 -5
// （90 局，噪声带内，等深度精度略降）；但**等时下明显更强**——大师档 30 个局面里
// 跑到 10 层的从 14 个增到 21 个，中位用时从 3.0s 降到 2.0s。典型的"速度类技术"。
var LMR_MORE_MOVES = 10;
var LMR_DEEP_DEPTH = 8;

// 空着裁剪（null-move）：不是将军、子力还够时，先假设自己不走一手让对方连走两步，
// 若这样对手都翻不了盘就直接截断。象棋几乎没有被迫走子（困毙极罕见），原理上安全。
//
// 上一轮用 depth ≥ 3 / 削减 2 层试过，等时对抗 0 胜 4 负——那时"空着"后的搜索
// 落在 depth ≤ 0，只剩静态搜索，"我不走对手也翻不了盘"这个判断太廉价。
// 这一轮门槛提到 depth ≥ 5（空着后至少还搜 2 层），且排序已全排序。
var NULL_MIN_DEPTH = 5;
var NULL_REDUCTION = 2;

// 迭代加深的预算预判：上一层耗时 × 本系数若超过剩余时限，下一层开了也会被砍掉、
// 结果作废——白等一场。所以提前收手，把已完成的那一层交出去。
// 实测分支因子约 2.75（中局 depth 8 约 1.2s → depth 9 约 3.3s），取 2.5 略宽松，
// 让"刚好装得下"的下一层仍然去试。
var NEXT_DEPTH_FACTOR = 2.5;

// 无用着削减（futility）：depth 1 时若静态评估离 alpha 还差一大截，安静走法几乎不可能
// 翻盘，直接跳过、不展开子树。吃子不跳（容易漏杀），第一手不跳（保底），将军时不跳。
//
// 2026-09-28 试过扩到 depth 2（余量 400）并加 razoring（评估差 400 就直接下沉到静态
// 搜索、够不着 alpha 就交差）：节点合计 -11%、墙钟 -6%，但确定性对抗 **净 -12**（90 局）
// ——省下的节点抵不过准确度的损失，两项都已回退。剪枝不是越多越好。
var FUTILITY_MARGIN = 200;
var NULL_MIN_PIECES = 9;

// ---------------------------------------------------------------------------
// 置换表：固定 2^16 槽的扁平 typed-array 表，键为 Position 的 Zobrist 哈希
//
// 旗标语义：EXACT 精确值 / LOWER 下界（截断）/ UPPER 上界（未抬升 alpha）。
// 杀棋分存表时按 ply 调整（与走子方无关的绝对距离），取出时还原。
// 替换策略：深度优先——浅层结果不覆盖同槽的深层结果。
// ---------------------------------------------------------------------------
var TT_BITS = 16;
var TT_SIZE = 1 << TT_BITS;
var TT_MASK = TT_SIZE - 1;
var TT_EXACT = 1;
var TT_LOWER = 2;
var TT_UPPER = 3;

/**
 * 难度配置
 *  depth         —— 迭代加深的最大层数（受 time 限制，可能提前结束）
 *  time          —— 单步思考时间上限（毫秒），到时立即返回已完成层的结果
 *  exact         —— 根节点是否使用全窗口搜索（得到精确分值，仅浅层难度启用）
 *  noise         —— 叠加到根节点分值上的随机扰动幅度，越大越"随意"
 *  topN          —— 在最优的 N 个候选中随机挑一个（需 exact 为 true 才有意义）
 *  spread        —— 候选纳入范围：与最优分差不超过该值
 *  blunder       —— 直接随机走一步的概率（模拟新手失误）
 *  useBook       —— 开局阶段是否查询开局库
 *  openingTopN   —— 开局前两手用于制造变化的候选数（配合浅层精确搜索）
 *  openingSpread —— 开局候选的分差容忍度
 *
 * 深度阶梯是 **2 / 4 / 6 / 8 / 10（等距 2 层）**。2026-09-28 重定：这几档的上限是当年
 * 按慢引擎定的，几轮搜索优化（全排序 + LMR + 空着裁剪 + TT + PVS + futility）之后
 * 引擎快了一个量级——实测中等档只用掉 1.5s 预算里的 19ms、困难档 2600ms 里的 133ms，
 * **卡住强度的是深度上限而不是速度**（详见 README「难度档位的深度上限重定」）。
 * 而「难度阶梯验证」实测**每 2 层 ≈ 净 +20 局**，所以等距 2 层 = 难度均匀。
 * 时限不变（那是产品定的等待容忍度），各档都还留着余量。
 */
var LEVELS = {
  beginner: {
    key: 'beginner', label: '入门', depth: 2, time: 350, exact: true,
    noise: 90, topN: 6, spread: 180, blunder: 0.35, useBook: false, openingTopN: 6, openingSpread: 180
  },
  easy: {
    key: 'easy', label: '简单', depth: 4, time: 800, exact: true,
    noise: 50, topN: 4, spread: 120, blunder: 0.12, useBook: true, openingTopN: 4, openingSpread: 120
  },
  normal: {
    key: 'normal', label: '中等', depth: 6, time: 1500, exact: false,
    noise: 0, topN: 1, spread: 0, blunder: 0, useBook: true, openingTopN: 3, openingSpread: 25
  },
  hard: {
    key: 'hard', label: '困难', depth: 8, time: 2600, exact: false,
    noise: 0, topN: 1, spread: 0, blunder: 0, useBook: true, openingTopN: 2, openingSpread: 12
  },
  master: {
    key: 'master', label: '大师', depth: 10, time: 4500, exact: false,
    noise: 0, topN: 1, spread: 0, blunder: 0, useBook: true, openingTopN: 2, openingSpread: 8
  }
};

/** 开局变化生效的己方已走手数上限 */
var OPENING_VARIETY_MOVES = 2;
/** 开局变化用的浅层精确搜索深度与时间上限 */
var OPENING_VARIETY_DEPTH = 2;
var OPENING_VARIETY_TIME = 450;

var LEVEL_ORDER = ['beginner', 'easy', 'normal', 'hard', 'master'];

// ---------------------------------------------------------------------------
// 搜索上下文
// ---------------------------------------------------------------------------

function createContext() {
  var killers = [];
  for (var i = 0; i < MAX_PLY + MAX_QPLY + 4; i++) {
    killers.push([0, 0]);
  }
  var history = [];
  for (i = 0; i < C.BOARD_SIZE * C.BOARD_SIZE; i++) history.push(0);

  var bestAtPly = [];
  for (i = 0; i < MAX_PLY + MAX_QPLY + 4; i++) bestAtPly.push(0);

  var hashMove = [];
  for (i = 0; i < MAX_PLY + MAX_QPLY + 4; i++) hashMove.push(0);

  // 重复局面判定用的路径栈：索引即 ply，每个节点进入时覆盖写入
  var pathHash = [];
  var pathCheck = [];
  for (i = 0; i < MAX_PLY + MAX_QPLY + 4; i++) {
    pathHash.push(0);
    pathCheck.push(0);
  }

  return {
    undoPool: Position.createUndoPool(MAX_PLY + MAX_QPLY + 8),
    filterUndo: { from: 0, to: 0, piece: 0, captured: 0, side: 0 },
    // 走法与分值共用一个扁平数组，跨递归复用，避免频繁分配
    moveStack: [],
    scoreStack: [],
    killers: killers,
    history: history,
    bestAtPly: bestAtPly,
    // 置换表命中的走法（按 ply），排序优先级高于 PV 走法
    hashMove: hashMove,
    // 重复局面判定：路径栈索引即 ply，节点进入时覆盖写入
    repDisabled: false,   // true 时关闭判定（供对照测试与基准 A/B）
    rootSide: 0,          // 根节点走子方，用于判定长将方
    pathHash: pathHash,   // 各层节点的局面哈希
    pathCheck: pathCheck, // 各层节点是否正被将军（1/0）
    nullLock: false,      // true 表示当前在空着搜索内部（不再空着、不记路径）
    pieces: 0,            // 盘上非将帅子力数，空着裁剪的门槛
    // 置换表本体：五条平行 typed-array，ttFlag 为 0 即空槽
    ttKey: new Int32Array(TT_SIZE),
    ttMove: new Int32Array(TT_SIZE),
    ttScore: new Int32Array(TT_SIZE),
    ttDepth: new Uint8Array(TT_SIZE),
    ttFlag: new Uint8Array(TT_SIZE),
    ttHits: 0,
    noTT: false,
    nodes: 0,
    deadline: 0,
    aborted: false
  };
}

function resetContext(ctx, deadline) {
  for (var i = 0; i < ctx.bestAtPly.length; i++) ctx.bestAtPly[i] = 0;
  for (i = 0; i < ctx.killers.length; i++) { ctx.killers[i][0] = 0; ctx.killers[i][1] = 0; }
  for (i = 0; i < ctx.history.length; i++) ctx.history[i] = 0;
  for (i = 0; i < ctx.hashMove.length; i++) ctx.hashMove[i] = 0;
  ctx.ttFlag.fill(0);   // 键/分/深度随旗标归零即失效，无需逐个清
  ctx.ttHits = 0;
  ctx.moveStack.length = 0;
  ctx.scoreStack.length = 0;
  ctx.nodes = 0;
  ctx.deadline = deadline;
  ctx.aborted = false;
}

/**
 * 初始化一次搜索需要的路径状态：把根局面写进第 0 层，搜索中任何一条走回根局面
 *    （或路径上其它局面）的变化都能被识别；ply ≥ 1 的节点由 negamax 写入。
 *
 * @param {object} ctx 搜索上下文
 * @param {Position} root 根局面
 * @param {boolean} [disabled] true 时关闭重复局面判定（供对照测试与基准 A/B）
 */
function initSearch(ctx, root, disabled) {
  ctx.repDisabled = !!disabled;
  ctx.rootSide = root.side;
  ctx.pathHash[0] = root.hash;
  ctx.pathCheck[0] = 0;
  ctx.nullLock = false;

  // 空着裁剪的子力门槛：残局（子力太少）不空着，避免"空着判断"失真
  var n = 0;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var p = root.board[i];
    if (p !== C.EMPTY && p !== C.R_KING && p !== C.B_KING) n++;
  }
  ctx.pieces = n;
}

function recordKiller(ctx, ply, move) {
  var slot = ctx.killers[ply];
  if (!slot) return;
  if (slot[0] === move) return;
  slot[1] = slot[0];
  slot[0] = move;
}

/**
 * 走法排序分值（越大越先搜）
 *
 * 顺序：置换表走法 > 上一层 PV 走法 > 划算的吃子(MVV-LVA) > 杀手走法 >
 *      安静走法(历史启发 + 位置增益) > **亏子的吃子**
 *
 * 最后一类是 SEE 的简化版：吃的子比自己便宜、且对方能回吃（车吃有根的马、
 * 炮打有保护的兵）。这类走法很少是好棋、搜起来却贵（子树大），排在安静走法
 * 之后能省下大量节点；"吃子无根"和"便宜子吃贵子"仍然排在最前面。
 */
function moveScore(pos, move, ply, ctx) {
  if (ctx.hashMove[ply] === move) return 3000000;
  if (ctx.bestAtPly[ply] === move) return 2000000;

  var from = MG.moveFrom(move);
  var to = MG.moveTo(move);
  var victim = pos.board[to];
  var attacker = pos.board[from];

  if (victim !== C.EMPTY) {
    var victimValue = EV.pieceValue(victim);
    var attackerValue = EV.pieceValue(attacker);
    if (victimValue < attackerValue &&
        MG.isSquareAttacked(pos, to, pos.side === C.RED ? C.BLACK : C.RED, from)) {
      return -1000000 + victimValue;
    }
    return 1000000 + victimValue * 20 - attackerValue;
  }

  var killers = ctx.killers[ply];
  if (killers) {
    if (killers[0] === move) return 900000;
    if (killers[1] === move) return 890000;
  }

  var type = attacker > 0 ? attacker : -attacker;
  var table = EV.PST[type];
  var gain;
  if (table) {
    gain = attacker > 0
      ? table[to] - table[from]
      : table[C.mirrorIdx(to)] - table[C.mirrorIdx(from)];
  } else {
    gain = 0;
  }
  return ctx.history[from * C.BOARD_SIZE + to] + gain * 8;
}

/**
 * 对 [start, end) 区间计算分值并**整体**排序
 *
 * 以前只把前 ORDER_K 手做选择排序，其余保持生成顺序——那些没排过序的走法在
 * alpha-beta 里基本等于白搜（好棋排在后面，剪枝就少）。排序质量直接决定剪枝量，
 * 而剪枝是后续一切加速（晚走法削减、空着裁剪）的前提，所以这里排满整个区间。
 *
 * 注意：**只有根搜索需要整体排序**（它要遍历全部着法拿分值）。negamax / quiesce
 * 里绝大多数节点第一手就剪枝了，排完剩下的纯属浪费——那两处改用 scoreMoves +
 * pickNextMove 按需选取（选出来的顺序与整体选择排序**逐个一致**，所以搜索结果不变）。
 */
function orderMoves(pos, ctx, start, end, ply) {
  scoreMoves(pos, ctx, start, end, ply);
  var moves = ctx.moveStack;
  var scores = ctx.scoreStack;
  for (var i = start; i < end; i++) {
    var maxIdx = i;
    for (var j = i + 1; j < end; j++) {
      if (scores[j] > scores[maxIdx]) maxIdx = j;
    }
    if (maxIdx !== i) {
      var tm = moves[i]; moves[i] = moves[maxIdx]; moves[maxIdx] = tm;
      var ts = scores[i]; scores[i] = scores[maxIdx]; scores[maxIdx] = ts;
    }
  }
}

/** 只给 [start, end) 算分值（不排序） */
function scoreMoves(pos, ctx, start, end, ply) {
  var moves = ctx.moveStack;
  var scores = ctx.scoreStack;
  for (var i = start; i < end; i++) {
    scores[i] = moveScore(pos, moves[i], ply, ctx);
  }
}

/**
 * 把 [i, end) 中分值最大的着法换到位置 i
 *
 * 这是选择排序的"按需"版本：调用方每取一手就调一次，不提前把整段排完。
 * 与整体选择排序相比，取出的序列完全相同，只是少了尾部那些用不到的排序。
 */
function pickNextMove(ctx, start, end, i) {
  var moves = ctx.moveStack;
  var scores = ctx.scoreStack;
  var maxIdx = i;
  for (var j = i + 1; j < end; j++) {
    if (scores[j] > scores[maxIdx]) maxIdx = j;
  }
  if (maxIdx !== i) {
    var tm = moves[i]; moves[i] = moves[maxIdx]; moves[maxIdx] = tm;
    var ts = scores[i]; scores[i] = scores[maxIdx]; scores[maxIdx] = ts;
  }
}

// ---------------------------------------------------------------------------
// 静态搜索：只展开吃子，消除水平线效应
// ---------------------------------------------------------------------------

/**
 * 静态搜索：只展开吃子，消除水平线效应
 * @param {number} qply 已进入静态搜索的层数（与搜索深度 ply 分开计数）
 */
function quiesce(pos, alpha, beta, ply, qply, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && Date.now() > ctx.deadline) ctx.aborted = true;
  if (ctx.aborted) return 0;

  // 被将军时不能"站着不动"：静态搜索必须搜**全部应将**（走将 / 垫子这类应法不是吃子，
  // 默认的 capturesOnly 会把它们全漏掉）。负amax 层面的将军延伸只兜住了 depth 0 那一层，
  // 吃子交换里再将军（qply ≥ 1）就漏了——所以这里也要处理。
  var inCheck = MG.isChecked(pos, pos.side);
  var best = -INF;
  if (!inCheck) {
    best = EV.evaluateForSide(pos);
    if (best >= beta) return best;
    if (best > alpha) alpha = best;
  }
  if (qply >= MAX_QPLY || ply >= MAX_PLY + MAX_QPLY) {
    // 到搜索上限：被将军时不能拿静态评估糊弄，那正是水平线效应本身
    return inCheck ? EV.evaluateForSide(pos) : best;
  }

  var stack = ctx.moveStack;
  var start = MG.genLegalMovesInPlace(pos, pos.side, stack, !inCheck, ctx.filterUndo);
  var end = stack.length;
  if (end === start) return inCheck ? -MATE + ply : best; // 无路可走：将死或困毙

  scoreMoves(pos, ctx, start, end, ply);

  var undo = ctx.undoPool[ply];
  for (var i = start; i < end; i++) {
    pickNextMove(ctx, start, end, i); // 按需取出当前最大，不提前排完
    var move = stack[i];
    var from = MG.moveFrom(move);
    var to = MG.moveTo(move);

    // 增量剪枝：即使白吃掉该子仍无法提升 alpha 时直接跳过
    // （被将军时 best 不是静态评估而是 -INF，不能套这个判断）
    if (!inCheck && best + EV.pieceValue(pos.board[to]) + 200 < alpha) continue;

    pos.makeMove(from, to, undo);
    var score = -quiesce(pos, -beta, -alpha, ply + 1, qply + 1, ctx);
    pos.unmakeMove(undo);
    if (ctx.aborted) break;

    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }

  stack.length = start;
  return best;
}

// ---------------------------------------------------------------------------
// Negamax + Alpha-Beta
// ---------------------------------------------------------------------------

/** 杀棋分存表前把「离根的 ply」折算进去，使分值与读取时的节点无关 */
function ttWriteScore(score, ply) {
  if (score > MATE - 1000) return score + ply;
  if (score < -MATE + 1000) return score - ply;
  return score;
}

/** 读取时按当前 ply 还原杀棋距离 */
function ttReadScore(score, ply) {
  if (score > MATE - 1000) return score - ply;
  if (score < -MATE + 1000) return score + ply;
  return score;
}

// ---------------------------------------------------------------------------
// 重复局面：双方不变作和 / 单方长将判负
//
// 与 core/game.js 的终局判定同一套规则（同型局面 = 盘面 + 走子方相同）：
// 循环段内单方每手都在将军而对方没有 → 该方长将判负；否则双方不变作和。
//
// 搜索里提前一拍生效——同型局面在搜索路径上第二次出现就按上述规则给分。
// 这样做有三个好处：
//   ① 引擎不再把"走回去"当成新变化反复计算，也就不会出现走一步、
//      下一步又撤销自己的往返走子；
//   ② 优势方不会主动走进重复和棋（和棋 0 分低于它的优势分），
//      劣势方则会主动争取和棋；
//   ③ 长将判负能被算出来，引擎不会把长将当成和棋去走。
//
// 只认搜索树内的循环（含"走回根局面"）：循环段的每一手是否将军都看得见，
// 长将才判得准；分值也不依赖对局外的信息，对局、提示、分析各调用方行为一致。
// 分值不写入置换表：它依赖搜索路径，换个路径就不成立。
// ---------------------------------------------------------------------------

// 重复局面（双方不变作和）在搜索内的分值：**故意给负分**，也就是"不甘心和棋"。
//
// 给 0 会出大问题：引擎只要算出自己略微落后（比如 -30），就会去往返走子凑重复和棋
// ——分值是 0，比 -30 好。对手不配合（人类、或带随机性的低难度）时，它就白挨打。
// 实测：关掉重复判定后大师能赢「简单」，开着却输/和。
//
// 给 -120（约 1.7 个兵）的含义是"只有明显落后才认和"：均势与微劣时继续找机会，
// 真被压住了仍然会接受和棋（-600 的局面里和棋 -120 依然划算）。
var REPETITION_DRAW = -120;

/**
 * 判定当前节点是否构成重复局面
 *
 * @param {Position} pos 当前局面
 * @param {number} ply 当前层
 * @param {object} ctx 搜索上下文
 * @returns {?number} 重复局面的分值；null 表示不构成重复
 */
function repetitionValue(pos, ply, ctx) {
  if (ctx.repDisabled) return null;
  var hash = pos.hash;
  // 同型局面必然出现在相隔偶数层的节点上（走子方要相同），故隔层回扫
  for (var i = ply - 2; i >= 0; i -= 2) {
    if (ctx.pathHash[i] === hash) return repeatSegmentValue(i, ply, pos, ctx);
  }
  return null;
}

/**
 * 循环段 [first+1, ply] 的长将判定，规则与 core/game.js 的 _perpetualCheckSide 一致
 *
 * @param {number} first 同型局面上一次出现在搜索路径上的层号
 * @param {number} ply 当前层
 * @param {Position} pos 当前局面
 * @param {object} ctx 搜索上下文
 * @returns {number} 不变作和为 REPETITION_DRAW；单方长将时给出该方判负的杀棋分
 */
function repeatSegmentValue(first, ply, pos, ctx) {
  // 根节点走子方在奇数层落子，另一方在偶数层落子
  var mover = ctx.rootSide;
  var moverTotal = 0;
  var moverCheck = 0;
  var foeTotal = 0;
  var foeCheck = 0;

  for (var k = first + 1; k <= ply; k++) {
    if ((k & 1) === 1) {
      moverTotal++;
      if (ctx.pathCheck[k]) moverCheck++;
    } else {
      foeTotal++;
      if (ctx.pathCheck[k]) foeCheck++;
    }
  }

  // 长将方：-1 表示双方都没长将（注意 C.RED 就是 0，不能用 0 当哨兵）
  var perpetual = -1;
  if (moverTotal > 0 && moverCheck === moverTotal && foeCheck === 0) {
    perpetual = mover;
  } else if (foeTotal > 0 && foeCheck === foeTotal && moverCheck === 0) {
    perpetual = mover === C.RED ? C.BLACK : C.RED;
  }
  if (perpetual < 0) return REPETITION_DRAW;

  // 长将方判负，量纲与引擎其它杀棋分一致（从当前节点走子方视角）
  return pos.side === perpetual ? -MATE + ply : MATE - ply;
}

function negamax(pos, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && Date.now() > ctx.deadline) ctx.aborted = true;
  if (ctx.aborted) return 0;

  var inCheck = MG.isChecked(pos, pos.side) ? 1 : 0;

  // 重复局面：必须在置换表之前判定，重复分依赖路径、不进置换表。
  // 路径标记要先写入本层——判定要读 [first+1, ply] 整段的将军标记，其中含本层
  // （本层的标记描述的是"刚走的这一手是否将军"）。
  // 空着搜索内部不记账：空着不是真实着法，不该参与重复判定。
  if (!ctx.repDisabled && !ctx.nullLock) {
    ctx.pathHash[ply] = pos.hash;
    ctx.pathCheck[ply] = inCheck;
    var rep = repetitionValue(pos, ply, ctx);
    if (rep !== null) return rep;
  }

  if (depth <= 0 || ply >= MAX_PLY) {
    // 将军延伸：静态搜索只生成吃子（genPseudoMoves 的 capturesOnly），碰上
    // "被将军但没有吃子可走"的局面会直接返回静态评估——等于没看见自己被将；
    // 被将死 / 困毙也会被当成普通局面估分（这是水平线效应最要命的一种）。
    // 所以被将军时不下沉到静态搜索，改为再搜一层，让应将被真正搜到。
    // 护栏：ply 接近 MAX_PLY 时不再延，避免连将把搜索拖爆；空着搜索里不延
    // （空着之后的"被将"不是真实局面）。
    if (inCheck && depth <= 0 && ply < MAX_PLY - 4 && !ctx.nullLock) {
      depth = 1;
    } else {
      return quiesce(pos, alpha, beta, ply, 0, ctx);
    }
  }

  // 置换表探测：层数足够时按旗标直接取值；不足也借它的走法排序
  var hash = pos.hash;
  var ttIdx = hash & TT_MASK;
  if (!ctx.noTT && ctx.ttFlag[ttIdx] !== 0 && ctx.ttKey[ttIdx] === hash) {
    var tMove = ctx.ttMove[ttIdx];
    ctx.hashMove[ply] = tMove;
    if (ctx.ttDepth[ttIdx] >= depth) {
      var tFlag = ctx.ttFlag[ttIdx];
      var tScore = ttReadScore(ctx.ttScore[ttIdx], ply);
      ctx.ttHits++;
      if (tFlag === TT_EXACT) return tScore;
      if (tFlag === TT_LOWER && tScore >= beta) return tScore;
      if (tFlag === TT_UPPER && tScore <= alpha) return tScore;
    }
  } else {
    ctx.hashMove[ply] = 0;
  }

  var stack = ctx.moveStack;
  var start = MG.genLegalMovesInPlace(pos, pos.side, stack, false, ctx.filterUndo);
  var end = stack.length;

  if (end === start) {
    // 无合法走法：将死或困毙，均判负；离根越近分值越高（优先选择速胜）
    return -MATE + ply;
  }

  // 空着裁剪：不是将军、子力还够、且不在空着搜索里时，先假设自己不走一手。
  // 空着搜索给出的杀棋分不可信（它比真实着法弱），只用来截断。
  if (depth >= NULL_MIN_DEPTH && !inCheck && !ctx.nullLock &&
      ctx.pieces >= NULL_MIN_PIECES && beta < MATE - 1000) {
    ctx.nullLock = true;
    pos.makeNullMove();
    var nullScore = -negamax(pos, depth - 1 - NULL_REDUCTION, -beta, -beta + 1, ply + 1, ctx);
    pos.unmakeNullMove();
    ctx.nullLock = false;
    if (!ctx.aborted && nullScore >= beta) {
      return nullScore > MATE - 1000 ? beta : nullScore;
    }
  }

  var undo = ctx.undoPool[ply];
  var best = -INF;
  var bestMove = stack[start];
  var alphaAtEntry = alpha;

  // 无用着削减的判据（只在 depth 1 算，其它深度不适用）
  var futile = false;
  if (depth === 1 && !inCheck && alpha < MATE - 1000) {
    futile = EV.evaluateForSide(pos) + FUTILITY_MARGIN <= alpha;
  }

  // 分值放在空着裁剪之后算：空着能截断时整段排序就白做了
  scoreMoves(pos, ctx, start, end, ply);

  for (var i = start; i < end; i++) {
    pickNextMove(ctx, start, end, i); // 按需取出当前最大，不提前排完
    var move = stack[i];
    var from = MG.moveFrom(move);
    var to = MG.moveTo(move);
    var quiet = pos.board[to] === C.EMPTY;

    if (futile && i > start && quiet) continue;

    pos.makeMove(from, to, undo);
    if (!quiet) ctx.pieces--;

    var score;
    // 零窗口（PVS）：只有第一手值全窗口。其余走法先用 (alpha, alpha+1) 的窄窗口试探
    // ——绝大多数走法在这里就被否掉，省下全窗口的开销；只有真的抬升了 alpha 才按全窗口
    // 重搜。这依赖走法排序质量（有全排序 + 置换表走法 + 杀手 + 历史撑着）。
    // 晚走法削减：全排序之后靠后的安静走法确实"不太可能好"，先减一层 + 零窗口搜；
    // 抬升了 alpha 说明判断错了，再按原深度全窗口补搜（吃子不削减，容易漏杀）。
    var nullWindow = (i > start);
    if (quiet && depth >= LMR_MIN_DEPTH && i - start >= LMR_MIN_MOVES) {
      var lmrR = LMR_REDUCTION;
      if (i - start >= LMR_MORE_MOVES) lmrR++;
      if (depth >= LMR_DEEP_DEPTH) lmrR++;
      score = -negamax(pos, depth - 1 - lmrR, -alpha - 1, -alpha, ply + 1, ctx);
      if (!ctx.aborted && score > alpha) {
        score = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, ctx);
      }
    } else if (nullWindow) {
      score = -negamax(pos, depth - 1, -alpha - 1, -alpha, ply + 1, ctx);
      if (!ctx.aborted && score > alpha && score < beta) {
        score = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, ctx);
      }
    } else {
      score = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, ctx);
    }
    pos.unmakeMove(undo);
    if (!quiet) ctx.pieces++;

    if (ctx.aborted) break;

    if (score > best) {
      best = score;
      bestMove = move;
    }
    if (score > alpha) alpha = score;

    if (alpha >= beta) {
      // 安静走法引发截断时记录杀手走法与历史分值
      if (quiet) {
        recordKiller(ctx, ply, move);
        ctx.history[from * C.BOARD_SIZE + to] += depth * depth;
      }
      break;
    }
  }

  stack.length = start;

  // 存表：被中断的结果不可靠，不存；浅层结果不覆盖同槽深层结果
  if (!ctx.aborted && !ctx.noTT &&
      (ctx.ttFlag[ttIdx] === 0 || depth >= ctx.ttDepth[ttIdx])) {
    ctx.ttKey[ttIdx] = hash;
    ctx.ttMove[ttIdx] = bestMove;
    ctx.ttScore[ttIdx] = ttWriteScore(best, ply);
    ctx.ttDepth[ttIdx] = depth;
    ctx.ttFlag[ttIdx] = best <= alphaAtEntry ? TT_UPPER : (best >= beta ? TT_LOWER : TT_EXACT);
  }

  if (!ctx.aborted && best > alphaAtEntry) {
    ctx.bestAtPly[ply] = bestMove;
  }
  return ctx.aborted && best === -INF ? 0 : best;
}

/**
 * 根节点搜索，返回全部根走法的分值（用于难度随机化与提示）
 * @param {boolean} exact true 时根节点不抬升 alpha，使每个根走法都得到精确分值
 *                        （代价是失去根节点剪枝，仅用于浅层难度）
 */
function searchRoot(pos, depth, exact, ctx) {
  var stack = ctx.moveStack;
  var start = MG.genLegalMovesInPlace(pos, pos.side, stack, false, ctx.filterUndo);
  var end = stack.length;
  if (end === start) return null;

  orderMoves(pos, ctx, start, end, 0);

  var moves = [];
  var undo = ctx.undoPool[0];
  var alpha = -INF;
  var best = -INF;
  var bestMove = stack[start];

  for (var i = start; i < end; i++) {
    var move = stack[i];
    pos.makeMove(MG.moveFrom(move), MG.moveTo(move), undo);
    var windowAlpha = exact ? -INF : alpha;
    var score = -negamax(pos, depth - 1, -INF, -windowAlpha, 1, ctx);
    pos.unmakeMove(undo);

    if (ctx.aborted) {
      stack.length = start;
      return null;
    }

    moves.push({ move: move, score: score, bound: !exact && !(score > alpha) });
    if (score > best) {
      best = score;
      bestMove = move;
    }
    if (!exact && score > alpha) alpha = score;
  }

  stack.length = start;
  ctx.bestAtPly[0] = bestMove;

  // 非全窗口搜索里，只有真正抬升过 alpha 的走法拿到的是可信分值，其余只是"上界"。
  // 上界可以恰好等于最优分，若让它参与同分比大小（按走法编码取小），
  // 就可能让一手坏棋靠编码小中选——实测就是这样把马送掉的。所以可信分排在前面。
  moves.sort(function (a, b) {
    if (a.bound !== b.bound) return a.bound ? 1 : -1;
    return b.score - a.score || a.move - b.move;
  });
  return { scored: moves, bestScore: best, bestMove: bestMove };
}

/**
 * 为当前走子方计算最佳走法
 * @param {Position} pos 局面（side 即需要走子的一方）
 * @param {object} [options] { level: 'normal', moveNumber: 0, deterministic: false, depth: 0 }
 *        moveNumber 为该方已经走过的步数，用于判断是否处于开局阶段
 *        deterministic 为 true 时关闭时间截止与全部随机化，结果可复现（供测试/回放）
 *        depth 覆盖难度的最大搜索深度，0/省略表示用难度自带值
 *        noTT 为 true 时关闭置换表（供对照测试）
 *        noRep 为 true 时关闭重复局面判定（供对照测试与基准 A/B）
 * @returns {?{move:number, from:number, to:number, score:number, depth:number,
 *              nodes:number, time:number, mateIn:number, blunder:boolean}}
 */
function findBestMove(pos, options) {
  options = options || {};
  var level = LEVELS[options.level] || LEVELS.normal;
  // 确定性模式：关闭时间截止与一切随机化、固定搜索深度，结果可复现（供测试/回放）
  var deterministic = !!options.deterministic;
  var maxDepth = options.depth || level.depth;
  var startTime = Date.now();
  var ctx = createContext();
  ctx.noTT = !!options.noTT;
  resetContext(ctx, deterministic ? Infinity : startTime + Math.max(100, level.time));
  initSearch(ctx, pos, options.noRep);

  var allMoves = MG.genLegalMoves(pos, pos.side);
  if (allMoves.length === 0) return null;

  // 低难度：按概率直接随机走一步（确定性模式跳过）
  if (!deterministic && level.blunder > 0 && Math.random() < level.blunder) {
    var randomMove = allMoves[(Math.random() * allMoves.length) | 0];
    return {
      move: randomMove, from: MG.moveFrom(randomMove), to: MG.moveTo(randomMove),
      score: 0, depth: 0, nodes: 0, time: Date.now() - startTime,
      mateIn: 0, blunder: true
    };
  }
  // 开局库：前几手直接按权重取库着，保证开局自然且盘盘不同（确定性模式跳过）
  if (!deterministic && level.useBook !== false && options.useBook !== false) {
    var bookMove = BOOK.getBookMove(pos);
    if (bookMove !== null && allMoves.indexOf(bookMove) >= 0) {
      return {
        move: bookMove, from: MG.moveFrom(bookMove), to: MG.moveTo(bookMove),
        score: 0, depth: 0, nodes: 0, time: Date.now() - startTime,
        mateIn: 0, blunder: false, book: true
      };
    }
  }

  var scored = null;
  var bestScore = 0;
  var completedDepth = 0;
  var lastIterMs = 0;

  for (var depth = 1; depth <= maxDepth; depth++) {
    // 预算预判：装不下的下一层不开了（见 NEXT_DEPTH_FACTOR 的说明）
    if (lastIterMs > 0 && lastIterMs * NEXT_DEPTH_FACTOR > ctx.deadline - Date.now()) break;

    var iterStart = Date.now();
    ctx.aborted = false;
    var result = searchRoot(pos, depth, !!level.exact, ctx);
    if (!result) break; // 本层超时未完成，沿用上一层结果

    lastIterMs = Date.now() - iterStart;
    scored = result.scored;
    bestScore = result.bestScore;
    completedDepth = depth;

    // 已算出必杀则无需继续加深
    if (bestScore > MATE - 1000 || bestScore < -MATE + 1000) break;
    if (Date.now() > ctx.deadline) break;
  }

  if (!scored || scored.length === 0) {
    var fallback = allMoves[0];
    return {
      move: fallback, from: MG.moveFrom(fallback), to: MG.moveTo(fallback),
      score: 0, depth: 0, nodes: ctx.nodes, time: Date.now() - startTime,
      mateIn: 0, blunder: false
    };
  }

  // 已算出必杀时不做任何随机化，避免放跑胜局
  var mateFound = bestScore > MATE - 1000 || bestScore < -MATE + 1000;

  // 选招分值来源：
  //   level.exact 为 true 时，主搜索已给出精确分值，直接使用
  //   否则非最优走法的分值仅为上界，无法用于比较；
  //   开局阶段额外做一次浅层全窗口搜索，以精确分值为依据制造开局变化
  var selection = scored;
  var topN = level.topN;
  var spread = level.spread;

  var wantVariety = !deterministic && !level.exact && !mateFound && topN <= 1 && completedDepth >= 1 &&
    (options.moveNumber === undefined || options.moveNumber <= OPENING_VARIETY_MOVES);

  if (wantVariety) {
    var savedDeadline = ctx.deadline;
    ctx.deadline = Math.min(savedDeadline, Date.now() + OPENING_VARIETY_TIME);
    ctx.aborted = false;
    var varietyResult = searchRoot(
      pos, Math.min(OPENING_VARIETY_DEPTH, completedDepth), true, ctx
    );
    ctx.deadline = savedDeadline;
    if (varietyResult && varietyResult.scored.length > 0) {
      selection = varietyResult.scored;
      topN = level.openingTopN;
      spread = level.openingSpread;
    }
  }

  // 确定性模式直接取分值最高者，绕过一切随机挑选
  var chosen = deterministic ? scored[0].move : pickMove(selection, topN, spread, level.noise, mateFound);
  var elapsed = Date.now() - startTime;

  // 杀棋距离：MATE - ply 表示 ply 步后取胜
  var mateIn = 0;
  if (bestScore > MATE - 1000) mateIn = Math.ceil((MATE - bestScore) / 2);
  else if (bestScore < -MATE + 1000) mateIn = -Math.ceil((bestScore + MATE) / 2);

  return {
    move: chosen,
    from: MG.moveFrom(chosen),
    to: MG.moveTo(chosen),
    score: bestScore,
    depth: completedDepth,
    nodes: ctx.nodes,
    ttHits: ctx.ttHits,
    time: elapsed,
    mateIn: mateIn,
    blunder: false,
    book: false
  };
}

/**
 * 依据难度参数在候选走法中挑选，制造强弱差异
 * @param {Array<{move:number,score:number}>} scored 已按分值降序排列的候选
 * @param {boolean} forceBest 强制选择最优走法（已算出杀棋时）
 */
function pickMove(scored, topN, spread, noise, forceBest) {
  if (scored.length === 1 || forceBest) return scored[0].move;
  if (topN <= 1) {
    // 仅允许微小抖动，不改变候选集
    return pickByNoise(scored, 1, 0, noise, false);
  }
  return pickByNoise(scored, topN, spread > 0 ? spread : noise * 2, noise, true);
}

/**
 * 在候选中叠加随机扰动后挑选
 *
 * **只在"可信分值"的走法里挑**：窄窗口搜索里只有抬升过 alpha 的根走法拿到的是真实分，
 * 其余只是"上界"——上界可以虚高，一旦参与随机挑选就会挑到坏棋。实测把中等档的抖动
 * 从 0 调到 15（窄窗口），平均每步损失从 5 分飙到 **288 分**、51% 的步子亏两个兵以上；
 * 同样的参数换成全窗口就回到 5 分。这正是"根走法择路"那个 bug 的翻版，只不过发生在
 * 随机挑选这一步。全窗口搜索里所有走法都可信，pool 就是全体，行为不变。
 *
 * @param {boolean} useSpread true 时用 spread 限制候选范围，false 时只取扰动后的第一名
 */
function pickByNoise(scored, topN, spread, noise, useSpread) {
  var pool = [];
  for (var q = 0; q < scored.length; q++) {
    if (!scored[q].bound) pool.push(scored[q]);
  }
  if (pool.length === 0) pool = scored; // 一个可信的都没有（极端局面）才退回全体

  if (noise <= 0) {
    if (!useSpread) return pool[0].move;
    var tied = [];
    for (var t = 0; t < pool.length && tied.length < topN; t++) {
      if (pool[0].score - pool[t].score <= spread) tied.push(pool[t]);
    }
    return tied[(Math.random() * tied.length) | 0].move;
  }

  var noisy = [];
  for (var i = 0; i < pool.length; i++) {
    noisy.push({ move: pool[i].move, score: pool[i].score + (Math.random() * 2 - 1) * noise });
  }
  noisy.sort(function (a, b) { return b.score - a.score; });

  if (!useSpread) return noisy[0].move;

  var candidates = [];
  var bestNoisy = noisy[0].score;
  for (i = 0; i < noisy.length && candidates.length < topN; i++) {
    if (bestNoisy - noisy[i].score <= spread) candidates.push(noisy[i]);
  }
  if (candidates.length === 0) candidates.push(noisy[0]);

  return candidates[(Math.random() * candidates.length) | 0].move;
}

/**
 * 给人类玩家的提示（始终按最强设置计算，不受难度影响）
 * @param {Position} pos
 * @returns {?{from:number,to:number,score:number}}
 */
function getHint(pos) {
  // moveNumber 传大值以禁用开局随机化，确保提示的确实是最优着
  var result = findBestMove(pos, { level: 'hard', moveNumber: 9999 });
  if (!result) return null;
  return { from: result.from, to: result.to, score: result.score };
}

/**
 * 列出当前走子方全部合法走法及其搜索分值（降序）
 * 用于调试、局面分析与提示功能
 * @param {Position} pos
 * @param {number} [depth=3]
 * @param {boolean} [exact=true] true 时全窗口搜索，每个走法均为精确分值
 * @param {boolean} [noRep] true 时关闭重复局面判定（供对照测试）
 * @returns {Array<{move:number,score:number}>}
 */
function analyzeMoves(pos, depth, exact, noRep) {
  var ctx = createContext();
  resetContext(ctx, Date.now() + 60000);
  initSearch(ctx, pos, noRep);
  var result = searchRoot(pos, depth || 3, exact === undefined ? true : exact, ctx);
  return result ? result.scored : [];
}

/**
 * 静态评估当前局面（红方视角），用于局面分析展示
 */
function evaluatePosition(pos) {
  return EV.evaluate(pos);
}

// ---------------------------------------------------------------------------
// 可分片搜索：把迭代加深拆成「每次一个根走法」的小步，片间让出主线程
// ---------------------------------------------------------------------------

/**
 * 创建可分片搜索（解决高难度同步搜索冻屏的问题）
 *
 * 与 findBestMove 同一套迭代加深 + Alpha-Beta，区别只在调度：
 * 每次 step(budgetMs) 只在时间预算内推进若干个根走法，到点就停，下一帧
 * 接着搜——UI 因此始终能渲染「思考中」，不再整段卡死。
 *
 * 单个根走法在片内搜不完时，沿用上一层迭代给出的分值（没有就垫底），
 * 保证每个深度都必然能收尾：宁可这一手估得粗一点，也不让某一步走法
 * 把整个切片拖死。层间停止条件（杀棋 / 总时限 / 最大深度）与
 * findBestMove 完全一致；开局库、失误随机、开局变化阶段的语义也一致。
 *
 * 搜索期间 pos 通过 make/unmake 保持平衡，片与片之间始终停在根局面，
 * 主线程可以安全地继续渲染同一个 pos。
 *
 * @param {Position} pos 局面（side 即需要走子的一方）
 * @param {object} [options] 同 findBestMove（level/moveNumber/deterministic/depth/useBook/noTT/noRep）
 * @returns {{step:function(number=):boolean, cancel:function(),
 *            isDone:function():boolean, getResult:function():?object, state:object}}
 *          step 返回 true 表示搜索结束（getResult 取结果，形状同 findBestMove）；
 *          cancel 后 step 立即结束且 getResult 为 null
 */
function createSearch(pos, options) {
  options = options || {};
  var level = LEVELS[options.level] || LEVELS.normal;
  var deterministic = !!options.deterministic;
  var maxDepth = options.depth || level.depth;
  var startTime = Date.now();
  var totalDeadline = deterministic ? Infinity : startTime + Math.max(100, level.time);
  var ctx = createContext();
  ctx.noTT = !!options.noTT;
  resetContext(ctx, totalDeadline);
  initSearch(ctx, pos, options.noRep);

  var allMoves = MG.genLegalMoves(pos, pos.side);

  var st = {
    done: false,
    cancelled: false,
    result: null,
    phase: 'main',           // 'main' | 'variety' | 'varietyRun'
    depth: 0,                // 当前阶段正在迭代的深度
    completedDepth: 0,
    rootMoves: null,         // 当前阶段的根走法（已排序）
    rootExact: false,
    curIndex: 0,
    curScored: null,
    curAlpha: -INF,
    prevScored: null,        // 上一完成阶段的 [{move,score,bound}]（可信分在前，降序）
    bestMove: 0,
    bestScore: 0,
    varietyUsed: false,
    abortedRootMoves: 0      // 诊断用：有多少根走法因片内超时而沿用旧分值
  };

  function finish(result) { st.done = true; st.result = result; }

  // 与 findBestMove 相同的即时分支：无走法 / 失误随机 / 开局库
  if (allMoves.length === 0) {
    finish(null);
  } else if (!deterministic && level.blunder > 0 && Math.random() < level.blunder) {
    var randomMove = allMoves[(Math.random() * allMoves.length) | 0];
    finish({
      move: randomMove, from: MG.moveFrom(randomMove), to: MG.moveTo(randomMove),
      score: 0, depth: 0, nodes: 0, time: Date.now() - startTime, mateIn: 0, blunder: true
    });
  } else if (!deterministic && level.useBook !== false && options.useBook !== false) {
    var bookMove = BOOK.getBookMove(pos);
    if (bookMove !== null && allMoves.indexOf(bookMove) >= 0) {
      finish({
        move: bookMove, from: MG.moveFrom(bookMove), to: MG.moveTo(bookMove),
        score: 0, depth: 0, nodes: 0, time: Date.now() - startTime,
        mateIn: 0, blunder: false, book: true
      });
    }
  }

  function mateFound() {
    return st.completedDepth >= 1 &&
      (st.bestScore > MATE - 1000 || st.bestScore < -MATE + 1000);
  }

  /** 开一个迭代层：生成根走法，有上一层分值时按其降序重排（好棋先搜剪枝多） */
  function beginPhase(depth, exact) {
    var stack = ctx.moveStack;
    var start = MG.genLegalMovesInPlace(pos, pos.side, stack, false, ctx.filterUndo);
    var end = stack.length;
    orderMoves(pos, ctx, start, end, 0);
    var moves = [];
    var i;
    for (i = start; i < end; i++) moves.push(stack[i]);
    stack.length = start;

    if (st.prevScored) {
      var scoreOf = {};
      for (i = 0; i < st.prevScored.length; i++) scoreOf[st.prevScored[i].move] = st.prevScored[i].score;
      moves.sort(function (a, b) {
        var sa = scoreOf[a] === undefined ? -INF : scoreOf[a];
        var sb = scoreOf[b] === undefined ? -INF : scoreOf[b];
        return sb - sa || a - b;
      });
    }

    st.rootMoves = moves;
    st.rootExact = exact;
    st.curIndex = 0;
    st.curScored = [];
    st.curAlpha = -INF;
    st.depth = depth;
    st.abortedRootMoves = 0;
  }

  /** 片内没搜完的根走法：沿用上一层分值，没有就按原顺序垫底 */
  function inheritedScore(move, index) {
    if (st.prevScored) {
      for (var i = 0; i < st.prevScored.length; i++) {
        if (st.prevScored[i].move === move) return st.prevScored[i].score;
      }
    }
    return -INF + index;
  }

  /** 搜索一个根走法；返回 false 表示本层已全部搜完 */
  function stepOne(sliceDeadline) {
    if (st.curIndex >= st.rootMoves.length) return false;
    var move = st.rootMoves[st.curIndex];
    var undo = ctx.undoPool[0];

    ctx.deadline = Math.min(sliceDeadline, totalDeadline);
    ctx.aborted = false;

    pos.makeMove(MG.moveFrom(move), MG.moveTo(move), undo);
    var windowAlpha = st.rootExact ? -INF : st.curAlpha;
    var score = -negamax(pos, st.depth - 1, -INF, -windowAlpha, 1, ctx);
    pos.unmakeMove(undo);

    if (ctx.aborted) {
      // 被切片打断：沿用上一层分值，但标记为不可信（不与同层可信分值比大小）
      score = inheritedScore(move, st.curIndex);
      st.abortedRootMoves++;
      st.curScored.push({ move: move, score: score, bound: true });
    } else {
      // 只有抬升过 alpha 的走法拿到可信分值，其余只是上界
      var credible = st.rootExact || score > st.curAlpha;
      if (!st.rootExact && score > st.curAlpha) st.curAlpha = score;
      st.curScored.push({ move: move, score: score, bound: !credible });
    }
    st.curIndex++;
    return true;
  }

  /**
   * 收一个迭代层：排序、更新最优
   *
   * 排序时把"只有上界/旧分"的走法排到后面：被切片打断的走法沿用上一层旧分、
   * 没抬升 alpha 的走法只拿到上界，都不该和同层可信分值比大小——否则它们
   * 会靠"上界恰好等于最优分 + 编码小"中选，选出实际上很糟的着法。
   */
  function finishPhase() {
    if (!st.curScored || !st.curScored.length) { st.rootMoves = null; return false; }
    st.curScored.sort(function (a, b) {
      if (a.bound !== b.bound) return a.bound ? 1 : -1;
      return b.score - a.score || a.move - b.move;
    });
    st.prevScored = st.curScored;
    st.bestMove = st.curScored[0].move;
    st.bestScore = st.curScored[0].score;
    ctx.bestAtPly[0] = st.bestMove;
    if (st.phase === 'main') st.completedDepth = st.depth;
    st.rootMoves = null;
    return true;
  }

  /** 主迭代结束：决定是否追加开局变化阶段（与 findBestMove 同条件） */
  function enterVarietyOrFinish() {
    var want = !deterministic && !level.exact && !mateFound() && level.topN <= 1 &&
      st.completedDepth >= 1 &&
      (options.moveNumber === undefined || options.moveNumber <= OPENING_VARIETY_MOVES);
    if (want) st.phase = 'variety';
    else finalize();
  }

  function finalize() {
    var scored = st.prevScored;
    if (!scored || !scored.length) {
      var fallback = allMoves[0];
      finish({
        move: fallback, from: MG.moveFrom(fallback), to: MG.moveTo(fallback),
        score: 0, depth: 0, nodes: ctx.nodes, time: Date.now() - startTime,
        mateIn: 0, blunder: false
      });
      return;
    }

    var bestScore = st.bestScore;
    var mf = bestScore > MATE - 1000 || bestScore < -MATE + 1000;
    var topN = st.varietyUsed ? level.openingTopN : level.topN;
    var spread = st.varietyUsed ? level.openingSpread : level.spread;
    var chosen = deterministic ? scored[0].move : pickMove(scored, topN, spread, level.noise, mf);

    var mateIn = 0;
    if (bestScore > MATE - 1000) mateIn = Math.ceil((MATE - bestScore) / 2);
    else if (bestScore < -MATE + 1000) mateIn = -Math.ceil((bestScore + MATE) / 2);

    finish({
      move: chosen,
      from: MG.moveFrom(chosen),
      to: MG.moveTo(chosen),
      score: bestScore,
      depth: st.completedDepth,
      nodes: ctx.nodes,
      ttHits: ctx.ttHits,
      time: Date.now() - startTime,
      mateIn: mateIn,
      blunder: false,
      book: false
    });
  }

  /** 推进一步：开一个迭代层 / 搜一个根走法 / 收一个迭代层 */
  function pumpOnce(sliceDeadline) {
    if (st.rootMoves) {
      if (stepOne(sliceDeadline)) return;
      finishPhase();
      if (st.phase === 'main') {
        if (mateFound() || st.completedDepth >= maxDepth || Date.now() >= totalDeadline) {
          enterVarietyOrFinish();
        }
      } else {
        // 开局变化阶段收尾：候选集已换成浅层精确分值那一份
        st.varietyUsed = true;
        finalize();
      }
      return;
    }

    if (st.phase === 'main') {
      if (st.completedDepth >= 1 &&
          (st.completedDepth >= maxDepth || Date.now() >= totalDeadline || mateFound())) {
        enterVarietyOrFinish();
        return;
      }
      beginPhase(st.completedDepth + 1, !!level.exact);
      if (!st.rootMoves.length) { st.rootMoves = null; finalize(); }
      return;
    }
    if (st.phase === 'variety') {
      beginPhase(Math.min(OPENING_VARIETY_DEPTH, Math.max(1, st.completedDepth)), true);
      st.phase = 'varietyRun';
      return;
    }
    finalize(); // 兜底：异常阶段直接出结果，绝不空转
  }

  /**
   * 推进搜索，最多占用 budgetMs 毫秒（默认 12）
   * @returns {boolean} true 表示搜索结束（含被取消）
   */
  function step(budgetMs) {
    if (st.done) return true;
    var sliceDeadline = Date.now() + Math.max(1, budgetMs === undefined ? 12 : budgetMs);
    var guard = 0;
    while (!st.done) {
      if (st.cancelled) { st.done = true; st.result = null; break; }
      if (Date.now() >= sliceDeadline) break;
      pumpOnce(sliceDeadline);
      // 防御性熔断：任何意外空转都不能拖死主线程
      if (++guard > 1000000) { finalize(); break; }
    }
    return st.done;
  }

  return {
    step: step,
    cancel: function () { st.cancelled = true; },
    isDone: function () { return st.done; },
    getResult: function () { return st.result; },
    state: st
  };
}

/**
 * 驱动分片搜索直到完成（同步语义，供测试与离线分析使用）
 * @param {number} [sliceMs=50] 每片预算；越小越能检验片间续搜路径
 */
function runSearch(pos, options, sliceMs) {
  var s = createSearch(pos, options);
  while (!s.step(sliceMs === undefined ? 50 : sliceMs)) {}
  return s.getResult();
}

module.exports = {
  LEVELS: LEVELS,
  LEVEL_ORDER: LEVEL_ORDER,
  MATE: MATE,
  INF: INF,
  findBestMove: findBestMove,
  createSearch: createSearch,
  runSearch: runSearch,
  getHint: getHint,
  analyzeMoves: analyzeMoves,
  evaluatePosition: evaluatePosition,
  createContext: createContext,
  // 重复局面判定（长将判负 / 不变作和），导出供测试直接验证规则
  repeatSegmentValue: repeatSegmentValue,
  REPETITION_DRAW: REPETITION_DRAW
};
