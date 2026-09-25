/**
 * 布局与渲染器测试（node scripts/test-ui.js）
 *
 * 用桩 Canvas 上下文记录全部绘图调用，从而在 node 下验证：
 *   坐标换算与翻转、触摸命中、棋盘线型与标记数量、棋子文字、覆盖层。
 */

var Layout = require('../miniprogram/ui/layout.js');
var R = require('../miniprogram/ui/renderer.js');
var Position = require('../miniprogram/core/position.js');
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
  var ok = Math.abs(actual - expected) <= (eps || 0.01);
  if (ok) {
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m  ' + name + ' ≈ ' + expected);
  } else {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name +
      ' 期望 ≈' + expected + '，实际 ' + actual);
  }
}

// ---------------------------------------------------------------------------
// 桩 Canvas 2D 上下文
// ---------------------------------------------------------------------------

function gradientStub() {
  return { stops: [], addColorStop: function (o, c) { this.stops.push([o, c]); } };
}

function createStubContext() {
  var calls = {
    clearRect: [], fillRect: [], strokeRect: [],
    moveTo: [], lineTo: [], arc: [], fillText: [],
    beginPath: 0, stroke: 0, fill: 0, save: 0, restore: 0,
    gradients: 0, fonts: [], alphas: [],
    gradientsSpec: [],
    order: []
  };

  function recordGradient() {
    var g = gradientStub();
    calls.gradientsSpec.push(g);
    return g;
  }

  var ctx = {
    calls: calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textAlign: '', textBaseline: '', globalAlpha: 1, lineCap: '',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,

    clearRect: function () { calls.clearRect.push([].slice.call(arguments)); },
    fillRect: function () { calls.fillRect.push([].slice.call(arguments)); },
    strokeRect: function () { calls.strokeRect.push([].slice.call(arguments)); },
    beginPath: function () { calls.beginPath++; },
    closePath: function () {},
    moveTo: function (x, y) { calls.moveTo.push([x, y]); calls.order.push('moveTo'); },
    lineTo: function (x, y) { calls.lineTo.push([x, y]); },
    arc: function (x, y, r) { calls.arc.push([x, y, r]); calls.order.push('arc'); },
    stroke: function () { calls.stroke++; },
    fill: function () { calls.fill++; },
    save: function () { calls.save++; },
    restore: function () { calls.restore++; },
    translate: function () {},
    rotate: function () {},
    scale: function () {},
    fillText: function (t, x, y) {
      calls.fillText.push([t, x, y]);
      calls.fonts.push(ctx.font);
      calls.alphas.push(ctx.globalAlpha);
      calls.order.push('fillText');
    },
    createLinearGradient: function () { calls.gradients++; return recordGradient(); },
    createRadialGradient: function () { calls.gradients++; return recordGradient(); }
  };
  return ctx;
}

/** 只统计棋子文字（单字，不含空格的楚河汉界标题） */
function pieceTexts(calls) {
  return calls.fillText.filter(function (t) { return t[0].indexOf(' ') < 0; });
}

/** 棋子文字在 fillText 序列中的下标（与 pieceTexts 对应） */
function pieceIndices(calls) {
  var out = [];
  for (var i = 0; i < calls.fillText.length; i++) {
    if (calls.fillText[i][0].indexOf(' ') < 0) out.push(i);
  }
  return out;
}

/**
 * 棋子文字是否落在某个交叉点上
 *
 * 棋面文字相对圆心下移 r*0.05，而动画中的棋子会缩放，故 y 用容差判定
 * （容差远小于一个格距，不会误判到相邻交叉点）。
 */
function pieceAtSquare(text, L, idx) {
  return Math.abs(text[1] - L.xOf(idx)) < 0.01 &&
    Math.abs(text[2] - L.yOf(idx)) < L.pieceRadius * 0.25;
}

/** 某坐标上棋子的外圈半径（该处没画棋子时返回 null） */
function radiusAt(calls, x, y) {
  for (var i = 0; i < calls.arc.length; i++) {
    if (Math.abs(calls.arc[i][0] - x) < 0.01 && Math.abs(calls.arc[i][1] - y) < 0.01) {
      return calls.arc[i][2];
    }
  }
  return null;
}

/** 某交叉点上棋子的外圈半径 */
function radiusAtSquare(calls, L, idx) {
  return radiusAt(calls, L.xOf(idx), L.yOf(idx));
}

/**
 * 一组角标点相对某格中心的「最远伸展」与「最近净空」，单位均为格距
 *
 * 角标由 4 个象限的 L 形折线构成：每象限 1 次 moveTo（内折点）+ 2 次 lineTo。
 * 最近净空 < 棋子半径（0.44 格距）就意味着角标会被棋子整块盖住。
 */
function markExtent(points, L, idx) {
  var x = L.xOf(idx);
  var y = L.yOf(idx);
  var max = 0;
  var min = Infinity;
  for (var i = 0; i < points.length; i++) {
    var dx = points[i][0] - x;
    var dy = points[i][1] - y;
    max = Math.max(max, Math.abs(dx), Math.abs(dy));
    min = Math.min(min, Math.sqrt(dx * dx + dy * dy));
  }
  return { reach: max / L.cell, clear: min / L.cell };
}

