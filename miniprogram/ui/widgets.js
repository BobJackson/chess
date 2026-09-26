/**
 * Canvas UI 组件库（小游戏专用）
 *
 * 小游戏没有 WXML 组件树，所有界面元素都在 Canvas 上自绘并自行命中测试。
 * 本模块提供最小可用的一组「组件」：圆角按钮、分段选择器、文本换行与绘制。
 * 组件本身只是数据（矩形 + 标签），绘制与命中分离，便于测试。
 * 纯 JavaScript，仅依赖 Canvas 2D 接口。
 */

var THEME = {
  bg: '#f3e9d2',
  panel: '#fffaf0',
  primary: '#5d4037',
  primaryText: '#ffffff',
  primaryDown: '#4a332c',
  ghostBorder: '#5d4037',
  ghostText: '#5d4037',
  ghostDown: 'rgba(93,64,55,0.12)',
  title: '#4e342e',
  subtitle: '#8d6e63',
  body: '#5d4037',
  segBg: '#e8d9b8',
  segOn: '#5d4037',
  segText: '#6d4c41',
  segOnText: '#ffffff',
  danger: '#b3261e',
  // 账本与列表：胜负色点（松/桂/和）、连胜横幅、行分隔线
  accentSong: '#c98a2b',
  accentGui: '#c62030',
  accentDraw: '#8d6e63',
  divider: 'rgba(93,64,55,0.14)',
  // 大厅房间号输入框
  inputFill: '#fffaf0',
  inputEdge: '#d7c39a',
  inputHint: '#bcaaa4'
};

function roundRectPath(ctx, x, y, w, h, r) {
  var rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 构造一个按钮数据对象 */
function makeButton(id, x, y, w, h, label, style) {
  return { id: id, x: x, y: y, w: w, h: h, label: label, style: style || 'primary' };
}

function hitButton(btn, px, py) {
  return px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h;
}

/** 绘制按钮；pressed 为 true 时略微加深 */
function drawButton(ctx, btn, pressed) {
  ctx.save();
  if (btn.style === 'ghost') {
    ctx.fillStyle = pressed ? THEME.ghostDown : 'rgba(0,0,0,0)';
    roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, 10);
    ctx.fill();
    ctx.strokeStyle = THEME.ghostBorder;
    ctx.lineWidth = 2;
    roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, 10);
    ctx.stroke();
    ctx.fillStyle = THEME.ghostText;
  } else {
    ctx.fillStyle = pressed ? THEME.primaryDown : THEME.primary;
    roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, 10);
    ctx.fill();
    ctx.fillStyle = THEME.primaryText;
  }
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 1);
  ctx.restore();
}

/** 绘制分段选择器；items 为标签数组 */
function drawSegmented(ctx, x, y, w, h, items, selected) {
  var n = items.length;
  var iw = w / n;
  ctx.save();
  ctx.fillStyle = THEME.segBg;
  roundRectPath(ctx, x, y, w, h, 8);
  ctx.fill();
  if (selected >= 0 && selected < n) {
    ctx.fillStyle = THEME.segOn;
    roundRectPath(ctx, x + selected * iw, y, iw, h, 8);
    ctx.fill();
  }
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (var i = 0; i < n; i++) {
    ctx.fillStyle = i === selected ? THEME.segOnText : THEME.segText;
    ctx.fillText(items[i], x + i * iw + iw / 2, y + h / 2 + 1);
  }
  ctx.restore();
}

/** 分段选择器命中测试，返回下标或 -1 */
function hitSegmented(x, y, w, h, items, px, py) {
  if (px < x || px > x + w || py < y || py > y + h) return -1;
  var iw = w / items.length;
  var idx = Math.floor((px - x) / iw);
  return idx >= 0 && idx < items.length ? idx : -1;
}

function setFont(ctx, size, bold) {
  ctx.font = (bold ? 'bold ' : '') + size + 'px sans-serif';
}

function drawText(ctx, text, x, y, size, color, align, bold) {
  ctx.save();
  setFont(ctx, size, bold);
  ctx.fillStyle = color;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** 按最大宽度把文本折成多行（中文按字折行） */
function wrapText(ctx, text, maxWidth, size) {
  setFont(ctx, size, false);
  var lines = [];
  var paragraphs = String(text).split('\n');
  for (var p = 0; p < paragraphs.length; p++) {
    var line = '';
    var chars = paragraphs[p].split('');
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = chars[i];
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** 填充整屏背景 */
function fillBackground(ctx, w, h) {
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, w, h);
}

module.exports = {
  THEME: THEME,
  roundRectPath: roundRectPath,
  makeButton: makeButton,
  hitButton: hitButton,
  drawButton: drawButton,
  drawSegmented: drawSegmented,
  hitSegmented: hitSegmented,
  setFont: setFont,
  drawText: drawText,
  wrapText: wrapText,
  fillBackground: fillBackground
};
