/**
 * 绝杀演出测试（node scripts/test-endgame.js）
 *
 * 演出是纯 Canvas 绘制 + 一条时间线，用桩上下文把每帧的绘图调用记下来，
 * 就能验证：时间线各阶段该出现什么、11 种杀法的母题各自画在正确的位置、
 * 跳过与按钮命中的交互约定。
 *
 * 母题「画对位置」是最要紧的一条——演出画错位置比不画更糟，
 * 所以对每种杀法都断言母题的第一笔落在预期的关键子上。
 */

var Position = require('../miniprogram/core/position.js');
var C = require('../miniprogram/core/constants.js');
var Mate = require('../miniprogram/core/mate.js');
var Layout = require('../miniprogram/ui/layout.js');
var Endgame = require('../miniprogram/ui/endgame.js');

var CASES = require('./fixtures/mate-cases.js');

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
function truthy(name, v) { assert(name, !!v, true); }
function approx(name, actual, expected, eps) {
  var ok = Math.abs(actual - expected) <= (eps || 0.01);
  if (ok) { passed++; console.log('  \x1b[32mPASS\x1b[0m  ' + name + ' ≈ ' + expected); }
  else {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name + ' 期望 ≈' + expected + '，实际 ' + actual);
  }
}

// ---------------------------------------------------------------------------
// 桩 Canvas 上下文
// ---------------------------------------------------------------------------

function createStubContext() {
  var calls = {
    moveTo: [], lineTo: [], arc: [], fillText: [],
    fillRect: [], fill: 0, stroke: 0, translate: 0
  };
  var ctx = {
    calls: calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textAlign: '', textBaseline: '', globalAlpha: 1, lineCap: '',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    clearRect: function () {},
    fillRect: function (x, y, w, h) { calls.fillRect.push([x, y, w, h, ctx.globalAlpha]); },
    strokeRect: function () {},
    beginPath: function () {}, closePath: function () {},
    moveTo: function (x, y) { calls.moveTo.push([x, y]); },
    lineTo: function (x, y) { calls.lineTo.push([x, y]); },
    arc: function (x, y, r) { calls.arc.push([x, y, r]); },
    arcTo: function () {},
    stroke: function () { calls.stroke++; },
    fill: function () { calls.fill++; },
    save: function () {}, restore: function () {},
    scale: function () {}, rotate: function () {},
    translate: function () { calls.translate++; },
    fillText: function (t, x, y) { calls.fillText.push([t, x, y]); },
    measureText: function (t) { return { width: String(t).length * 13 }; },
    createLinearGradient: function () { return { addColorStop: function () {} }; },
    createRadialGradient: function () { return { addColorStop: function () {} }; }
  };
  return ctx;
}

var W = 375;
var H = 700;
var BX = 30;
var BY = 60;
var T = Endgame.TIMELINE;

var L = new Layout(W, false);

/** 用真实杀局构造一份 result */
function resultOf(fen) {
  var pos = new Position(fen);
  var atk = 1 - pos.side;
  var info = Mate.classifyMate(pos, atk);
  return {
    pos: pos,
    result: { winner: atk, reason: '将死', mate: info.name, mateKey: info.key, mateInfo: info }
  };
}

function drawAt(eg, t) {
  eg.t = t;
  var ctx = createStubContext();
  eg.draw(ctx, W, H, BX, BY);
  return ctx;
}

/**
 * 落款区的文字
 *
 * 高亮棋子自己也会 fillText（棋子名），所以不能拿 fillText 总数当落款——
 * 落款文字都在卡片里，按「落在卡片纵向范围内」筛出来。
 */
function cardTexts(ctx) {
  var cardTop = (H - 158) / 2;
  return ctx.calls.fillText.filter(function (t) { return t[2] >= cardTop - 10; });
}

