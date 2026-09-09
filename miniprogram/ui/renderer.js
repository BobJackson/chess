/**
 * 棋盘渲染器
 *
 * 只依赖 Canvas 2D 上下文接口（arc / fillText / createRadialGradient 等），
 * 不直接引用 wx，因此可以在 node 下用桩上下文做单元测试。
 *
 * 绘制分层：
 *   背景 -> 网格/九宫/炮兵位标记/楚河汉界
 *        -> 上一步标记（棋子下方）
 *        -> 棋子
 *        -> 选中环、可走点、将军脉冲、提示（棋子上方）
 */

var C = require('../core/constants.js');

var THEME = {
  bgTop: '#f6e6c2',
  bgBottom: '#e7cfa2',
  boardEdge: '#b98f52',
  line: '#5d4037',
  riverText: 'rgba(93,64,55,0.42)',
  pieceFaceTop: '#fffaf0',
  pieceFaceMid: '#fdf3d8',
  pieceFaceBottom: '#e0cca1',
  pieceEdge: '#a9825a',
  pieceShadow: 'rgba(60,40,10,0.30)',
  redText: '#b3261e',
  blackText: '#1f1f1f',
  selected: '#1e88e5',
  target: 'rgba(46,150,64,0.85)',
  capture: 'rgba(206,64,58,0.92)',
  lastMove: 'rgba(233,168,52,0.95)',
  check: 'rgba(206,64,58,0.95)',
  hint: 'rgba(30,136,229,0.92)'
};

