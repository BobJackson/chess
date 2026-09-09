/**
 * 对局场景：人机 / 本地双人 / 联机
 *
 * 复用 ui/controller（触摸状态机）与 ui/renderer（棋盘绘制），
 * 本场景只负责：屏幕布局（状态栏 + 棋盘 + 工具栏）、坐标换算、
 * AI 回合调度、联机会话事件绑定、工具栏按钮的自绘与命中。
 */
var Game = require('../core/game.js');
var AI = require('../core/ai.js');
var Layout = require('../ui/layout.js');
var Renderer = require('../ui/renderer.js');
var Controller = require('../ui/controller.js');
var C = require('../core/constants.js');
var W = require('../ui/widgets.js');

/** layout.height / layout.width 的固定比例（由 PADDING_RATIO 决定） */
var BOARD_ASPECT = 10.24 / 9.24;

// ---------------------------------------------------------------------------
// 屏幕级装饰（美化棋盘上下的留白）
// ---------------------------------------------------------------------------

/** 整屏纵向渐变底色，比纯色更有"桌布"质感 */
function drawScreenBg(ctx, w, h) {
  var g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f8eed9');
  g.addColorStop(0.5, '#f1e2c2');
  g.addColorStop(1, '#e6d2a8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** 棋盘衬底：一圈略大的"棋桌"面板 + 投影 + 内描边 */
function drawPanel(ctx, x, y, w, h) {
  ctx.save();
  ctx.shadowColor = 'rgba(93,64,55,0.28)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  ctx.fillStyle = '#dcc08c';
  W.roundRectPath(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(93,64,55,0.35)';
  ctx.lineWidth = 1;
  W.roundRectPath(ctx, x + 4, y + 4, w - 8, h - 8, 10);
  ctx.stroke();
  ctx.restore();
}

/** 中式分隔饰线：两端细线 + 中心菱形 */
function drawOrnament(ctx, cx, cy, halfW) {
  ctx.save();
  ctx.strokeStyle = 'rgba(93,64,55,0.30)';
  ctx.fillStyle = 'rgba(93,64,55,0.30)';
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
  ctx.fillStyle = '#5d4037';
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

function createBoardScene(app) {
  var scene = {
    name: 'board',
    app: app,
    mode: 'ai',
    session: null,
    game: null,
    controller: null,
    layout: null,
    aiThinking: false,
    dirty: true,
    lastTs: 0,
    uiBtn: null,
    statusText: '',
    modeLabel: '',
    toolbar: [],
    boardX: 0,
    boardTop: 0,
    statusH: 44,
    toolbarH: 60
  };

  // -------------------------------------------------------------------------

  scene.onEnter = function (params) {
    scene.mode = params.mode === 'local' ? 'local' : (params.mode === 'online' ? 'online' : 'ai');
    scene.session = scene.mode === 'online' ? app.session : null;
    if (scene.mode === 'online' && !scene.session) { app.go('menu'); return; }

    scene.difficulty = app.difficulty;
    scene.humanSide = scene.mode === 'online' ? scene.session.mySide : C.RED;
    scene.aiSide = 1 - scene.humanSide;

    scene.measure();
    scene.layout = new Layout(scene.boardWidth, scene.humanSide === C.BLACK);

    scene.game = (scene.mode === 'online' && scene.session.game) ? scene.session.game : new Game();
    scene.controller = new Controller(scene.layout, scene.game, {
      canMove: scene.canMove.bind(scene),
      onMoved: scene.onMoved.bind(scene),
      onIllegal: scene.onIllegal.bind(scene),
      onSelect: scene.onSelect.bind(scene),
      onCapture: scene.onCapture.bind(scene)
    });

    if (scene.mode === 'online') scene.bindSession();

    scene.modeLabel = scene.mode === 'online'
      ? '联机 · 房间 ' + scene.session.room + ' · 执' + (scene.humanSide === C.RED ? '红' : '黑')
      : (scene.mode === 'ai'
        ? '人机 · ' + AI.LEVELS[scene.difficulty].label + ' · 执' + (scene.humanSide === C.RED ? '红' : '黑')
        : '本地双人');

    scene.buildToolbar();
    scene.refreshStatus();
    scene.dirty = true;

    if (scene.mode === 'ai' && scene.game.pos.side === scene.aiSide) scene.scheduleAi();
  };

  scene.measure = function () {
    var w = app.w, h = app.h;
    // 可用区域：状态栏与工具栏之间
    scene.areaTop = scene.statusH + 6;
    scene.areaBottom = h - scene.toolbarH - 6;
    var availH = scene.areaBottom - scene.areaTop;

    // 侧边留出呼吸边距；高度受限时按可用高度缩放
    scene.boardWidth = Math.min(w - 24, availH / BOARD_ASPECT);
    scene.boardHeight = scene.boardWidth * BOARD_ASPECT;
    scene.boardX = (w - scene.boardWidth) / 2;
    // 垂直居中：上下留白均分
    scene.boardTop = scene.areaTop + Math.max(0, (availH - scene.boardHeight) / 2);
  };

  scene.buildToolbar = function () {
    var w = app.w;
    var pad = 10, gap = 8;
    var labels = ['悔棋', '提示', '翻转', '重开', '菜单'];
    var ids = ['undo', 'hint', 'flip', 'restart', 'back'];
    var bw = (w - pad * 2 - gap * 4) / 5;
    var y = app.h - scene.toolbarH + 10;
    scene.toolbar = ids.map(function (id, i) {
      return W.makeButton(id, pad + i * (bw + gap), y, bw, 38, labels[i], 'ghost');
    });
  };

  // -------------------------------------------------------------------------
  // Controller 回调

  scene.canMove = function () {
    if (scene.mode === 'online') return scene.session.canPlay();
    if (scene.aiThinking) return false;
    if (scene.mode === 'local') return true;
    return scene.game.pos.side === scene.humanSide;
  };

  scene.onMoved = function (res) {
    scene.dirty = true;
    scene.refreshStatus();
    scene.sfxMove(res);
    if (scene.mode === 'online' && res && res.entry) {
      scene.session.broadcastMove(res.entry.from, res.entry.to);
      if (scene.game.result) scene.showResult();
      return;
    }
    if (scene.game.result) scene.showResult();
    else if (scene.mode === 'ai' && scene.game.pos.side === scene.aiSide) scene.scheduleAi();
  };

  scene.onIllegal = function (msg) { app.toast(msg || '不符合走法'); };
  scene.onSelect = function () { scene.dirty = true; };
  scene.onCapture = function () { if (wx.vibrateShort) wx.vibrateShort({ type: 'light' }); };

  /** 一步棋的音效：落子/吃子 + 将军警示 */
  scene.sfxMove = function (res) {
    var cap = res && res.entry && res.entry.captured !== C.EMPTY;
    app.audio.play(cap ? 'capture' : 'move');
    if (!scene.game.result && scene.game.isChecked()) app.audio.play('check');
  };

  // -------------------------------------------------------------------------
  // 联机事件

  scene.bindSession = function () {
    var o = scene.session.options;
    o.onRemoteMove = function (res) {
      scene.dirty = true; scene.refreshStatus();
      scene.sfxMove(res);
      if (scene.game.result) scene.showResult();
    };
    o.onResync = function (game) {
      scene.game = game;
      scene.controller.setGame(game);
      scene.dirty = true; scene.refreshStatus();
    };
    o.onResult = function () {
      scene.dirty = true; scene.refreshStatus(); scene.showResult();
    };
    o.onOpponentLeft = function () {
      scene.dirty = true; scene.refreshStatus();
      if (!scene.game.result) {
        scene.game.finish(scene.humanSide, '对手离开');
        scene.session.broadcastResult(scene.game.result);
        scene.showResult();
      }
    };
  };

  // -------------------------------------------------------------------------
  // AI 回合

  scene.scheduleAi = function () {
    if (scene.aiThinking || scene.game.result) return;
    scene.aiThinking = true;
    scene.dirty = true;
    scene.refreshStatus();
    setTimeout(function () {
      var mv = null;
      try {
        mv = AI.findBestMove(scene.game.pos, {
          level: scene.difficulty,
          moveNumber: Math.floor(scene.game.plyCount() / 2)
        });
      } catch (e) { mv = null; }
      scene.aiThinking = false;
      if (mv) scene.game.move(mv.from, mv.to);
      scene.dirty = true;
      scene.refreshStatus();
      if (scene.game.result) scene.showResult();
    }, 30);
  };

  // -------------------------------------------------------------------------
  // 状态与弹窗

  scene.refreshStatus = function () {
    var g = scene.game;
    if (!g) return;
    if (g.result) scene.statusText = g.result.text;
    else if (scene.aiThinking) scene.statusText = 'AI 思考中…';
    else scene.statusText = '轮到 ' + (g.pos.side === C.RED ? '红方' : '黑方') + (g.isChecked() ? '（被将军）' : '');
  };

  scene.showResult = function () {
    var win = scene.mode === 'local' ? true : (scene.game.result.winner === scene.humanSide);
    app.audio.play(win ? 'win' : 'lose');
    wx.showModal({ title: '对局结束', content: scene.game.result.text, showCancel: false, confirmText: '知道了' });
  };

  // -------------------------------------------------------------------------
  // 触摸

  scene.toBoard = function (x, y) {
    return { x: x - scene.boardX, y: y - scene.boardTop };
  };

  scene.onTouch = function (type, x, y) {
    // 工具栏优先
    if (type === 'start') {
      scene.uiBtn = null;
      for (var i = 0; i < scene.toolbar.length; i++) {
        if (W.hitButton(scene.toolbar[i], x, y)) { scene.uiBtn = scene.toolbar[i].id; return; }
      }
    }
    if (scene.uiBtn) {
      if (type === 'end') {
        var id = scene.uiBtn;
        scene.uiBtn = null;
        for (var b = 0; b < scene.toolbar.length; b++) {
          if (scene.toolbar[b].id === id && W.hitButton(scene.toolbar[b], x, y)) { scene.toolAction(id); return; }
        }
      }
      return;
    }

    var p = scene.toBoard(x, y);
    var changed = false;
    if (type === 'start') changed = scene.controller.touchStart(p.x, p.y);
    else if (type === 'move') changed = scene.controller.touchMove(p.x, p.y);
    else if (type === 'end') changed = scene.controller.touchEnd(p.x, p.y);
    else changed = scene.controller.touchCancel();
    if (changed) scene.dirty = true;
  };

  scene.toolAction = function (id) {
    if (id === 'undo') app.audio.play('undo');
    else app.audio.play('tap');
    if (id === 'back') { scene.leave(); app.go('menu'); return; }
    if (id === 'undo') {
      if (scene.mode === 'online') { app.toast('联机不可悔棋'); return; }
      if (scene.aiThinking || !scene.game.history.length) return;
      scene.game.undo(scene.mode === 'ai' ? 2 : 1);
      scene.controller.reset();
      scene.dirty = true; scene.refreshStatus();
      return;
    }
    if (id === 'hint') {
      if (!scene.controller.canOperate()) { app.toast('现在不能提示'); return; }
      var h = AI.getHint(scene.game.pos);
      if (h) { scene.controller.setHint({ from: h.from, to: h.to }); scene.dirty = true; }
      return;
    }
    if (id === 'flip') { scene.layout.setFlipped(!scene.layout.flipped); scene.dirty = true; return; }
    if (id === 'restart') {
      if (scene.mode === 'online') { app.toast('联机不可重开'); return; }
      scene.aiThinking = false;
      scene.game = new Game();
      scene.controller.setGame(scene.game);
      scene.dirty = true; scene.refreshStatus();
      if (scene.mode === 'ai' && scene.game.pos.side === scene.aiSide) scene.scheduleAi();
    }
  };

  scene.leave = function () {
    if (scene.mode !== 'online' || !scene.session) return;
    scene.session.leave();
    app.session = null;
    app.transport = null;
  };

  scene.onExit = function () {
    // 离开对局场景时若仍在联机，通知对手（菜单返回已 leave，这里兜底）
    if (scene.mode === 'online' && scene.session && scene.session.state === 'playing') scene.leave();
  };

  // -------------------------------------------------------------------------
  // 渲染

  scene.shouldRender = function (dt) {
    var anim = !!scene.controller.drag || (!scene.game.result && scene.game.isChecked());
    if (anim) { scene.controller.tick(dt); scene.dirty = true; }
    return scene.dirty;
  };

  scene.render = function (ctx, w, h) {
    scene.dirty = false;
    drawScreenBg(ctx, w, h);

    var boardBottom = scene.boardTop + scene.boardHeight;

    // 上下留白美化：上留白靠近棋盘处饰线 +「帥」水印；下留白「棋」水印 + 饰线
    decorateGap(ctx, w, scene.areaTop, scene.boardTop, '帥', scene.boardTop - 20);
    decorateGap(ctx, w, boardBottom, scene.areaBottom, '棋', boardBottom + 20);

    // 棋盘衬底（棋桌面板）
    drawPanel(ctx, scene.boardX - 8, scene.boardTop - 8, scene.boardWidth + 16, scene.boardHeight + 16);

    // 状态栏
    W.drawText(ctx, scene.modeLabel, 14, scene.statusH / 2, 12, W.THEME.subtitle);
    W.drawText(ctx, scene.statusText, w - 14, scene.statusH / 2, 14, W.THEME.title, 'right', true);

    // 棋盘（平移到布局位置）
    ctx.save();
    ctx.translate(scene.boardX, scene.boardTop);
    scene.controller.render(ctx, Renderer);
    ctx.restore();

    // 工具栏
    for (var i = 0; i < scene.toolbar.length; i++) W.drawButton(ctx, scene.toolbar[i], scene.uiBtn === scene.toolbar[i].id);
  };

  return scene;
}

module.exports = createBoardScene;