/** 第 n 次（0 起）某类调用在调用顺序日志中的位置，用于验证绘制层级 */
function orderIndexOf(calls, tag, n) {
  var seen = -1;
  for (var i = 0; i < calls.order.length; i++) {
    if (calls.order[i] !== tag) continue;
    seen++;
    if (seen === n) return i;
  }
  return -1;
}

console.log('\n[1] 布局尺寸自洽');
(function () {
  var L = new Layout(375);
  var expectedCell = 375 / (C.FILES - 1 + Layout.PADDING_RATIO * 2);
  approx('格距', L.cell, expectedCell);
  approx('留白', L.padding, expectedCell * Layout.PADDING_RATIO);
  approx('画布高度', L.height, expectedCell * (C.RANKS - 1) + expectedCell * Layout.PADDING_RATIO * 2);
  approx('宽度 = 8 格距 + 两侧留白', L.padding * 2 + L.cell * (C.FILES - 1), 375);
  assert('棋子半径不超过半格（避免重叠）', L.pieceRadius < L.cell / 2, true);
  assert('命中半径大于半格（便于触摸）', L.hitRadius > L.cell / 2, true);
  assert('size() 与字段一致', L.size().width === L.width && L.size().height === L.height, true);

  L.resize(320);
  approx('resize 后宽度', L.width, 320);
  approx('resize 后格距', L.cell, 320 / (C.FILES - 1 + Layout.PADDING_RATIO * 2));

  var tiny = new Layout(0);
  assert('非法宽度不会得到 0 格距', tiny.cell > 0, true);
})();

console.log('\n[2] 坐标换算：红方视角（红在下）');
(function () {
  var L = new Layout(375, false);
  var roundTrip = true;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    if (L.hitTest(L.xOf(i), L.yOf(i)) !== i) { roundTrip = false; break; }
  }
  assert('全部 90 个交叉点坐标往返一致', roundTrip, true);

  assert('rank 0（黑方底线）在屏幕上方',
    L.yOf(C.idxOf(4, 0)) < L.yOf(C.idxOf(4, 9)), true);
  assert('file 0 在屏幕左侧',
    L.xOf(C.idxOf(0, 4)) < L.xOf(C.idxOf(8, 4)), true);
  assert('红帅初始位于屏幕下方', L.yOf(C.idxOf(4, 9)) > L.height / 2, true);
  assert('黑将初始位于屏幕上方', L.yOf(C.idxOf(4, 0)) < L.height / 2, true);

  var p = L.pointOf(C.idxOf(4, 9));
  assert('pointOf 与 xOf/yOf 一致', p.x === L.xOf(C.idxOf(4, 9)) && p.y === L.yOf(C.idxOf(4, 9)), true);

  var rect = L.rectOf(C.idxOf(4, 4));
  approx('rectOf 以交叉点为中心', rect.x + rect.w / 2, L.xOf(C.idxOf(4, 4)));
  assert('rectOf 默认边长为一个格距', rect.w, L.cell);

  assert('setFlipped 返回自身便于链式调用', L.setFlipped(false) === L, true);
  assert('画布内判定', L.contains(L.width / 2, L.height / 2), true);
  assert('画布外判定', L.contains(-1, L.height / 2), false);
})();

console.log('\n[3] 坐标换算：黑方视角（翻转）');
(function () {
  var L = new Layout(375, true);
  var roundTrip = true;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    if (L.hitTest(L.xOf(i), L.yOf(i)) !== i) { roundTrip = false; break; }
  }
  assert('翻转后全部交叉点坐标往返一致', roundTrip, true);

  assert('翻转后 rank 0（黑方底线）在屏幕下方',
    L.yOf(C.idxOf(4, 0)) > L.yOf(C.idxOf(4, 9)), true);
  assert('翻转后 file 0 在屏幕右侧',
    L.xOf(C.idxOf(0, 4)) > L.xOf(C.idxOf(8, 4)), true);
  assert('黑将位于屏幕下方', L.yOf(C.idxOf(4, 0)) > L.height / 2, true);

  // 翻转等价于把 file 与 rank 同时镜像
  var base = new Layout(375, false);
  var mirrored = true;
  for (i = 0; i < C.BOARD_SIZE; i++) {
    var fx = C.idxOf(C.FILES - 1 - C.fileOf(i), C.rankOf(i));
    var fy = C.idxOf(C.fileOf(i), C.RANKS - 1 - C.rankOf(i));
    if (Math.abs(L.xOf(i) - base.xOf(fx)) > 1e-9) { mirrored = false; break; }
    if (Math.abs(L.yOf(i) - base.yOf(fy)) > 1e-9) { mirrored = false; break; }
  }
  assert('翻转等价于 file 与 rank 同时镜像', mirrored, true);
  approx('翻转后 rank 0 的 y 等于未翻转 rank 9 的 y',
    L.yOf(C.idxOf(4, 0)), base.yOf(C.idxOf(4, 9)));
})();

