/**
 * 引擎正确性测试（Node 直接运行：node scripts/test-engine.js）
 *
 * 核心基准：中国象棋初始局面的 perft 值
 *   depth 1 = 44
 *   depth 2 = 1920
 *   depth 3 = 79666
 *   depth 4 = 3290240
 *
 * 说明：所有测试局面均同时保留双方将/帅，且刻意避免"意外照面"干扰断言。
 * 统一约定：黑将置于 (file=3, rank=0)，红帅置于 (file=4, rank=9)，两者不同列。
 */

var Position = require('../miniprogram/core/position.js');
var MG = require('../miniprogram/core/movegen.js');
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

// ---------------------------------------------------------------------------
// perft 基础设施
// ---------------------------------------------------------------------------
var filterUndo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
var undoPool = Position.createUndoPool(64);

function perft(pos, depth, ply) {
  var stack = [];
  var start = MG.genLegalMovesInPlace(pos, pos.side, stack, false, filterUndo);
  var count = stack.length - start;
  if (depth <= 1) return count;

  var undo = undoPool[ply];
  var total = 0;
  for (var i = start; i < stack.length; i++) {
    var m = stack[i];
    pos.makeMove(MG.moveFrom(m), MG.moveTo(m), undo);
    total += perft(pos, depth - 1, ply + 1);
    pos.unmakeMove(undo);
  }
  return total;
}

/** 逐走法列出分叉数，用于定位 perft 偏差 */
function divide(pos, depth) {
  var stack = [];
  var start = MG.genLegalMovesInPlace(pos, pos.side, stack, false, filterUndo);
  var undo = undoPool[0];
  var result = [];
  for (var i = start; i < stack.length; i++) {
    var m = stack[i];
    pos.makeMove(MG.moveFrom(m), MG.moveTo(m), undo);
    var n = depth === 1 ? 1 : perft(pos, depth - 1, 1);
    pos.unmakeMove(undo);
    result.push({ from: MG.moveFrom(m), to: MG.moveTo(m), count: n });
  }
  return result;
}

function has(list, from, to) {
  return list.indexOf(MG.packMove(from, to)) >= 0;
}

console.log('\n[1] FEN 解析与序列化');
(function () {
  var p = new Position();
  assert('初始局面 FEN 往返一致', p.toFen(), C.START_FEN);
  assert('初始局面红方棋子数', p.countPieces(C.RED), 16);
  assert('初始局面黑方棋子数', p.countPieces(C.BLACK), 16);
  assert('红帅位置', p.kingPos[C.RED], C.idxOf(4, 9));
  assert('黑将位置', p.kingPos[C.BLACK], C.idxOf(4, 0));
  assert('初始局面未将军', MG.isChecked(p, C.RED), false);
  assert('初始局面不构成照面', MG.kingsAreFacing(p), false);

  var fen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1';
  var p2 = new Position(fen);
  assert('黑方先行解析', p2.side, C.BLACK);
  assert('自定义 FEN 往返', p2.toFen(), fen);
})();

console.log('\n[2] perft 基准');
(function () {
  var EXPECT = [44, 1920, 79666, 3290240];
  for (var depth = 1; depth <= EXPECT.length; depth++) {
    var t0 = Date.now();
    var n = perft(new Position(), depth, 0);
    var ms = Date.now() - t0;
    assert('perft(' + depth + ')', n, EXPECT[depth - 1]);
    console.log('        耗时 ' + ms + 'ms');
    if (n !== EXPECT[depth - 1] && depth <= 2) {
      console.log('        divide:');
      divide(new Position(), depth).forEach(function (d) {
        console.log('          ' + d.from + '->' + d.to + ' : ' + d.count);
      });
    }
  }
})();

