/**
 * 触摸交互控制器测试（node scripts/test-controller.js）
 *
 * Controller 是「触摸状态机」：把 Canvas 的 touchStart/Move/End 翻译成
 * 选中 / 落点提示 / 走子请求，并维护 renderer 所需的视图状态。
 * 这里用真实的 Layout + Game 驱动它，覆盖：
 *   构造与复位、canOperate 门控、点选式与拖拽式走子、非法走子、
 *   回调触发（onSelect/onMoved/onIllegal/onCapture）、renderState 组装、
 *   走子动画生命周期、将军脉冲 tick、换局 setGame，以及对 renderer 的驱动。
 */

var Controller = require('../miniprogram/ui/controller.js');
var Layout = require('../miniprogram/ui/layout.js');
var Game = require('../miniprogram/core/game.js');
var C = require('../miniprogram/core/constants.js');

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

function approx(name, actual, expected, eps) {
  var ok = typeof actual === 'number' && Math.abs(actual - expected) <= (eps || 0.01);
  if (ok) {
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m  ' + name + ' ≈ ' + expected);
  } else {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name +
      ' 期望 ≈' + expected + '，实际 ' + actual);
  }
}

function truthy(name, actual) {
  assert(name, !!actual, true);
}

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

var WIDTH = 375;

/** 标准开局坐标：红兵 idx54 -> idx45；红炮 idx64 可吃 idx1 黑马 */
var PAWN = 54;
var PAWN_TO = 45;
var CANNON = 64;
var CANNON_CAPTURE = 1;   // 黑马
var ENEMY = 19;           // 黑炮（红方视角下的敌子）
var EMPTY_SQ = 45;        // 开局时的空位

/** 车吃卒的确定局面：红车 idx89 可吃 idx53 黑卒，红先 */
var CAPTURE_FEN = '3k5/9/9/9/9/8p/9/9/9/4K3R w - - 0 1';
var ROOK = 89;
var ROOK_CAPTURE = 53;

/** 黑方被将军的局面：黑先且被红车照将，黑将位于 idx3 */
var CHECK_FEN = '3k5/9/9/9/9/3R5/9/9/9/5K3 b - - 0 1';
var BLACK_KING = 3;

function newLayout(flipped) {
  return new Layout(WIDTH, flipped);
}

/** 记录全部回调触发情况 */
function recorder(canMove) {
  var log = {
    select: 0, moved: 0, illegal: 0, capture: 0,
    lastSelect: null, lastMoved: null, lastIllegal: null, lastCapture: null
  };
  var options = {
    onSelect: function (idx, targets) { log.select++; log.lastSelect = { idx: idx, targets: targets }; },
    onMoved: function (res) { log.moved++; log.lastMoved = res; },
    onIllegal: function (msg) { log.illegal++; log.lastIllegal = msg; },
    onCapture: function (entry) { log.capture++; log.lastCapture = entry; }
  };
  if (typeof canMove === 'function') options.canMove = canMove;
  return { log: log, options: options };
}

/** 造一个绑定标准开局、带回调记录器的控制器 */
function mkController(opts) {
  opts = opts || {};
  var game = opts.game || new Game(opts.fen);
  var layout = opts.layout || newLayout(opts.flipped);
  var rec = recorder(opts.canMove);
  var ctrl = new Controller(layout, game, rec.options);
  return { ctrl: ctrl, game: game, layout: layout, log: rec.log };
}

/** 某交叉点的屏幕中心 */
function at(layout, idx) {
  return layout.pointOf(idx);
}

console.log('\n[1] 构造与初始状态');
(function () {
  var s = mkController();
  assert('初始未选中', s.ctrl.selected, -1);
  assert('初始无落点', s.ctrl.targets.length, 0);
  assert('初始无拖拽', s.ctrl.drag, null);
  assert('初始无提示', s.ctrl.hint, null);
  assert('初始脉冲为 0', s.ctrl.pulse, 0);
  assert('初始无走子动画', s.ctrl.anim, null);
  truthy('持有 layout', s.ctrl.layout);
  truthy('持有 game', s.ctrl.game);
  assert('导出的拖拽阈值比例', Controller.DRAG_RATIO, 0.35);
  assert('导出的走子动画时长', Controller.MOVE_DURATION, 200);
})();