// ---------------------------------------------------------------------------
console.log('\n[1] 生命周期与时间线');
(function () {
  var eg = new Endgame();
  assert('初始未激活', eg.isActive(), false);

  var r = resultOf(CASES[0].fen);
  eg.start(r.result, { board: r.pos.board, layout: L, win: true });
  assert('start 后激活', eg.isActive(), true);
  assert('起点 t=0', eg.t, 0);
  assert('起点未播完', eg.isDone(), false);
  assert('起点按钮未浮现', eg.buttonsLive(), false);

  eg.tick(500);
  assert('tick 推进', eg.t, 500);
  eg.tick(100000);
  assert('tick 封顶在结束时刻', eg.t, T.END);
  assert('播完后 isDone', eg.isDone(), true);

  eg.reset();
  assert('reset 收起', eg.isActive(), false);
  assert('reset 归零', eg.t, 0);

  var eg2 = new Endgame();
  eg2.start(r.result, { board: r.pos.board, layout: L });
  eg2.tick(200);
  assert('跳过返回 true', eg2.skip(), true);
  assert('跳过即到末态', eg2.t, T.END);
  assert('跳过时按钮可点', eg2.buttonsLive(), true);
})();

// ---------------------------------------------------------------------------
console.log('\n[2] 三拍：各阶段该画什么');
(function () {
  var r = resultOf(CASES[0].fen);
  var eg = new Endgame();
  eg.start(r.result, { board: r.pos.board, layout: L, win: true });

  // 起点：暗场还没铺开，也还没有落款
  var c0 = drawAt(eg, 0);
  assert('起点暗场透明度为 0', c0.calls.fillRect[0][4], 0);
  assert('起点无落款文字', c0.calls.fillText.length, 0);

  // 压暗结束：暗场到满。注意此时已有文字——那是被高亮的棋子本身
  var c1 = drawAt(eg, T.DIM);
  approx('压暗到位后透明度 0.62', c1.calls.fillRect[0][4], 0.62, 0.01);
  assert('压暗阶段还没画母题', c1.calls.moveTo.length, 0);
  assert('压暗阶段还没落款', cardTexts(c1).length, 0);
  truthy('压暗阶段已浮出高亮棋子', c1.calls.fillText.length > 0);

  // 演示中：母题在画，落款还没出
  var c2 = drawAt(eg, (T.DIM + T.SHOW) / 2);
  truthy('演示阶段画出了将军线', c2.calls.moveTo.length > 0);
  assert('演示阶段仍无落款', cardTexts(c2).length, 0);

  // 落款完成：标题、胜负、按钮都出来了
  var c3 = drawAt(eg, T.END);
  var texts = c3.calls.fillText.map(function (t) { return t[0]; });
  truthy('落款出现杀法名', texts.indexOf('马后炮') >= 0);
  truthy('落款出现胜负', texts.indexOf('红方胜') >= 0);
  truthy('出现「再来一局」按钮', texts.indexOf('再来一局') >= 0);
  truthy('出现「回菜单」按钮', texts.indexOf('回菜单') >= 0);
})();

// ---------------------------------------------------------------------------
console.log('\n[3] 11 种杀法的母题各自画在正确的位置');
(function () {
  /** 母题的第一笔应该从哪一枚棋子出发 */
  function motifStart(info) {
    // 将帅照面没有将军子、二鬼拍门从兵出发，其余都从将军子出发
    if (info.key === 'duimianxiao' || info.key === 'erguipaimen') {
      return info.pieces[0];
    }
    return info.checker;
  }

  CASES.forEach(function (cs) {
    var r = resultOf(cs.fen);
    var info = r.result.mateInfo;
    truthy(cs.name + ' · 识别出几何', info);

    var eg = new Endgame();
    eg.start(r.result, { board: r.pos.board, layout: L, win: true });
    var ctx = drawAt(eg, (T.DIM + T.SHOW) / 2);

    assert(cs.name + ' · 落款标题', eg.title(), cs.name);
    truthy(cs.name + ' · 母题画了线', ctx.calls.moveTo.length > 0);

    var want = motifStart(info);
    // 容差半格多：有的母题第一笔不是格心（如铁门栓画的是门闩的左端）。
    // 但错格至少偏一格、坐标算错则是 NaN，都会被这条逮住。
    var tol = L.cell * 0.6;
    approx(cs.name + ' · 母题起点落在关键子附近 x', ctx.calls.moveTo[0][0], L.xOf(want), tol);
    approx(cs.name + ' · 母题起点落在关键子附近 y', ctx.calls.moveTo[0][1], L.yOf(want), tol);
  });
})();

