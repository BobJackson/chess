/**
 * AI 搜索引擎
 *
 * 采用：迭代加深 + Negamax Alpha-Beta 剪枝 + 静态搜索(Quiescence)
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
/** 主搜索中只对分值最高的前 ORDER_K 个走法做选择排序，其余保持生成顺序 */
var ORDER_K = 12;
var CAPTURE_ORDER_K = 8;

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
 */
var LEVELS = {
  beginner: {
    key: 'beginner', label: '入门', depth: 2, time: 350, exact: true,
    noise: 90, topN: 6, spread: 180, blunder: 0.35, useBook: false, openingTopN: 6, openingSpread: 180
  },
  easy: {
    key: 'easy', label: '简单', depth: 3, time: 800, exact: true,
    noise: 50, topN: 4, spread: 120, blunder: 0.12, useBook: true, openingTopN: 4, openingSpread: 120
  },
  normal: {
    key: 'normal', label: '中等', depth: 4, time: 1500, exact: false,
    noise: 0, topN: 1, spread: 0, blunder: 0, useBook: true, openingTopN: 3, openingSpread: 25
  },
  hard: {
    key: 'hard', label: '困难', depth: 6, time: 2600, exact: false,
    noise: 0, topN: 1, spread: 0, blunder: 0, useBook: true, openingTopN: 2, openingSpread: 12
  },
  master: {
    key: 'master', label: '大师', depth: 8, time: 4500, exact: false,
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

  return {
    undoPool: Position.createUndoPool(MAX_PLY + MAX_QPLY + 8),
    filterUndo: { from: 0, to: 0, piece: 0, captured: 0, side: 0 },
    // 走法与分值共用一个扁平数组，跨递归复用，避免频繁分配
    moveStack: [],
    scoreStack: [],
    killers: killers,
    history: history,
    bestAtPly: bestAtPly,
    nodes: 0,
    deadline: 0,
    aborted: false
  };
}

function resetContext(ctx, deadline) {
  for (var i = 0; i < ctx.bestAtPly.length; i++) ctx.bestAtPly[i] = 0;
  for (i = 0; i < ctx.killers.length; i++) { ctx.killers[i][0] = 0; ctx.killers[i][1] = 0; }
  for (i = 0; i < ctx.history.length; i++) ctx.history[i] = 0;
  ctx.moveStack.length = 0;
  ctx.scoreStack.length = 0;
  ctx.nodes = 0;
  ctx.deadline = deadline;
  ctx.aborted = false;
}

function recordKiller(ctx, ply, move) {
  var slot = ctx.killers[ply];
  if (!slot) return;
  if (slot[0] === move) return;
  slot[1] = slot[0];
  slot[0] = move;
}

/**
 * 走法排序分值：PV 走法 > 吃子(MVV-LVA) > 杀手走法 > 历史启发+位置增益
 */
function moveScore(pos, move, ply, ctx) {
  if (ctx.bestAtPly[ply] === move) return 2000000;

  var from = MG.moveFrom(move);
  var to = MG.moveTo(move);
  var victim = pos.board[to];
  var attacker = pos.board[from];

  if (victim !== C.EMPTY) {
    return 1000000 + EV.pieceValue(victim) * 20 - EV.pieceValue(attacker);
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

/** 对 [start, end) 区间计算分值，并把分值最高的前 k 个选择排序到区间前部 */
function orderMoves(pos, ctx, start, end, ply, k) {
  var moves = ctx.moveStack;
  var scores = ctx.scoreStack;
  var i, j;

  for (i = start; i < end; i++) {
    scores[i] = moveScore(pos, moves[i], ply, ctx);
  }

  var limit = Math.min(end, start + k);
  for (i = start; i < limit; i++) {
    var maxIdx = i;
    for (j = i + 1; j < end; j++) {
      if (scores[j] > scores[maxIdx]) maxIdx = j;
    }
    if (maxIdx !== i) {
      var tm = moves[i]; moves[i] = moves[maxIdx]; moves[maxIdx] = tm;
      var ts = scores[i]; scores[i] = scores[maxIdx]; scores[maxIdx] = ts;
    }
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

  var best = EV.evaluateForSide(pos);
  if (best >= beta) return best;
  if (best > alpha) alpha = best;
  if (qply >= MAX_QPLY || ply >= MAX_PLY + MAX_QPLY) return best;

  var stack = ctx.moveStack;
  var start = MG.genLegalMovesInPlace(pos, pos.side, stack, true, ctx.filterUndo);
  var end = stack.length;
  if (end === start) return best;

  orderMoves(pos, ctx, start, end, ply, CAPTURE_ORDER_K);

  var undo = ctx.undoPool[ply];
  for (var i = start; i < end; i++) {
    var move = stack[i];
    var from = MG.moveFrom(move);
    var to = MG.moveTo(move);

    // 增量剪枝：即使白吃掉该子仍无法提升 alpha 时直接跳过
    if (best + EV.pieceValue(pos.board[to]) + 200 < alpha) continue;

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

function negamax(pos, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 255) === 0 && Date.now() > ctx.deadline) ctx.aborted = true;
  if (ctx.aborted) return 0;

  if (depth <= 0 || ply >= MAX_PLY) {
    return quiesce(pos, alpha, beta, ply, 0, ctx);
  }

  var stack = ctx.moveStack;
  var start = MG.genLegalMovesInPlace(pos, pos.side, stack, false, ctx.filterUndo);
  var end = stack.length;

  if (end === start) {
    // 无合法走法：将死或困毙，均判负；离根越近分值越高（优先选择速胜）
    return -MATE + ply;
  }

  orderMoves(pos, ctx, start, end, ply, ORDER_K);

  var undo = ctx.undoPool[ply];
  var best = -INF;
  var bestMove = stack[start];
  var alphaAtEntry = alpha;

  for (var i = start; i < end; i++) {
    var move = stack[i];
    var from = MG.moveFrom(move);
    var to = MG.moveTo(move);

    pos.makeMove(from, to, undo);
    var score = -negamax(pos, depth - 1, -beta, -alpha, ply + 1, ctx);
    pos.unmakeMove(undo);

    if (ctx.aborted) break;

    if (score > best) {
      best = score;
      bestMove = move;
    }
    if (score > alpha) alpha = score;

    if (alpha >= beta) {
      // 安静走法引发截断时记录杀手走法与历史分值
      if (pos.board[to] === C.EMPTY) {
        recordKiller(ctx, ply, move);
        ctx.history[from * C.BOARD_SIZE + to] += depth * depth;
      }
      break;
    }
  }

  stack.length = start;

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

  orderMoves(pos, ctx, start, end, 0, ORDER_K);

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

    moves.push({ move: move, score: score });
    if (score > best) {
      best = score;
      bestMove = move;
    }
    if (!exact && score > alpha) alpha = score;
  }

  stack.length = start;
  ctx.bestAtPly[0] = bestMove;

  moves.sort(function (a, b) { return b.score - a.score; });
  return { scored: moves, bestScore: best, bestMove: bestMove };
}

/**
 * 为当前走子方计算最佳走法
 * @param {Position} pos 局面（side 即需要走子的一方）
 * @param {object} [options] { level: 'normal', moveNumber: 0, deterministic: false, depth: 0 }
 *        moveNumber 为该方已经走过的步数，用于判断是否处于开局阶段
 *        deterministic 为 true 时关闭时间截止与全部随机化，结果可复现（供测试/回放）
 *        depth 覆盖难度的最大搜索深度，0/省略表示用难度自带值
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
  resetContext(ctx, deterministic ? Infinity : startTime + Math.max(100, level.time));

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

  for (var depth = 1; depth <= maxDepth; depth++) {
    ctx.aborted = false;
    var result = searchRoot(pos, depth, !!level.exact, ctx);
    if (!result) break; // 本层超时未完成，沿用上一层结果

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
 * @param {boolean} useSpread true 时用 spread 限制候选范围，false 时只取扰动后的第一名
 */
function pickByNoise(scored, topN, spread, noise, useSpread) {
  if (noise <= 0) {
    if (!useSpread) return scored[0].move;
    var tied = [];
    for (var t = 0; t < scored.length && tied.length < topN; t++) {
      if (scored[0].score - scored[t].score <= spread) tied.push(scored[t]);
    }
    return tied[(Math.random() * tied.length) | 0].move;
  }

  var noisy = [];
  for (var i = 0; i < scored.length; i++) {
    noisy.push({ move: scored[i].move, score: scored[i].score + (Math.random() * 2 - 1) * noise });
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
 * @returns {Array<{move:number,score:number}>}
 */
function analyzeMoves(pos, depth, exact) {
  var ctx = createContext();
  resetContext(ctx, Date.now() + 60000);
  var result = searchRoot(pos, depth || 3, exact === undefined ? true : exact, ctx);
  return result ? result.scored : [];
}

/**
 * 静态评估当前局面（红方视角），用于局面分析展示
 */
function evaluatePosition(pos) {
  return EV.evaluate(pos);
}

module.exports = {
  LEVELS: LEVELS,
  LEVEL_ORDER: LEVEL_ORDER,
  MATE: MATE,
  INF: INF,
  findBestMove: findBestMove,
  getHint: getHint,
  analyzeMoves: analyzeMoves,
  evaluatePosition: evaluatePosition,
  createContext: createContext
};
