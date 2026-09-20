/**
 * 绝杀演出
 *
 * 替代原来的 wx.showModal 纯文字弹窗：终局时在棋盘上演一段「怎么杀的」，
 * 再落款给出杀法名与结果，最后浮出「再来一局 / 回菜单」两个按钮。
 *
 * 三拍时间线：
 *   ① 压暗   棋盘蒙一层暗场，其余棋子沉下去
 *   ② 演示   按 result.mateInfo 的几何，画出该杀法的专属母题（见 drawMotif）
 *   ③ 落款   杀法名以书法字放大落款 + 胜负 + 按钮浮出
 *
 * 交互约定：
 *   - 演出途中点屏幕 -> 直接跳到落款（每局等两秒会烦，跳过是必须的）
 *   - 落款后按钮才可点，按钮出现前点屏幕只会跳过
 *
 * 只依赖 Canvas 2D（棋子与光晕复用 ui/renderer），可在 node 下用桩上下文单测。
 */

var C = require('../core/constants.js');
var Renderer = require('./renderer.js');
var W = require('./widgets.js');

// ---------------------------------------------------------------------------
// 时间线（毫秒）
// ---------------------------------------------------------------------------

var T_DIM = 350;    // ① 压暗结束
var T_SHOW = 1050;  // ② 演示杀招结束
var T_NAME = 1750;  // ③ 落款浮现结束
var T_UI = 2050;    // 按钮浮出结束
var T_END = T_UI + 300;

/** 演出配色：与棋盘「上一步发光」同一支琥珀，保证是一套语言 */
var FX = {
  scrim: 'rgba(24,14,6,0.62)',
  lineGlow: 'rgba(233,168,52,0.30)',
  line: 'rgba(255,217,138,0.98)',
  pulse: 'rgba(255,217,138,0.95)',
  cardFill: 'rgba(36,22,8,0.93)',
  cardEdge: '#b98f52',
  cardEdgeInner: 'rgba(233,168,52,0.32)',
  name: '#f2dcae',
  sub: '#c9b48c',
  btnFill: 'rgba(233,168,52,0.16)',
  btnFillDown: 'rgba(233,168,52,0.34)',
  btnEdge: 'rgba(233,168,52,0.60)',
  btnEdgeDim: 'rgba(185,143,82,0.55)',
  btnText: '#f2dcae',
  btnTextDim: '#c9b48c'
};

var CARD_W_MAX = 300;
var CARD_H = 158;
var BTN_H = 34;

