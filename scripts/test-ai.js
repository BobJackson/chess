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
function truthy(name, actual) { assert(name, !!actual, true); }

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

console.log('\n[9] 分片搜索：与同步搜索确定性一致');
(function () {
  var spots = [
    { name: '初始局面', make: function () { return new Position(); } },
    { name: '白吃车战术', make: function () { return new Position('3k5/9/4r4/9/9/4R4/9/9/9/4K4 w - - 0 1'); } },
    // 中局局面：从初始局面走四手得到，不凭空写 FEN
    { name: '中局', make: function () {
      var p = new Position();
      var uu = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
      [[54, 45], [31, 40], [64, 63], [19, 28]].forEach(function (mv) { p.makeMove(mv[0], mv[1], uu); });
      return p;
    } }
  ];

  // exact 难度（简单，全窗口）：确定性模式下分片与同步必须逐分一致
  var exactOk = true;
  var exactScoreOk = true;
  spots.forEach(function (s) {
    var opt = { level: 'easy', moveNumber: 999, useBook: false, deterministic: true };
    var a = AI.findBestMove(s.make(), opt);
    var b = AI.runSearch(s.make(), opt);
    if (!b || a.move !== b.move) exactOk = false;
    if (!b || a.score !== b.score) exactScoreOk = false;
  });
  assert('exact 难度分片/同步走法一致', exactOk, true);
  assert('exact 难度分片/同步分值一致', exactScoreOk, true);

  // 非 exact 难度（困难，带窗口）：最优走法必须一致
  var hardOk = true;
  spots.forEach(function (s) {
    var opt = { level: 'hard', moveNumber: 999, useBook: false, deterministic: true, depth: 4 };
    var a = AI.findBestMove(s.make(), opt);
    var b = AI.runSearch(s.make(), opt, 50);
    if (!b || a.move !== b.move) hardOk = false;
  });
  assert('困难难度分片/同步走法一致', hardOk, true);

  // 一步杀：分片搜索同样直接报杀
  var mateOpt = { level: 'hard', moveNumber: 999, useBook: false, deterministic: true, depth: 4 };
  var matePos = new Position('4k4/3R5/9/9/9/8R/9/9/9/3K5 w - - 0 1');
  var mr = AI.runSearch(matePos, mateOpt);
  assert('分片搜索识别一步致胜', mr.mateIn, 1);
})();

console.log('\n[10] 分片搜索：小切片续搜、时限与取消');
(function () {
  // 1ms 小切片：强制走片间续搜路径，必须收敛且走法合法
  var pos = new Position();
  var s = AI.createSearch(pos, { level: 'hard', moveNumber: 999, useBook: false, deterministic: true, depth: 4 });
  var slices = 0;
  while (!s.step(1)) { slices++; if (slices > 100000) break; }
  var r = s.getResult();
  truthy('1ms 切片收敛出结果', !!r);
  truthy('1ms 切片确实分多片完成', slices > 0);
  truthy('小切片结果走法合法', r && MG.genLegalMoves(pos, pos.side).indexOf(r.move) >= 0);

  // 大师档（非确定性）：总时限内必须出结果，不能让切片拖死
  var s2 = AI.createSearch(new Position(), { level: 'master', moveNumber: 999, useBook: false });
  var t0 = Date.now();
  while (!s2.step(12)) { if (Date.now() - t0 > 8000) break; }
  var r2 = s2.getResult();
  truthy('大师档在时限内出结果', !!r2);
  truthy('大师档至少完成一层', r2 && r2.depth >= 1);

  // 取消：cancel 后 step 立即结束且结果为 null
  var s3 = AI.createSearch(new Position(), { level: 'master', moveNumber: 999, useBook: false });
  s3.cancel();
  assert('取消后 step 立即完成', s3.step(12), true);
  assert('取消后结果为 null', s3.getResult(), null);

  // 开局库：初始局面第一步就出结果，无需迭代
  var s4 = AI.createSearch(new Position(), { level: 'normal', moveNumber: 0 });
  assert('开局库第一步即完成', s4.step(12), true);
  truthy('开局库命中标记', s4.getResult() && s4.getResult().book === true);

  // 无子可动（已被将死）的局面：结果为 null 而不是死循环
  var mp = new Position('4k4/3R5/9/9/9/8R/9/9/9/3K5 w - - 0 1');
  var win = AI.findBestMove(mp, { level: 'hard', moveNumber: 999, useBook: false, deterministic: true, depth: 2 });
  var uw = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  mp.makeMove(win.from, win.to, uw);
  assert('构造出黑方无子可动', MG.genLegalMoves(mp, C.BLACK).length, 0);
  var sm = AI.createSearch(mp, { level: 'easy' });
  assert('无子可动第一步即完成', sm.step(12), true);
  assert('无子可动结果为 null', sm.getResult(), null);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31mAI 测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32mAI 全部测试通过\x1b[0m\n');
