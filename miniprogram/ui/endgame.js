/**
 * 绝杀演出
 *
 * 替代原来的 wx.showModal 纯文字弹窗：终局时在棋盘上演一段「怎么杀的」，
 * 再落款给出杀法名与结果，最后浮出「再来一局 / 回菜单」两个按钮。
 *
 * 镜头化时间线（三拍 + 两处剪辑手法）：
 *   ① 压暗   棋盘蒙一层暗场，其余棋子沉下去
 *   ② 演示   按 result.mateInfo 的几何画出该杀法的专属母题；
 *            同时整盘向「将」缓推 1.06x（推镜，把视线押到要害上）
 *   ②.5 顿帧  演示毕、落款前静止 130ms——重击前的沉默，电影重击感来源
 *   ③ 落款   杀法名以书法字放大落款，金墨滴溅落 + 胜负 + 按钮浮出
 *
 * 交互约定：
 *   - 演出途中点屏幕 -> 直接跳到落款（每局等两秒会烦，跳过是必须的）
 *   - 落款后按钮才可点，按钮出现前点屏幕只会跳过
 *
 * 只依赖 Canvas 2D（棋子与光晕复用 ui/renderer，墨滴用 ui/particles），
 * 可在 node 下用桩上下文单测。
 */

var C = require('../core/constants.js');
var Renderer = require('./renderer.js');
var W = require('./widgets.js');
var Particles = require('./particles.js');

// ---------------------------------------------------------------------------
// 时间线（毫秒）
// ---------------------------------------------------------------------------

var T_DIM = 350;    // ① 压暗结束
var T_SHOW = 1050;  // ② 演示杀招结束
var T_HOLD = 1180;  // ②.5 顿帧结束
var T_NAME = 1880;  // ③ 落款浮现结束
var T_UI = 2180;    // 按钮浮出结束
var T_END = T_UI + 300;

/** 推镜幅度：演示拍向将缓推的倍率（1 → 1+ZOOM） */
var ZOOM = 0.06;

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
  /** 落款金墨滴（自建小池，与对局粒子互不干扰） */
  this.fx = Particles.create(20);
  /** 墨滴是否已溅（顿帧结束进入落款时触发一次） */
  this._inked = false;
  /** 最近一次 draw 的屏幕尺寸（tick 里定位墨滴用） */
  this._w = 0;
  this._h = 0;
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
  this.fx.clear();
  this._inked = false;
  return this;
};

Endgame.prototype.reset = function () {
  this.active = false;
  this.t = 0;
  this.pressed = null;
  this.buttons = [];
  this.fx.clear();
  this._inked = false;
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
  // 顿帧结束、落款起笔：溅金墨滴（只溅一次）
  if (!this._inked && this.t >= T_HOLD && this.t < T_END) {
    this._inked = true;
    this._splashInk();
  }
  this.fx.tick(dt);
  return this.t;
};

/** 跳过演出：直接落到落款完成态（不再补墨滴，跳就跳干净） */
Endgame.prototype.skip = function () {
  if (!this.active) return false;
  this.t = T_END;
  this._inked = true;
  return true;
};