// ---------------------------------------------------------------------------

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function seg(t, a, b) { return clamp01((t - a) / (b - a)); }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function Endgame() {
  this.active = false;
  this.t = 0;
  this.result = null;
  this.mateInfo = null;
  this.board = null;
  this.layout = null;
  this.win = true;
  this.buttons = [];
  this.pressed = null;
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/**
 * 起演出
 *
 * @param {object} result Game.result（含 mate / mateInfo）
 * @param {object} opts { board, layout, win, online }
 */
Endgame.prototype.start = function (result, opts) {
  opts = opts || {};
  this.active = true;
  this.t = 0;
  this.pressed = null;
  this.result = result || null;
  this.mateInfo = (result && result.mateInfo) || null;
  this.board = opts.board || null;
  this.layout = opts.layout || null;
  this.win = opts.win !== false;
  this.online = !!opts.online;
  this.buttons = [];
  return this;
};

Endgame.prototype.reset = function () {
  this.active = false;
  this.t = 0;
  this.pressed = null;
  this.buttons = [];
  return this;
};

Endgame.prototype.isActive = function () { return this.active; };

/** 演出是否已经播完（按钮可点、可以跳过等待） */
Endgame.prototype.isDone = function () { return this.t >= T_END; };

/** 推进时间线；已播完则停在末态 */
Endgame.prototype.tick = function (dt) {
  if (!this.active) return this.t;
  this.t += (dt || 16);
  if (this.t > T_END) this.t = T_END;
  return this.t;
};

/** 跳过演出：直接落到落款完成态 */
Endgame.prototype.skip = function () {
  if (!this.active) return false;
  this.t = T_END;
  return true;
};

/** 落款是否已经浮现（决定点击是「跳过」还是「命中按钮」） */
Endgame.prototype.buttonsLive = function () { return this.t >= T_UI; };

// ---------------------------------------------------------------------------
// 结算卡与按钮
// ---------------------------------------------------------------------------

/** 卡片矩形（居中） */
Endgame.prototype.cardRect = function (w, h) {
  var cw = Math.min(CARD_W_MAX, w - 48);
  return { x: (w - cw) / 2, y: (h - CARD_H) / 2, w: cw, h: CARD_H };
};

/** 布局按钮；联机不可重开，只给「回菜单」 */
Endgame.prototype.layoutButtons = function (w, h) {
  var card = this.cardRect(w, h);
  var gap = 12;
  var y = card.y + card.h - BTN_H - 18;

  if (this.online) {
    var bw = card.w - 48;
    this.buttons = [W.makeButton('menu', card.x + 24, y, bw, BTN_H, '回菜单', 'ghost')];
    return this.buttons;
  }

  var bw2 = (card.w - 48 - gap) / 2;
  this.buttons = [
    W.makeButton('again', card.x + 24, y, bw2, BTN_H, '再来一局', 'primary'),
    W.makeButton('menu', card.x + 24 + bw2 + gap, y, bw2, BTN_H, '回菜单', 'ghost')
  ];
  return this.buttons;
};

/** 命中按钮，返回 id 或 null；按钮未浮现时不响应 */
Endgame.prototype.hitButtonAt = function (x, y) {
  if (!this.active || !this.buttonsLive()) return null;
  for (var i = 0; i < this.buttons.length; i++) {
    if (W.hitButton(this.buttons[i], x, y)) return this.buttons[i].id;
  }
  return null;
};

/** 落款标题：有杀法名就用杀法名，否则用终局原因 */
Endgame.prototype.title = function () {
  if (this.mateInfo && this.mateInfo.name) return this.mateInfo.name;
  var reason = this.result && this.result.reason;
  if (reason === '将死') return '绝杀';
  return reason || '对局结束';
};

/** 落款副标题：胜负 */
Endgame.prototype.subtitle = function () {
  var r = this.result;
  if (!r) return '';
  if (r.winner === C.RED) return '红方胜';
  if (r.winner === C.BLACK) return '黑方胜';
  return '和棋';
};

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

/**
 * 绘制整场演出
 *
 * @param {object} ctx
 * @param {number} w 屏幕宽
 * @param {number} h 屏幕高
 * @param {number} boardX 棋盘原点（用于把高亮棋子画回棋盘坐标）
 * @param {number} boardY
 */
Endgame.prototype.draw = function (ctx, w, h, boardX, boardY) {
  if (!this.active) return;

  var t = this.t;
  var pDim = easeOut(seg(t, 0, T_DIM));
  var pShow = seg(t, T_DIM, T_SHOW);
  var pName = easeOut(seg(t, T_SHOW, T_NAME));
  var pUi = easeOut(seg(t, T_NAME, T_UI));

  // ① 压暗：连工具栏一起盖住，整屏进入结算
  ctx.save();
  ctx.globalAlpha = 0.62 * pDim;
  ctx.fillStyle = FX.scrim;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // ② 演示：先把杀招相关的棋子重画一遍浮出暗场，再画母题
  var L = this.layout;
  if (L && this.board && this.mateInfo) {
    ctx.save();
    ctx.translate(boardX, boardY);
    drawHighlights(ctx, L, this.board, this.mateInfo, pDim);
    drawMotif(ctx, L, this.mateInfo, pShow);
    ctx.restore();
  }

  // ③ 落款
  this.layoutButtons(w, h);
  drawCard(ctx, w, h, this, pName, pUi);
};

/** 把构成该杀法的棋子 + 被将的将浮出暗场 */
function drawHighlights(ctx, L, board, info, p) {
  if (p <= 0) return;
  var idxs = (info.pieces || []).slice();
  if (info.king !== null && info.king !== undefined) idxs.push(info.king);

  var i;
  ctx.save();
  ctx.globalAlpha = p;
  for (i = 0; i < idxs.length; i++) {
    var idx = idxs[i];
    if (idx < 0 || idx >= C.BOARD_SIZE || board[idx] === C.EMPTY) continue;
    Renderer.drawPieceGlow(ctx, L, idx, FX.line, 0);
  }
  for (i = 0; i < idxs.length; i++) {
    var k = idxs[i];
    if (k < 0 || k >= C.BOARD_SIZE || board[k] === C.EMPTY) continue;
    Renderer.drawPiece(ctx, L, k, board[k], null);
  }
  ctx.restore();
}

/** 画一条带外发光的线段 */
function glowLine(ctx, L, x1, y1, x2, y2, widthRatio) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = FX.lineGlow;
  ctx.lineWidth = Math.max(2, L.cell * (widthRatio * 3));
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = FX.line;
  ctx.lineWidth = Math.max(1, L.cell * widthRatio);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/** 扩散脉动环：rings 圈依次外扩，用于点出「这里是关键子」 */
function pulseRings(ctx, L, idx, p, rings) {
  if (p <= 0 || p >= 1) return;
  var pt = L.pointOf(idx);
  var n = rings || 1;
  ctx.save();
  ctx.strokeStyle = FX.pulse;
  for (var i = 0; i < n; i++) {
    var q = clamp01(p - i * 0.18);
    if (q <= 0) continue;
    ctx.globalAlpha = Math.max(0, 0.85 * (1 - q));
    ctx.lineWidth = Math.max(1, L.cell * 0.06 * (1 - q * 0.5));
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, L.pieceRadius + L.cell * (0.08 + 0.42 * q), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** 将军线扫到炮架时的进度（按几何距离算，别硬编码） */
function screenProgress(L, from, screen, to) {
  var a = L.pointOf(from);
  var s = L.pointOf(screen);
  var b = L.pointOf(to);
  var total = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  if (total <= 0) return 1;
  return clamp01((Math.abs(s.x - a.x) + Math.abs(s.y - a.y)) / total);
}

// ---------------------------------------------------------------------------
// 杀法母题
// ---------------------------------------------------------------------------

/**
 * 按杀法分叉画出「怎么杀的」
 *
 * 母题要回答的是「这一招凭什么成立」，所以每种杀法都点在自己的关键处：
 * 炮系点炮架、马系画日字轨迹、闷系合拢成框、双车画交叉线。
 *
 * @param {number} p 演示进度 0~1
 */
function drawMotif(ctx, L, info, p) {
  if (p <= 0 || !info) return;
  var key = info.key;

  if (key === 'mahoupao') {
    sweepToKing(ctx, L, info, p, { rings: 1, pulse: true });
    return;
  }
  if (key === 'chongpao') {
    sweepToKing(ctx, L, info, p, { rings: 2, pulse: true });
    return;
  }
  if (key === 'mengong' || key === 'mensha') {
    // 前半段扫将军线，后半段把将围起来（被自家子堵死）
    sweepToKing(ctx, L, info, p * 0.55, { rings: 1, pulse: true });
    closingBox(ctx, L, info.king, clamp01((p - 0.45) / 0.55));
    return;
  }
  if (key === 'shuangchecuo' || key === 'tiandipao' || key === 'jiachepao') {
    // 都是「几枚子各拉一条线指向将」：双车错两条、天地炮两条、夹车炮三条
    sweepFromPieces(ctx, L, info, p);
    return;
  }
  if (key === 'tiemenshuan') {
    // 门闩落下 + 车与中炮各拉一条线
    doorBar(ctx, L, info.checker, clamp01(p / 0.6));
    sweepFromPieces(ctx, L, info, p);
    return;
  }
  if (key === 'haidilaoyue') {
    // 底线那条将军线 + 一弯月弧兜住将（「捞月」的意象）
    sweepToKing(ctx, L, info, p, {});
    crescent(ctx, L, info.king, clamp01((p - 0.55) / 0.45));
    return;
  }
  if (key === 'wocaoma' || key === 'guajiaoma' || key === 'diaoyuma' || key === 'cemianhu') {
    traceKnight(ctx, L, info, p);
    return;
  }
  if (key === 'duimianxiao') {
    var kk = info.pieces || [];
    if (kk.length >= 2) beam(ctx, L, kk[0], kk[1], p);
    return;
  }
  if (key === 'erguipaimen') {
    lockLines(ctx, L, info.pieces || [], info.king, p);
    return;
  }
}

/** 炮系：将军线由将军子扫向将，扫过炮架时脉动一下 */
function sweepToKing(ctx, L, info, p, opts) {
  if (p <= 0) return;
  var a = L.pointOf(info.checker);
  var b = L.pointOf(info.king);
  var x = a.x + (b.x - a.x) * p;
  var y = a.y + (b.y - a.y) * p;
  glowLine(ctx, L, a.x, a.y, x, y, 0.05);

  if (opts.pulse && info.screen !== null && info.screen !== undefined) {
    var sp = screenProgress(L, info.checker, info.screen, info.king);
    var q = clamp01((p - sp) / Math.max(0.12, 1 - sp));
    pulseRings(ctx, L, info.screen, q, opts.rings || 1);
  }
}

/** 几枚子各拉一条线指向将（双车错 / 天地炮 / 夹车炮共用） */
function sweepFromPieces(ctx, L, info, p) {
  var pieces = info.pieces || [];
  var b = L.pointOf(info.king);
  for (var i = 0; i < pieces.length; i++) {
    var a = L.pointOf(pieces[i]);
    // 逐条错开一拍起步，形成「交替配合」而不是同时
    var q = clamp01((p - i * 0.18) / (1 - i * 0.18));
    if (q <= 0) continue;
    glowLine(ctx, L, a.x, a.y, a.x + (b.x - a.x) * q, a.y + (b.y - a.y) * q, 0.05);
  }
}

/** 门闩：在将门那一格横一道粗线，像落下的门闩 */
function doorBar(ctx, L, doorIdx, p) {
  if (p <= 0) return;
  var pt = L.pointOf(doorIdx);
  var half = L.pieceRadius * (0.45 + 0.75 * p);

  ctx.save();
  ctx.globalAlpha = 0.35 + 0.65 * p;
  ctx.strokeStyle = FX.line;
  ctx.lineWidth = Math.max(2, L.cell * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pt.x - half, pt.y);
  ctx.lineTo(pt.x + half, pt.y);
  ctx.stroke();
  ctx.restore();
}

/** 月牙：海底捞月的意象——一弯月弧从将的下方兜上来 */
function crescent(ctx, L, kingIdx, p) {
  if (p <= 0) return;
  var pt = L.pointOf(kingIdx);
  var r = L.cell * (0.52 + 0.32 * p);

  ctx.save();
  ctx.globalAlpha = 0.55 * p;
  ctx.strokeStyle = FX.line;
  ctx.lineWidth = Math.max(1, L.cell * 0.05);
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, r, Math.PI * 0.18, Math.PI * 0.82);
  ctx.stroke();
  ctx.restore();
}

/** 马系：从马到将画一条「日」字轨迹（先走长边，再走短边） */
function traceKnight(ctx, L, info, p) {
  var a = L.pointOf(info.checker);
  var b = L.pointOf(info.king);
  var dx = b.x - a.x;
  var dy = b.y - a.y;

  // 马的走法是「一长一短」，长边先走
  var corner = Math.abs(dx) > Math.abs(dy)
    ? { x: b.x, y: a.y }
    : { x: a.x, y: b.y };

  var leg1 = Math.abs(corner.x - a.x) + Math.abs(corner.y - a.y);
  var leg2 = Math.abs(b.x - corner.x) + Math.abs(b.y - corner.y);
  var total = leg1 + leg2;
  if (total <= 0) return;

  var travelled = total * p;
  if (travelled <= leg1) {
    var q1 = leg1 > 0 ? travelled / leg1 : 1;
    glowLine(ctx, L, a.x, a.y, a.x + (corner.x - a.x) * q1, a.y + (corner.y - a.y) * q1, 0.05);
  } else {
    glowLine(ctx, L, a.x, a.y, corner.x, corner.y, 0.05);
    var q2 = leg2 > 0 ? (travelled - leg1) / leg2 : 1;
    glowLine(ctx, L, corner.x, corner.y,
      corner.x + (b.x - corner.x) * q2, corner.y + (b.y - corner.y) * q2, 0.05);
  }

  // 落点闪一下，强调「马踏到这一格」
  pulseRings(ctx, L, info.king, clamp01((p - 0.8) / 0.2), 1);
}

/** 闷系：将四周四道短线合拢成框，表示被自家子堵死 */
function closingBox(ctx, L, kingIdx, p) {
  if (p <= 0) return;
  var pt = L.pointOf(kingIdx);
  var near = L.cell * 0.34;
  var far = L.cell * 0.78;
  var d = near + (far - near) * p;

  ctx.save();
  ctx.strokeStyle = FX.line;
  ctx.lineWidth = Math.max(1, L.cell * 0.055);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.35 + 0.65 * p;
  ctx.beginPath();
  for (var sx = -1; sx <= 1; sx += 2) {
    ctx.moveTo(pt.x + sx * d, pt.y - L.cell * 0.26);
    ctx.lineTo(pt.x + sx * d, pt.y + L.cell * 0.26);
  }
  for (var sy = -1; sy <= 1; sy += 2) {
    ctx.moveTo(pt.x - L.cell * 0.26, pt.y + sy * d);
    ctx.lineTo(pt.x + L.cell * 0.26, pt.y + sy * d);
  }
  ctx.stroke();
  ctx.restore();
}

/** 对面笑：两帅之间一道光柱贯穿 */
function beam(ctx, L, a, b, p) {
  if (p <= 0) return;
  var pa = L.pointOf(a);
  var pb = L.pointOf(b);
  var x = pa.x + (pb.x - pa.x) * p;
  var y = pa.y + (pb.y - pa.y) * p;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = FX.lineGlow;
  ctx.lineWidth = L.cell * 0.42;
  ctx.beginPath();
  ctx.moveTo(pa.x, pa.y);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = FX.line;
  ctx.lineWidth = Math.max(1, L.cell * 0.06);
  ctx.beginPath();
  ctx.moveTo(pa.x, pa.y);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.restore();
}

/** 二鬼拍门：两条封线从两兵向外拉开，锁住两条肋道 */
function lockLines(ctx, L, pawns, kingIdx, p) {
  var kp = L.pointOf(kingIdx);
  for (var i = 0; i < pawns.length && i < 2; i++) {
    var pp = L.pointOf(pawns[i]);
    var q = clamp01((p - i * 0.18) / (1 - i * 0.18));
    if (q <= 0) continue;
    glowLine(ctx, L, pp.x, pp.y,
      pp.x + (kp.x - pp.x) * q, pp.y + (kp.y - pp.y) * q, 0.05);
  }
}

// ---------------------------------------------------------------------------
// 结算卡
// ---------------------------------------------------------------------------

function drawCard(ctx, w, h, self, pName, pUi) {
  if (pName <= 0) return;
  var card = self.cardRect(w, h);
  var cx = card.x + card.w / 2;

  ctx.save();
  ctx.globalAlpha = pName;

  // 卡片：深色描金，与棋盘同一套质感
  ctx.fillStyle = FX.cardFill;
  W.roundRectPath(ctx, card.x, card.y, card.w, card.h, 14);
  ctx.fill();
  ctx.strokeStyle = FX.cardEdge;
  ctx.lineWidth = 1;
  W.roundRectPath(ctx, card.x, card.y, card.w, card.h, 14);
  ctx.stroke();
  ctx.strokeStyle = FX.cardEdgeInner;
  ctx.lineWidth = 0.8;
  W.roundRectPath(ctx, card.x + 5, card.y + 5, card.w - 10, card.h - 10, 10);
  ctx.stroke();

  // 杀法名：放大落款，用棋盘同一套书法字栈
  var title = self.title();
  var size = title.length <= 3 ? 36 : (title.length <= 5 ? 27 : 21);
  ctx.save();
  ctx.translate(cx, card.y + 46);
  ctx.scale(0.7 + 0.3 * pName, 0.7 + 0.3 * pName);
  ctx.fillStyle = FX.name;
  ctx.font = 'bold ' + size + 'px ' + Renderer.PIECE_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 0, 0);
  ctx.restore();

  // 胜负
  ctx.fillStyle = FX.sub;
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(self.subtitle(), cx, card.y + 80);

  // 按钮：晚一拍浮出
  if (pUi > 0) {
    ctx.globalAlpha = pName * pUi;
    for (var i = 0; i < self.buttons.length; i++) {
      var b = self.buttons[i];
      var down = self.pressed === b.id;
      var primary = b.style !== 'ghost';
      ctx.fillStyle = primary
        ? (down ? FX.btnFillDown : FX.btnFill)
        : (down ? 'rgba(233,168,52,0.14)' : 'rgba(0,0,0,0)');
      W.roundRectPath(ctx, b.x, b.y, b.w, b.h, 8);
      ctx.fill();
      ctx.strokeStyle = primary ? FX.btnEdge : FX.btnEdgeDim;
      ctx.lineWidth = primary ? 1.2 : 1;
      W.roundRectPath(ctx, b.x, b.y, b.w, b.h, 8);
      ctx.stroke();

      ctx.fillStyle = primary ? FX.btnText : FX.btnTextDim;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 0.5);
    }
  }

  ctx.restore();
}

module.exports = Endgame;
module.exports.FX = FX;
module.exports.TIMELINE = { DIM: T_DIM, SHOW: T_SHOW, NAME: T_NAME, UI: T_UI, END: T_END };