console.log('\n[4] 触摸命中判定');
(function () {
  var L = new Layout(375, false);
  var center = C.idxOf(4, 4);
  var cx = L.xOf(center);
  var cy = L.yOf(center);

  assert('精确命中中心', L.hitTest(cx, cy), center);
  assert('轻微偏移仍命中', L.hitTest(cx + L.cell * 0.2, cy - L.cell * 0.15), center);
  // 偏移 0.9 格时，最近的交叉点已是相邻点，因此命中相邻点才是正确行为
  assert('大偏移归入相邻交叉点', L.hitTest(cx + L.cell * 0.9, cy), C.idxOf(5, 4));
  // 四个交叉点围成的正中心离最近点为 0.707 格，超出命中半径
  assert('四叉正中心不命中任何点', L.hitTest(cx + L.cell * 0.5, cy + L.cell * 0.5), -1);
  assert('棋盘外不命中', L.hitTest(-50, -50), -1);
  assert('画布右下角外不命中', L.hitTest(L.width + 50, L.height + 50), -1);
  assert('留白区边缘不命中', L.hitTest(2, 2), -1);
  assert('非数字输入不命中', L.hitTest('a', 'b'), -1);
  assert('undefined 输入不命中', L.hitTest(undefined, undefined), -1);
  assert('NaN 输入不命中', L.hitTest(NaN, NaN), -1);
  assert('Infinity 输入不命中', L.hitTest(Infinity, 0), -1);

  // 随机撒点：命中结果必须等于最近交叉点（或落在容差外）
  var mismatch = 0;
  for (var t = 0; t < 2000; t++) {
    var x = Math.random() * L.width;
    var y = Math.random() * L.height;
    var hit = L.hitTest(x, y);
    if (hit < 0) continue;
    var dx = x - L.xOf(hit);
    var dy = y - L.yOf(hit);
    if (dx * dx + dy * dy > L.hitRadius * L.hitRadius + 1e-9) mismatch++;
    // 命中点必须是最近的交叉点
    for (var i = 0; i < C.BOARD_SIZE; i++) {
      var ex = x - L.xOf(i);
      var ey = y - L.yOf(i);
      if (ex * ex + ey * ey < dx * dx + dy * dy - 1e-9) { mismatch++; break; }
    }
  }
  assert('随机撒点命中结果均为最近交叉点', mismatch, 0);
})();

console.log('\n[5] 渲染初始局面：棋子文字完整');
(function () {
  var L = new Layout(375, false);
  var ctx = createStubContext();
  var pos = new Position();

  R.draw(ctx, L, { board: pos.board, selected: -1, targets: [], checkIdx: -1 });

  var calls = ctx.calls;
  assert('先清空画布', calls.clearRect.length, 1);
  assert('棋子 + 楚河汉界共 34 次文字绘制', calls.fillText.length, 34);

  var texts = pieceTexts(calls).map(function (t) { return t[0]; });
  assert('绘制了 32 枚棋子', texts.length, 32);

  var expect = ['帥', '仕', '仕', '相', '相', '傌', '傌', '俥', '俥', '炮', '炮',
    '兵', '兵', '兵', '兵', '兵',
    '將', '士', '士', '象', '象', '傌', '傌', '車', '車', '砲', '砲',
    '卒', '卒', '卒', '卒', '卒'];
  var sortedActual = texts.slice(0).sort();
  var sortedExpect = expect.slice(0).sort();
  assert('棋子文字集合与初始局面一致', sortedActual.join(''), sortedExpect.join(''));

  // 每枚棋子文字必须落在其交叉点上
  var misplaced = 0;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    if (pos.board[i] === C.EMPTY) continue;
    var found = calls.fillText.some(function (t) {
      return t[0] === C.PIECE_NAMES[pos.board[i]] &&
        Math.abs(t[1] - L.xOf(i)) < 0.01 &&
        Math.abs(t[2] - L.yOf(i) - L.pieceRadius * 0.05) < 0.01;
    });
    if (!found) misplaced++;
  }
  assert('每枚棋子绘制在正确交叉点', misplaced, 0);
  assert('save/restore 配对', calls.save, calls.restore);
})();

console.log('\n[6] 翻转视角下棋子位置随之镜像');
(function () {
  var normal = new Layout(375, false);
  var flipped = new Layout(375, true);
  var pos = new Position();

  var ctxA = createStubContext();
  var ctxB = createStubContext();
  R.draw(ctxA, normal, { board: pos.board });
  R.draw(ctxB, flipped, { board: pos.board });

  var idx = C.idxOf(4, 9);   // 红帅
  var findText = function (calls, ch) {
    return calls.fillText.filter(function (t) { return t[0] === ch; });
  };
  var kings = findText(ctxB.calls, '帥');
  assert('翻转后仅一枚帅', kings.length, 1);
  approx('翻转后帅的横坐标不变（同列）', kings[0][1], flipped.xOf(idx), 0.01);
  approx('翻转后帅移到屏幕上方', kings[0][2], flipped.yOf(idx) + flipped.pieceRadius * 0.05, 0.01);
  assert('翻转后帅确实在上半屏', kings[0][2] < flipped.height / 2, true);

  // 未翻转时帅在下半屏
  var kingsA = findText(ctxA.calls, '帥');
  assert('未翻转时帅在下半屏', kingsA[0][2] > normal.height / 2, true);
})();

