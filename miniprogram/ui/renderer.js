/**
 * 棋盘渲染器
 *
 * 只依赖 Canvas 2D 上下文接口（arc / fillText / createRadialGradient 等），
 * 不直接引用 wx，因此可以在 node 下用桩上下文做单元测试。
 *
 * 绘制分层：
 *   背景 -> 网格/九宫/炮兵位标记/楚河汉界
 *        -> 上一步标记（棋子下方）
 *        -> 棋子（含走子动画中在途的那一枚）
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
  hint: 'rgba(30,136,229,0.92)',
  // 被威胁的棋子：与「上一步」用同一套光晕形状、只换颜色。
  // 刻意取偏冷的深绛红，与琥珀拉开距离——两件事必须一眼分得开。
  // 同一局面被威胁的子可能有好几枚，**统一用这一个颜色**，不再按子分色。
  threat: 'rgba(198,32,48,0.95)'
};

/**
 * 棋子/题字用的中文书法字栈
 * iOS 命中 Kaiti SC / Songti SC，Android 回落到 Noto Serif CJK（宋体），
 * 最终 serif 兜底，保证任何平台都是传统字形而非现代黑体。
 */
var PIECE_FONT = '"Kaiti SC", "STKaiti", "KaiTi", "Songti SC", "STSong", "Noto Serif CJK SC", serif';

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

/**
 * 由主题色派生指定透明度（支持 #rrggbb 与 rgb()/rgba() 两种写法）
 * 用于把不透明的强调色铺成渐隐的光晕。
 */
function withAlpha(color, alpha) {
  var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    var h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }
  var rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgb) {
    var p = rgb[1].split(',');
    return 'rgba(' + p[0].trim() + ',' + p[1].trim() + ',' + p[2].trim() + ',' + alpha + ')';
  }
  return color;
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
  ctx.font = px(size) + 'px ' + PIECE_FONT;
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
 * @param {object} [opts] { scale, dim, alpha }
 */
function drawPieceAt(ctx, L, x, y, piece, opts) {
  opts = opts || {};
  var r = L.pieceRadius * (opts.scale || 1);
  var isRed = piece > 0;

  ctx.save();
  if (opts.dim) ctx.globalAlpha = 0.55;
  else if (typeof opts.alpha === 'number') {
    ctx.globalAlpha = Math.max(0, Math.min(1, opts.alpha));
  }

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
  ctx.font = 'bold ' + px(r * 1.08) + 'px ' + PIECE_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(C.PIECE_NAMES[piece] || '?', x, y + r * 0.05);

  ctx.restore();
}

/** 在交叉点上画一枚棋子 */
function drawPiece(ctx, L, idx, piece, opts) {
  drawPieceAt(ctx, L, L.xOf(idx), L.yOf(idx), piece, opts);
}

