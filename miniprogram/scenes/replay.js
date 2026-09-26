/**
 * 复盘场景：终局后按记谱逐步回放本盘棋
 *
 * 数据来自 Game.toJSON()（起始 FEN + 着法序列），复盘场景内重建一个
 * 新对局，从开局起逐手重放：
 *
 *   工具栏五键：开局 ⏮ / 上一步 ◀ / 播放·暂停·绝杀 ▶ / 下一步 / 退出
 *   - 前进走子带与对局一致的滑动动画与音效；后退与跳转即时落定（无动画）
 *   - 自动播放每 900ms 一手，播到终局自停
 *   - 停在终局且本局有杀法时，中键变为「绝杀」：复用绝杀演出再演一遍
 *     （演出内不给出按钮，点屏即收起）
 *
 * 交互约束：棋盘不吃触摸（复盘不是对局，点选/走子一律不响应），
 * 全部操作集中在工具栏。视角沿用对局结束时的翻转状态。
 *
 * 视觉框架（底色/棋桌面板/水印饰线）与对局场景共享 ui/chrome.js。
 */

var Game = require('../core/game.js');
var Layout = require('../ui/layout.js');
var Renderer = require('../ui/renderer.js');
var Controller = require('../ui/controller.js');
var Endgame = require('../ui/endgame.js');
var C = require('../core/constants.js');
var W = require('../ui/widgets.js');
var Chrome = require('../ui/chrome.js');

var BOARD_ASPECT = Chrome.BOARD_ASPECT;

/** 自动播放的步进间隔（毫秒）：比走子动画（200ms）宽得多，看清每手 */
var PLAY_INTERVAL = 900;