console.log('\n[2] canOperate 门控');
(function () {
  // 2.1 无对局
  var noGame = new Controller(newLayout(), null);
  assert('无对局时不可操作', noGame.canOperate(), false);
  var p = at(newLayout(), PAWN);
  assert('无对局时 touchStart 被拒', noGame.touchStart(p.x, p.y), false);
  assert('无对局时未产生选中', noGame.selected, -1);

  // 2.2 对局已结束
  var over = mkController();
  over.game.finish(C.RED, '认输');
  assert('结束后不可操作', over.ctrl.canOperate(), false);
  var pe = at(over.layout, PAWN);
  assert('结束后 touchStart 被拒', over.ctrl.touchStart(pe.x, pe.y), false);

  // 2.3 canMove 注入 false
  var blocked = mkController({ canMove: function () { return false; } });
  assert('canMove=false 时不可操作', blocked.ctrl.canOperate(), false);
  var pb = at(blocked.layout, PAWN);
  assert('canMove=false 时 touchStart 被拒', blocked.ctrl.touchStart(pb.x, pb.y), false);
  assert('canMove=false 时未选中', blocked.ctrl.selected, -1);
  assert('canMove=false 时未进入拖拽', blocked.ctrl.drag, null);

  // 2.4 canMove 注入 true
  var allowed = mkController({ canMove: function () { return true; } });
  assert('canMove=true 时可操作', allowed.ctrl.canOperate(), true);

  // 2.5 未注入 canMove 时默认可操作
  var dflt = mkController();
  assert('缺省 canMove 时可操作', dflt.ctrl.canOperate(), true);
})();

console.log('\n[3] select / focusIdx / clearSelection / setHint');
(function () {
  var s = mkController();

  var targets = s.ctrl.select(PAWN);
  assert('选中后记录索引', s.ctrl.selected, PAWN);
  assert('红兵仅有一个落点', targets.length, 1);
  assert('红兵落点为正前方', targets[0], PAWN_TO);
  assert('onSelect 触发一次', s.log.select, 1);
  assert('onSelect 携带索引', s.log.lastSelect.idx, PAWN);

  s.ctrl.clearSelection();
  assert('清空后未选中', s.ctrl.selected, -1);
  assert('清空后无落点', s.ctrl.targets.length, 0);

  // focusIdx 合法
  var f = s.ctrl.focusIdx(CANNON);
  assert('focusIdx 选中红炮', s.ctrl.selected, CANNON);
  truthy('focusIdx 返回落点数组', f.length > 0);

  // focusIdx 越界
  var neg = s.ctrl.focusIdx(-1);
  assert('focusIdx(-1) 清空选中', s.ctrl.selected, -1);
  assert('focusIdx(-1) 返回空数组', neg.length, 0);
  s.ctrl.focusIdx(CANNON);
  var big = s.ctrl.focusIdx(C.BOARD_SIZE);
  assert('focusIdx(越界) 清空选中', s.ctrl.selected, -1);
  assert('focusIdx(越界) 返回空数组', big.length, 0);

  // setHint
  var hint = { from: PAWN, to: PAWN_TO };
  assert('setHint 合法对象被保留', s.ctrl.setHint(hint), hint);
  assert('hint 字段写入', s.ctrl.hint, hint);
  assert('setHint(null) 归零', s.ctrl.setHint(null), null);
  assert('setHint(缺 from) 归零', s.ctrl.setHint({ to: 1 }), null);
  assert('setHint(非对象) 归零', s.ctrl.setHint('x'), null);
})();

console.log('\n[4] requestMove：合法、非法、回调');
(function () {
  // 4.1 合法走子（非吃子）
  var s = mkController();
  s.ctrl.select(PAWN);
  s.ctrl.setHint({ from: PAWN, to: PAWN_TO });
  var res = s.ctrl.requestMove(PAWN, PAWN_TO);
  assert('走子成功', res.ok, true);
  assert('走子后轮到黑方', s.game.pos.side, C.BLACK);
  assert('成功后清空选中', s.ctrl.selected, -1);
  assert('成功后清空落点', s.ctrl.targets.length, 0);
  assert('成功后清空提示', s.ctrl.hint, null);
  assert('成功后清空拖拽', s.ctrl.drag, null);
  assert('onMoved 触发一次', s.log.moved, 1);
  assert('onCapture 未触发', s.log.capture, 0);
  assert('onIllegal 未触发', s.log.illegal, 0);

  // 4.2 非法走子：保留选中，触发 onIllegal
  var b = mkController();
  b.ctrl.select(PAWN);
  var bad = b.ctrl.requestMove(PAWN, PAWN_TO + 1); // 非落点
  assert('非法走子被拒', bad.ok, false);
  assert('非法走子仍轮红方', b.game.pos.side, C.RED);
  assert('非法走子保留选中', b.ctrl.selected, PAWN);
  assert('onIllegal 触发一次', b.log.illegal, 1);
  assert('onIllegal 携带原因', b.log.lastIllegal, '不符合走法');
  assert('onMoved 未触发', b.log.moved, 0);

  // 4.3 吃子走法：触发 onCapture + onMoved
  var c = mkController({ fen: CAPTURE_FEN });
  c.ctrl.select(ROOK);
  truthy('车确有吃卒落点', c.ctrl.targets.indexOf(ROOK_CAPTURE) >= 0);
  var cap = c.ctrl.requestMove(ROOK, ROOK_CAPTURE);
  assert('吃子成功', cap.ok, true);
  assert('onCapture 触发一次', c.log.capture, 1);
  assert('onCapture 携带被吃子', c.log.lastCapture.captured, C.B_PAWN);
  assert('onMoved 同时触发', c.log.moved, 1);

  // 4.4 标准开局红炮吃黑马同样触发 onCapture
  var d = mkController();
  d.ctrl.select(CANNON);
  truthy('炮有吃马落点', d.ctrl.targets.indexOf(CANNON_CAPTURE) >= 0);
  d.ctrl.requestMove(CANNON, CANNON_CAPTURE);
  assert('炮吃马触发 onCapture', d.log.capture, 1);
  assert('被吃子为黑马', d.log.lastCapture.captured, C.B_KNIGHT);
})();

