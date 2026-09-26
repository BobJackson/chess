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
var Endgame = require('../ui/endgame.js');
var Particles = require('../ui/particles.js');
var C = require('../core/constants.js');
var W = require('../ui/widgets.js');
var Chrome = require('../ui/chrome.js');

var BOARD_ASPECT = Chrome.BOARD_ASPECT;
var drawScreenBg = Chrome.drawScreenBg;
var drawPanel = Chrome.drawPanel;
var decorateGap = Chrome.decorateGap;

/**
 * 绝杀后延迟多久朗读杀法名
 *
 * 演出时间线里落款在 1050ms 开始浮现，所以让语音稍晚一点起步，
 * 念到名字时字正好放大到位——声音和落款同拍，而不是各说各的。
 */
var MATE_VOICE_DELAY = 1000;

/**
 * AI 搜索每个时间片的预算（毫秒）
 *
 * 分片搜索（core/ai.js createSearch）每片最多占用这么久就让出主线程，
 * 配合 setTimeout(0) 的间隔，UI 能保持约 60fps 渲染「思考中」，
 * 大师档 8 层搜索也不再整段冻屏。
 */
var AI_SLICE_MS = 12;

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
    /** 进行中的分片搜索（AI 回合），用于取消与防串台 */
    aiSearch: null,
    /** 进行中的提示搜索 */
    hintSearch: null,
    hintThinking: false,
    dirty: true,
    lastTs: 0,
    uiBtn: null,
    statusText: '',
    modeLabel: '',
    toolbar: [],
    boardX: 0,
    boardTop: 0,
    statusH: 44,
    toolbarH: 60,
    /** 落子动画播完后要执行的收尾动作（AI 回手 / 终局弹窗），见 runAfterAnim */
    afterAnim: null,
    /** 绝杀语音的延迟定时器 */
    mateVoiceTimer: null,
    /** 终局只播一次（音效 + 语音 + 演出） */
    resultShown: false,
    /** 绝杀演出（替代 wx.showModal） */
    endgame: new Endgame(),
    /** 打击感粒子池（木屑/桂花/冲击波环），固定池、帧内零分配 */
    fx: Particles.create(64),
    /** 震屏强度 1→0（吃子落定时置 1，按帧衰减）与震荡相位 */
    shake: 0,
    shakePhase: 0
  };

  // -------------------------------------------------------------------------

  scene.onEnter = function (params) {
    scene.mode = params.mode === 'local' ? 'local' : (params.mode === 'online' ? 'online' : 'ai');
    scene.session = scene.mode === 'online' ? app.session : null;
    if (scene.mode === 'online' && !scene.session) { app.go('menu'); return; }

    scene.endgame.reset();
    scene.resultShown = false;
    scene.mateVoiceTimer = null;
    scene.fx.clear();
    scene.shake = 0;

    scene.difficulty = app.difficulty;
    // 先后手：联机由房间分配；人机/本地用设置页的选择（默认执红，可让先执黑）
    scene.humanSide = scene.mode === 'online'
      ? scene.session.mySide
      : (app.humanSide === C.BLACK ? C.BLACK : C.RED);
    scene.aiSide = 1 - scene.humanSide;

    scene.measure();
    scene.layout = new Layout(scene.boardWidth, scene.humanSide === C.BLACK);

    scene.game = (scene.mode === 'online' && scene.session.game) ? scene.session.game : new Game();
    scene.controller = new Controller(scene.layout, scene.game, {
      canMove: scene.canMove.bind(scene),
      onMoved: scene.onMoved.bind(scene),
      onIllegal: scene.onIllegal.bind(scene),
      onSelect: scene.onSelect.bind(scene),
      onCapture: scene.onCapture.bind(scene),
      onAnimEnd: scene.onAnimEnd.bind(scene)
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
    if (scene.aiThinking || scene.hintThinking) return false;
    if (scene.mode === 'local') return true;
    return scene.game.pos.side === scene.humanSide;
  };

  scene.onMoved = function (res) {
    scene.dirty = true;
    scene.refreshStatus();
    scene.sfxMove(res);
    if (scene.mode === 'online' && res && res.entry) {
      scene.session.broadcastMove(res.entry.from, res.entry.to);
    }
    // 收尾（AI 回手 / 终局弹窗）等落子动画播完再做，否则会盖住「正在移动的棋子」
    scene.runAfterAnim(function () {
      if (scene.game.result) scene.showResult();
      else if (scene.mode === 'ai' && scene.game.pos.side === scene.aiSide) scene.scheduleAi();
    });
  };

  // -------------------------------------------------------------------------
  // 走子动画

  /**
   * 走子后的收尾动作：正在播动画就挂起，等棋子落定再执行；否则立即执行。
   * 同一时刻只保留一个（新的会覆盖旧的）。
   */
  scene.runAfterAnim = function (fn) {
    if (scene.controller && scene.controller.isAnimating()) scene.afterAnim = fn;
    else fn();
  };

  scene.onAnimEnd = function (anim) {
    var fn = scene.afterAnim;
    scene.afterAnim = null;
    scene.dirty = true;
    // 吃子落定：棋子已磕到位，这一帧起迸木屑、震屏、震落桂花
    if (anim && anim.captured && anim.captured !== C.EMPTY) scene.impactAt(anim.to);
    if (fn) fn();
  };

  /**
   * 吃子打击感三连：震屏（160ms 衰减）+ 木屑迸溅 + 两瓣桂花被震落
   * @param {number} idx 落点棋盘索引
   */
  scene.impactAt = function (idx) {
    var p = scene.layout.pointOf(idx);
    var x = scene.boardX + p.x;
    var y = scene.boardTop + p.y;
    scene.shake = 1;
    Particles.burst(scene.fx, x, y, {
      n: 7, shape: 'chip',
      colors: ['#c9a06b', '#a97e4f', '#8a6238', '#e2c084'],
      speed: 240, up: 60, size: [2, 4.5], ttl: [380, 640],
      gravity: 1100, drag: 1.2, vr: 9
    });
    Particles.petal(scene.fx, x - 6, y - 10, { vy: 30, ttl: 2600, alpha: 0.6 });
    Particles.petal(scene.fx, x + 8, y - 14, { vy: 26, ttl: 3000, alpha: 0.55 });
  };

  scene.onIllegal = function (msg) { app.toast(msg || '不符合走法'); };
  scene.onSelect = function () { scene.dirty = true; };
  scene.onCapture = function () { if (wx.vibrateShort) wx.vibrateShort({ type: 'light' }); };

  /** 一步棋的音效与观感：落子/吃子 + 将军警示（含冲击波环） */
  scene.sfxMove = function (res) {
    var cap = res && res.entry && res.entry.captured !== C.EMPTY;
    app.audio.play(cap ? 'capture' : 'move');
    if (!scene.game.result && scene.game.isChecked()) {
      app.audio.play('check');
      // 将军冲击波：在被将的将/帅身上扩散一圈，比单纯的脉冲更像「警钟」
      var kp = scene.game.pos.kingPos[scene.game.pos.side];
      var pt = scene.layout.pointOf(kp);
      Particles.ring(scene.fx, scene.boardX + pt.x, scene.boardTop + pt.y, {
        color: 'rgba(198,32,48,0.9)',
        size: scene.layout.pieceRadius * 1.15,
        grow: 300, ttl: 480
      });
    }
  };

  // -------------------------------------------------------------------------
  // 联机事件

  scene.bindSession = function () {
    var o = scene.session.options;
    o.onRemoteMove = function (res) {
      // 对手的棋子也要看得见是怎么走过来的
      if (res && res.entry) scene.controller.playMoveAnim(res.entry);
      scene.dirty = true; scene.refreshStatus();
      scene.sfxMove(res);
    };
    o.onResync = function (game) {
      scene.game = game;
      scene.controller.setGame(game);
      scene.afterAnim = null;
      scene.dirty = true; scene.refreshStatus();
    };
    o.onResult = function () {
      scene.dirty = true; scene.refreshStatus();
      scene.runAfterAnim(function () { scene.showResult(); });
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
  // AI 回合（分片搜索：每片 AI_SLICE_MS，片间让出主线程渲染「思考中」）

  /** 取消进行中的 AI 搜索（悔棋/重开/离场时调用），后续 tick 会被防串台检查挡掉 */
  scene.cancelAi = function () {
    if (scene.aiSearch) { scene.aiSearch.cancel(); scene.aiSearch = null; }
    scene.aiThinking = false;
  };

  /** 取消进行中的提示搜索 */
  scene.cancelHint = function () {
    if (scene.hintSearch) { scene.hintSearch.cancel(); scene.hintSearch = null; }
    scene.hintThinking = false;
  };

  /**
   * 驱动一次分片搜索：每片最多 AI_SLICE_MS，未完则排在下一个宏任务继续。
   * onDone(result) 在搜索结束（含被取消，此时 result 为 null）时恰好调用一次。
   */
  scene.driveSearch = function (search, onDone) {
    var tick = function () {
      var done;
      try {
        done = search.step(AI_SLICE_MS);
      } catch (e) {
        search.cancel();
        done = true;
      }
      if (!done) { setTimeout(tick, 0); return; }
      onDone(search.getResult());
    };
    setTimeout(tick, 30); // 起手稍等一拍，让玩家的落子动画先被看见
  };

  scene.scheduleAi = function () {
    if (scene.aiThinking || scene.game.result) return;
    scene.aiThinking = true;
    scene.dirty = true;
    scene.refreshStatus();

    var search = AI.createSearch(scene.game.pos, {
      level: scene.difficulty,
      moveNumber: Math.floor(scene.game.plyCount() / 2)
    });
    scene.aiSearch = search;

    scene.driveSearch(search, function (mv) {
      if (scene.aiSearch !== search) return; // 已被悔棋/重开/离场取消
      scene.aiSearch = null;
      scene.aiThinking = false;
      var res = mv ? scene.game.move(mv.from, mv.to) : null;
      if (res && res.ok) {
        scene.controller.playMoveAnim(res.entry);
        scene.sfxMove(res);
      }
      scene.dirty = true;
      scene.refreshStatus();
      scene.runAfterAnim(function () {
        if (scene.game.result) scene.showResult();
      });
    });
  };

  // -------------------------------------------------------------------------
  // 状态与弹窗

  scene.refreshStatus = function () {
    var g = scene.game;
    if (!g) return;
    if (g.result) scene.statusText = g.result.text;
    else if (scene.aiThinking) scene.statusText = 'AI 思考中…';
    else if (scene.hintThinking) scene.statusText = '提示计算中…';
    else scene.statusText = '轮到 ' + (g.pos.side === C.RED ? '红方' : '黑方') + (g.isChecked() ? '（被将军）' : '');
  };

  scene.showResult = function () {
    if (scene.resultShown) return;
    scene.resultShown = true;

    var result = scene.game.result;

    // 松桂账本：只记人对人的局（本地双人/联机），人机是练棋不入账
    if (app.ledger) {
      app.ledger.record({ mode: scene.mode, result: result, humanSide: scene.humanSide });
    }

    var win = scene.mode === 'local' ? true : (result.winner === scene.humanSide);
    app.audio.play(win ? 'win' : 'lose');

    // 绝杀时把杀法名念出来——不只是显示。延迟到落款浮现时再念，声画同拍
    if (result.mateKey) {
      scene.clearMateVoice();
      scene.mateVoiceTimer = setTimeout(function () {
        scene.mateVoiceTimer = null;
        app.audio.playMate(result.mateKey);
      }, MATE_VOICE_DELAY);
    }

    // 用自绘的绝杀演出替代 wx.showModal：纯文字弹窗太单薄，
    // 演出能把「这一招怎么杀的」按杀法分叉演一遍，再落款给名字与结果
    scene.endgame.start(result, {
      board: scene.game.pos.board,
      layout: scene.layout,
      win: win,
      online: scene.mode === 'online'
    });
    scene.dirty = true;
  };

  /** 演出的落款按钮：复盘 / 再来一局 / 回菜单 */
  scene.endgameAction = function (id) {
    scene.endgame.reset();
    scene.dirty = true;
    if (id === 'replay') {
      // 复盘是独立场景：带上完整棋谱（起始 FEN + 着法序列）与当前视角
      app.go('replay', {
        data: scene.game.toJSON(),
        label: scene.modeLabel,
        flipped: scene.layout.flipped
      });
      return;
    }
    if (id === 'again') scene.toolAction('restart');
    else if (id === 'menu') scene.toolAction('back');
  };

  /** 离开对局时撤掉还没播出的杀法语音，避免在菜单里突然冒出一句 */
  scene.clearMateVoice = function () {
    if (scene.mateVoiceTimer) {
      clearTimeout(scene.mateVoiceTimer);
      scene.mateVoiceTimer = null;
    }
  };

  // -------------------------------------------------------------------------
  // 触摸

  scene.toBoard = function (x, y) {
    return { x: x - scene.boardX, y: y - scene.boardTop };
  };

  scene.onTouch = function (type, x, y) {
    // 绝杀演出期间独占输入：点按跳过，落款浮现后按钮才可点
    if (scene.endgame.isActive()) {
      if (type === 'start') {
        scene.endgame.pressed = scene.endgame.hitButtonAt(x, y);
        scene.dirty = true;
      } else if (type === 'cancel') {
        scene.endgame.pressed = null;
        scene.dirty = true;
      } else if (type === 'end') {
        var hit = scene.endgame.hitButtonAt(x, y);
        var was = scene.endgame.pressed;
        scene.endgame.pressed = null;
        scene.dirty = true;
        if (hit && hit === was) scene.endgameAction(hit);
        else if (!hit) scene.endgame.skip();   // 点空白处 = 跳过演出
      }
      return;
    }

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
    if (id === 'back') { scene.cancelAi(); scene.cancelHint(); scene.leave(); app.go('menu'); return; }
    if (id === 'undo') {
      if (scene.mode === 'online') { app.toast('联机不可悔棋'); return; }
      if (!scene.game.history.length) return;
      // AI 思考中悔棋 = 撤回自己刚走的那一手（并取消 AI）；
      // 平时人机悔两手（人 + AI），本地双人悔一手
      var wasThinking = scene.aiThinking;
      if (wasThinking) scene.cancelAi();
      scene.cancelHint();
      scene.game.undo(scene.mode === 'ai' && !wasThinking ? 2 : 1);
      scene.controller.reset();
      scene.afterAnim = null;
      scene.dirty = true; scene.refreshStatus();
      // 人执黑（让先）时悔棋可能悔回开局——轮到 AI 就得重新调度，
      // 否则棋盘会停在「轮到红方」却无人走子
      if (scene.mode === 'ai' && scene.game.pos.side === scene.aiSide) scene.scheduleAi();
      return;
    }
    if (id === 'hint') {
      if (!scene.controller.canOperate() || scene.hintThinking || scene.aiThinking) {
        app.toast('现在不能提示');
        return;
      }
      // 提示也走分片搜索：困难档深度 6 不再冻住棋盘
      var hs = AI.createSearch(scene.game.pos, { level: 'hard', moveNumber: 9999 });
      scene.hintSearch = hs;
      scene.hintThinking = true;
      scene.dirty = true;
      scene.refreshStatus();
      scene.driveSearch(hs, function (r) {
        if (scene.hintSearch !== hs) return; // 已被取消
        scene.hintSearch = null;
        scene.hintThinking = false;
        if (r) scene.controller.setHint({ from: r.from, to: r.to });
        scene.dirty = true;
        scene.refreshStatus();
      });
      return;
    }
    if (id === 'flip') { scene.layout.setFlipped(!scene.layout.flipped); scene.dirty = true; return; }
    if (id === 'restart') {
      if (scene.mode === 'online') { app.toast('联机不可重开'); return; }
      scene.cancelAi();
      scene.cancelHint();
      scene.afterAnim = null;
      scene.resultShown = false;
      scene.clearMateVoice();
      scene.endgame.reset();
      scene.fx.clear();
      scene.shake = 0;
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
    // 取消还在跑的分片搜索，别让迟到的 AI 走子落在别的场景上
    scene.cancelAi();
    scene.cancelHint();
    // 撤掉还没播出的杀法语音，别在菜单里突然冒出一句；演出与粒子一并清掉
    scene.clearMateVoice();
    scene.endgame.reset();
    scene.fx.clear();
    scene.shake = 0;
  };

  // -------------------------------------------------------------------------
  // 渲染

  scene.shouldRender = function (dt) {
    var fxAlive = scene.fx.count() > 0 || scene.shake > 0;
    // 拖拽中、走子动画中、落子余晖未散、绝杀演出未播完、被将军、粒子未落尽时都需要按帧重绘
    var anim = !!scene.controller.drag || scene.controller.isAnimating() ||
      scene.controller.isLanding() ||
      (scene.endgame.isActive() && !scene.endgame.isDone()) ||
      (!scene.game.result && scene.game.isChecked()) ||
      fxAlive;
    if (anim) {
      scene.controller.tick(dt);
      scene.endgame.tick(dt);
      if (fxAlive) {
        scene.fx.tick(dt);
        if (scene.shake > 0) {
          scene.shake -= (dt || 16) / 160;
          if (scene.shake < 0) scene.shake = 0;
          scene.shakePhase += (dt || 16) * 0.11;
        }
      }
      scene.dirty = true;
    }
    return scene.dirty;
  };

  scene.render = function (ctx, w, h) {
    scene.dirty = false;
    drawScreenBg(ctx, w, h);

    // 吃子震屏：整屏（含工具栏）随正弦震荡偏移，强度按平方衰减
    ctx.save();
    if (scene.shake > 0) {
      var m = 3.2 * scene.shake * scene.shake;
      ctx.translate(Math.sin(scene.shakePhase) * m, Math.cos(scene.shakePhase * 1.31) * m * 0.7);
    }

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

    // 打击感粒子：画在棋盘之上、震屏坐标系之内（跟着屏一起震才对味）
    scene.fx.draw(ctx);
    ctx.restore();

    // 绝杀演出盖在工具栏之上：终局时整屏进入结算，不再有工具栏的干扰
    // （演出不随震屏——它是结算镜头，机位要稳）
    if (scene.endgame.isActive()) {
      scene.endgame.draw(ctx, w, h, scene.boardX, scene.boardTop);
    }
  };

  return scene;
}

module.exports = createBoardScene;