console.log('\n[7] 棋盘线型：网格与九宫');
(function () {
  var L = new Layout(375, false);
  var ctx = createStubContext();
  R.drawGrid(ctx, L);
  // 横线 10 条 + 纵线（2 条贯通 + 7 条各断为 2 段）= 10 + 16 = 26 段
  assert('网格线段数 = 10 横 + 16 纵', ctx.calls.moveTo.length, 26);
  assert('网格线段数与 lineTo 一致', ctx.calls.lineTo.length, 26);
  assert('网格只描边一次', ctx.calls.stroke, 1);

  var ctx2 = createStubContext();
  R.drawPalaces(ctx2, L);
  assert('九宫斜线共 4 条', ctx2.calls.moveTo.length, 4);

  var ctx3 = createStubContext();
  R.drawMarks(ctx3, L);
  // 14 个标记点，其中 4 个位于屏幕左右边缘只画 2 个象限
  // 非边缘点 10 个 × 4 象限 × 2 线 = 80；边缘点 4 个 × 2 象限 × 2 线 = 16
  assert('准星线段数 = 80 + 16', ctx3.calls.moveTo.length, 96);

  var ctx4 = createStubContext();
  R.drawMarks(ctx4, new Layout(375, true));
  assert('翻转后准星线段数不变（左右对称）', ctx4.calls.moveTo.length, 96);

  var ctx5 = createStubContext();
  R.drawBackground(ctx5, L);
  assert('背景填充一次', ctx5.calls.fillRect.length, 1);
  assert('背景外框描边一次', ctx5.calls.strokeRect.length, 1);
  assert('背景使用渐变', ctx5.calls.gradients > 0, true);
  assert('背景覆盖整个画布',
    ctx5.calls.fillRect[0][2] === L.width && ctx5.calls.fillRect[0][3] === L.height, true);

  var ctx6 = createStubContext();
  R.drawRiver(ctx6, L);
  assert('楚河汉界两次文字', ctx6.calls.fillText.length, 2);
  assert('楚河在左半屏', ctx6.calls.fillText[0][1] < L.width / 2, true);
  assert('汉界在右半屏', ctx6.calls.fillText[1][1] > L.width / 2, true);
  approx('文字位于楚河中线',
    ctx6.calls.fillText[0][2],
    (L.yOf(C.idxOf(0, 4)) + L.yOf(C.idxOf(0, 5))) / 2, 0.01);
})();

console.log('\n[8] 覆盖层：选中、落点、上一步、将军');
(function () {
  var L = new Layout(375, false);
  var pos = new Position();
  var selected = C.idxOf(7, 7);          // 红炮二
  var targetEmpty = C.idxOf(4, 7);       // 平中，落点为空
  var enemyIdx = C.idxOf(2, 3);          // 黑卒，可吃子落点

  var ctx = createStubContext();
  R.draw(ctx, L, {
    board: pos.board,
    selected: selected,
    targets: [targetEmpty, enemyIdx],
    lastMove: { from: C.idxOf(0, 9), to: C.idxOf(0, 8) },
    checkIdx: C.idxOf(4, 0),
    pulse: 0.5
  });

  var calls = ctx.calls;
  // 选中环 1 次 + 可吃子红环 1 次 + 将军脉冲 1 次 = 3 次 arc 描边相关
  var rings = calls.arc.filter(function (a) {
    return Math.abs(a[2] - (L.pieceRadius + L.cell * 0.075)) < 0.01 ||
      Math.abs(a[2] - (L.pieceRadius + L.cell * 0.07)) < 0.01;
  });
  assert('选中环与可吃子环各一次', rings.length, 2);

  var dots = calls.arc.filter(function (a) { return Math.abs(a[2] - L.cell * 0.135) < 0.01; });
  assert('空落点画一个小圆点', dots.length, 1);
  approx('小圆点位于落点中心', dots[0][0], L.xOf(targetEmpty), 0.01);

  var pulses = calls.arc.filter(function (a) {
    return Math.abs(a[2] - (L.pieceRadius + L.cell * (0.10 + 0.16 * 0.5))) < 0.01;
  });
  assert('将军脉冲环一次', pulses.length, 1);
  approx('脉冲环位于黑将处', pulses[0][0], L.xOf(C.idxOf(4, 0)), 0.01);

  // 棋子文字仍为 32 枚（覆盖层不额外写字）
  assert('棋子文字数不受覆盖层影响', pieceTexts(calls).length, 32);
  assert('上一步标记未增加文字', calls.fillText.length, 34);
})();

console.log('\n[9] 覆盖层：角标与提示');
(function () {
  var L = new Layout(375, false);
  var ctx = createStubContext();
  R.drawCornerMark(ctx, L, C.idxOf(4, 4), '#000', 0.44);
  // 4 个象限，每象限 1 次 moveTo + 2 次 lineTo
  assert('角标 moveTo 数 = 4', ctx.calls.moveTo.length, 4);
  assert('角标 lineTo 数 = 8', ctx.calls.lineTo.length, 8);
  assert('角标描边一次', ctx.calls.stroke, 1);

  var ctx2 = createStubContext();
  R.drawRing(ctx2, L, C.idxOf(4, 4), '#000', 0.07, 0.07);
  assert('圆环只画一条弧', ctx2.calls.arc.length, 1);
  approx('圆环半径 = 棋子半径 + 格距比例',
    ctx2.calls.arc[0][2], L.pieceRadius + L.cell * 0.07, 0.01);

  var ctx3 = createStubContext();
  R.drawCheckPulse(ctx3, L, -1, 0);
  assert('checkIdx 为 -1 时不绘制脉冲', ctx3.calls.arc.length, 0);

  var ctx4 = createStubContext();
  R.drawTargets(ctx4, L, new Position().board, []);
  assert('空落点列表不绘制', ctx4.calls.arc.length, 0);

  var ctx5 = createStubContext();
  R.drawTargets(ctx5, L, new Position().board, null);
  assert('落点为 null 不绘制且不报错', ctx5.calls.arc.length, 0);
})();