// ---------------------------------------------------------------------------
console.log('\n[4] 母题的分支差异');
(function () {
  function linesAt(key) {
    var cs = CASES.filter(function (c) { return c.key === key; })[0];
    var r = resultOf(cs.fen);
    var eg = new Endgame();
    eg.start(r.result, { board: r.pos.board, layout: L, win: true });
    return drawAt(eg, T.SHOW).calls.lineTo.length;
  }

  // 双车错画两条线（一车一条），单线的杀法只有一条
  assert('双车错画两条线', linesAt('shuangchecuo'), 4);
  assert('马后炮画一条线', linesAt('mahoupao'), 2);
  assert('卧槽马画一条线（日字拆两段，但同一时刻只画一段）', linesAt('wocaoma') >= 2, true);

  // 闷系除了将军线还要合拢一个框（框是 4 段），所以线数明显更多
  truthy('闷宫比马后炮多出合拢框', linesAt('mengong') > linesAt('mahoupao'));
})();

// ---------------------------------------------------------------------------
console.log('\n[4.5] 动作层：炮弹 / 马跃 / 车冲 / 将震颤');
(function () {
  function caseOf(key) {
    return CASES.filter(function (c) { return c.key === key; })[0];
  }
  /** 按演示进度 p（0~1）取一帧 */
  function drawAtP(eg, p) {
    return drawAt(eg, T.DIM + p * (T.SHOW - T.DIM));
  }
  function startOf(key) {
    var r = resultOf(caseOf(key).fen);
    var eg = new Endgame();
    eg.start(r.result, { board: r.pos.board, layout: L, win: true });
    return { eg: eg, r: r, info: r.result.mateInfo };
  }
  /** 距 (x,y) tol 内的 arc 数 */
  function arcsNear(ctx, x, y, tol) {
    return ctx.calls.arc.filter(function (a) {
      return Math.abs(a[0] - x) < tol && Math.abs(a[1] - y) < tol;
    }).length;
  }
  /** 指定文字的 fillText 记录 */
  function textsOf(ctx, ch) {
    return ctx.calls.fillText.filter(function (t) { return t[0] === ch; });
  }

  // —— 炮系：火球沿将军线飞行 ——
  var m = startOf('mahoupao');
  var a = L.pointOf(m.info.checker);
  var b = L.pointOf(m.info.king);
  var ctxF = drawAtP(m.eg, 0.4);
  // p=0.4 → q=0.714 → fly≈0.651，火球应在炮与将之间 65% 处
  var fly = (0.4 / 0.56 - 0.18) / 0.82;
  var shellX = a.x + (b.x - a.x) * fly;
  var shellY = a.y + (b.y - a.y) * fly;
  truthy('马后炮 · 火球飞在炮与将之间', arcsNear(ctxF, shellX, shellY, L.cell * 0.45) >= 1);

  // —— 命中爆点：命中窗内将附近 arc 明显增多 ——
  var early = drawAtP(m.eg, 0.3);
  var hit = drawAtP(m.eg, 0.7);
  var nEarly = arcsNear(early, b.x, b.y, L.cell * 1.0);
  var nHit = arcsNear(hit, b.x, b.y, L.cell * 1.0);
  truthy('马后炮 · 命中窗将附近爆点增多（' + nEarly + '→' + nHit + '）', nHit > nEarly);

  // —— 将震颤：命中窗内将偏离格心，窗外回正 ——
  var kingChar = null;
  ['將', '帥'].forEach(function (ch) {
    if (textsOf(hit, ch).length) kingChar = ch;
  });
  truthy('找到被将的将', kingChar !== null);
  var tHit = textsOf(hit, kingChar).filter(function (t) {
    return Math.abs(t[2] - b.y) < L.cell * 0.5;
  });
  truthy('命中窗将偏离格心（震颤）', tHit.length > 0 && Math.abs(tHit[0][1] - b.x) > 0.5);
  var calmCtx = drawAtP(m.eg, 0.3);
  var tCalm = textsOf(calmCtx, kingChar).filter(function (t) {
    return Math.abs(t[2] - b.y) < L.cell * 0.5;
  });
  approx('未命中时将端坐在格心', tCalm.length ? Math.abs(tCalm[0][1] - b.x) : 99, 0, 0.01);

  // —— 重炮：两发炮弹错拍，一发炸一发飞 ——
  var c2 = startOf('chongpao');
  var ctxC = drawAtP(c2.eg, 0.6);
  var ck = L.pointOf(c2.info.king);
  truthy('重炮 · 第一发已炸（将旁爆点）', arcsNear(ctxC, ck.x, ck.y, L.cell * 1.0) >= 1);
  // 第二发 q=0.786 fly≈0.738，从后炮（screen）飞出
  var back = L.pointOf(c2.info.screen);
  var fly2 = ((0.6 - 0.16) / 0.56 - 0.18) / 0.82;
  truthy('重炮 · 第二发飞行中', arcsNear(ctxC,
    back.x + (ck.x - back.x) * fly2, back.y + (ck.y - back.y) * fly2, L.cell * 0.45) >= 1);

  // —— 马系：跃迁中原位无马、残影+本体多匹 ——
  var kn = startOf('wocaoma');
  var checker = kn.info.checker;
  var ctxK = drawAtP(kn.eg, 0.5);
  var horses = textsOf(ctxK, '傌');
  truthy('卧槽马 · 残影与本体多于一匹', horses.length >= 2);
  var atHome = horses.filter(function (t) {
    return Math.abs(t[1] - L.xOf(checker)) < 0.01 && Math.abs(t[2] - L.yOf(checker)) < L.pieceRadius * 0.12;
  });
  assert('卧槽马 · 跃迁中原位无马', atHome.length, 0);
  var ctxK0 = drawAtP(kn.eg, 0);
  var home0 = textsOf(ctxK0, '傌').filter(function (t) {
    return Math.abs(t[1] - L.xOf(checker)) < 0.01;
  });
  assert('卧槽马 · 起播时马在原位', home0.length, 1);

  // —— 车系：冲锋中车离原格、速度线让笔画增多 ——
  var rk = startOf('shuangchecuo');
  var ctxR = drawAtP(rk.eg, 0.35);
  var rooks = textsOf(ctxR, '車');
  var homeCount = rooks.filter(function (t) {
    return rk.info.pieces.some(function (idx) {
      return Math.abs(t[1] - L.xOf(idx)) < 0.01 && Math.abs(t[2] - L.yOf(idx)) < L.pieceRadius * 0.12;
    });
  }).length;
  assert('双车错 · 冲锋中车都不在原格', homeCount, 0);
  var stillCtx = drawAtP(rk.eg, 1.0);
  truthy('双车错 · 冲锋速度线让笔画多于静止帧（' +
    ctxR.calls.lineTo.length + ' vs ' + stillCtx.calls.lineTo.length + '）',
    ctxR.calls.lineTo.length > stillCtx.calls.lineTo.length);
})();

