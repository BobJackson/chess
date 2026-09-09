/**
 * AI 引擎测试与基准（node scripts/test-ai.js）
 *
 * 覆盖：各难度出招耗时、战术识别（白吃子 / 一步杀）、自我对弈完整性。
 */

var Position = require('../miniprogram/core/position.js');
var MG = require('../miniprogram/core/movegen.js');
var AI = require('../miniprogram/core/ai.js');
var BOOK = require('../miniprogram/core/book.js');
var C = require('../miniprogram/core/constants.js');

var passed = 0;
var failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m  ' + name + ' = ' + actual);
  } else {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name + ' 期望 ' + expected + '，实际 ' + actual);
  }
}

function describeMove(move) {
  var from = MG.moveFrom(move);
  var to = MG.moveTo(move);
  return '(f' + C.fileOf(from) + ',r' + C.rankOf(from) + ')->(f' +
    C.fileOf(to) + ',r' + C.rankOf(to) + ')';
}

console.log('\n[1] 各难度基准（初始局面，非开局阶段）');
AI.LEVEL_ORDER.forEach(function (key) {
  var pos = new Position();
  var t0 = Date.now();
  var r = AI.findBestMove(pos, { level: key, moveNumber: 999, useBook: false });
  var ms = Date.now() - t0;
  console.log('  ' + AI.LEVELS[key].label.padEnd(4) +
    ' 深度=' + String(r.depth).padStart(2) +
    ' 节点=' + String(r.nodes).padStart(8) +
    ' 耗时=' + String(ms).padStart(5) + 'ms' +
    ' 分值=' + String(r.score).padStart(6) +
    ' 走法=' + describeMove(r.move));
  if (!r || typeof r.move !== 'number') {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + key + ' 未返回合法走法');
  } else if (MG.genLegalMoves(pos, pos.side).indexOf(r.move) < 0) {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + key + ' 返回了非法走法');
  } else {
    passed++;
  }
});

console.log('\n[2] 战术识别：白吃一车');
(function () {
  // 红车 (4,5) 可沿四路线直吃无保护的黑车 (4,2)
  var pos = new Position('3k5/9/4r4/9/9/4R4/9/9/9/4K4 w - - 0 1');
  var expected = MG.packMove(C.idxOf(4, 5), C.idxOf(4, 2));
  var r = AI.findBestMove(pos, { level: 'hard' });
  console.log('        引擎选择 ' + describeMove(r.move) + '，期望 ' + describeMove(expected));
  assert('困难难度吃掉无保护的车', r.move, expected);

  var r2 = AI.findBestMove(pos, { level: 'normal' });
  assert('中等难度吃掉无保护的车', r2.move, expected);
})();

console.log('\n[3] 战术识别：一步致胜（将死或困毙）');
(function () {
  // 黑将 (4,0) 孤将，红车 (3,1) 封锁，红车 (8,5) 可平移成杀
  // 存在两个一步致胜点：(8,5)->(8,0) 直接将死；(8,5)->(5,5) 造成困毙（象棋规则困毙也判负）
  var fen = '4k4/3R5/9/9/9/8R/9/9/9/3K5 w - - 0 1';
  var pos = new Position(fen);
  var r = AI.findBestMove(pos, { level: 'hard' });
  console.log('        引擎选择 ' + describeMove(r.move) + '，mateIn=' + r.mateIn);
  assert('识别为一步致胜', r.mateIn, 1);

  // 验证走完这一步后黑方确实无子可动
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  pos.makeMove(MG.moveFrom(r.move), MG.moveTo(r.move), undo);
  assert('走后黑方无合法走法', MG.genLegalMoves(pos, C.BLACK).length, 0);
  pos.unmakeMove(undo);

  // 未走子前黑方仍有合法走法，确保不是构造错局面
  assert('走子前黑方仍有合法走法', MG.genLegalMoves(new Position(fen), C.BLACK).length > 0, true);
})();

console.log('\n[4] 不送吃：不吃有保护的子');
(function () {
  // 黑卒 (4,4) 由黑车 (4,2) 保护；红车 (4,7) 吃卒会被车反吃，净亏一车
  var pos = new Position('3k5/9/4r4/9/4p4/9/9/4R4/9/4K4 w - - 0 1');
  var r = AI.findBestMove(pos, { level: 'hard' });
  var bad = MG.packMove(C.idxOf(4, 7), C.idxOf(4, 4));
  console.log('        引擎选择 ' + describeMove(r.move) + '，分值=' + r.score);
  assert('不会用车白吃有保护的卒', r.move === bad, false);

  // 确认吃卒这一走法确实存在于合法列表中（避免因生成错误而假通过）
  assert('吃卒走法本身合法', MG.genLegalMoves(pos, C.RED).indexOf(bad) >= 0, true);
})();

console.log('\n[5] 自我对弈（入门 vs 入门，最多 120 手）');
(function () {
  var pos = new Position();
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  var signatures = {};
  var plies = 0;
  var reason = '达到手数上限';
  var t0 = Date.now();

  while (plies < 240) {
    var legal = MG.genLegalMoves(pos, pos.side);
    if (legal.length === 0) {
      reason = (pos.side === C.RED ? '红方' : '黑方') + '无子可动（将死/困毙）';
      break;
    }
    var sig = pos.signature();
    signatures[sig] = (signatures[sig] || 0) + 1;
    if (signatures[sig] >= 3) { reason = '三次重复局面'; break; }

    var r = AI.findBestMove(pos, { level: 'beginner' });
    if (!r) { reason = 'AI 未返回走法'; break; }
    if (legal.indexOf(r.move) < 0) {
      failed++;
      console.log('  \x1b[31mFAIL\x1b[0m  AI 返回了非法走法 ' + describeMove(r.move));
      return;
    }
    pos.makeMove(MG.moveFrom(r.move), MG.moveTo(r.move), undo);
    plies++;
  }

  var ms = Date.now() - t0;
  console.log('        共 ' + plies + ' 手，结束原因：' + reason + '，总耗时 ' + ms + 'ms');
  assert('自我对弈全部走法合法且正常推进', plies > 0, true);
})();

