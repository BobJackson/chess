/**
 * 屏幕级装饰（对局/复盘共用的视觉框架）
 *
 * 从 scenes/board.js 抽出：整屏底色、棋盘衬底（棋桌面板）、
 * 上下留白的水印大字与中式饰线。两个场景用同一套装饰，
 * 保证「对局」与「复盘」看起来是同一张棋桌。
 *
 * 只依赖 Canvas 2D 与 ui/widgets，纯 JavaScript，无 wx 依赖。
 */

var Renderer = require('./renderer.js');
var W = require('./widgets.js');

/** layout.height / layout.width 的固定比例（由 PADDING_RATIO 决定） */
var BOARD_ASPECT = 10.24 / 9.24;

/**
 * 屏幕装饰色板（ui/themes.js 切换主题时就地覆写这里面的值，
 * 绘制函数每次都从 PALETTE 读取，调用点因此零改动）
 */
var PALETTE = {
  bgStops: ['#f8eed9', '#f1e2c2', '#e6d2a8'],
  panelFill: '#dcc08c',
  panelShadow: 'rgba(93,64,55,0.28)',
  panelStroke: 'rgba(93,64,55,0.35)',
  ornament: 'rgba(93,64,55,0.30)',
  watermark: '#5d4037'
};

/** 整屏纵向渐变底色，比纯色更有"桌布"质感 */
function drawScreenBg(ctx, w, h) {
  var g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, PALETTE.bgStops[0]);
  g.addColorStop(0.5, PALETTE.bgStops[1]);
  g.addColorStop(1, PALETTE.bgStops[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** 棋盘衬底：一圈略大的"棋桌"面板 + 投影 + 内描边 */
function drawPanel(ctx, x, y, w, h) {
  ctx.save();
  ctx.shadowColor = PALETTE.panelShadow;
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  ctx.fillStyle = PALETTE.panelFill;
  W.roundRectPath(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = PALETTE.panelStroke;
  ctx.lineWidth = 1;
  W.roundRectPath(ctx, x + 4, y + 4, w - 8, h - 8, 10);
  ctx.stroke();
  ctx.restore();
}

/** 中式分隔饰线：两端细线 + 中心菱形 */
function drawOrnament(ctx, cx, cy, halfW) {
  ctx.save();
  ctx.strokeStyle = PALETTE.ornament;
  ctx.fillStyle = PALETTE.ornament;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - halfW, cy); ctx.lineTo(cx - 9, cy);
  ctx.moveTo(cx + 9, cy); ctx.lineTo(cx + halfW, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - 4.5); ctx.lineTo(cx + 4.5, cy);
  ctx.lineTo(cx, cy + 4.5); ctx.lineTo(cx - 4.5, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 淡墨水印大字，填充大块留白 */
function drawWatermark(ctx, cx, cy, ch, size) {
  ctx.save();
  ctx.globalAlpha = 0.055;
  ctx.fillStyle = PALETTE.watermark;
  ctx.font = 'bold ' + size + 'px ' + Renderer.PIECE_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, cx, cy);
  ctx.restore();
}

/**
 * 装饰一段留白区域 [y0, y1]：
 * 空间足够时放一枚水印字 + 靠近棋盘一侧的饰线；空间较小只放居中饰线。
 */
function decorateGap(ctx, w, y0, y1, ch, ornamentNearY) {
  var gap = y1 - y0;
  if (gap < 26) return;
  var cx = w / 2;
  var halfW = Math.min(70, w * 0.2);
  if (gap > 110) {
    drawWatermark(ctx, cx, (y0 + y1) / 2 + 4, ch, Math.min(92, gap * 0.55));
    drawOrnament(ctx, cx, ornamentNearY, halfW);
  } else {
    drawOrnament(ctx, cx, (y0 + y1) / 2, halfW);
  }
}

module.exports = {
  BOARD_ASPECT: BOARD_ASPECT,
  PALETTE: PALETTE,
  drawScreenBg: drawScreenBg,
  drawPanel: drawPanel,
  drawOrnament: drawOrnament,
  drawWatermark: drawWatermark,
  decorateGap: decorateGap
};