console.log('\n[5] 点击式走子（两次 touchStart）');
(function () {
  var s = mkController();
  var from = at(s.layout, PAWN);
  var to = at(s.layout, PAWN_TO);

  var r1 = s.ctrl.touchStart(from.x, from.y);
  assert('第一次点击选中并需重绘', r1, true);
  assert('已选中红兵', s.ctrl.selected, PAWN);
  assert('落点已算出', s.ctrl.targets.length, 1);
  // 第一次抬手（未拖动）：保留选中
  var e1 = s.ctrl.touchEnd(from.x, from.y);
  assert('未拖动的抬手不触发改动', e1, false);
  assert('抬手后仍选中', s.ctrl.selected, PAWN);
  assert('抬手后拖拽已清', s.ctrl.drag, null);

  // 第二次点击落点
  var r2 = s.ctrl.touchStart(to.x, to.y);
  assert('点击落点触发改动', r2, true);
  assert('走子完成轮到黑方', s.game.pos.side, C.BLACK);
  assert('走子后清空选中', s.ctrl.selected, -1);
  assert('onMoved 触发', s.log.moved, 1);
})();

console.log('\n[6] 拖拽式走子（touchStart -> Move -> End）');
(function () {
  var s = mkController();
  var from = at(s.layout, PAWN);
  var to = at(s.layout, PAWN_TO);

  s.ctrl.touchStart(from.x, from.y);
  truthy('按下后进入拖拽预备', s.ctrl.drag);
  assert('拖拽起点记录正确', s.ctrl.drag.from, PAWN);
  assert('尚未标记为拖动', s.ctrl.drag.moved, false);

  var mv = s.ctrl.touchMove(to.x, to.y); // 位移 = 一格 > 阈值
  assert('超过阈值后返回需重绘', mv, true);
  assert('已标记为拖动', s.ctrl.drag.moved, true);
  assert('悬停落在合法落点', s.ctrl.drag.hover, PAWN_TO);
  approx('拖拽 x 跟随手指', s.ctrl.drag.x, to.x);
  approx('拖拽 y 跟随手指', s.ctrl.drag.y, to.y);

  var end = s.ctrl.touchEnd(to.x, to.y);
  assert('松手在落点触发改动', end, true);
  assert('拖拽走子完成', s.game.pos.side, C.BLACK);
  assert('拖拽走子后清空拖拽', s.ctrl.drag, null);
  assert('拖拽走子后清空选中', s.ctrl.selected, -1);
  assert('onMoved 触发', s.log.moved, 1);
})();