console.log('\n[6] 自我对弈（中等 vs 中等，最多 60 手，检验强度与稳定性）');
(function () {
  var pos = new Position();
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  var plies = 0;
  var captures = 0;
  var reason = '达到手数上限';
  var t0 = Date.now();

  while (plies < 60) {
    var legal = MG.genLegalMoves(pos, pos.side);
    if (legal.length === 0) {
      reason = (pos.side === C.RED ? '红方' : '黑方') +
        (MG.isChecked(pos, pos.side) ? '被将死' : '困毙');
      break;
    }
    var r = AI.findBestMove(pos, { level: 'normal', moveNumber: plies });
    if (!r) { reason = 'AI 未返回走法'; break; }
    if (legal.indexOf(r.move) < 0) {
      failed++;
      console.log('  \x1b[31mFAIL\x1b[0m  AI 返回了非法走法 ' + describeMove(r.move));
      return;
    }
    if (pos.board[MG.moveTo(r.move)] !== C.EMPTY) captures++;
    pos.makeMove(MG.moveFrom(r.move), MG.moveTo(r.move), undo);
    plies++;
  }

  console.log('        共 ' + plies + ' 手，吃子 ' + captures + ' 次，耗时 ' + (Date.now() - t0) + 'ms');
  console.log('        结束原因：' + reason);
  console.log('        终局 FEN: ' + pos.toFen());
  // 未走满 60 手时，必须是规则上的正常终局（将死/困毙）
  var legalEnd = plies === 60 || MG.genLegalMoves(pos, pos.side).length === 0;
  assert('对弈正常结束（走满或合法终局）', legalEnd, true);
  assert('对弈有效推进', plies >= 20, true);
})();

console.log('\n[7] 开局库');
(function () {
  var errors = BOOK.buildErrors();
  if (errors.length) {
    errors.forEach(function (e) { console.log('        \x1b[31m' + e + '\x1b[0m'); });
  }
  assert('开局库线路全部合法', errors.length, 0);
  console.log('        覆盖局面数 = ' + BOOK.size());
  assert('开局库非空', BOOK.size() > 0, true);

  // 回放全部线路，逐手校验库给出的着法均合法
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  var hits = 0;
  var allLegal = true;
  BOOK.BOOK_LINES.forEach(function (line) {
    var pos = new Position();
    line.moves.forEach(function (text) {
      var mv = BOOK.parseMove(text);
      if (mv === null || !MG.isMoveLegal(pos, pos.side, MG.moveFrom(mv), MG.moveTo(mv))) {
        allLegal = false;
        return;
      }
      if (BOOK.getBookMove(pos) !== null) hits++;
      pos.makeMove(MG.moveFrom(mv), MG.moveTo(mv), undo);
    });
  });
  assert('库内每一手均合法', allLegal, true);
  console.log('        回放命中开局库 ' + hits + ' 次');

  // 初始局面下 AI 应当直接走库着，且库着属于主流开局
  var r = AI.findBestMove(new Position(), { level: 'hard' });
  console.log('        困难难度开局选择 ' + describeMove(r.move) + '，book=' + r.book);
  assert('初始局面命中开局库', r.book, true);
})();

console.log('\n[8] 开局变化与中局确定性');
(function () {
  var seen = {};
  for (var i = 0; i < 8; i++) {
    var r = AI.findBestMove(new Position(), { level: 'hard' });
    seen[r.move] = (seen[r.move] || 0) + 1;
  }
  var distinct = Object.keys(seen).length;
  console.log('        困难难度开局 8 次出现 ' + distinct + ' 种不同走法');
  assert('开局阶段具备变化（>1 种）', distinct > 1, true);

  var mid = {};
  var fixedDepth = 3;
  var depthOk = true;
  for (i = 0; i < 5; i++) {
    // 确定性模式：关闭时间截止与随机化并固定深度，结果必须可复现
    var r2 = AI.findBestMove(new Position(), {
      level: 'hard', moveNumber: 999, useBook: false,
      deterministic: true, depth: fixedDepth
    });
    if (r2.depth !== fixedDepth) depthOk = false;
    mid[r2.move] = (mid[r2.move] || 0) + 1;
  }
  console.log('        非开局阶段 5 次出现 ' + Object.keys(mid).length + ' 种走法');
  assert('非开局阶段走法稳定', Object.keys(mid).length, 1);
  assert('确定性模式跑满指定深度（未被时间截断）', depthOk, true);

  // 真实中局局面（走过若干手）下，确定性模式两次调用必须完全一致
  var pos = new Position();
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  [[54, 45], [31, 40], [64, 63], [19, 28]].forEach(function (mv) {
    pos.makeMove(mv[0], mv[1], undo);
  });
  var optA = { level: 'hard', moveNumber: 999, useBook: false, deterministic: true, depth: fixedDepth };
  var ra = AI.findBestMove(pos, optA);
  var rb = AI.findBestMove(pos, optA);
  assert('真实中局确定性着法可复现', ra.move, rb.move);
  assert('真实中局确定性分值可复现', ra.score, rb.score);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31mAI 测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32mAI 全部测试通过\x1b[0m\n');