console.log('\n[10] 拖拽中的棋子浮于最上层');
(function () {
  var L = new Layout(375, false);
  var pos = new Position();
  var from = C.idxOf(7, 7);   // 红炮
  var dragX = 200;
  var dragY = 120;

  var ctx = createStubContext();
  R.draw(ctx, L, {
    board: pos.board,
    moving: { from: from, x: dragX, y: dragY, piece: pos.board[from] }
  });

  var texts = pieceTexts(ctx.calls);
  assert('拖拽时仍绘制 32 枚棋子', texts.length, 32);

  var dragged = texts.filter(function (t) {
    return Math.abs(t[1] - dragX) < 0.01;
  });
  assert('被拖拽的棋子画在手指位置', dragged.length, 1);
  assert('拖拽棋子文字为炮', dragged[0][0], '炮');
  assert('原位不再重复绘制',
    texts.filter(function (t) {
      return Math.abs(t[1] - L.xOf(from)) < 0.01 &&
        Math.abs(t[2] - (L.yOf(from) + L.pieceRadius * 0.05)) < 0.01;
    }).length, 0);
  assert('拖拽棋子是最后一次绘制', texts[texts.length - 1][1], dragX);
})();

console.log('\n[11] 异常输入容错');
(function () {
  var L = new Layout(375, false);
  var ctx = createStubContext();
  var threw = null;
  try {
    R.draw(ctx, L, {});                 // 无 board
    R.drawPieces(ctx, L, null, null);   // board 为 null
    R.draw(ctx, L, { board: new Position().board, moving: { from: -1 } });
  } catch (e) {
    threw = e.message;
  }
  assert('缺字段不抛异常', threw, null);

  var ctx2 = createStubContext();
  R.draw(ctx2, L, { board: new Position().board });
  assert('省略覆盖层字段仍完成绘制', ctx2.calls.clearRect.length, 1);
  assert('省略覆盖层时棋子照常绘制', pieceTexts(ctx2.calls).length, 32);
})();

console.log('\n[12] 拖拽悬停落点高亮');
(function () {
  var L = new Layout(375, false);
  var board = new Position().board;
  var moving = { from: 54, x: 10, y: 10, piece: 7 };

  var c1 = createStubContext();
  R.draw(c1, L, { board: board, targets: [45], moving: { from: moving.from, x: moving.x, y: moving.y, piece: moving.piece, hover: -1 } });
  var c2 = createStubContext();
  R.draw(c2, L, { board: board, targets: [45], moving: { from: moving.from, x: moving.x, y: moving.y, piece: moving.piece, hover: 45 } });

  assert('悬停高亮多画一条弧（圆环）', c2.calls.arc.length - c1.calls.arc.length, 1);
  assert('悬停高亮多描边一次', c2.calls.stroke - c1.calls.stroke, 1);

  // 高亮环是最后绘制的弧，位于悬停落点中心
  var ring = c2.calls.arc[c2.calls.arc.length - 1];
  approx('高亮环中心 x', ring[0], L.xOf(45));
  approx('高亮环中心 y', ring[1], L.yOf(45));
  approx('高亮环半径', ring[2], L.pieceRadius + L.cell * 0.075);

  // hover=-1 时不画高亮环，最后一条弧仍是空落点小圆点
  var dot = c1.calls.arc[c1.calls.arc.length - 1];
  approx('无悬停时最后一条弧为落点小圆点', dot[2], L.cell * 0.135);
})();

console.log('\n[13] 中文书法字栈');
(function () {
  var L = new Layout(375, false);
  var ctx = createStubContext();
  R.draw(ctx, L, { board: new Position().board });

  // 棋子文字（单字）对应的 font 应为书法字栈
  var pieceIdx = -1;
  var i;
  for (i = 0; i < ctx.calls.fillText.length; i++) {
    if (ctx.calls.fillText[i][0].length === 1) { pieceIdx = i; break; }
  }
  assert('找到棋子文字', pieceIdx >= 0, true);
  assert('棋子文字使用书法字栈', /Kaiti|Songti|serif/.test(ctx.calls.fonts[pieceIdx]), true);
  assert('棋子文字不再用 sans-serif', ctx.calls.fonts[pieceIdx].indexOf('sans-serif') < 0, true);

  // 楚河汉界（含空格）同样使用书法字栈
  var riverIdx = -1;
  for (i = 0; i < ctx.calls.fillText.length; i++) {
    if (ctx.calls.fillText[i][0].indexOf(' ') >= 0) { riverIdx = i; break; }
  }
  assert('楚河汉界使用书法字栈', /Kaiti|Songti|serif/.test(ctx.calls.fonts[riverIdx]), true);
})();