console.log('\n[3] 走子/撤销可逆性');
(function () {
  var pos = new Position();
  var fenBefore = pos.toFen();
  var stack = [];
  MG.genLegalMovesInPlace(pos, pos.side, stack, false, filterUndo);
  var undo = undoPool[0];
  var ok = true;
  for (var i = 0; i < stack.length; i++) {
    pos.makeMove(MG.moveFrom(stack[i]), MG.moveTo(stack[i]), undo);
    pos.unmakeMove(undo);
    if (pos.toFen() !== fenBefore) { ok = false; break; }
  }
  assert('全部 ' + stack.length + ' 个走法 make/unmake 后局面还原', ok, true);
})();

console.log('\n[4] 将帅照面');
(function () {
  var facing = new Position('4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
  assert('照面时红方处于被将状态', MG.isChecked(facing, C.RED), true);
  assert('照面时黑方同样处于被将状态', MG.isChecked(facing, C.BLACK), true);
  assert('kingsAreFacing 判定', MG.kingsAreFacing(facing), true);
  // 帅只能横向避让；(4,8) 仍然照面，属非法
  assert('照面局面红方合法走法数', MG.genLegalMoves(facing, C.RED).length, 2);

  var blocked = new Position('4k4/9/9/9/4R4/9/9/9/9/4K4 w - - 0 1');
  assert('有子遮挡时不构成照面', MG.kingsAreFacing(blocked), false);
  assert('有子遮挡时红方未被将', MG.isChecked(blocked, C.RED), false);

  // 回归：别的列上有子不能影响照面判定。
  // 旧实现遍历两个将帅索引之间的线性区间，会把中间各横线的其他列一并扫进来，
  // 于是 (3,3) 的俥就让 (4,0)-(4,9) 的照面被误判为「没照面」。
  var otherFile = new Position('4k4/9/9/3R5/9/9/9/9/9/4K4 w - - 0 1');
  assert('别列有子时仍构成照面', MG.kingsAreFacing(otherFile), true);
  assert('别列有子时红方被将', MG.isChecked(otherFile, C.RED), true);

  // 同一条纵线上、但隔着一段距离有子遮挡，依然不构成照面
  var farBlock = new Position('4k4/9/4R4/9/9/9/9/9/9/4K4 w - - 0 1');
  assert('同线远端有子遮挡时不构成照面', MG.kingsAreFacing(farBlock), false);
})();

console.log('\n[5] 马腿与象眼');
(function () {
  // 红马 (0,9)，马腿 (0,8) 为空
  var open = new Position('3k5/9/9/9/9/9/9/9/9/N3K4 w - - 0 1');
  var openMoves = MG.genLegalMoves(open, C.RED);
  assert('马腿为空可跳 (0,9)->(1,7)', has(openMoves, C.idxOf(0, 9), C.idxOf(1, 7)), true);
  assert('马腿为空可跳 (0,9)->(2,8)', has(openMoves, C.idxOf(0, 9), C.idxOf(2, 8)), true);

  // 在 (0,8) 放一枚红兵蹩住马腿
  var blocked = new Position('3k5/9/9/9/9/9/9/9/P8/N3K4 w - - 0 1');
  var blockedMoves = MG.genLegalMoves(blocked, C.RED);
  assert('马腿被蹩不可跳 (0,9)->(1,7)', has(blockedMoves, C.idxOf(0, 9), C.idxOf(1, 7)), false);
  assert('另一方向不受影响 (0,9)->(2,8)', has(blockedMoves, C.idxOf(0, 9), C.idxOf(2, 8)), true);

  // 红相 (2,9)，两个象眼 (1,8) / (3,8) 均为空
  var elephant = new Position('3k5/9/9/9/9/9/9/9/9/2B1K4 w - - 0 1');
  var em = MG.genLegalMoves(elephant, C.RED);
  assert('象眼为空可飞 (2,9)->(0,7)', has(em, C.idxOf(2, 9), C.idxOf(0, 7)), true);
  assert('象眼为空可飞 (2,9)->(4,7)', has(em, C.idxOf(2, 9), C.idxOf(4, 7)), true);

  // 在 (3,8) 塞一枚黑卒
  var eyeBlocked = new Position('3k5/9/9/9/9/9/9/9/3p5/2B1K4 w - - 0 1');
  var ebm = MG.genLegalMoves(eyeBlocked, C.RED);
  assert('象眼被塞不可飞 (2,9)->(4,7)', has(ebm, C.idxOf(2, 9), C.idxOf(4, 7)), false);
  assert('另一象眼仍可飞 (2,9)->(0,7)', has(ebm, C.idxOf(2, 9), C.idxOf(0, 7)), true);

  // 相不可过河：从任意相位出发的终点 rank 必须 >= 5
  var allOk = true;
  for (var i = 0; i < em.length; i++) {
    if (elephant.board[MG.moveFrom(em[i])] === C.R_BISHOP && C.rankOf(MG.moveTo(em[i])) < 5) {
      allOk = false;
    }
  }
  assert('相不过河', allOk, true);
})();

console.log('\n[6] 炮的隔子吃与车的直线');
(function () {
  // 红炮 (0,7)，炮架为黑卒 (2,7)，目标为黑卒 (4,7)
  var cannon = new Position('3k5/9/9/9/9/9/9/C1p1p4/9/4K4 w - - 0 1');
  var cm = MG.genLegalMoves(cannon, C.RED);
  assert('炮可走空格 (0,7)->(1,7)', has(cm, C.idxOf(0, 7), C.idxOf(1, 7)), true);
  assert('炮不可占据炮架 (0,7)->(2,7)', has(cm, C.idxOf(0, 7), C.idxOf(2, 7)), false);
  assert('炮可隔一个子吃 (0,7)->(4,7)', has(cm, C.idxOf(0, 7), C.idxOf(4, 7)), true);
  assert('炮不可吃第二个子之后的目标', has(cm, C.idxOf(0, 7), C.idxOf(5, 7)), false);

  // 无炮架时不能吃子：红炮 (0,7) 与黑卒 (4,7) 之间全空
  var noScreen = new Position('3k5/9/9/9/9/9/9/C3p4/9/4K4 w - - 0 1');
  var nm = MG.genLegalMoves(noScreen, C.RED);
  assert('无炮架不可吃子 (0,7)->(4,7)', has(nm, C.idxOf(0, 7), C.idxOf(4, 7)), false);
  assert('无炮架仍可走空格 (0,7)->(3,7)', has(nm, C.idxOf(0, 7), C.idxOf(3, 7)), true);

  // 车遇己方子需停在其前，遇对方子可吃并停止
  var rook = new Position('3k5/9/9/9/9/9/9/9/p8/R3K4 w - - 0 1');
  var rm = MG.genLegalMoves(rook, C.RED);
  assert('车可吃对方子 (0,9)->(0,8)', has(rm, C.idxOf(0, 9), C.idxOf(0, 8)), true);
  assert('车吃子后不可继续前进 (0,9)->(0,7)', has(rm, C.idxOf(0, 9), C.idxOf(0, 7)), false);
  assert('车可横走空格 (0,9)->(3,9)', has(rm, C.idxOf(0, 9), C.idxOf(3, 9)), true);
  assert('车不可吃掉己方帅 (0,9)->(4,9)', has(rm, C.idxOf(0, 9), C.idxOf(4, 9)), false);
})();

console.log('\n[7] 兵/卒过河与士的活动范围');
(function () {
  var before = new Position('3k5/9/9/9/9/4P4/9/9/9/4K4 w - - 0 1');
  var bm = MG.genLegalMoves(before, C.RED);
  assert('未过河兵可前进 (4,5)->(4,4)', has(bm, C.idxOf(4, 5), C.idxOf(4, 4)), true);
  assert('未过河兵不可横走 (4,5)->(3,5)', has(bm, C.idxOf(4, 5), C.idxOf(3, 5)), false);
  assert('兵不可后退 (4,5)->(4,6)', has(bm, C.idxOf(4, 5), C.idxOf(4, 6)), false);

  var after = new Position('3k5/9/9/9/4P4/9/9/9/9/4K4 w - - 0 1');
  var am = MG.genLegalMoves(after, C.RED);
  assert('过河兵可横走 (4,4)->(3,4)', has(am, C.idxOf(4, 4), C.idxOf(3, 4)), true);
  assert('过河兵可横走 (4,4)->(5,4)', has(am, C.idxOf(4, 4), C.idxOf(5, 4)), true);
  assert('过河兵仍不可后退 (4,4)->(4,5)', has(am, C.idxOf(4, 4), C.idxOf(4, 5)), false);

  var advisor = new Position('3k5/9/9/9/9/9/9/9/9/3AK4 w - - 0 1');
  var av = MG.genLegalMoves(advisor, C.RED);
  assert('仕可斜进 (3,9)->(4,8)', has(av, C.idxOf(3, 9), C.idxOf(4, 8)), true);
  var inPalace = true;
  for (var i = 0; i < av.length; i++) {
    if (advisor.board[MG.moveFrom(av[i])] === C.R_ADVISOR) {
      if (!C.inPalace(C.fileOf(MG.moveTo(av[i])), C.rankOf(MG.moveTo(av[i])), C.RED)) inPalace = false;
    }
  }
  assert('仕不出九宫', inPalace, true);
})();

console.log('\n[8] 将军与将死判定');
(function () {
  // 黑将 (4,0)，红车 (3,0) 与 (3,1)(4,1) 封锁全部出路
  var mate = new Position('3Rk4/3RR4/9/9/9/9/9/9/9/4K4 b - - 0 1');
  assert('黑方被将', MG.isChecked(mate, C.BLACK), true);
  assert('黑方无合法走法（将死）', MG.genLegalMoves(mate, C.BLACK).length, 0);
  assert('红方未被将', MG.isChecked(mate, C.RED), false);

  // 同一局面轮红走，红方应有大量走法
  mate.side = C.RED;
  assert('轮到红方时存在合法走法', MG.genLegalMoves(mate, C.RED).length > 0, true);
})();

console.log('\n[9] isMoveLegal 校验（初始局面）');
(function () {
  var pos = new Position();
  assert('炮二平五合法', MG.isMoveLegal(pos, C.RED, C.idxOf(7, 7), C.idxOf(4, 7)), true);
  assert('马二进三合法', MG.isMoveLegal(pos, C.RED, C.idxOf(7, 9), C.idxOf(6, 7)), true);
  assert('兵三进一合法', MG.isMoveLegal(pos, C.RED, C.idxOf(6, 6), C.idxOf(6, 5)), true);
  assert('炮直走空格合法', MG.isMoveLegal(pos, C.RED, C.idxOf(7, 7), C.idxOf(7, 3)), true);
  assert('炮无架不可吃子', MG.isMoveLegal(pos, C.RED, C.idxOf(7, 7), C.idxOf(7, 2)), false);
  assert('车不可越子', MG.isMoveLegal(pos, C.RED, C.idxOf(8, 9), C.idxOf(8, 6)), false);
  assert('不可走对方的子', MG.isMoveLegal(pos, C.RED, C.idxOf(4, 3), C.idxOf(4, 4)), false);
  assert('不可原地不动', MG.isMoveLegal(pos, C.RED, C.idxOf(7, 7), C.idxOf(7, 7)), false);
  assert('越界索引非法', MG.isMoveLegal(pos, C.RED, C.idxOf(7, 7), 999), false);
  assert('马不可走直线', MG.isMoveLegal(pos, C.RED, C.idxOf(7, 9), C.idxOf(7, 8)), false);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m引擎测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m引擎全部测试通过\x1b[0m\n');