/** 需要画「准星」标记的交叉点：4 个炮位 + 10 个兵卒位 */
var MARK_POINTS = [
  [1, 2], [7, 2], [1, 7], [7, 7],
  [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
  [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]
];

// ---------------------------------------------------------------------------
// 基础绘图工具
// ---------------------------------------------------------------------------

function seg(ctx, x1, y1, x2, y2) {
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
}

function px(n) {
  return Math.round(n * 100) / 100;
}

/** 线宽随格距缩放，并保证不小于 1 逻辑像素 */
function lineWidth(cell, ratio) {
  return Math.max(1, cell * ratio);
}

// ---------------------------------------------------------------------------
// 棋盘底层
// ---------------------------------------------------------------------------

function drawBackground(ctx, L) {
  var g = ctx.createLinearGradient(0, 0, 0, L.height);
  g.addColorStop(0, THEME.bgTop);
  g.addColorStop(1, THEME.bgBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, L.width, L.height);

  // 棋盘外框：沿最外圈交叉点略微外扩
  var half = L.cell * 0.16;
  var x0 = L.xOf(C.idxOf(0, 0)) - half;
  var y0 = L.yOf(C.idxOf(0, 0)) - half;
  var x1 = L.xOf(C.idxOf(C.FILES - 1, 0)) + half;
  var y1 = L.yOf(C.idxOf(0, C.RANKS - 1)) + half;
  ctx.strokeStyle = THEME.boardEdge;
  ctx.lineWidth = lineWidth(L.cell, 0.06);
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function drawGrid(ctx, L) {
  ctx.strokeStyle = THEME.line;
  ctx.lineWidth = lineWidth(L.cell, 0.024);
  ctx.beginPath();

  var file, rank, x, y;

  // 横线：10 条贯通
  for (rank = 0; rank < C.RANKS; rank++) {
    y = L.yOf(C.idxOf(0, rank));
    seg(ctx, L.xOf(C.idxOf(0, rank)), y, L.xOf(C.idxOf(C.FILES - 1, rank)), y);
  }

  // 纵线：最左最右贯通，其余 7 条在楚河处断开
  var yRiverNear = L.yOf(C.idxOf(0, 4));
  var yRiverFar = L.yOf(C.idxOf(0, 5));
  for (file = 0; file < C.FILES; file++) {
    x = L.xOf(C.idxOf(file, 0));
    if (file === 0 || file === C.FILES - 1) {
      seg(ctx, x, L.yOf(C.idxOf(file, 0)), x, L.yOf(C.idxOf(file, C.RANKS - 1)));
    } else {
      seg(ctx, x, L.yOf(C.idxOf(file, 0)), x, yRiverNear);
      seg(ctx, x, yRiverFar, x, L.yOf(C.idxOf(file, C.RANKS - 1)));
    }
  }

  ctx.stroke();
}

function drawPalaces(ctx, L) {
  ctx.strokeStyle = THEME.line;
  ctx.lineWidth = lineWidth(L.cell, 0.024);
  ctx.beginPath();
  seg(ctx, L.xOf(C.idxOf(3, 0)), L.yOf(C.idxOf(3, 0)),
    L.xOf(C.idxOf(5, 2)), L.yOf(C.idxOf(5, 2)));
  seg(ctx, L.xOf(C.idxOf(5, 0)), L.yOf(C.idxOf(5, 0)),
    L.xOf(C.idxOf(3, 2)), L.yOf(C.idxOf(3, 2)));
  seg(ctx, L.xOf(C.idxOf(3, 7)), L.yOf(C.idxOf(3, 7)),
    L.xOf(C.idxOf(5, 9)), L.yOf(C.idxOf(5, 9)));
  seg(ctx, L.xOf(C.idxOf(5, 7)), L.yOf(C.idxOf(5, 7)),
    L.xOf(C.idxOf(3, 9)), L.yOf(C.idxOf(3, 9)));
  ctx.stroke();
}

/** 炮位与兵位的四角准星；靠屏幕左右边缘的一侧省略 */
function drawMarks(ctx, L) {
  var gap = L.cell * 0.09;
  var arm = L.cell * 0.19;
  ctx.strokeStyle = THEME.line;
  ctx.lineWidth = lineWidth(L.cell, 0.022);
  ctx.beginPath();

  for (var i = 0; i < MARK_POINTS.length; i++) {
    var file = MARK_POINTS[i][0];
    var idx = C.idxOf(file, MARK_POINTS[i][1]);
    var x = L.xOf(idx);
    var y = L.yOf(idx);
    // 用屏幕列号判断边缘，翻转视角后依然正确
    var screenFile = L.flipped ? C.FILES - 1 - file : file;

    for (var q = -1; q <= 1; q += 2) {
      // 屏幕最左列不画左侧象限，最右列不画右侧象限
      if (q < 0 ? screenFile === 0 : screenFile === C.FILES - 1) continue;
      for (var v = -1; v <= 1; v += 2) {
        seg(ctx, x + q * gap, y + v * gap, x + q * (gap + arm), y + v * gap);
        seg(ctx, x + q * gap, y + v * gap, x + q * gap, y + v * (gap + arm));
      }
    }
  }

  ctx.stroke();
}

function drawRiver(ctx, L) {
  var y = (L.yOf(C.idxOf(0, 4)) + L.yOf(C.idxOf(0, 5))) / 2;
  var size = L.cell * 0.44;
  ctx.save();
  ctx.fillStyle = THEME.riverText;
  ctx.font = 'bold ' + px(size) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('楚  河', L.width * 0.27, y);
  ctx.fillText('汉  界', L.width * 0.73, y);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 棋子
// ---------------------------------------------------------------------------

/**
 * 在任意屏幕坐标画一枚棋子（拖拽时位置不再是交叉点）
 * @param {number} piece 棋子编码（正红负黑）
 * @param {object} [opts] { scale, dim }
 */
function drawPieceAt(ctx, L, x, y, piece, opts) {
  opts = opts || {};
  var r = L.pieceRadius * (opts.scale || 1);
  var isRed = piece > 0;

  ctx.save();
  if (opts.dim) ctx.globalAlpha = 0.55;

  // 投影
  ctx.shadowColor = THEME.pieceShadow;
  ctx.shadowBlur = r * 0.30;
  ctx.shadowOffsetY = r * 0.14;

  var g = ctx.createRadialGradient(x - r * 0.32, y - r * 0.40, r * 0.10, x, y, r);
  g.addColorStop(0, THEME.pieceFaceTop);
  g.addColorStop(0.60, THEME.pieceFaceMid);
  g.addColorStop(1, THEME.pieceFaceBottom);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  // 关闭阴影后再描边，避免边缘发糊
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.lineWidth = Math.max(1, r * 0.10);
  ctx.strokeStyle = THEME.pieceEdge;
  ctx.stroke();

  // 内圈细线
  ctx.beginPath();
  ctx.arc(x, y, r * 0.80, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(0.6, r * 0.055);
  ctx.strokeStyle = isRed ? 'rgba(179,38,30,0.45)' : 'rgba(31,31,31,0.38)';
  ctx.stroke();

  ctx.fillStyle = isRed ? THEME.redText : THEME.blackText;
  ctx.font = 'bold ' + px(r * 1.08) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(C.PIECE_NAMES[piece] || '?', x, y + r * 0.05);

  ctx.restore();
}

/** 在交叉点上画一枚棋子 */
function drawPiece(ctx, L, idx, piece, opts) {
  drawPieceAt(ctx, L, L.xOf(idx), L.yOf(idx), piece, opts);
}

function drawPieces(ctx, L, board, moving) {
  if (!board) return;
  var dragFrom = moving ? moving.from : -1;
  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var piece = board[i];
    if (piece === C.EMPTY) continue;
    // 拖拽中的棋子最后画，保证浮在最上层
    if (i === dragFrom) continue;
    drawPiece(ctx, L, i, piece, null);
  }
  if (moving && moving.piece !== C.EMPTY) {
    drawPieceAt(ctx, L, moving.x, moving.y, moving.piece, { scale: 1.10 });
  }
}

// ---------------------------------------------------------------------------
// 覆盖层
// ---------------------------------------------------------------------------

/** 四角直角标记，用于标示上一步的起点与终点 */
function drawCornerMark(ctx, L, idx, color, ratio) {
  var x = L.xOf(idx);
  var y = L.yOf(idx);
  var half = L.cell * (ratio || 0.40) / 2;
  var arm = half * 0.85;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth(L.cell, 0.055);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (var sx = -1; sx <= 1; sx += 2) {
    for (var sy = -1; sy <= 1; sy += 2) {
      var cx = x + sx * half;
      var cy = y + sy * half;
      ctx.moveTo(cx - sx * arm, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy - sy * arm);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawRing(ctx, L, idx, color, widthRatio, radiusExtra) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth(L.cell, widthRatio);
  ctx.beginPath();
  ctx.arc(L.xOf(idx), L.yOf(idx), L.pieceRadius + L.cell * radiusExtra, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawTargets(ctx, L, board, targets) {
  if (!targets || !targets.length) return;
  ctx.save();
  for (var i = 0; i < targets.length; i++) {
    var idx = targets[i];
    var x = L.xOf(idx);
    var y = L.yOf(idx);
    if (board && board[idx] !== C.EMPTY) {
      // 可吃子：在敌子外围画红环
      ctx.strokeStyle = THEME.capture;
      ctx.lineWidth = lineWidth(L.cell, 0.065);
      ctx.beginPath();
      ctx.arc(x, y, L.pieceRadius + L.cell * 0.07, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // 空位：画半透明小圆点
      ctx.fillStyle = THEME.target;
      ctx.beginPath();
      ctx.arc(x, y, L.cell * 0.135, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** 将军脉冲：pulse 取 0~1，由页面按帧驱动 */
function drawCheckPulse(ctx, L, idx, pulse) {
  if (idx === undefined || idx === null || idx < 0) return;
  var t = typeof pulse === 'number' ? pulse : 0;
  var x = L.xOf(idx);
  var y = L.yOf(idx);
  var r = L.pieceRadius + L.cell * (0.10 + 0.16 * t);

  ctx.save();
  ctx.globalAlpha = Math.max(0, 0.9 - 0.6 * t);
  ctx.strokeStyle = THEME.check;
  ctx.lineWidth = lineWidth(L.cell, 0.075);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 绘制整个棋盘
 *
 * @param {object} ctx Canvas 2D 上下文
 * @param {Layout} L 布局
 * @param {object} state {
 *   board: number[90],           必需，棋盘数组
 *   selected: number,            选中的己方棋子索引，-1 表示未选
 *   targets: number[],           选中棋子的合法落点
 *   lastMove: {from:number,to:number},
 *   checkIdx: number,            被将军的将/帅索引，-1 表示无
 *   pulse: number,               将军动画相位 0~1
 *   hint: {from:number,to:number}, AI 提示着法
 *   moving: {from:number,x:number,y:number,piece:number,hover?:number}, 拖拽中的棋子，
 *           hover 为手指正悬停的合法落点（-1 表示无），用于画落点高亮
 * }
 */
function draw(ctx, L, state) {
  state = state || {};

  ctx.clearRect(0, 0, L.width, L.height);
  drawBackground(ctx, L);
  drawGrid(ctx, L);
  drawPalaces(ctx, L);
  drawMarks(ctx, L);
  drawRiver(ctx, L);

  // 上一步标记画在棋子下方，避免遮挡棋面
  if (state.lastMove) {
    drawCornerMark(ctx, L, state.lastMove.from, THEME.lastMove, 0.44);
    drawCornerMark(ctx, L, state.lastMove.to, THEME.lastMove, 0.44);
  }
  if (state.hint) {
    drawCornerMark(ctx, L, state.hint.from, THEME.hint, 0.34);
    drawCornerMark(ctx, L, state.hint.to, THEME.hint, 0.34);
  }

  drawPieces(ctx, L, state.board, state.moving);

  drawTargets(ctx, L, state.board, state.targets);
  // 拖拽悬停的落点高亮：提示用户松手后棋子会落在哪
  if (state.moving && typeof state.moving.hover === 'number' && state.moving.hover >= 0) {
    drawRing(ctx, L, state.moving.hover, THEME.target, 0.075, 0.075);
  }
  if (typeof state.selected === 'number' && state.selected >= 0) {
    drawRing(ctx, L, state.selected, THEME.selected, 0.075, 0.075);
  }
  drawCheckPulse(ctx, L, state.checkIdx, state.pulse);
}

module.exports = {
  THEME: THEME,
  MARK_POINTS: MARK_POINTS,
  draw: draw,
  drawBackground: drawBackground,
  drawGrid: drawGrid,
  drawPalaces: drawPalaces,
  drawMarks: drawMarks,
  drawRiver: drawRiver,
  drawPiece: drawPiece,
  drawPieceAt: drawPieceAt,
  drawPieces: drawPieces,
  drawCornerMark: drawCornerMark,
  drawRing: drawRing,
  drawTargets: drawTargets,
  drawCheckPulse: drawCheckPulse
};