console.log('\n[7] 拖拽阈值与非法落点');
(function () {
  // 7.1 位移不足阈值：视为点击，保留选中，touchEnd 不改动
  var s = mkController();
  var from = at(s.layout, PAWN);
  s.ctrl.touchStart(from.x, from.y);
  var cell = s.layout.cell;
  var small = cell * 0.1; // 远小于 0.35*cell
  var mv = s.ctrl.touchMove(from.x + small, from.y);
  assert('微小位移不返回重绘', mv, false);
  assert('微小位移未标记拖动', s.ctrl.drag.moved, false);
  var end = s.ctrl.touchEnd(from.x + small, from.y);
  assert('未拖动的抬手返回 false', end, false);
  assert('未拖动抬手保留选中', s.ctrl.selected, PAWN);
  assert('未拖动抬手未走子', s.game.pos.side, C.RED);

  // 7.2 拖到非法位置：棋子回位但保持选中
  var b = mkController();
  var bf = at(b.layout, PAWN);
  var off = at(b.layout, PAWN + 18); // idx63，红兵不可达
  b.ctrl.touchStart(bf.x, bf.y);
  b.ctrl.touchMove(off.x, off.y);
  assert('拖到非法点已标记拖动', b.ctrl.drag.moved, true);
  assert('非法点悬停为 -1', b.ctrl.drag.hover, -1);
  var be = b.ctrl.touchEnd(off.x, off.y);
  assert('非法落点抬手返回 true（需回位重绘）', be, true);
  assert('非法落点未走子', b.game.pos.side, C.RED);
  assert('非法落点保留选中', b.ctrl.selected, PAWN);
  assert('非法落点清空拖拽', b.ctrl.drag, null);
  assert('非法落点未触发 onMoved', b.log.moved, 0);
})();

console.log('\n[8] 触摸容错：空位 / 敌子 / 越界 / cancel');
(function () {
  // 8.1 点空位（无选中时）
  var s = mkController();
  var e = at(s.layout, EMPTY_SQ);
  var r = s.ctrl.touchStart(e.x, e.y);
  assert('点空位无需重绘', r, false);
  assert('点空位未选中', s.ctrl.selected, -1);

  // 8.2 已选中后点空位：取消选中并需重绘
  s.ctrl.select(PAWN);
  var r2 = s.ctrl.touchStart(e.x, e.y);
  assert('有选中时点空位需重绘', r2, true);
  assert('点空位取消选中', s.ctrl.selected, -1);

  // 8.3 点敌子：不选中
  var en = mkController();
  var pe = at(en.layout, ENEMY);
  var re = en.ctrl.touchStart(pe.x, pe.y);
  assert('点敌子无需重绘', re, false);
  assert('点敌子不选中', en.ctrl.selected, -1);
  assert('点敌子未进入拖拽', en.ctrl.drag, null);

  // 8.4 越界坐标
  var o = mkController();
  o.ctrl.select(PAWN);
  var ro = o.ctrl.touchStart(-999, -999);
  assert('越界点击需重绘（因原有选中）', ro, true);
  assert('越界点击取消选中', o.ctrl.selected, -1);

  // 8.5 touchMove 无拖拽
  var m = mkController();
  assert('无拖拽时 touchMove 返回 false', m.ctrl.touchMove(10, 10), false);

  // 8.6 touchCancel 清理拖拽
  var c = mkController();
  var pc = at(c.layout, PAWN);
  c.ctrl.touchStart(pc.x, pc.y);
  truthy('cancel 前存在拖拽', c.ctrl.drag);
  assert('touchCancel 返回 true', c.ctrl.touchCancel(), true);
  assert('touchCancel 清空拖拽', c.ctrl.drag, null);
  assert('touchCancel 保留选中', c.ctrl.selected, PAWN);
})();