/** 落款起笔时的金墨滴：从标题字的位置向外溅落 */
Endgame.prototype._splashInk = function () {
  if (!this._w || !this._h) return;
  var card = this.cardRect(this._w, this._h);
  Particles.burst(this.fx, card.x + card.w / 2, card.y + 46, {
    n: 6, shape: 'drop',
    colors: ['#f2dcae', '#d9b878', '#b98f52'],
    speed: 130, dirX: 0, dirY: -1, spread: Math.PI * 1.2,
    size: [1.4, 2.8], ttl: [420, 720],
    gravity: 1500, vr: 4
  });
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
  this._w = w;
  this._h = h;

  var t = this.t;
  var pDim = easeOut(seg(t, 0, T_DIM));
  var pShow = seg(t, T_DIM, T_SHOW);
  var pName = easeOut(seg(t, T_HOLD, T_NAME));
  var pUi = easeOut(seg(t, T_NAME, T_UI));

  // ① 压暗：连工具栏一起盖住，整屏进入结算
  ctx.save();
  ctx.globalAlpha = 0.62 * pDim;
  ctx.fillStyle = FX.scrim;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // ② 演示：先把杀招相关的棋子重画一遍浮出暗场，再画母题。
  // 推镜：整盘以「将」为焦点缓推 1+ZOOM，顿帧保持，落款时缓退还原——
  // 只推高亮与母题这一层，暗场与结算卡不动（镜头推的是棋盘，不是 UI）
  var L = this.layout;
  if (L && this.board && this.mateInfo) {
    var zoom = 1 + ZOOM * easeOut(seg(t, T_DIM * 0.5, T_SHOW)) -
      ZOOM * easeOut(seg(t, T_HOLD, T_NAME));
    ctx.save();
    if (zoom > 1.0005 && this.mateInfo.king !== null && this.mateInfo.king !== undefined) {
      var kp = L.pointOf(this.mateInfo.king);
      var fx0 = boardX + kp.x;
      var fy0 = boardY + kp.y;
      ctx.translate(fx0, fy0);
      ctx.scale(zoom, zoom);
      ctx.translate(-fx0, -fy0);
    }
    ctx.save();
    ctx.translate(boardX, boardY);
    // 动作层调度：跃迁的马/冲锋的车在高亮层让位；将按命中时刻表震颤
    var plan = actorsPlan(this.mateInfo, pShow);
    plan.shakeQ = actorShake(this.mateInfo, pShow);
    drawHighlights(ctx, L, this.board, this.mateInfo, pDim, plan);
    drawMotif(ctx, L, this.mateInfo, pShow);
    paintActors(ctx, L, this.board, this.mateInfo, pShow);
    ctx.restore();
    ctx.restore();
  }

  // ③ 落款
  this.layoutButtons(w, h);
  drawCard(ctx, w, h, this, pName, pUi);

  // 金墨滴盖在卡片之上（墨是溅出来的，不该被卡片边缘裁掉）
  this.fx.draw(ctx);
};