console.log('\n[14] 走子动画：正在移动的那枚棋子');
(function () {
  var L = new Layout(375, false);
  var pos = new Position();

  // 红兵 54 -> 47：起终点不同列也不同行，便于按坐标定位飞行中的棋子
  var from = C.idxOf(0, 6);
  var to = C.idxOf(2, 5);
  var piece = pos.board[from];
  assert('起点是红兵', piece, C.R_PAWN);

  // 模拟「已经走完这一步」的棋盘：起点空、终点已落子
  var board = pos.board.slice();
  board[from] = C.EMPTY;
  board[to] = piece;

  var midX = (L.xOf(from) + L.xOf(to)) / 2;
  var midY = (L.yOf(from) + L.yOf(to)) / 2;

  // 14.1 中段：棋子悬在起终点之间，终点格不重复绘制
  var ctx = createStubContext();
  R.draw(ctx, L, {
    board: board,
    anim: { from: from, to: to, piece: piece, captured: C.EMPTY, t: 0.5 }
  });

  var texts = pieceTexts(ctx.calls);
  assert('动画期间棋子总数不变', texts.length, 32);

  // 缓动中点即几何中点，但走子是抛物线：中段沿法向抬起
  // lift = min(cell*0.34, dist*0.16) * sin(π·t)，t=0.5 时达到峰值
  var distPx = Math.sqrt(
    Math.pow(L.xOf(to) - L.xOf(from), 2) + Math.pow(L.yOf(to) - L.yOf(from), 2));
  var expectLift = Math.min(L.cell * 0.34, distPx * 0.16) * Math.sin(Math.PI * 0.5);
  var flying = texts.filter(function (t) {
    // y 容差需吸收文字自身的 r*0.05 视觉偏移（drawPieceAt 文字基线）
    return Math.abs(t[1] - midX) < 0.01 && Math.abs(t[2] - (midY - expectLift)) < L.pieceRadius * 0.12;
  });
  assert('在途棋子画在起终点之间（抛物线抬起）', flying.length, 1);
  assert('抛物线抬升量大于零', expectLift > 0, true);
  assert('在途棋子文字为兵', flying[0][0], '兵');
  assert('终点格不再重复绘制',
    texts.filter(function (t) { return pieceAtSquare(t, L, to); }).length, 0);

  // 14.2 中段抬起：棋子比落定状态更大（弧心随抛物线在 midY - expectLift 处）
  var midR = radiusAt(ctx.calls, midX, midY - expectLift);
  assert('在途棋子有外圈', typeof midR === 'number', true);
  assert('在途棋子被抬起（半径变大）', midR > L.pieceRadius, true);

  // 14.3 t=0 时仍在起点，t=1 时正好落在终点且尺寸复原
  var ctx0 = createStubContext();
  R.draw(ctx0, L, { board: board, anim: { from: from, to: to, piece: piece, captured: C.EMPTY, t: 0 } });
  assert('t=0 时棋子仍在起点',
    pieceTexts(ctx0.calls).filter(function (t) { return pieceAtSquare(t, L, from); }).length, 1);

  var ctx1 = createStubContext();
  R.draw(ctx1, L, { board: board, anim: { from: from, to: to, piece: piece, captured: C.EMPTY, t: 1 } });
  assert('t=1 时棋子落在终点',
    pieceTexts(ctx1.calls).filter(function (t) { return pieceAtSquare(t, L, to); }).length, 1);
  approx('落定时缩放回到 1', radiusAtSquare(ctx1.calls, L, to), L.pieceRadius);

  // 14.4 吃子：被吃棋子沿走子方向击飞（旋转 + 淡出），不再原地停留
  // 旋转绘制时文字落在局部坐标 (0, ~0)（drawPieceAt 旋转分支把坐标系搬到棋子中心）
  var capCtx = createStubContext();
  R.draw(capCtx, L, {
    board: board,
    anim: { from: from, to: to, piece: piece, captured: C.B_PAWN, t: 0.5 }
  });
  var capTexts = pieceTexts(capCtx.calls);
  assert('吃子动画多出被吃的卒', capTexts.length, 33);
  assert('被吃棋子被击飞（不在终点格）',
    capTexts.filter(function (t) { return pieceAtSquare(t, L, to); }).length, 0);
  var dead = capTexts.filter(function (t) { return t[0] === '卒' && Math.abs(t[1]) < 0.01; });
  assert('被吃卒仍在绘制（旋转坐标系原点）', dead.length, 1);
  assert('被吃卒带缩小', radiusAt(capCtx.calls, 0, 0) < L.pieceRadius, true);

  // 淡出用 globalAlpha 表现：旋转绘制的被吃棋子（fillText 在原点）透明度应小于 1
  var deadAlpha = null;
  for (var i = 0; i < capCtx.calls.fillText.length; i++) {
    var t2 = capCtx.calls.fillText[i];
    if (t2[0] === '卒' && Math.abs(t2[1]) < 0.01) deadAlpha = capCtx.calls.alphas[i];
  }
  approx('被吃棋子半透明', deadAlpha, 0.5);

  // 14.5 无动画时行为不变：终点格照常绘制
  var plain = createStubContext();
  R.draw(plain, L, { board: board });
  assert('无动画时照常绘制终点格棋子',
    pieceTexts(plain.calls).filter(function (t) { return pieceAtSquare(t, L, to); }).length, 1);
})();

