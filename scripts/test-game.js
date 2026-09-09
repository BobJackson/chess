/**
 * 对局控制器与中文记谱测试（node scripts/test-game.js）
 *
 * 覆盖：记谱正确性、将死/困毙/三次重复/长将判负/自然限着、
 *       悔棋可逆性、序列化重放一致性。
 */

var Position = require('../miniprogram/core/position.js');
var Game = require('../miniprogram/core/game.js');
var MG = require('../miniprogram/core/movegen.js');
var NT = require('../miniprogram/core/notation.js');
var AI = require('../miniprogram/core/ai.js');
var C = require('../miniprogram/core/constants.js');

var DRAW = Game.DRAW;
var passed = 0;
var failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m  ' + name + ' = ' + JSON.stringify(actual));
  } else {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name +
      ' 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/** 构造并走一步，返回 Game 便于链式断言 */
function play(game, fromFile, fromRank, toFile, toRank) {
  return game.move(C.idxOf(fromFile, fromRank), C.idxOf(toFile, toRank));
}

console.log('\n[1] 中文记谱：红方（汉字纵线号）');
(function () {
  // 逐手在初始局面上校验（moveText 不会改变局面）
  var pos = new Position();
  var cases = [
    [[7, 7], [4, 7], '炮二平五'],   // 中炮
    [[8, 9], [8, 7], '車一进二'],   // 直线子进退记格数
    [[6, 9], [4, 7], '相三进五'],   // 斜线子进退记终点纵线号
    [[5, 9], [4, 8], '仕四进五'],
    [[4, 9], [4, 8], '帅五进一'],   // (3,9) 初始有己方仕，改用前进一格
    [[7, 9], [6, 7], '马二进三'],
    [[2, 6], [2, 5], '兵七进一']
  ];
  cases.forEach(function (item) {
    var from = C.idxOf(item[0][0], item[0][1]);
    var to = C.idxOf(item[1][0], item[1][1]);
    var ok = MG.isMoveLegal(pos, C.RED, from, to);
    if (!ok) {
      failed++;
      console.log('  \x1b[31mFAIL\x1b[0m  测试用例本身非法: ' + item[2]);
      return;
    }
    assert('红方 ' + item[2], NT.moveText(pos, from, to), item[2]);
  });
  assert('用例执行后局面未变', pos.toFen() === C.START_FEN, true);
})();

console.log('\n[2] 中文记谱：黑方（阿拉伯纵线号）');
(function () {
  var pos = new Position();
  // 先走一步红棋，轮到黑方
  var undo = { from: 0, to: 0, piece: 0, captured: 0, side: 0 };
  pos.makeMove(C.idxOf(7, 7), C.idxOf(4, 7), undo);

  var cases = [
    [[7, 0], [6, 2], '马8进7'],
    [[1, 0], [2, 2], '马2进3'],
    [[0, 0], [0, 1], '車1进1'],   // 車在底线前进一格
    [[3, 0], [4, 1], '士4进5'],
    [[2, 3], [2, 4], '卒3进1'],
    [[4, 0], [4, 1], '将5进1'],   // 将帅只走直线，进退记格数
    [[7, 2], [4, 2], '炮8平5']
  ];
  cases.forEach(function (item) {
    var from = C.idxOf(item[0][0], item[0][1]);
    var to = C.idxOf(item[1][0], item[1][1]);
    if (!MG.isMoveLegal(pos, C.BLACK, from, to)) {
      failed++;
      console.log('  \x1b[31mFAIL\x1b[0m  测试用例本身非法: ' + item[2]);
      return;
    }
    assert('黑方 ' + item[2], NT.moveText(pos, from, to), item[2]);
  });
})();

console.log('\n[3] 中文记谱：同纵线多子用「前/后/序号」');
(function () {
  // 红方双炮同在 file 1：(1,7) 靠后、(1,3) 靠前（红方向 rank 0 进攻）
  var pos = new Position('4k4/9/9/1C7/9/9/9/1C7/9/5K3 w - - 0 1');
  assert('前炮（靠近对方一侧）', NT.moveText(pos, C.idxOf(1, 3), C.idxOf(4, 3)), '前炮平五');
  assert('后炮', NT.moveText(pos, C.idxOf(1, 7), C.idxOf(4, 7)), '后炮平五');

  // 黑方双车同在 file 8：(8,0) 靠后、(8,4) 靠前（黑方向 rank 9 进攻）
  var pos2 = new Position('3k4r/9/9/9/8r/9/9/9/9/5K3 b - - 0 1');
  assert('黑方前车', NT.moveText(pos2, C.idxOf(8, 4), C.idxOf(4, 4)), '前車平5');
  assert('黑方后车', NT.moveText(pos2, C.idxOf(8, 0), C.idxOf(4, 0)), '后車平5');

  // 三枚同列红兵（file 0 的 rank 3/5/7，各能前进一格且不互挡）
  // 从前到后依次为：前、二、后
  var pos4 = new Position('4k4/9/9/P8/9/P8/9/P8/9/5K3 w - - 0 1');
  assert('三兵同列·前', NT.moveText(pos4, C.idxOf(0, 3), C.idxOf(0, 2)), '前兵进一');
  assert('三兵同列·二', NT.moveText(pos4, C.idxOf(0, 5), C.idxOf(0, 4)), '二兵进一');
  assert('三兵同列·后', NT.moveText(pos4, C.idxOf(0, 7), C.idxOf(0, 6)), '后兵进一');
})();

console.log('\n[4] 终局：将死');
(function () {
  // 黑将 (4,0)，红车 (3,1) 封锁，红车 (8,5) 沉底成杀
  var game = new Game('4k4/3R5/9/9/9/8R/9/9/9/3K5 w - - 0 1');
  var r = play(game, 8, 5, 8, 0);
  assert('走法被接受', r.ok, true);
  console.log('        着法记谱: ' + r.text);
  assert('记谱含绝杀标记', r.text, '車一进五绝杀');
  assert('对局已结束', !!game.result, true);
  assert('胜方为红', game.result && game.result.winner, C.RED);
  assert('终局原因', game.result && game.result.reason, '将死');
  assert('黑方确无合法走法', MG.genLegalMoves(game.pos, C.BLACK).length, 0);
  assert('黑方处于被将军状态', game.pos.side === C.BLACK && MG.isChecked(game.pos, C.BLACK), true);
})();

console.log('\n[5] 终局：困毙（无子可动同样判负）');
(function () {
  var game = new Game('4k4/3R5/9/9/9/8R/9/9/9/3K5 w - - 0 1');
  // 红车平中，封死黑将所有出路但不将军
  var r = play(game, 8, 5, 5, 5);
  assert('走法被接受', r.ok, true);
  assert('黑方未被将军', MG.isChecked(game.pos, C.BLACK), false);
  assert('黑方无合法走法', MG.genLegalMoves(game.pos, C.BLACK).length, 0);
  assert('终局原因为困毙', game.result && game.result.reason, '困毙');
  assert('胜方为红', game.result && game.result.winner, C.RED);
})();

console.log('\n[6] 终局：三次重复局面（双方均不长将 → 和棋）');
(function () {
  // 红车 (0,9) 与黑车 (0,0) 各自平移一格来回，双方都不将军
  var game = new Game('r2k5/9/9/9/9/9/9/9/9/R4K3 w - - 0 1');
  var seq = [
    [[0, 9], [1, 9]], [[0, 0], [1, 0]],
    [[1, 9], [0, 9]], [[1, 0], [0, 0]],
    [[0, 9], [1, 9]], [[0, 0], [1, 0]],
    [[1, 9], [0, 9]], [[1, 0], [0, 0]]
  ];
  var last = null;
  seq.forEach(function (m, i) {
    last = play(game, m[0][0], m[0][1], m[1][0], m[1][1]);
    if (!last.ok) {
      failed++;
      console.log('  \x1b[31mFAIL\x1b[0m  第 ' + (i + 1) + ' 手非法: ' + last.error);
    }
  });
  assert('共走 8 手', game.plyCount(), 8);
  assert('终局为和棋', game.result && game.result.winner, DRAW);
  assert('终局原因', game.result && game.result.reason, '三次重复局面');
  assert('局面回到初始', game.pos.toFen(), 'r2k5/9/9/9/9/9/9/9/9/R4K3 w - - 0 1');
  console.log('        终局文本: ' + (game.result ? game.result.text : ''));
})();

console.log('\n[7] 终局：长将判负（单方连续将军）');
(function () {
  // 红车 A(3,1) 借 B(8,1) 横向保护，反复照将；黑将被迫在 (4,0)/(3,0) 之间往返
  // 红方每手都将军、黑方从不将军 → 红方长将，按规则判负
  var game = new Game('4k4/3R4R/9/9/9/9/9/9/9/5K3 w - - 0 1');
  var seq = [
    [[3, 1], [4, 1]], [[4, 0], [3, 0]],   // 红将、黑躲
    [[4, 1], [3, 1]], [[3, 0], [4, 0]],
    [[3, 1], [4, 1]], [[4, 0], [3, 0]],
    [[4, 1], [3, 1]], [[3, 0], [4, 0]]    // 第 8 手回到开局局面（第 3 次）
  ];
  seq.forEach(function (m, i) {
    var r = play(game, m[0][0], m[0][1], m[1][0], m[1][1]);
    if (!r.ok) {
      failed++;
      console.log('  \x1b[31mFAIL\x1b[0m  第 ' + (i + 1) + ' 手非法: ' + r.error);
    }
  });

  var redChecks = game.history.filter(function (h) { return h.side === C.RED; })
    .every(function (h) { return h.check; });
  var blackChecks = game.history.filter(function (h) { return h.side === C.BLACK; })
    .some(function (h) { return h.check; });
  assert('红方每手都在将军', redChecks, true);
  assert('黑方从未将军', blackChecks, false);

  assert('终局原因', game.result && game.result.reason, '长将判负');
  assert('长将方（红）判负，黑胜', game.result && game.result.winner, C.BLACK);
  console.log('        终局文本: ' + (game.result ? game.result.text : ''));
})();

console.log('\n[8] 终局：自然限着（连续无吃子判和）');
(function () {
  assert('规则阈值为 120 手', Game.NO_CAPTURE_LIMIT, 120);

  // 红车在 rank 8 往返 file 0~4，黑车在 rank 1 往返 file 4~8：
  //   红车避开黑将所在的 file 5、黑车避开红帅所在的 file 3，双方永不照将
  //   往返周期均为 8 步，12 手内任一局面最多出现 2 次，不会先触发重复局面
  var game = new Game('5k3/4r4/9/9/9/9/9/9/R8/3K5 w - - 0 1');
  // 缩短阈值以覆盖判定逻辑（默认为 120 手）
  game.noCaptureLimit = 12;

  var RED_PATH = [0, 1, 2, 3, 4, 3, 2, 1];
  var BLACK_PATH = [4, 5, 6, 7, 8, 7, 6, 5];

  var plies = 0;
  var illegal = null;
  while (!game.result && plies < 40) {
    var step = plies >> 1;
    var isRed = plies % 2 === 0;
    var path = isRed ? RED_PATH : BLACK_PATH;
    var rank = isRed ? 8 : 1;
    var r = play(game, path[step % 8], rank, path[(step + 1) % 8], rank);
    if (!r.ok) { illegal = r.error + '（第 ' + (plies + 1) + ' 手）'; break; }
    plies++;
  }

  assert('全部着法合法', illegal, null);
  assert('在阈值手数结束', plies, 12);
  assert('终局为和棋', game.result && game.result.winner, DRAW);
  assert('终局原因', game.result && game.result.reason, '自然限着');
  assert('全程无吃子', game.noCapturePlies, 12);
  assert('全程无人被将死', game.history.some(function (h) { return h.check; }), false);
  console.log('        终局文本: ' + (game.result ? game.result.text : ''));
})();

console.log('\n[9] 悔棋可逆性');
(function () {
  var game = new Game();
  var startFen = game.pos.toFen();
  var snapshots = [startFen];
  var plies = 0;
  var captures = 0;

  // 用入门级 AI 自我对弈 24 手，中途必然出现吃子与将军
  while (plies < 24 && !game.result) {
    var r = AI.findBestMove(game.pos, { level: 'beginner' });
    if (!r) break;
    if (game.pos.board[r.to] !== C.EMPTY) captures++;
    var res = game.move(r.from, r.to);
    if (!res.ok) break;
    plies++;
    snapshots.push(game.pos.toFen());
  }
  console.log('        自我对弈 ' + plies + ' 手，吃子 ' + captures + ' 次');
  assert('推进了足够手数', plies >= 20, true);

  var noCaptureBefore = game.noCapturePlies;
  var repKeysBefore = Object.keys(game.repetition).length;

  // 逐手悔棋，每一步都必须精确回到对应快照
  var stepwiseOk = true;
  while (game.history.length > 0) {
    game.undo(1);
    if (game.pos.toFen() !== snapshots[game.history.length]) {
      stepwiseOk = false;
      break;
    }
  }

  assert('逐步悔棋均回到对应历史局面', stepwiseOk, true);
  assert('局面回到初始', game.pos.toFen(), startFen);
  assert('历史清空', game.history.length, 0);
  assert('重复计数只剩起始局面', Object.keys(game.repetition).length, 1);
  assert('起始局面计数为 1', game.repetition[game.startSig], 1);
  assert('无吃子计数归零', game.noCapturePlies, 0);
  assert('对局重新开放', game.result, null);
  console.log('        悔棋前 noCapturePlies=' + noCaptureBefore +
    '，重复指纹数=' + repKeysBefore);
})();

console.log('\n[10] 悔棋与吃子计数还原');
(function () {
  // 红车 (4,7) 吃黑卒 (4,4)，随后悔棋，验证 noCapturePlies 精确还原
  var game = new Game('3k5/9/4r4/9/4p4/9/9/4R4/9/4K4 w - - 0 1');
  var steps = [
    [[4, 9], [4, 8]],   // 红帅上一步（凑无吃子计数）
    [[3, 0], [4, 0]],   // 黑将平移
    [[4, 8], [4, 9]],   // 红帅回位
    [[4, 0], [3, 0]]    // 黑将回位；四手后重新轮到红方
  ];
  steps.forEach(function (m) { play(game, m[0][0], m[0][1], m[1][0], m[1][1]); });
  assert('四手后轮到红方', game.pos.side, C.RED);
  assert('吃子前无吃子计数', game.noCapturePlies, 4);

  var cap = play(game, 4, 7, 4, 4);   // 红车吃黑卒
  assert('吃子走法被接受', cap.ok, true);
  assert('吃子后计数清零', game.noCapturePlies, 0);
  assert('记录了被吃子', cap.entry && cap.entry.captured, C.B_PAWN);

  game.undo(1);
  assert('悔棋后计数还原为 4', game.noCapturePlies, 4);
  assert('悔棋后黑卒回到原位', game.pos.board[C.idxOf(4, 4)], C.B_PAWN);
  assert('悔棋后红车回到原位', game.pos.board[C.idxOf(4, 7)], C.R_ROOK);

  // 一次性回退 3 手：依次取消吃卒、黑将回位、红帅回位，计数逐步还原 0→4→3→2
  game.move(C.idxOf(4, 7), C.idxOf(4, 4));
  assert('吃子后历史为 5 手', game.history.length, 5);
  var undone = game.undo(3);
  assert('一次回退 3 手返回实际手数', undone, 3);
  assert('回退后计数还原为 2', game.noCapturePlies, 2);
  assert('历史只剩 2 手', game.history.length, 2);
  assert('回退后轮到红方', game.pos.side, C.RED);
})();

console.log('\n[11] 非法走法与终局后禁止走子');
(function () {
  var game = new Game();
  var r = play(game, 4, 9, 4, 5);   // 帅直冲五格
  assert('越权走法被拒', r.ok, false);
  assert('错误提示存在', typeof r.error === 'string' && r.error.length > 0, true);
  assert('局面未改变', game.pos.toFen(), C.START_FEN);

  var r2 = play(game, 0, 9, 0, 8);  // 车往前走一格（红车在 (0,9)）
  assert('合法走法被接受', r2.ok, true);

  var r3 = game.move(C.idxOf(0, 8), C.idxOf(0, 7));
  assert('不能走对方的子（当前轮到黑方）', r3.ok, false);

  // 终局后禁止继续走子
  var over = new Game('4k4/3R5/9/9/9/8R/9/9/9/3K5 w - - 0 1');
  play(over, 8, 5, 8, 0);
  assert('将死后对局已结束', !!over.result, true);
  var r4 = over.move(C.idxOf(3, 1), C.idxOf(3, 0));
  assert('终局后走子被拒', r4.ok, false);
  assert('终局后无合法落点', over.legalTargets(C.idxOf(3, 1)).length, 0);
})();

console.log('\n[12] legalTargets 与状态摘要');
(function () {
  var game = new Game();
  var targets = game.legalTargets(C.idxOf(7, 9));  // 红马 (7,9)
  console.log('        初始局面红马 (7,9) 可走 ' + targets.length + ' 处');
  assert('马有 2 个合法落点', targets.length, 2);
  assert('落点含 (6,7)', targets.indexOf(C.idxOf(6, 7)) >= 0, true);
  assert('落点含 (8,7)', targets.indexOf(C.idxOf(8, 7)) >= 0, true);

  assert('不能查询对方棋子', game.legalTargets(C.idxOf(7, 0)).length, 0);
  assert('不能查询空位', game.legalTargets(C.idxOf(4, 5)).length, 0);

  play(game, 7, 7, 4, 7);   // 炮二平五
  play(game, 7, 0, 6, 2);   // 马8进7
  var st = game.status();
  assert('轮到红方', st.side, C.RED);
  assert('已走 2 手', st.ply, 2);
  assert('未结束', st.finished, false);
  assert('记录最后一手', st.lastMove && st.lastMove.text, '马8进7');
  assert('FEN 与局面一致', st.fen, game.pos.toFen());

  var texts = game.moveTexts();
  assert('着法文本序列', texts.join(','), '炮二平五,马8进7');
  assert('回合排版', game.moveList()[0], '1. 炮二平五  马8进7');
})();

console.log('\n[13] 将军标记');
(function () {
  // 红炮 (4,7) 借中兵位将军需要炮架；改用直接构造：红车照将黑将
  var game = new Game('4k4/9/9/9/9/9/9/9/4R4/4K4 w - - 0 1');
  var r = play(game, 4, 8, 4, 1);   // 红车直插将前
  assert('走法被接受', r.ok, true);
  assert('记为将军', r.text, '車五进七将');
  assert('isChecked 反映当前走子方被将军', game.isChecked(), true);
  assert('黑方仍有应将着法', MG.genLegalMoves(game.pos, C.BLACK).length > 0, true);
  assert('尚未终局', game.result, null);
})();

console.log('\n[14] 序列化与重放一致性');
(function () {
  var game = new Game();
  var plies = 0;
  while (plies < 30 && !game.result) {
    var r = AI.findBestMove(game.pos, { level: 'easy', moveNumber: plies });
    if (!r) break;
    var res = game.move(r.from, r.to);
    if (!res.ok) break;
    plies++;
  }
  console.log('        自我对弈 ' + plies + ' 手，结果 ' +
    (game.result ? game.result.reason : '未结束'));

  var json = game.toJSON();
  var copy = Game.fromJSON(JSON.parse(JSON.stringify(json)));

  assert('重放后 FEN 一致', copy.pos.toFen(), game.pos.toFen());
  assert('重放后手数一致', copy.plyCount(), game.plyCount());
  assert('重放后走子方一致', copy.pos.side, game.pos.side);
  assert('重放后着法文本一致', copy.moveTexts().join('|'), game.moveTexts().join('|'));
  assert('重放后终局一致',
    copy.result ? copy.result.reason : null,
    game.result ? game.result.reason : null);
  assert('序列化体积（着法数）', json.moves.length, plies);

  // 部分重放：只应用前一半着法
  var half = Math.floor(plies / 2);
  var partial = Game.replay(C.START_FEN, json.moves.slice(0, half));
  assert('部分重放手数正确', partial.plyCount(), half);
  assert('部分重放前缀文本一致',
    partial.moveTexts().join('|'), game.moveTexts().slice(0, half).join('|'));

  // 脏数据容错：混入非法着法后应停止而非崩溃
  var dirty = json.moves.slice(0, 4).concat([[0, 89]]);
  var tough = new Game();
  var applied = tough.applyMoves(dirty);
  assert('非法着法处停止重放', applied, 4);
  var ref4 = Game.replay(C.START_FEN, json.moves.slice(0, 4));
  assert('停止前的着法仍正确重放', tough.pos.toFen(), ref4.pos.toFen());
})();

console.log('\n[15] 认输等人为终局');
(function () {
  var game = new Game();
  play(game, 7, 7, 4, 7);
  var result = game.finish(C.BLACK, '红方认输');
  assert('胜方为黑', result.winner, C.BLACK);
  assert('原因文本', result.reason, '红方认输');
  assert('终局文本', result.text, '红方认输，黑方胜');
  assert('对局标记结束', game.status().finished, true);
  assert('重复 finish 不覆盖', game.finish(C.RED, '黑方认输').winner, C.BLACK);
  assert('终局后不可走子', play(game, 7, 0, 6, 2).ok, false);

  var draw = new Game();
  draw.finish(DRAW, '双方协议');
  assert('和棋文本', draw.result.text, '双方协议，和棋');
})();

console.log('\n[16] parseText 反解析');
(function () {
  var pos = new Position();
  var legal = MG.genLegalMoves(pos, C.RED);
  assert('炮二平五', NT.parseText(pos, '炮二平五', legal),
    MG.packMove(C.idxOf(7, 7), C.idxOf(4, 7)));
  assert('马二进三', NT.parseText(pos, '马二进三', legal),
    MG.packMove(C.idxOf(7, 9), C.idxOf(6, 7)));
  assert('兵七进一', NT.parseText(pos, '兵七进一', legal),
    MG.packMove(C.idxOf(2, 6), C.idxOf(2, 5)));
  assert('不存在的着法返回 null', NT.parseText(pos, '車九进九', legal), null);
  assert('空文本返回 null', NT.parseText(pos, '', legal), null);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m对局层测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m对局层全部测试通过\x1b[0m\n');