/** 把构成该杀法的棋子 + 被将的将浮出暗场 */
function drawHighlights(ctx, L, board, info, p, opts) {
  if (p <= 0) return;
  opts = opts || {};
  var hide = opts.hide || null;
  var shakeQ = opts.shakeQ || 0;
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
    // 演员（跃迁的马/冲锋的车）由动作层另画，这里让位，避免双重影像
    if (hide && hide[k]) continue;
    // 将中弹震颤：横向快速衰减抖动
    if (shakeQ > 0 && k === info.king) {
      var dx = Math.sin(shakeQ * Math.PI * 5) * L.cell * 0.055 * (1 - shakeQ);
      Renderer.drawPieceAt(ctx, L, L.xOf(k) + dx, L.yOf(k), board[k], null);
      continue;
    }
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
// 动作层：棋子亲自演（炮弹 / 马跃 / 车冲 / 命中反馈），叠加在线条母题之上
//
// 全部是进度 p 的纯函数（无内部状态、无随机源），可复现、可单测；
// 线条母题降级为弹道/轨迹底衬，演员层负责「形象」。
// ---------------------------------------------------------------------------

var KNIGHT_KEYS = { wocaoma: 1, guajiaoma: 1, diaoyuma: 1, cemianhu: 1 };

/**
 * 炮弹：炮口聚能（前 18%）→ 火球带尾迹沿 (a→b) 飞出
 * q 为本发炮弹的局部进度 0~1；q>=1 时炮弹已炸，不再绘制
 */
function shell(ctx, L, a, b, q) {
  if (q <= 0 || q >= 1) return;
  var fly = clamp01((q - 0.18) / 0.82);
  ctx.save();
  if (fly <= 0) {
    // 聚能：炮口光点膨胀
    var charge = q / 0.18;
    ctx.globalAlpha = 0.5 + 0.5 * charge;
    ctx.fillStyle = FX.pulse;
    ctx.beginPath();
    ctx.arc(a.x, a.y, L.pieceRadius * (0.15 + 0.45 * charge), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // 尾迹三点：越靠后越小越淡
  var i, tb;
  ctx.fillStyle = FX.line;
  for (i = 1; i <= 3; i++) {
    tb = fly - i * 0.07;
    if (tb <= 0) continue;
    ctx.globalAlpha = 0.55 * (1 - i / 4);
    ctx.beginPath();
    ctx.arc(a.x + (b.x - a.x) * tb, a.y + (b.y - a.y) * tb,
      L.pieceRadius * (0.30 - i * 0.06), 0, Math.PI * 2);
    ctx.fill();
  }
  // 火球本体：径向渐变的光球
  var x = a.x + (b.x - a.x) * fly;
  var y = a.y + (b.y - a.y) * fly;
  var r = L.pieceRadius * 0.5;
  var g = ctx.createRadialGradient(x, y, r * 0.15, x, y, r);
  g.addColorStop(0, 'rgba(255,236,180,1)');
  g.addColorStop(0.45, 'rgba(255,180,80,0.85)');
  g.addColorStop(1, 'rgba(220,80,30,0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * 命中爆点：星芒八道（先长后缩）+ 火花五粒（固定角度，不用随机源）+ 扩散环
 * q 0~1，窗外不画
 */
function explosion(ctx, L, pt, q) {
  if (q <= 0 || q >= 1) return;
  var i;
  ctx.save();
  // 星芒
  var grow = q < 0.4 ? q / 0.4 : 1 - (q - 0.4) / 0.6;
  var ray = L.cell * (0.12 + 0.55 * grow);
  ctx.strokeStyle = FX.line;
  ctx.globalAlpha = 1 - q * 0.7;
  ctx.lineWidth = Math.max(1, L.cell * 0.05 * (1 - q * 0.5));
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (i = 0; i < 8; i++) {
    var ang = i * Math.PI / 4 + Math.PI / 8;
    ctx.moveTo(pt.x + Math.cos(ang) * ray * 0.3, pt.y + Math.sin(ang) * ray * 0.3);
    ctx.lineTo(pt.x + Math.cos(ang) * ray, pt.y + Math.sin(ang) * ray);
  }
  ctx.stroke();
  // 火花：向外飞散、微微上飘、淡出
  ctx.fillStyle = FX.pulse;
  for (i = 0; i < 5; i++) {
    var a2 = i * (Math.PI * 2 / 5) + 0.6;
    var d = L.cell * 0.9 * q;
    ctx.globalAlpha = 0.9 * (1 - q);
    ctx.beginPath();
    ctx.arc(pt.x + Math.cos(a2) * d, pt.y + Math.sin(a2) * d - L.cell * 0.2 * q * q,
      Math.max(0.6, 2.2 * (1 - q)), 0, Math.PI * 2);
    ctx.fill();
  }
  // 扩散环
  ctx.globalAlpha = 0.7 * (1 - q);
  ctx.strokeStyle = FX.pulse;
  ctx.lineWidth = Math.max(0.8, L.cell * 0.05 * (1 - q));
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, L.pieceRadius + L.cell * 0.5 * q, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** 炮架亮一下：炮弹掠过瞬间按钟形窗提亮（点出「它是炮架」） */
function screenFlash(ctx, L, idx, q) {
  if (q <= 0 || q >= 1 || idx === null || idx === undefined) return;
  var bell = Math.sin(Math.PI * q);
  Renderer.drawPieceGlow(ctx, L, idx, FX.pulse, bell * 0.8);
}

/**
 * 炮系动作：每门炮错拍 0.16 出一发炮弹，弹着点爆点；最后一发大爆
 * @param {number[]} cannons 开炮的棋子（按出膛顺序）
 * @param {number} [glowIdx] 炮弹掠过时需要提亮的炮架
 */
function cannonActors(ctx, L, info, p, cannons, glowIdx) {
  var kp = L.pointOf(info.king);
  for (var i = 0; i < cannons.length; i++) {
    var a = L.pointOf(cannons[i]);
    var q = clamp01((p - i * 0.16) / 0.56);
    shell(ctx, L, a, kp, q);
    // 炮弹掠过炮架：按飞行进度与炮架位置的距离开窗
    if (glowIdx !== null && glowIdx !== undefined && i === 0 && info.screen !== null && info.screen !== undefined) {
      var fly = clamp01((q - 0.18) / 0.82);
      var sp = screenProgress(L, info.checker, info.screen, info.king);
      screenFlash(ctx, L, glowIdx, clamp01((fly - (sp - 0.12)) / 0.24));
    }
    // 弹着爆点：本发命中时刻 hit = i*0.16 + 0.56
    explosion(ctx, L, kp, clamp01((p - (i * 0.16 + 0.56)) / 0.30));
  }
}

/** 炮系命中时刻表（与 cannonActors 的错拍一致，供将震颤纯函数使用） */
function cannonHits(info) {
  var key = info.key;
  var n = 1;
  if (key === 'chongpao' || key === 'tiandipao' || key === 'jiachepao') n = 2;
  var hits = [];
  for (var i = 0; i < n; i++) hits.push(i * 0.16 + 0.56);
  return hits;
}

/** 马系动作：马沿日字两跳（各带抛物抬升），身后残影，拐角与落点踏尘环 */
function knightActors(ctx, L, info, p, board) {
  if (p <= 0.02 || p >= 0.97) return;
  var a = L.pointOf(info.checker);
  var b = L.pointOf(info.king);
  var dx = b.x - a.x;
  var dy = b.y - a.y;
  var corner = Math.abs(dx) > Math.abs(dy) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  var leg1 = Math.abs(corner.x - a.x) + Math.abs(corner.y - a.y);
  var leg2 = Math.abs(b.x - corner.x) + Math.abs(b.y - corner.y);
  var total = leg1 + leg2;
  if (total <= 0) return;

  function posAt(q) {
    var d = total * clamp01(q);
    if (d <= leg1) {
      var t = leg1 > 0 ? d / leg1 : 1;
      return {
        x: a.x + (corner.x - a.x) * t,
        y: a.y + (corner.y - a.y) * t - L.cell * 0.30 * Math.sin(Math.PI * t)
      };
    }
    var t2 = leg2 > 0 ? (d - leg1) / leg2 : 1;
    return {
      x: corner.x + (b.x - corner.x) * t2,
      y: corner.y + (b.y - corner.y) * t2 - L.cell * 0.30 * Math.sin(Math.PI * t2)
    };
  }

  var piece = board[info.checker];
  // 残影两匹：滞后 0.09 / 0.045，越拖越淡
  var ghosts = [0.09, 0.045];
  for (var i = 0; i < ghosts.length; i++) {
    var gq = p - ghosts[i];
    if (gq <= 0.02) continue;
    var gp = posAt(gq);
    Renderer.drawPieceAt(ctx, L, gp.x, gp.y, piece, { alpha: 0.14 + i * 0.13 });
  }
  // 本体（略放大，奔腾感）
  var pos = posAt(p);
  Renderer.drawPieceAt(ctx, L, pos.x, pos.y, piece, { scale: 1.06 });

  // 蹄印尘环：第一跳落拐角、第二跳踏向将
  var split = leg1 / total;
  drawDustRing(ctx, L, corner, clamp01((p - split) / 0.18));
  drawDustRing(ctx, L, b, clamp01((p - 0.9) / 0.1));
  // 踏将爆点
  explosion(ctx, L, b, clamp01((p - 0.88) / 0.12));
}

/** 落定尘环：一小圈外扩的淡环（pulseRings 的坐标版） */
function drawDustRing(ctx, L, pt, q) {
  if (q <= 0 || q >= 1) return;
  ctx.save();
  ctx.globalAlpha = 0.6 * (1 - q);
  ctx.strokeStyle = FX.pulse;
  ctx.lineWidth = Math.max(0.8, L.cell * 0.05 * (1 - q * 0.5));
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, L.pieceRadius * 0.6 + L.cell * 0.35 * q, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** 车系动作：每枚车错拍向将实冲一段（正弦去回），车尾拉三条速度线 */
function rookActors(ctx, L, info, p, board) {
  var kp = L.pointOf(info.king);
  for (var i = 0; i < info.pieces.length; i++) {
    var idx = info.pieces[i];
    var q = clamp01((p - i * 0.22) / 0.6);
    if (q <= 0 || q >= 1) continue;
    var a = L.pointOf(idx);
    var dx = kp.x - a.x;
    var dy = kp.y - a.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d <= 0) continue;
    dx /= d; dy /= d;

    var push = Math.sin(Math.PI * q) * L.cell * 0.42;
    // 速度线：冲得越猛越长（与位移同相）
    var vigor = Math.sin(Math.PI * q);
    ctx.save();
    ctx.strokeStyle = FX.line;
    ctx.lineCap = 'round';
    for (var j = 0; j < 3; j++) {
      var off = L.pieceRadius + L.cell * (0.10 + j * 0.13);
      var len = L.cell * 0.34 * vigor * (1 - j * 0.25);
      if (len <= 0.5) continue;
      ctx.globalAlpha = 0.75 * vigor * (1 - j * 0.28);
      ctx.lineWidth = Math.max(1, L.cell * (0.055 - j * 0.012));
      ctx.beginPath();
      ctx.moveTo(a.x + dx * push - dx * off, a.y + dy * push - dy * off);
      ctx.lineTo(a.x + dx * push - dx * (off + len), a.y + dy * push - dy * (off + len));
      ctx.stroke();
    }
    ctx.restore();
    Renderer.drawPieceAt(ctx, L, a.x + dx * push, a.y + dy * push, board[idx], { scale: 1.04 });
  }
}

/**
 * 将震颤进度（纯函数）：各杀法「打到将」的时刻表统一在这里，
 * 高亮层按它给将加抖动——与动作层的爆点共用同一组时刻，保证声画同拍
 */
function actorShake(info, p) {
  var key = info.key;
  var beats;
  if (KNIGHT_KEYS[key]) beats = [0.88];
  else if (key === 'shuangchecuo') {
    beats = [];
    for (var i = 0; i < info.pieces.length; i++) beats.push(i * 0.22 + 0.30);
  } else if (key === 'mahoupao' || key === 'mengong' || key === 'mensha' ||
             key === 'chongpao' || key === 'tiandipao' || key === 'jiachepao') {
    beats = cannonHits(info);
  } else {
    return 0;
  }
  var shakeQ = 0;
  for (var j = 0; j < beats.length; j++) {
    var q = clamp01((p - beats[j]) / 0.30);
    if (q > shakeQ && q < 1) shakeQ = q;
  }
  return shakeQ;
}

/**
 * 动作层调度（纯函数）：算出高亮层要让位的演员（跃迁的马/冲锋的车）
 * @returns {{hide:Object}}
 */
function actorsPlan(info, p) {
  var plan = { hide: {} };
  if (!info || p <= 0) return plan;
  var key = info.key;

  if (KNIGHT_KEYS[key]) {
    if (p > 0.02 && p < 0.97) plan.hide[info.checker] = true;
    return plan;
  }
  if (key === 'shuangchecuo') {
    for (var i = 0; i < info.pieces.length; i++) {
      var q = clamp01((p - i * 0.22) / 0.6);
      if (q > 0.02 && q < 0.98) plan.hide[info.pieces[i]] = true;
    }
  }
  return plan;
}

/** 动作层绘制（在高亮与母题之后） */
function paintActors(ctx, L, board, info, p) {
  if (!info || p <= 0) return;
  var key = info.key;
  if (KNIGHT_KEYS[key]) { knightActors(ctx, L, info, p, board); return; }
  if (key === 'shuangchecuo') { rookActors(ctx, L, info, p, board); return; }

  var cannons = null;
  var glow = null;
  if (key === 'mahoupao' || key === 'mengong' || key === 'mensha') {
    cannons = [info.checker];
    glow = info.screen;
  } else if (key === 'chongpao') {
    cannons = [info.checker, info.screen];
    glow = info.screen;
  } else if (key === 'tiandipao' || key === 'jiachepao') {
    cannons = (info.pieces || []).slice(0, 2);
  }
  if (cannons && cannons.length) cannonActors(ctx, L, info, p, cannons, glow);
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
