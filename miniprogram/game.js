/**
 * 微信小游戏入口
 *
 * 小游戏没有页面与组件树：整屏一块 Canvas，UI 全部自绘（ui/widgets），
 * 界面切换用场景状态机（scenes/manager）替代路由。
 * 本文件只负责：Canvas 与 dpr、全局触摸分发、rAF 主循环、云开发初始化、
 * 软键盘封装，以及把 app 上下文交给各场景。
 *
 * 对局逻辑（core/）、棋盘渲染与触摸状态机（ui/）、联机会话（net/）均为
 * 纯 JS 模块，原样复用，不感知小游戏环境。
 */
var Manager = require('./scenes/manager.js');
var createMenu = require('./scenes/menu.js');
var createBoard = require('./scenes/board.js');
var createLobby = require('./scenes/lobby.js');
var createRules = require('./scenes/rules.js');
var audio = require('./ui/audio.js');

audio.init();

// ---------------------------------------------------------------------------
// 画布与尺寸
// ---------------------------------------------------------------------------
var info = wx.getSystemInfoSync();
var dpr = info.pixelRatio || 2;
var canvas = wx.createCanvas();
canvas.width = Math.round(info.windowWidth * dpr);
canvas.height = Math.round(info.windowHeight * dpr);
var ctx = canvas.getContext('2d');
ctx.scale(dpr, dpr);

var raf = canvas.requestAnimationFrame
  ? canvas.requestAnimationFrame.bind(canvas)
  : requestAnimationFrame;

// ---------------------------------------------------------------------------
// app 上下文（交给各场景）
// ---------------------------------------------------------------------------
var app = {
  w: info.windowWidth,
  h: info.windowHeight,
  ctx: ctx,
  canvas: canvas,
  difficulty: 'normal',
  session: null,
  transport: null,
  cloudReady: false,
  audio: audio,

  go: function (name, params) { return manager.show(name, params); },

  toast: function (msg) {
    wx.showToast({ title: msg, icon: 'none' });
  },

  /** 小游戏软键盘录入（房间号等短文本） */
  openKeyboard: function (opts) {
    if (!wx.showKeyboard) return;
    var onInput = function (res) { if (opts.onInput) opts.onInput(res.value); };
    var onComplete = function (res) {
      if (opts.onComplete) opts.onComplete(res.value);
      if (wx.hideKeyboard) wx.hideKeyboard();
      if (wx.offKeyboardInput) wx.offKeyboardInput(onInput);
      if (wx.offKeyboardComplete) wx.offKeyboardComplete(onComplete);
    };
    wx.onKeyboardInput(onInput);
    wx.onKeyboardComplete(onComplete);
    wx.showKeyboard({ defaultValue: '', maxLength: opts.maxLength || 4, confirmHold: false });
  },

  createScene: function (name, params) {
    if (name === 'menu') return createMenu(app);
    if (name === 'board') return createBoard(app);
    if (name === 'lobby') return createLobby(app);
    if (name === 'rules') return createRules(app);
    return null;
  }
};

// 云开发初始化（联机需要）；失败不影响本地玩法
if (wx.cloud && wx.cloud.init) {
  try {
    wx.cloud.init({ traceUser: true });
    app.cloudReady = true;
  } catch (e) {
    app.cloudReady = false;
  }
}

// ---------------------------------------------------------------------------
// 场景管理 + 全局触摸 + 主循环
// ---------------------------------------------------------------------------
var manager = new Manager(app);
manager.show('menu');

// iOS 要求用户首次交互后才能出声：第一次触摸时启动 BGM
var bgmStarted = false;
function ensureBgm() {
  if (bgmStarted) return;
  bgmStarted = true;
  audio.startBgm();
}

wx.onTouchStart(function (e) {
  ensureBgm();
  var t = e.touches && e.touches[0];
  if (t) manager.touch('start', t.clientX, t.clientY);
});
wx.onTouchMove(function (e) {
  var t = e.touches && e.touches[0];
  if (t) manager.touch('move', t.clientX, t.clientY);
});
wx.onTouchEnd(function (e) {
  var t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
  if (t) manager.touch('end', t.clientX, t.clientY);
});
wx.onTouchCancel(function () {
  manager.touch('cancel', 0, 0);
});

// 前后台切换：暂停/恢复 BGM，省电也避免回前台双音
if (wx.onShow) wx.onShow(function () { audio.resumeBgm(); });
if (wx.onHide) wx.onHide(function () { audio.pauseBgm(); });

var last = 0;
function frame(ts) {
  var dt = last ? ts - last : 16;
  last = ts;
  manager.frame(ctx, app.w, app.h, dt);
  raf(frame);
}
raf(frame);

// 供测试与调试引用
module.exports = { app: app, manager: manager };
