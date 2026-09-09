/**
 * 对局页
 *
 * 把 core/（Game、AI）与 ui/（Layout、Renderer、Controller）接到真实 Canvas：
 *   - Canvas 2D + dpr 缩放，尺寸由 Layout 计算
 *   - requestAnimationFrame 循环：仅在拖拽/将军时推进脉冲动画，脏标记按需重绘
 *   - 触摸事件换算为画布逻辑坐标后交给 Controller 状态机
 *   - 人机模式下 AI 回合异步出招，期间通过 canMove 锁住本地操作
 */
var Game = require('../../core/game.js');
var AI = require('../../core/ai.js');
var Layout = require('../../ui/layout.js');
var Renderer = require('../../ui/renderer.js');
var Controller = require('../../ui/controller.js');
var C = require('../../core/constants.js');

Page({
  data: {
    canvasHeight: 300,
    statusText: '',
    modeLabel: ''
  },

  onLoad: function (options) {
    this.session = null;
    if (options.mode === 'online') {
      this.mode = 'online';
      this.session = getApp().globalData.session;
      if (!this.session) {
        wx.navigateBack();
        return;
      }
      this.humanSide = this.session.mySide;
    } else {
      this.mode = options.mode === 'local' ? 'local' : 'ai';
      this.humanSide = options.side === 'black' ? C.BLACK : C.RED;
    }
    this.difficulty = options.difficulty || 'normal';
    if (!AI.LEVELS[this.difficulty]) this.difficulty = 'normal';

    this.aiSide = 1 - this.humanSide;

    this.aiThinking = false;
    this.dirty = true;
    this.lastTs = 0;
    this.rect = null;

    var label;
    if (this.mode === 'online') {
      label = '联机 · 房间 ' + this.session.room + ' · 执' + (this.humanSide === C.RED ? '红' : '黑');
    } else if (this.mode === 'ai') {
      label = '人机 · ' + AI.LEVELS[this.difficulty].label + ' · 执' + (this.humanSide === C.RED ? '红' : '黑');
    } else {
      label = '本地双人';
    }
    this.setData({ modeLabel: label });
  },

  onReady: function () {
    var self = this;
    wx.createSelectorQuery()
      .select('#board')
      .fields({ node: true, size: true })
      .exec(function (res) {
        if (!res || !res[0] || !res[0].node) return;
        self.canvas = res[0].node;
        self.cssWidth = res[0].width;
        self.setupBoard();
      });

    wx.createSelectorQuery()
      .select('#board')
      .boundingClientRect(function (r) { self.rect = r; })
      .exec();
  },

  onUnload: function () {
    this.stopped = true;
    this.leaveOnline();
  },

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  setupBoard: function () {
    var dpr = (wx.getSystemInfoSync() || {}).pixelRatio || 2;

    this.layout = new Layout(this.cssWidth, this.humanSide === C.BLACK);
    var height = this.layout.height;

    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
    this.setData({ canvasHeight: height });

    this.game = (this.mode === 'online' && this.session && this.session.game)
      ? this.session.game
      : new Game();
    this.controller = new Controller(this.layout, this.game, {
      canMove: this.canMove.bind(this),
      onMoved: this.onMoved.bind(this),
      onIllegal: this.onIllegal.bind(this),
      onSelect: this.onSelect.bind(this),
      onCapture: this.onCapture.bind(this)
    });

    if (this.mode === 'online') this.bindSession();

    this.refreshStatus();
    this.startLoop();

    if (this.mode === 'ai' && this.game.pos.side === this.aiSide) this.scheduleAi();
  },

  /** 联机：把会话事件接到页面渲染与提示 */
  bindSession: function () {
    var self = this;
    var o = this.session.options;
    o.onRemoteMove = function () {
      self.dirty = true;
      self.refreshStatus();
      if (self.game.result) self.showResult();
    };
    o.onResync = function (game) {
      self.game = game;
      self.controller.setGame(game);
      self.dirty = true;
      self.refreshStatus();
    };
    o.onResult = function () {
      self.dirty = true;
      self.refreshStatus();
      self.showResult();
    };
    o.onOpponentLeft = function () {
      self.dirty = true;
      self.refreshStatus();
      if (!self.game.result) {
        self.game.finish(self.humanSide, '对手离开');
        self.session.broadcastResult(self.game.result);
        self.showResult();
      }
    };
  },

  // -------------------------------------------------------------------------
  // Controller 回调
  // -------------------------------------------------------------------------

  canMove: function () {
    if (this.mode === 'online') return this.session.canPlay();
    if (this.aiThinking) return false;
    if (this.mode === 'local') return true;
    return this.game.pos.side === this.humanSide;
  },

  onMoved: function (res) {
    this.dirty = true;
    this.refreshStatus();
    if (this.mode === 'online' && res && res.entry) {
      // 本地已落子，广播给对手；若本步终局会话内部会顺带广播结果
      this.session.broadcastMove(res.entry.from, res.entry.to);
      if (this.game.result) this.showResult();
      return;
    }
    if (this.game.result) {
      this.showResult();
    } else if (this.mode === 'ai' && this.game.pos.side === this.aiSide) {
      this.scheduleAi();
    }
  },

  onIllegal: function (msg) {
    wx.showToast({ title: msg || '不符合走法', icon: 'none' });
  },

  onSelect: function () {
    this.dirty = true;
  },

  onCapture: function () {
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  // -------------------------------------------------------------------------
  // AI 回合
  // -------------------------------------------------------------------------

  scheduleAi: function () {
    if (this.aiThinking || this.game.result) return;
    this.aiThinking = true;
    this.dirty = true;
    this.refreshStatus();

    var self = this;
    setTimeout(function () {
      if (self.stopped) return;
      var mv = null;
      try {
        mv = AI.findBestMove(self.game.pos, {
          level: self.difficulty,
          moveNumber: Math.floor(self.game.plyCount() / 2)
        });
      } catch (e) {
        mv = null;
      }
      self.aiThinking = false;
      if (mv) self.game.move(mv.from, mv.to);
      self.dirty = true;
      self.refreshStatus();
      if (self.game.result) self.showResult();
    }, 30);
  },

  // -------------------------------------------------------------------------
  // 渲染循环
  // -------------------------------------------------------------------------

  startLoop: function () {
    var self = this;
    var step = function (ts) {
      if (self.stopped) return;
      var dt = self.lastTs ? ts - self.lastTs : 16;
      self.lastTs = ts;

      var animating = !!self.controller.drag ||
        (!self.game.result && self.game.isChecked());
      if (animating) {
        self.controller.tick(dt);
        self.dirty = true;
      }
      if (self.dirty) {
        self.controller.render(self.ctx, Renderer);
        self.dirty = false;
      }
      self.canvas.requestAnimationFrame(step);
    };
    this.canvas.requestAnimationFrame(step);
  },

  refreshStatus: function () {
    var g = this.game;
    if (!g) return;
    var text;
    if (g.result) {
      text = g.result.text;
    } else if (this.aiThinking) {
      text = 'AI 思考中…';
    } else {
      text = '轮到 ' + (g.pos.side === C.RED ? '红方' : '黑方') +
        (g.isChecked() ? '（被将军）' : '');
    }
    this.setData({ statusText: text });
  },

  showResult: function () {
    wx.showModal({
      title: '对局结束',
      content: this.game.result.text,
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // -------------------------------------------------------------------------
  // 触摸事件
  // -------------------------------------------------------------------------

  pointOf: function (e, useChanged) {
    var list = useChanged ? e.changedTouches : e.touches;
    if (!list || !list.length) return null;
    var t = list[0];
    var left = this.rect ? this.rect.left : 0;
    var top = this.rect ? this.rect.top : 0;
    return { x: t.clientX - left, y: t.clientY - top };
  },

  onTouchStart: function (e) {
    var p = this.pointOf(e, false);
    if (!p) return;
    if (this.controller.touchStart(p.x, p.y)) this.dirty = true;
  },

  onTouchMove: function (e) {
    var p = this.pointOf(e, false);
    if (!p) return;
    if (this.controller.touchMove(p.x, p.y)) this.dirty = true;
  },

  onTouchEnd: function (e) {
    var p = this.pointOf(e, true);
    if (!p) return;
    if (this.controller.touchEnd(p.x, p.y)) this.dirty = true;
  },

  onTouchCancel: function () {
    if (this.controller.touchCancel()) this.dirty = true;
  },

  // -------------------------------------------------------------------------
  // 工具栏
  // -------------------------------------------------------------------------

  onUndo: function () {
    if (this.mode === 'online') {
      wx.showToast({ title: '联机不可悔棋', icon: 'none' });
      return;
    }
    if (this.aiThinking || !this.game.history.length) return;
    var plies = this.mode === 'ai' ? 2 : 1;
    this.game.undo(plies);
    this.controller.reset();
    this.dirty = true;
    this.refreshStatus();
  },

  onHint: function () {
    if (!this.controller.canOperate()) {
      wx.showToast({ title: '现在不能提示', icon: 'none' });
      return;
    }
    var h = AI.getHint(this.game.pos);
    if (h) {
      this.controller.setHint({ from: h.from, to: h.to });
      this.dirty = true;
    }
  },

  onFlip: function () {
    this.layout.setFlipped(!this.layout.flipped);
    this.dirty = true;
  },

  onRestart: function () {
    if (this.mode === 'online') {
      wx.showToast({ title: '联机不可重开', icon: 'none' });
      return;
    }
    this.aiThinking = false;
    this.game = new Game();
    this.controller.setGame(this.game);
    this.dirty = true;
    this.refreshStatus();
    if (this.mode === 'ai' && this.game.pos.side === this.aiSide) this.scheduleAi();
  },

  /** 联机退出：通知对手并清理全局会话 */
  leaveOnline: function () {
    if (this.mode !== 'online' || this.onlineLeft) return;
    this.onlineLeft = true;
    if (this.session) this.session.leave();
    var app = getApp();
    app.globalData.session = null;
    app.globalData.transport = null;
  },

  onBack: function () {
    this.leaveOnline();
    wx.navigateBack();
  }
});