console.log('\n[9] renderState 组装');
(function () {
  // 9.1 默认态
  var s = mkController();
  var st = s.ctrl.renderState();
  assert('默认 board 即局面棋盘', st.board === s.game.pos.board, true);
  assert('默认未选中', st.selected, -1);
  assert('默认无落点', st.targets.length, 0);
  assert('默认无上一步', st.lastMove, null);
  assert('默认无将军', st.checkIdx, -1);
  assert('默认脉冲 0', st.pulse, 0);
  assert('默认无提示', st.hint, null);
  assert('默认无拖拽子', st.moving, null);
  assert('默认无走子动画', st.anim, null);
  assert('默认无落子余晖', st.land, 0);

  // 9.2 选中态
  s.ctrl.select(PAWN);
  var st2 = s.ctrl.renderState();
  assert('选中态索引', st2.selected, PAWN);
  assert('选中态落点', st2.targets.length, 1);

  // 9.3 拖拽态：拖拽子浮起，选中环隐藏
  var d = mkController();
  var from = at(d.layout, PAWN);
  var to = at(d.layout, PAWN_TO);
  d.ctrl.touchStart(from.x, from.y);
  d.ctrl.touchMove(to.x, to.y);
  var st3 = d.ctrl.renderState();
  truthy('拖拽态含 moving', st3.moving);
  assert('moving 起点', st3.moving.from, PAWN);
  assert('moving 棋子为红兵', st3.moving.piece, C.R_PAWN);
  approx('moving 跟随手指 x', st3.moving.x, to.x);
  assert('moving 携带悬停落点', st3.moving.hover, PAWN_TO);
  assert('拖拽态隐藏选中环', st3.selected, -1);

  // 悬停在非法点时 hover 为 -1，渲染层据此不高亮
  var nh = mkController();
  var nf = at(nh.layout, PAWN);
  var no = at(nh.layout, PAWN + 18);
  nh.ctrl.touchStart(nf.x, nf.y);
  nh.ctrl.touchMove(no.x, no.y);
  var sth = nh.ctrl.renderState();
  truthy('非法悬停仍有 moving', sth.moving);
  assert('悬停非法点时 hover 为 -1', sth.moving.hover, -1);

  // 9.4 上一步标记：动画期间让位，播完才出现（否则会提前剧透落点）
  var m = mkController();
  m.ctrl.requestMove(PAWN, PAWN_TO);
  var stAnim = m.ctrl.renderState();
  truthy('走子后 renderState 含 anim', stAnim.anim);
  assert('renderState.anim.from', stAnim.anim.from, PAWN);
  assert('renderState.anim.to', stAnim.anim.to, PAWN_TO);
  assert('动画期间不画上一步标记', stAnim.lastMove, null);

  m.ctrl.tick(Controller.MOVE_DURATION);
  var st4 = m.ctrl.renderState();
  assert('播完后 anim 清空', st4.anim, null);
  truthy('走上一步后含 lastMove', st4.lastMove);
  assert('lastMove.from', st4.lastMove.from, PAWN);
  assert('lastMove.to', st4.lastMove.to, PAWN_TO);

  // 9.5 将军脉冲指向被将的王
  var ck = mkController({ fen: CHECK_FEN });
  var st5 = ck.ctrl.renderState();
  assert('被将时 checkIdx 指向黑将', st5.checkIdx, BLACK_KING);

  // 9.6 提示着法透传
  var h = mkController();
  h.ctrl.setHint({ from: PAWN, to: PAWN_TO });
  var st6 = h.ctrl.renderState();
  truthy('renderState 透传 hint', st6.hint);
  assert('hint.from', st6.hint.from, PAWN);

  // 9.7 无对局时不抛异常
  var ng = new Controller(newLayout(), null);
  var threw = null;
  var st7 = null;
  try { st7 = ng.renderState(); } catch (err) { threw = err.message; }
  assert('无对局 renderState 不抛异常', threw, null);
  assert('无对局时 board 为 null', st7.board, null);
  assert('无对局时无上一步', st7.lastMove, null);
})();

console.log('\n[10] tick：将军脉冲推进与回绕');
(function () {
  var s = mkController();
  approx('tick(450) 推进 0.5', s.ctrl.tick(450), 0.5);
  approx('再 tick(450) 到达 1.0', s.ctrl.tick(450), 1.0);
  approx('越过后回绕（1.5 -> 0.5）', s.ctrl.tick(450), 0.5);

  var w = mkController();
  w.ctrl.pulse = 0.95;
  approx('接近 1 时回绕到 0.05', w.ctrl.tick(90), 0.05);

  var dflt = mkController();
  approx('缺省 dt=16 的步进', dflt.ctrl.tick(), 16 / 900, 1e-6);
})();

console.log('\n[11] setGame / reset 复位');
(function () {
  var s = mkController();
  s.ctrl.select(PAWN);
  s.ctrl.setHint({ from: PAWN, to: PAWN_TO });
  s.ctrl.pulse = 0.7;
  s.ctrl.playMoveAnim({ from: PAWN, to: PAWN_TO, piece: C.R_PAWN, captured: C.EMPTY });

  var other = new Game();
  var ret = s.ctrl.setGame(other);
  assert('setGame 返回自身支持链式', ret === s.ctrl, true);
  assert('setGame 后指向新对局', s.ctrl.game === other, true);
  assert('setGame 清空选中', s.ctrl.selected, -1);
  assert('setGame 清空落点', s.ctrl.targets.length, 0);
  assert('setGame 清空提示', s.ctrl.hint, null);
  assert('setGame 复位脉冲', s.ctrl.pulse, 0);
  assert('setGame 清空走子动画', s.ctrl.anim, null);

  // reset 单独复位视图但不换局
  s.ctrl.select(PAWN);
  s.ctrl.setHint({ from: PAWN, to: PAWN_TO });
  s.ctrl.pulse = 0.4;
  var game = s.ctrl.game;
  s.ctrl.reset();
  assert('reset 不换局', s.ctrl.game === game, true);
  assert('reset 清空选中', s.ctrl.selected, -1);
  assert('reset 清空落点', s.ctrl.targets.length, 0);
  assert('reset 清空拖拽', s.ctrl.drag, null);
  assert('reset 清空提示', s.ctrl.hint, null);
  assert('reset 复位脉冲', s.ctrl.pulse, 0);
  assert('reset 清空走子动画', s.ctrl.anim, null);
})();