console.log('\n[15] 走子动画缓动');
(function () {
  assert('t=0 缓动为 0', R.easeInOutCubic(0), 0);
  assert('t=1 缓动为 1', R.easeInOutCubic(1), 1);
  approx('中点为 0.5', R.easeInOutCubic(0.5), 0.5);
  assert('区间外被夹紧', R.easeInOutCubic(-1), 0);
  assert('区间外被夹紧（上界）', R.easeInOutCubic(2), 1);
  // 单调递增：起步慢、中段快、落定慢
  var prev = -1;
  var monotonic = true;
  for (var t = 0; t <= 1.0001; t += 0.05) {
    var v = R.easeInOutCubic(t);
    if (v < prev) monotonic = false;
    prev = v;
  }
  assert('全程单调不减', monotonic, true);
  assert('起步比线性慢（缓入）', R.easeInOutCubic(0.25) < 0.25, true);
  assert('落定前比线性快（缓出）', R.easeInOutCubic(0.75) > 0.75, true);
})();

console.log('\n[16] 上一步棋子标记：持续发光，一眼看出刚动的是哪枚子');
(function () {
  var L = new Layout(375, false);
  var board = new Position().board;

  // 红兵 54 走到空位 47
  var FROM = C.idxOf(0, 6);
  var TO = C.idxOf(2, 5);
  var moved = board.slice();
  moved[TO] = moved[FROM];
  moved[FROM] = C.EMPTY;
  var move = { from: FROM, to: TO };
  var pieceR = L.pieceRadius / L.cell;

  // 16.1 一次调用里分流：空格画四角小角标，有棋子的格子画径向光晕
  var mk = createStubContext();
  R.drawMoveMarks(mk, L, moved, move, '#000', 0.44);
  assert('起点已空 -> 四角小角标 4 个 moveTo', mk.calls.moveTo.length, 4);
  assert('终点有子 -> 不再画角标', mk.calls.moveTo.length, 4);
  assert('终点有子 -> 画径向光晕', mk.calls.gradients, 1);
  assert('光晕填充一次', mk.calls.fill, 1);

  // 16.2 小角标净空 0.22 格距 < 棋子半径 0.44 —— 正是它会被整块盖住的原因
  var small = markExtent(mk.calls.moveTo, L, FROM);
  approx('小角标外缘 0.22 格距', small.reach, 0.22, 0.01);
  assert('小角标净空 < 棋子半径 -> 只能画在空格上', small.clear < pieceR, true);

  // 16.3 光晕：以棋子为中心，覆盖到棋子轮廓之外才看得见
  var glow = mk.calls.arc[0];
  approx('光晕圆心 x 落在终点', glow[0], L.xOf(TO));
  approx('光晕圆心 y 落在终点', glow[1], L.yOf(TO));
  assert('光晕半径伸出棋子轮廓之外', glow[2] > L.pieceRadius, true);
  approx('常亮态光晕半径 1.90 倍棋子半径', glow[2] / L.pieceRadius, 1.90, 0.01);

  // 16.4 起势：boost 越大越亮、铺得越开，回落到常亮
  var b0 = createStubContext();
  R.drawPieceGlow(b0, L, TO, '#000', 0);
  var b1 = createStubContext();
  R.drawPieceGlow(b1, L, TO, '#000', 1);
  assert('起势时光晕铺得更开', b1.calls.arc[0][2] > b0.calls.arc[0][2], true);
  approx('满起势半径 2.30 倍棋子半径', b1.calls.arc[0][2] / L.pieceRadius, 2.30, 0.01);
  approx('常亮态半径与单独调用一致', b0.calls.arc[0][2], glow[2], 0.01);

  var bOver = createStubContext();
  R.drawPieceGlow(bOver, L, TO, '#000', 5);
  assert('boost 超过 1 被夹紧', bOver.calls.arc[0][2], b1.calls.arc[0][2]);

  var bNeg = createStubContext();
  R.drawPieceGlow(bNeg, L, TO, '#000', -1);
  assert('负 boost 按常亮处理', bNeg.calls.arc[0][2], b0.calls.arc[0][2]);

  var bUndef = createStubContext();
  R.drawPieceGlow(bUndef, L, TO, '#000');
  assert('省略 boost 仍是常亮（持续发光）', bUndef.calls.arc[0][2], b0.calls.arc[0][2]);

  // 16.5 渐变由中心向外衰减到全透明（这才是「发光」而不是「描边」）
  var grad = mk.calls.gradientsSpec[0];
  assert('光晕用三段渐变', grad.stops.length, 3);
  assert('内圈有色', /rgba\(/.test(grad.stops[0][1]), true);
  assert('最外圈全透明', /,0\)$/.test(grad.stops[2][1]), true);
  assert('外圈比内圈淡',
    parseFloat(grad.stops[2][1].split(',')[3]) < parseFloat(grad.stops[0][1].split(',')[3]), true);

  // 16.6 整盘绘制：光晕画在棋子之前（光从棋子底下透出来，不糊棋面）
  var c = createStubContext();
  R.draw(c, L, { board: moved, lastMove: move });
  var cBase = createStubContext();
  R.draw(cBase, L, { board: moved });
  assert('整盘只比无标记时多出起点一个角标',
    c.calls.moveTo.length - cBase.calls.moveTo.length, 4);

  var glowArc = -1;
  for (var i = 0; i < c.calls.arc.length; i++) {
    if (Math.abs(c.calls.arc[i][2] - L.pieceRadius * 1.90) < 0.01) { glowArc = i; break; }
  }
  assert('整盘绘制中画出常亮光晕', glowArc >= 0, true);
  assert('光晕位于棋子所在格', Math.abs(c.calls.arc[glowArc][0] - L.xOf(TO)) < 0.01, true);
  // 楚河汉界占前 2 次 fillText，第 3 次起才是棋子
  assert('光晕在楚河汉界之后',
    orderIndexOf(c.calls, 'arc', glowArc) > orderIndexOf(c.calls, 'fillText', 1), true);
  assert('光晕在第一枚棋子之前',
    orderIndexOf(c.calls, 'arc', glowArc) < orderIndexOf(c.calls, 'fillText', 2), true);

  // 16.7 起势：land 透传给光晕
  var cBoost = createStubContext();
  R.draw(cBoost, L, { board: moved, lastMove: move, land: 1 });
  var boostArc = null;
  for (i = 0; i < cBoost.calls.arc.length; i++) {
    if (Math.abs(cBoost.calls.arc[i][2] - L.pieceRadius * 2.30) < 0.01) { boostArc = cBoost.calls.arc[i]; break; }
  }
  assert('land=1 时光晕按起势半径绘制', !!boostArc, true);

  // 16.8 提示着法同理：起点有子用光晕，落点为空用小角标
  var HINT_FROM = C.idxOf(1, 7);   // 红炮，有子
  var HINT_TO = C.idxOf(1, 5);     // 空位
  var h = createStubContext();
  R.drawMoveMarks(h, L, board, { from: HINT_FROM, to: HINT_TO }, '#000', 0.34);
  assert('提示起点有子 -> 光晕', h.calls.gradients, 1);
  assert('提示落点为空 -> 小角标', h.calls.moveTo.length, 4);
  approx('提示光晕落在起点', h.calls.arc[0][0], L.xOf(HINT_FROM));

  // 16.9 无着法时不画任何标记
  var none = createStubContext();
  R.drawMoveMarks(none, L, board, null, '#000', 0.44);
  assert('无着法不画角标', none.calls.moveTo.length, 0);
  assert('无着法不画光晕', none.calls.gradients, 0);

  // 16.10 被威胁的棋子：与「上一步」同一套光晕形状，只换颜色
  var THREAT_RGB = '198,32,48';
  var threats = [C.idxOf(0, 0), C.idxOf(8, 0), C.idxOf(1, 2)];

  function threatGlows(ctx) {
    return ctx.calls.gradientsSpec.filter(function (g) {
      return g.stops.length && String(g.stops[0][1]).indexOf(THREAT_RGB) >= 0;
    });
  }

  var tctx = createStubContext();
  R.draw(tctx, L, { board: board, threats: threats });
  assert('三枚被威胁的棋子各一圈光晕', threatGlows(tctx).length, 3);

  // 三圈必须出自同一个基色（只是透明度不同）——「多枚颜色统一」
  var baseColors = {};
  threatGlows(tctx).forEach(function (g) {
    g.stops.forEach(function (s) {
      baseColors[String(s[1]).replace(/[\d.]+\)$/, ')')] = 1;
    });
  });
  assert('多枚被威胁的子共用同一个基色', Object.keys(baseColors).length, 1);

  // 与「上一步」的光晕形状一致：同样的三段渐变（内浓外透）
  var one = threatGlows(tctx)[0];
  assert('光晕三段渐变', one.stops.length, 3);
  assert('最外圈透明', one.stops[2][1].indexOf(',0)') > 0, true);

  // 与「上一步」的颜色必须分得开，否则玩家分不清「刚走的」和「要被吃的」
  assert('威胁色与上一步色不同', R.THEME.threat === R.THEME.lastMove, false);

  // 空列表 / null / 越界 / 空格：不画也不报错
  var e1 = createStubContext();
  R.drawThreats(e1, L, board, []);
  assert('空列表不绘制', e1.calls.gradients, 0);
  var e2 = createStubContext();
  R.drawThreats(e2, L, board, null);
  assert('null 不绘制且不报错', e2.calls.gradients, 0);
  var e3 = createStubContext();
  R.drawThreats(e3, L, board, [C.idxOf(4, 4), -1, 999]);
  assert('空格与越界索引被跳过', e3.calls.gradients, 0);

  // 同一局面里既可能有「上一步」也可能有被威胁的子：两套光晕共存、颜色各异
  // 注意别拿 calls.gradients 总数断言——棋子盘面本身也用径向渐变
  var both = createStubContext();
  R.draw(both, L, { board: moved, lastMove: move, threats: [C.idxOf(0, 0)] });
  var amber = both.calls.gradientsSpec.filter(function (g) {
    return g.stops.length && String(g.stops[0][1]).indexOf('233,168,52') >= 0;
  });
  assert('两套光晕共存：上一步的琥珀一圈', amber.length, 1);
  assert('两套光晕共存：被威胁的绛红一圈', threatGlows(both).length, 1);
})();

console.log('\n[17] 主题色派生透明度');
(function () {
  assert('六位十六进制', R.withAlpha('#e9a834', 0.5), 'rgba(233,168,52,0.5)');
  assert('rgba 改写透明度', R.withAlpha('rgba(30,136,229,0.92)', 0.25), 'rgba(30,136,229,0.25)');
  assert('rgb 补透明度', R.withAlpha('rgb(1,2,3)', 0.4), 'rgba(1,2,3,0.4)');
  assert('无法识别时原样返回', R.withAlpha('gold', 0.5), 'gold');
  assert('主题色都能派生', /^rgba\(/.test(R.withAlpha(R.THEME.lastMove, 0.3)), true);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31mUI 层测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32mUI 层全部测试通过\x1b[0m\n');