function createReplayScene(app) {
  var scene = {
    name: 'replay',
    app: app,
    game: null,
    controller: null,
    layout: null,
    /** 起始 FEN 与着法序列 [[from, to], ...] */
    fen: null,
    moves: [],
    /** 已重放的手数（0..moves.length），与 game.history.length 同步 */
    ply: 0,
    playing: false,
    playTimer: 0,
    dirty: true,
    uiBtn: null,
    statusText: '',
    label: '',
    toolbar: [],
    boardX: 0,
    boardTop: 0,
    statusH: 44,
    toolbarH: 60,
    /** 绝杀演出（复用对局的结算镜头；这里不带按钮，点屏收起） */
    endgame: new Endgame()
  };

  // -------------------------------------------------------------------------

  scene.onEnter = function (params) {
    params = params || {};
    var data = params.data || {};
    scene.fen = data.fen || C.START_FEN;
    scene.moves = Array.isArray(data.moves) ? data.moves : [];
    scene.label = params.label || '';
    scene.ply = 0;
    scene.playing = false;
    scene.playTimer = 0;

    scene.endgame.reset();
    // 复盘里的绝杀演出不给「再来一局/回菜单」按钮——那不是这里的语义；
    // 演出播完点屏即收起
    scene.endgame.layoutButtons = function () {
      this.buttons = [];
      return [];
    };

    scene.measure();
    scene.layout = new Layout(scene.boardWidth, !!params.flipped);

    scene.game = new Game(scene.fen);
    scene.controller = new Controller(scene.layout, scene.game, {
      canMove: function () { return false; }  // 复盘不走子，Controller 只做渲染与动画
    });

    scene.buildToolbar();
    scene.refreshStatus();
    scene.dirty = true;
  };

  scene.onExit = function () {
    scene.endgame.reset();
    scene.playing = false;
  };

  scene.measure = function () {
    var w = app.w, h = app.h;
    scene.areaTop = scene.statusH + 6;
    scene.areaBottom = h - scene.toolbarH - 6;
    var availH = scene.areaBottom - scene.areaTop;

    scene.boardWidth = Math.min(w - 24, availH / BOARD_ASPECT);
    scene.boardHeight = scene.boardWidth * BOARD_ASPECT;
    scene.boardX = (w - scene.boardWidth) / 2;
    scene.boardTop = scene.areaTop + Math.max(0, (availH - scene.boardHeight) / 2);
  };

  scene.buildToolbar = function () {
    var w = app.w;
    var pad = 10, gap = 8;
    var labels = ['开局', '上步', '播放', '下步', '退出'];
    var ids = ['start', 'prev', 'play', 'next', 'exit'];
    var bw = (w - pad * 2 - gap * 4) / 5;
    var y = app.h - scene.toolbarH + 10;
    scene.toolbar = ids.map(function (id, i) {
      return W.makeButton(id, pad + i * (bw + gap), y, bw, 38, labels[i], 'ghost');
    });
  };

  // -------------------------------------------------------------------------
  // 重放控制

  scene.atStart = function () { return scene.ply <= 0; };
  scene.atEnd = function () { return scene.ply >= scene.moves.length; };

  /** 终局有杀法可演时，中键从「播放」变成「绝杀」 */
  scene.hasMateShow = function () {
    return !!(scene.atEnd() && scene.game.result && scene.game.result.mateInfo);
  };

  /**
   * 前进一手
   * @param {boolean} animate 是否播走子动画与音效（跳转时静默）
   */
  scene.applyStep = function (animate) {
    if (scene.atEnd()) return false;
    var m = scene.moves[scene.ply];
    var res = scene.game.move(m[0], m[1]);
    if (!res.ok) return false;   // 脏数据防御：棋谱与起始局面不匹配时停住
    scene.ply++;
    scene.controller.refreshThreats();
    if (animate) {
      scene.controller.playMoveAnim(res.entry);
      app.audio.play(res.entry.captured !== C.EMPTY ? 'capture' : 'move');
      if (!scene.game.result && scene.game.isChecked()) app.audio.play('check');
    }
    scene.refreshStatus();
    scene.dirty = true;
    return true;
  };

  /** 后退一手：即时落定，不倒播动画 */
  scene.stepBack = function () {
    if (scene.atStart() || scene.controller.isAnimating()) return false;
    scene.game.undo(1);
    scene.ply--;
    scene.controller.reset();
    scene.controller.land = 1;   // 落定余晖，标出退到的那一手
    scene.refreshStatus();
    scene.dirty = true;
    return true;
  };

  /** 跳回开局 */
  scene.gotoStart = function () {
    if (scene.controller.isAnimating()) scene.controller.finishAnim();
    scene.game = new Game(scene.fen);
    scene.ply = 0;
    scene.controller.setGame(scene.game);
    scene.refreshStatus();
    scene.dirty = true;
  };

  /** 跳到终局（静默连放，只留最后一手的余晖） */
  scene.gotoEnd = function () {
    if (scene.controller.isAnimating()) scene.controller.finishAnim();
    while (!scene.atEnd()) {
      if (!scene.applyStep(false)) break;
    }
    scene.controller.reset();
    scene.controller.land = 1;
    scene.refreshStatus();
    scene.dirty = true;
  };

  scene.setPlaying = function (on) {
    scene.playing = !!on && !scene.atEnd();
    // 按下的第一下立即步进，不等满一个间隔
    scene.playTimer = scene.playing ? PLAY_INTERVAL : 0;
    scene.syncPlayButton();
    scene.dirty = true;
  };

  /** 重演绝杀：复用对局的结算镜头（无按钮，点屏收起） */
  scene.showMate = function () {
    if (!scene.hasMateShow()) return false;
    app.audio.play('win');
    scene.endgame.start(scene.game.result, {
      board: scene.game.pos.board,
      layout: scene.layout,
      win: true,
      online: false
    });
    scene.dirty = true;
    return true;
  };

  /** 中键标签随状态切换：绝杀 > 暂停 > 播放 */
  scene.syncPlayButton = function () {
    var btn = scene.toolbar[2];
    if (!btn) return;
    if (scene.hasMateShow()) btn.label = '绝杀';
    else btn.label = scene.playing ? '暂停' : '播放';
  };

  /** 状态栏右侧：进度 + 当前着法 */
  scene.refreshStatus = function () {
    var n = scene.moves.length;
    if (scene.ply === 0) {
      scene.statusText = n > 0 ? ('共 ' + n + ' 手') : '空棋谱';
    } else {
      var last = scene.game.lastEntry();
      scene.statusText = '第 ' + scene.ply + '/' + n + ' 手' +
        (last && last.text ? ' · ' + last.text : '');
    }
    scene.syncPlayButton();
  };

  // -------------------------------------------------------------------------
  // 触摸

  scene.onTouch = function (type, x, y) {
    // 绝杀演出期间独占输入：未播完点按跳过，播完点按收起（本场景无按钮）
    if (scene.endgame.isActive()) {
      if (type === 'end') {
        if (scene.endgame.isDone()) scene.endgame.reset();
        else scene.endgame.skip();
        scene.dirty = true;
      }
      return;
    }

    // 只认工具栏；棋盘不吃触摸（复盘不是对局）
    if (type === 'start') {
      scene.uiBtn = null;
      for (var i = 0; i < scene.toolbar.length; i++) {
        if (W.hitButton(scene.toolbar[i], x, y)) { scene.uiBtn = scene.toolbar[i].id; return; }
      }
    }
    if (scene.uiBtn && type === 'end') {
      var id = scene.uiBtn;
      scene.uiBtn = null;
      for (var b = 0; b < scene.toolbar.length; b++) {
        if (scene.toolbar[b].id === id && W.hitButton(scene.toolbar[b], x, y)) {
          scene.toolAction(id);
          return;
        }
      }
    }
    if (type === 'cancel') scene.uiBtn = null;
  };

  scene.toolAction = function (id) {
    app.audio.play('tap');
    if (id === 'exit') { app.go('menu'); return; }
    if (id === 'start') { scene.setPlaying(false); scene.gotoStart(); return; }
    if (id === 'prev') { scene.setPlaying(false); scene.stepBack(); return; }
    if (id === 'next') {
      scene.setPlaying(false);
      if (!scene.controller.isAnimating()) scene.applyStep(true);
      return;
    }
    if (id === 'play') {
      if (scene.playing) { scene.setPlaying(false); return; }
      if (scene.hasMateShow()) { scene.showMate(); return; }
      scene.setPlaying(true);
    }
  };

  // -------------------------------------------------------------------------
  // 渲染

  scene.shouldRender = function (dt) {
    // 自动播放：等当前动画落定后再数下一个间隔
    if (scene.playing && !scene.controller.isAnimating() && !scene.endgame.isActive()) {
      scene.playTimer += dt || 16;
      if (scene.playTimer >= PLAY_INTERVAL) {
        scene.playTimer = 0;
        if (!scene.applyStep(true)) scene.setPlaying(false);
        else scene.syncPlayButton();
      }
    }

    var animating = scene.controller.isAnimating() || scene.controller.isLanding() ||
      scene.playing ||
      (scene.endgame.isActive() && !scene.endgame.isDone()) ||
      (!scene.game.result && scene.game.isChecked());
    if (animating) {
      scene.controller.tick(dt);
      scene.endgame.tick(dt);
      scene.dirty = true;
    }
    return scene.dirty;
  };

  scene.render = function (ctx, w, h) {
    scene.dirty = false;
    Chrome.drawScreenBg(ctx, w, h);

    var boardBottom = scene.boardTop + scene.boardHeight;
    Chrome.decorateGap(ctx, w, scene.areaTop, scene.boardTop, '棋', scene.boardTop - 20);
    Chrome.decorateGap(ctx, w, boardBottom, scene.areaBottom, '谱', boardBottom + 20);

    Chrome.drawPanel(ctx, scene.boardX - 8, scene.boardTop - 8,
      scene.boardWidth + 16, scene.boardHeight + 16);

    // 状态栏：左 = 来源（对局模式），右 = 进度与当前着法
    W.drawText(ctx, '复盘' + (scene.label ? ' · ' + scene.label : ''),
      14, scene.statusH / 2, 12, W.THEME.subtitle);
    W.drawText(ctx, scene.statusText, w - 14, scene.statusH / 2, 14, W.THEME.title, 'right', true);

    // 棋盘
    ctx.save();
    ctx.translate(scene.boardX, scene.boardTop);
    scene.controller.render(ctx, Renderer);
    ctx.restore();

    // 工具栏：到头的按钮压暗表示不可用
    for (var i = 0; i < scene.toolbar.length; i++) {
      var btn = scene.toolbar[i];
      var disabled =
        ((btn.id === 'start' || btn.id === 'prev') && scene.atStart()) ||
        (btn.id === 'next' && scene.atEnd()) ||
        (btn.id === 'play' && scene.atEnd() && !scene.hasMateShow() && !scene.playing);
      ctx.save();
      if (disabled) ctx.globalAlpha = 0.35;
      W.drawButton(ctx, btn, scene.uiBtn === btn.id);
      ctx.restore();
    }

    // 绝杀演出盖在最上层（结算镜头，同对局场景）
    if (scene.endgame.isActive()) {
      scene.endgame.draw(ctx, w, h, scene.boardX, scene.boardTop);
    }
  };

  return scene;
}

module.exports = createReplayScene;