console.log('\n[12] render 驱动 renderer.draw');
(function () {
  var s = mkController();
  s.ctrl.select(PAWN);

  var calls = [];
  var stubRenderer = {
    draw: function (ctx, layout, state) { calls.push({ ctx: ctx, layout: layout, state: state }); }
  };
  var fakeCtx = { tag: 'ctx' };

  var ret = s.ctrl.render(fakeCtx, stubRenderer);
  assert('render 调用 draw 一次', calls.length, 1);
  assert('draw 收到同一 ctx', calls[0].ctx === fakeCtx, true);
  assert('draw 收到同一 layout', calls[0].layout === s.layout, true);
  truthy('draw 收到状态对象', calls[0].state);
  assert('状态含选中索引', calls[0].state.selected, PAWN);
  assert('render 无返回值', ret, undefined);
})();

console.log('\n[13] 多指误触防护（单手势模型）');
(function () {
  // 13.1 点按手势进行中，第二根手指按下被忽略，不改写选中
  var s = mkController();
  var p1 = at(s.layout, PAWN);
  var p2 = at(s.layout, CANNON);
  s.ctrl.touchStart(p1.x, p1.y);
  assert('第一根手指已选中红兵', s.ctrl.selected, PAWN);
  var ignored = s.ctrl.touchStart(p2.x, p2.y);
  assert('手势中第二指 touchStart 返回 false', ignored, false);
  assert('选中未被第二指改写', s.ctrl.selected, PAWN);
  assert('拖拽起点未被第二指改写', s.ctrl.drag.from, PAWN);

  // 13.2 拖拽进行中，第二根手指按下被忽略，起点不变，仍可正常落子
  var d = mkController();
  var from = at(d.layout, PAWN);
  var to = at(d.layout, PAWN_TO);
  var other = at(d.layout, CANNON);
  d.ctrl.touchStart(from.x, from.y);
  d.ctrl.touchMove(to.x, to.y);
  assert('已进入拖拽', d.ctrl.drag.moved, true);
  var ig2 = d.ctrl.touchStart(other.x, other.y);
  assert('拖拽中第二指被忽略', ig2, false);
  assert('拖拽起点仍是红兵', d.ctrl.drag.from, PAWN);
  assert('拖拽状态未被破坏', d.ctrl.drag.moved, true);
  var done = d.ctrl.touchEnd(to.x, to.y);
  assert('忽略第二指后仍能正常落子', done, true);
  assert('落子为 54->45', d.game.pos.side, C.BLACK);

  // 13.3 手势结束后控制器不冻结：先被落子动画挡 200ms，落定后可继续操作
  var bp = at(d.layout, 27); // 黑兵
  assert('抬手后仍在播落子动画', d.ctrl.isAnimating(), true);
  assert('动画期间按下被挡', d.ctrl.touchStart(bp.x, bp.y), false);
  d.ctrl.tick(Controller.MOVE_DURATION);
  var r3 = d.ctrl.touchStart(bp.x, bp.y);
  assert('落定后可再次按下', r3, true);
  assert('轮到黑方时可选中黑兵', d.ctrl.selected, 27);
})();