// ---------------------------------------------------------------------------
console.log('\n[5] 结算卡与按钮');
(function () {
  var r = resultOf(CASES[0].fen);

  var eg = new Endgame();
  eg.start(r.result, { board: r.pos.board, layout: L, win: true });
  var btns = eg.layoutButtons(W, H);
  assert('人机/本地三个按钮', btns.map(function (b) { return b.id; }).join(','), 'replay,again,menu');
  truthy('按钮落在卡片内', btns[0].x > eg.cardRect(W, H).x);
  assert('相邻按钮不重叠', btns[1].x > btns[0].x + btns[0].w && btns[2].x > btns[1].x + btns[1].w, true);

  // 按钮未浮现时点按不算命中（只当作跳过）
  eg.t = T.SHOW;
  assert('未浮现时点按钮不算命中', eg.hitButtonAt(btns[0].x + 4, btns[0].y + 4), null);
  eg.t = T.END;
  assert('浮现后命中「复盘」', eg.hitButtonAt(btns[0].x + 4, btns[0].y + 4), 'replay');
  assert('浮现后命中「再来一局」', eg.hitButtonAt(btns[1].x + 4, btns[1].y + 4), 'again');
  assert('浮现后命中「回菜单」', eg.hitButtonAt(btns[2].x + 4, btns[2].y + 4), 'menu');
  assert('卡片外不算命中', eg.hitButtonAt(btns[0].x - 20, btns[0].y), null);
  assert('收起后不响应命中', (function () { eg.reset(); return eg.hitButtonAt(btns[0].x + 4, btns[0].y + 4); })(), null);

  // 联机不可重开 -> 复盘 + 回菜单
  var eg2 = new Endgame();
  eg2.start(r.result, { board: r.pos.board, layout: L, online: true });
  assert('联机两个按钮', eg2.layoutButtons(W, H).map(function (b) { return b.id; }).join(','), 'replay,menu');

  // 胜负文案
  var eg3 = new Endgame();
  eg3.start({ winner: C.BLACK, reason: '将死' }, { layout: L });
  assert('黑方胜文案', eg3.subtitle(), '黑方胜');
  assert('和棋文案', (function () { eg3.result = { winner: -1 }; return eg3.subtitle(); })(), '和棋');
})();