/** 走子动画缓动：起步与落定都平滑（easeInOutCubic） */
function easeInOutCubic(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 画走子动画中「正在移动的那枚棋子」
 *
 * 对局状态在走子瞬间就已更新，终点格上已有棋子；动画期间渲染层跳过终点格，
 * 改由本函数按进度把棋子从起点插值滑向终点，并在中段微微抬起（缩放），
 * 落定时缩放回到 1，与终点格上的棋子无缝衔接。
 *
 * @param {object} anim { from, to, piece, t }，t 为 0~1 的线性进度
 */
function drawMoveAnim(ctx, L, anim) {
  var e = easeInOutCubic(anim.t);
  var x0 = L.xOf(anim.from);
  var y0 = L.yOf(anim.from);
  var x1 = L.xOf(anim.to);
  var y1 = L.yOf(anim.to);

  drawPieceAt(ctx, L, x0 + (x1 - x0) * e, y0 + (y1 - y0) * e, anim.piece, {
    scale: 1 + 0.14 * Math.sin(Math.PI * anim.t)
  });
}

/**
 * 画全部棋子
 *
 * @param {object} [moving] 拖拽中的棋子 { from, x, y, piece }
 * @param {object} [anim]   走子动画 { from, to, piece, captured, t }
 */
function drawPieces(ctx, L, board, moving, anim) {
  if (!board) return;
  var dragFrom = moving ? moving.from : -1;
  var animTo = anim ? anim.to : -1;

  for (var i = 0; i < C.BOARD_SIZE; i++) {
    var piece = board[i];
    if (piece === C.EMPTY) continue;
    // 拖拽中的棋子最后画，保证浮在最上层；走子动画的终点格交给动画层绘制
    if (i === dragFrom || i === animTo) continue;
    drawPiece(ctx, L, i, piece, null);
  }

  if (anim) {
    // 被吃的棋子留在终点格淡出，被落下的棋子覆盖后消失
    if (anim.captured !== C.EMPTY && anim.captured !== undefined) {
      drawPiece(ctx, L, anim.to, anim.captured, {
        alpha: 1 - anim.t,
        scale: 1 - 0.18 * anim.t
      });
    }
    drawMoveAnim(ctx, L, anim);
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

/**
 * 棋子光晕：在该棋子下方垫一圈柔和的径向辉光
 *
 * 直接标出「是哪一枚」，而不是框住哪一格。用径向渐变由棋子边缘向外衰减，
 * 比描硬边圆环更接近「发光」的观感，也压得住木质棋盘的暖调。
 * 画在棋子之前——光从棋子底下透出来，同时避免糊住棋面。
 *
 * @param {number} [boost] 0~1 起势强度：落子瞬间给一下更亮的爆闪，再回落到常亮
 */
function drawPieceGlow(ctx, L, idx, color, boost) {
  var b = typeof boost === 'number' && boost > 0 ? Math.min(1, boost) : 0;
  var x = L.xOf(idx);
  var y = L.yOf(idx);
  var r0 = L.pieceRadius * 0.90;
  var r1 = L.pieceRadius * (1.90 + 0.40 * b);

  var g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  g.addColorStop(0, withAlpha(color, 0.38 + 0.30 * b));
  g.addColorStop(0.45, withAlpha(color, 0.15 + 0.15 * b));
  g.addColorStop(1, withAlpha(color, 0));

  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * 被威胁的棋子：统一套一圈光晕，形状与「上一步」完全一致，只换颜色
 *
 * 走「同一套形状 + 换色」而不是另做一套造型，是因为这两件事必须一眼分得开：
 * 一个说「刚动的是这枚」，一个说「这几枚正被盯着」。
 *
 * @param {number[]} threats 棋子索引数组；多枚共用同一个主题色，不按子分色
 */
function drawThreats(ctx, L, board, threats) {
  if (!threats || !threats.length || !board) return;
  for (var i = 0; i < threats.length; i++) {
    var idx = threats[i];
    if (typeof idx !== 'number' || idx < 0 || idx >= C.BOARD_SIZE) continue;
    if (board[idx] === C.EMPTY) continue;
    drawPieceGlow(ctx, L, idx, THEME.threat, 0);
  }
}

/**
 * 画一组着法标记（上一步 / 提示的起点与终点）
 *
 * 空格用四角小角标即可；但格子有棋子时角标会被整块盖住（角标 half 远小于棋子
 * 半径，且画在棋子之前），改为给那枚棋子垫一圈光晕——既不会被遮住，
 * 又能直接指出「是哪一枚」。
 *
 * @param {object} board 当前棋盘（用于判断格子占用）
 * @param {object} move { from, to }
 * @param {string} color 标记色，同时用于角标与光晕
 * @param {number} smallRatio 空格角标尺寸（相对格距）
 * @param {number} [boost] 光晕起势强度，透传给 drawPieceGlow
 */
function drawMoveMarks(ctx, L, board, move, color, smallRatio, boost) {
  if (!move) return;
  var idxs = [move.from, move.to];

  for (var i = 0; i < idxs.length; i++) {
    var idx = idxs[i];
    if (typeof idx !== 'number' || idx < 0) continue;
    if (board && board[idx] !== C.EMPTY) drawPieceGlow(ctx, L, idx, color, boost);
    else drawCornerMark(ctx, L, idx, color, smallRatio);
  }
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
 *   anim: {from:number,to:number,piece:number,captured:number,t:number},
 *         走子动画中「正在移动的那一枚」，t 为 0~1 的线性进度
 *   land: number, 光晕起势强度 1~0，走子动画落定时置 1 后衰减；0 即常亮态
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

  // 着法标记画在棋子下方：空格用小角标，有棋子的格子垫一圈光晕标出「是哪一枚」
  // 上一步的棋子常亮发光；落子瞬间由 land 给一下更亮的起势，再回落到常亮
  drawMoveMarks(ctx, L, state.board, state.lastMove, THEME.lastMove, 0.44, state.land);
  drawMoveMarks(ctx, L, state.board, state.hint, THEME.hint, 0.34, 0);
  // 被威胁的棋子：同一套光晕形状、只换颜色，多枚统一一个色
  drawThreats(ctx, L, state.board, state.threats);

  drawPieces(ctx, L, state.board, state.moving, state.anim);

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
  PIECE_FONT: PIECE_FONT,
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
  drawMoveAnim: drawMoveAnim,
  easeInOutCubic: easeInOutCubic,
  drawCornerMark: drawCornerMark,
  drawMoveMarks: drawMoveMarks,
  drawThreats: drawThreats,
  drawPieceGlow: drawPieceGlow,
  withAlpha: withAlpha,
  drawRing: drawRing,
  drawTargets: drawTargets,
  drawCheckPulse: drawCheckPulse
};