console.log('\n[14] 走子动画：把「正在移动的棋子」交给渲染层');
(function () {
  // 14.1 走子成功即进入动画，棋子从起点滑向终点
  var s = mkController();
  var res = s.ctrl.requestMove(PAWN, PAWN_TO);
  truthy('走子成功', res.ok);
  truthy('走子后进入动画', s.ctrl.isAnimating());
  assert('anim.from', s.ctrl.anim.from, PAWN);
  assert('anim.to', s.ctrl.anim.to, PAWN_TO);
  assert('anim 记录走子棋子', s.ctrl.anim.piece, C.R_PAWN);
  assert('anim 起始进度为 0', s.ctrl.anim.t, 0);
  assert('anim 时长为 MOVE_DURATION', s.ctrl.anim.dur, Controller.MOVE_DURATION);

  // 14.2 动画期间暂停收输入，避免与飞行中的棋子抢状态
  assert('动画期间不可操作', s.ctrl.canOperate(), false);
  var p2 = at(s.layout, 27); // 轮到黑方，但即便轮到自己也应被动画挡住
  assert('动画期间按下被拒', s.ctrl.touchStart(p2.x, p2.y), false);
  assert('动画期间未产生选中', s.ctrl.selected, -1);

  // 14.3 tick 按帧推进进度
  s.ctrl.tick(Controller.MOVE_DURATION / 2);
  approx('半程进度 0.5', s.ctrl.anim.t, 0.5);
  truthy('半程仍在动画中', s.ctrl.isAnimating());

  // 14.4 播完即落定：动画清空、onAnimEnd 触发、恢复操作
  var ended = 0;
  s.ctrl.options.onAnimEnd = function () { ended++; };
  s.ctrl.tick(Controller.MOVE_DURATION / 2);
  assert('播完触发 onAnimEnd 一次', ended, 1);
  assert('播完动画清空', s.ctrl.anim, null);
  assert('播完恢复操作', s.ctrl.canOperate(), true);
  s.ctrl.tick(500);
  assert('播完后再 tick 不重复触发', ended, 1);

  // 14.5 吃子动画携带被吃棋子（渲染层据此在终点格淡出旧子）
  var cap = mkController({ fen: CAPTURE_FEN });
  cap.ctrl.requestMove(ROOK, ROOK_CAPTURE);
  var stc = cap.ctrl.renderState();
  truthy('吃子后进入动画', stc.anim);
  assert('anim 携带被吃棋子', stc.anim.captured, C.B_PAWN);
  assert('anim 携带走子棋子为红车', stc.anim.piece, C.R_ROOK);

  // 14.6 手动播放：AI 与联机对手的着法绕过 controller 落子，需显式喂入着法记录
  var ai = mkController();
  var r2 = ai.game.move(PAWN, PAWN_TO);
  truthy('手动播放返回动画状态', ai.ctrl.playMoveAnim(r2.entry));
  assert('手动播放的起点', ai.ctrl.anim.from, PAWN);
  assert('手动播放的终点', ai.ctrl.anim.to, PAWN_TO);
  assert('手动播放的棋子', ai.ctrl.anim.piece, C.R_PAWN);

  // 14.7 instant：重连/重放时直接落定，不播动画
  var inst = mkController();
  var r3 = inst.game.move(PAWN, PAWN_TO);
  assert('instant 不返回动画', inst.ctrl.playMoveAnim(r3.entry, { instant: true }), null);
  assert('instant 后无动画', inst.ctrl.anim, null);

  // 14.8 异常输入不着动画
  var bad = mkController();
  bad.ctrl.requestMove(PAWN, PAWN + 18); // 非法着法
  assert('非法着法不起动画', bad.ctrl.anim, null);
  var noop = mkController();
  assert('空着法记录不着动画', noop.ctrl.playMoveAnim(null), null);
  assert('原地着法不着动画', noop.ctrl.playMoveAnim({ from: 5, to: 5, piece: 1 }), null);

  // 14.9 finishAnim 立即落定，且不再回调 onAnimEnd
  var fin = mkController();
  fin.ctrl.requestMove(PAWN, PAWN_TO);
  var endCount = 0;
  fin.ctrl.options.onAnimEnd = function () { endCount++; };
  truthy('finishAnim 返回被中断的动画', fin.ctrl.finishAnim());
  assert('finishAnim 后无动画', fin.ctrl.anim, null);
  assert('finishAnim 不触发 onAnimEnd', endCount, 0);
  fin.ctrl.tick(500);
  assert('finishAnim 后再 tick 也不触发', endCount, 0);
})();

console.log('\n[15] 落子余晖：落定后把视线钉在刚落的那枚子上');
(function () {
  // 15.1 初始无余晖
  var s = mkController();
  assert('初始余晖为 0', s.ctrl.land, 0);
  assert('初始不在余晖中', s.ctrl.isLanding(), false);
  assert('导出的余晖时长', Controller.LAND_DURATION, 360);

  // 15.2 动画期间不亮，落定那一刻才满格
  s.ctrl.requestMove(PAWN, PAWN_TO);
  assert('动画期间余晖为 0', s.ctrl.land, 0);
  s.ctrl.tick(Controller.MOVE_DURATION);
  assert('落定即满格余晖', s.ctrl.land, 1);
  truthy('落定后处于余晖中', s.ctrl.isLanding());
  assert('renderState 透传余晖', s.ctrl.renderState().land, 1);

  // 15.3 按帧衰减并归零，不会变负
  s.ctrl.tick(Controller.LAND_DURATION / 2);
  approx('半程衰减到 0.5', s.ctrl.land, 0.5);
  s.ctrl.tick(Controller.LAND_DURATION / 2);
  assert('走完归零', s.ctrl.land, 0);
  assert('归零后不再处于余晖中', s.ctrl.isLanding(), false);
  s.ctrl.tick(5000);
  assert('归零后不再变负', s.ctrl.land, 0);

  // 15.4 余晖只是视觉，不拦输入（拦输入的只有走子动画）
  var i = mkController();
  i.ctrl.requestMove(PAWN, PAWN_TO);
  i.ctrl.tick(Controller.MOVE_DURATION);
  truthy('落定后处于余晖中', i.ctrl.isLanding());
  assert('余晖期间仍可操作', i.ctrl.canOperate(), true);
  var bp = at(i.layout, 27);
  assert('余晖期间可按下', i.ctrl.touchStart(bp.x, bp.y), true);
  assert('余晖期间可选中黑兵', i.ctrl.selected, 27);

  // 15.5 reset / setGame 清空余晖
  var r = mkController();
  r.ctrl.requestMove(PAWN, PAWN_TO);
  r.ctrl.tick(Controller.MOVE_DURATION);
  r.ctrl.reset();
  assert('reset 清空余晖', r.ctrl.land, 0);

  var g = mkController();
  g.ctrl.requestMove(PAWN, PAWN_TO);
  g.ctrl.tick(Controller.MOVE_DURATION);
  g.ctrl.setGame(new Game());
  assert('setGame 清空余晖', g.ctrl.land, 0);
})();

