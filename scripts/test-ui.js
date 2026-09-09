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
    gradients: 0, fonts: []
  };

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
    moveTo: function (x, y) { calls.moveTo.push([x, y]); },
    lineTo: function (x, y) { calls.lineTo.push([x, y]); },
    arc: function (x, y, r) { calls.arc.push([x, y, r]); },
    stroke: function () { calls.stroke++; },
    fill: function () { calls.fill++; },
    save: function () { calls.save++; },
    restore: function () { calls.restore++; },
    fillText: function (t, x, y) { calls.fillText.push([t, x, y]); calls.fonts.push(ctx.font); },
    createLinearGradient: function () { calls.gradients++; return gradientStub(); },
    createRadialGradient: function () { calls.gradients++; return gradientStub(); }
  };
  return ctx;
}

/** 只统计棋子文字（单字，不含空格的楚河汉界标题） */
function pieceTexts(calls) {
  return calls.fillText.filter(function (t) { return t[0].indexOf(' ') < 0; });
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

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31mUI 层测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32mUI 层全部测试通过\x1b[0m\n');