// ---------------------------------------------------------------------------
console.log('\n[6] 没有杀法名时的兜底');
(function () {
  var eg = new Endgame();
  eg.start({ winner: C.RED, reason: '认输' }, { layout: L, board: new Position().board });
  var ctx = drawAt(eg, T.END);

  assert('无杀法时标题用终局原因', eg.title(), '认输');
  // 高亮棋子与母题脉动都用 arc；卡片圆角走 arcTo，所以 arc 为 0 就说明棋盘那一层没画
  assert('无杀法时不画棋盘层（高亮与母题）', ctx.calls.arc.length, 0);
  var texts = ctx.calls.fillText.map(function (t) { return t[0]; });
  truthy('仍然落款', texts.indexOf('认输') >= 0);
  truthy('仍然给按钮', texts.indexOf('再来一局') >= 0);

  // 将死但认不出杀法：标题写「绝杀」，不硬套名字
  var eg2 = new Endgame();
  eg2.start({ winner: C.RED, reason: '将死' }, { layout: L, board: new Position().board });
  assert('认不出杀法时标题为绝杀', eg2.title(), '绝杀');

  // 完全没有 result 也不能崩
  var eg3 = new Endgame();
  eg3.start(null, { layout: L });
  var threw = null;
  try { drawAt(eg3, T.END); } catch (e) { threw = e.message; }
  assert('无 result 不抛异常', threw, null);
  assert('无 result 时标题兜底', eg3.title(), '对局结束');
})();

// ---------------------------------------------------------------------------
console.log('\n[7] 缺布局/棋盘时不崩');
(function () {
  var r = resultOf(CASES[0].fen);
  var eg = new Endgame();
  eg.start(r.result, {});   // 没给 layout / board
  var threw = null;
  var ctx = null;
  try { ctx = drawAt(eg, T.END); } catch (e) { threw = e.message; }
  assert('缺 layout/board 不抛异常', threw, null);
  truthy('仍画出落款', ctx && ctx.calls.fillText.length > 0);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m绝杀演出测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m绝杀演出全部测试通过\x1b[0m\n');