console.log('\n[16] 被威胁的棋子：当前走棋方的子中，对方能吃掉的');
(function () {
  // 黑方走棋。黑马 (0,5)、黑炮 (8,5) 都落在红车 (0,9)/(8,9) 的射程里
  var FEN = '3k5/9/9/9/9/n7c/9/9/9/R3K3R b - - 0 1';
  var s = mkController({ fen: FEN });
  assert('标出两枚被威胁的子', s.ctrl.threats.length, 2);
  assert('含黑马', s.ctrl.threats.indexOf(C.idxOf(0, 5)) >= 0, true);
  assert('含黑炮', s.ctrl.threats.indexOf(C.idxOf(8, 5)) >= 0, true);
  assert('renderState 透传威胁列表', s.ctrl.renderState().threats.length, 2);

  // 走子后轮到对方，威胁列表要跟着换成「标对方的子」
  // 黑马跳到 (1,7) 反咬红车 (0,9)
  s.ctrl.requestMove(C.idxOf(0, 5), C.idxOf(1, 7));
  s.ctrl.finishAnim();
  assert('走子后重算：轮到红方', s.game.pos.side, C.RED);
  assert('  标出红方被威胁的子', s.ctrl.threats.length, 1);
  assert('  正是那辆红车', s.ctrl.threats[0], C.idxOf(0, 9));

  // reset（悔棋 / 换局走的就是它）也要重算
  var s2 = mkController({ fen: FEN });
  assert('换局后标出两枚', s2.ctrl.threats.length, 2);
  s2.ctrl.reset();
  assert('reset 后仍标出两枚（局面没变）', s2.ctrl.threats.length, 2);

  // 开局就标出 2 枚：黑炮 (1,2) 隔着红炮 (1,7) 能打到红马 (1,9)，另一侧同理。
  // 这不是误报——「能被吃就算」这条判据的应有之义，长射也算。
  var open = mkController();
  assert('开局标出两枚（黑炮隔红炮盯着红马）', open.ctrl.threats.length, 2);
  assert('  含红马 (1,9)', open.ctrl.threats.indexOf(C.idxOf(1, 9)) >= 0, true);
  assert('  含红马 (7,9)', open.ctrl.threats.indexOf(C.idxOf(7, 9)) >= 0, true);

  // 终局之后不再标
  var over = mkController({ fen: FEN });
  over.game.finish(C.RED, '认输');
  over.ctrl.refreshThreats();
  assert('终局后不标威胁', over.ctrl.threats.length, 0);

  // 判据是「有合法吃子能落到它身上」，**不做得失过滤**：
  // 下面这局黑马 (0,5) 有黑车 (0,0) 保着，红炮吃它是等价交换，照样标出来
  var defended = mkController({ fen: 'r3k4/9/9/9/9/n8/9/P8/9/C4K3 b - - 0 1' });
  assert('有根、等价交换也照样标（不替玩家判断值不值）',
    defended.ctrl.threats.length, 1);
  assert('  正是那匹马', defended.ctrl.threats[0], C.idxOf(0, 5));

  // 只标「能被吃到的子」，不标「能走到的空格」
  s.ctrl.threats.forEach(function (idx) {
    assert('  威胁项都是棋子（非空格）', s.game.pos.board[idx] !== C.EMPTY, true);
  });
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m交互控制器测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m交互控制器全部测试通过\x1b[0m\n');
