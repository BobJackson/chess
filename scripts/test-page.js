/**
 * 小游戏接线冒烟测试（node scripts/test-page.js）
 *
 * 小游戏入口 game.js 依赖 wx 全局 API，这里桩掉：
 *   wx.createCanvas / getSystemInfoSync / onTouch* / showToast / showModal /
 *   showKeyboard 系列 / vibrateShort，并把 setTimeout 桩为同步以驱动 AI 回合。
 * 真实加载 game.js 后通过捕获的触摸处理器驱动场景状态机：
 *   菜单 -> 人机对局（走子+AI 应招）-> 菜单 -> 规则（滚动）-> 大厅（软键盘录入）
 *   -> 联机对局（回环传输双会话同步）-> 退出清理。
 */

var path = require('path');

var OnlineSession = require('../miniprogram/net/session.js');
var NT = require('../miniprogram/net/transport.js');

var passed = 0;
var failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log('  \x1b[32mPASS\x1b[0m  ' + name + ' = ' + JSON.stringify(actual));
  } else {
    failed++;
    console.log('  \x1b[31mFAIL\x1b[0m  ' + name +
      ' 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}
function truthy(name, actual) { assert(name, !!actual, true); }

// ---------------------------------------------------------------------------
// 桩 Canvas 2D 上下文
// ---------------------------------------------------------------------------
function createStubContext() {
  var calls = { fillText: [], clearRect: 0, arc: 0 };
  return {
    calls: calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textAlign: '', textBaseline: '', globalAlpha: 1, lineCap: '',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
    clearRect: function () { calls.clearRect++; },
    fillRect: function () {}, strokeRect: function () {},
    beginPath: function () {}, closePath: function () {},
    moveTo: function () {}, lineTo: function () {},
    arc: function () { calls.arc++; },
    arcTo: function () {},
    stroke: function () {}, fill: function () {},
    save: function () {}, restore: function () {},
    scale: function () {}, setTransform: function () {}, translate: function () {}, rotate: function () {},
    fillText: function (t) { calls.fillText.push(t); },
    measureText: function (t) { return { width: String(t).length * 13 }; },
    createLinearGradient: function () { return { addColorStop: function () {} }; },
    createRadialGradient: function () { return { addColorStop: function () {} }; }
  };
}

// ---------------------------------------------------------------------------
// 桩 wx 全局
// ---------------------------------------------------------------------------
var touchHandlers = {};
var keyboardHandlers = {};
var shownModals = [];
var shownToasts = [];
var keyboardShown = 0;

global.wx = {
  getSystemInfoSync: function () { return { windowWidth: 375, windowHeight: 667, pixelRatio: 2 }; },
  createCanvas: function () {
    var ctx = createStubContext();
    var node = {
      width: 0, height: 0, ctx: ctx, _raf: null,
      getContext: function () { return ctx; },
      requestAnimationFrame: function (cb) { node._raf = cb; return cb; }
    };
    global.__canvas = node;
    return node;
  },
  onTouchStart: function (cb) { touchHandlers.start = cb; },
  onTouchMove: function (cb) { touchHandlers.move = cb; },
  onTouchEnd: function (cb) { touchHandlers.end = cb; },
  onTouchCancel: function (cb) { touchHandlers.cancel = cb; },
  showToast: function (o) { shownToasts.push(o.title); },
  showModal: function (o) { shownModals.push(o); },
  vibrateShort: function () {},
  showKeyboard: function () { keyboardShown++; },
  hideKeyboard: function () {},
  onKeyboardInput: function (cb) { keyboardHandlers.input = cb; },
  onKeyboardComplete: function (cb) { keyboardHandlers.complete = cb; },
  offKeyboardInput: function () {},
  offKeyboardComplete: function () {}
};
global.setTimeout = function (fn) { fn(); return 0; };

function tap(x, y) {
  touchHandlers.start({ touches: [{ clientX: x, clientY: y }] });
  touchHandlers.end({ changedTouches: [{ clientX: x, clientY: y }] });
}
function centerOf(rect) { return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }
function buttonCenter(scene, id) {
  for (var i = 0; i < scene.buttons.length; i++) {
    if (scene.buttons[i].id === id) return centerOf(scene.buttons[i]);
  }
  return null;
}
function pump(ts) {
  if (global.__canvas && global.__canvas._raf) global.__canvas._raf(ts || 16);
}

// ---------------------------------------------------------------------------
// 加载入口
// ---------------------------------------------------------------------------
var entry = require(path.join(__dirname, '..', 'miniprogram', 'game.js'));
var app = entry.app;
var manager = entry.manager;

console.log('\n[1] 入口与主菜单');
(function () {
  truthy('app 上下文创建', app);
  assert('初始场景为菜单', manager.current.name, 'menu');
  truthy('菜单按钮已布局', manager.current.buttons.length === 4);
  pump(16);
  truthy('菜单已绘制', global.__canvas.ctx.calls.fillText.length > 0);

  // 切换难度分段
  var seg = manager.current.seg;
  tap(seg.x + seg.w * 0.9, seg.y + seg.h / 2); // 最后一档
  assert('分段可切换难度', app.difficulty, 'master');
  tap(seg.x + seg.w * 0.5, seg.y + seg.h / 2); // 回到中等
  assert('分段可切回', app.difficulty, 'normal');
})();

console.log('\n[2] 人机对局：走子 + AI 应招 + 返回');
(function () {
  var c = buttonCenter(manager.current, 'ai');
  tap(c.x, c.y);
  assert('进入对局场景', manager.current.name, 'board');
  var b = manager.current;
  assert('人机模式', b.mode, 'ai');
  truthy('controller 已创建', b.controller);

  pump(32);
  truthy('棋盘已绘制', global.__canvas.ctx.calls.fillText.length > 0);

  var from = b.layout.pointOf(54);
  var to = b.layout.pointOf(45);
  var sx = b.boardX, sy = b.boardTop;
  tap(sx + from.x, sy + from.y);
  assert('点选选中红兵', b.controller.selected, 54);
  tap(sx + to.x, sy + to.y);
  assert('人手走子成功', b.game.history.length >= 1, true);
  assert('AI 已应招（共两手）', b.game.history.length, 2);

  // 工具栏返回
  var back = centerOf(b.toolbar[4]);
  tap(back.x, back.y);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n[3] 规则场景：滚动与返回');
(function () {
  var c = buttonCenter(manager.current, 'rules');
  tap(c.x, c.y);
  assert('进入规则场景', manager.current.name, 'rules');
  var r = manager.current;
  truthy('规则已折行', r.lines.length > 10);
  assert('初始无滚动', r.scrollY, 0);

  touchHandlers.start({ touches: [{ clientX: 187, clientY: 400 }] });
  touchHandlers.move({ touches: [{ clientX: 187, clientY: 320 }] });
  touchHandlers.end({ changedTouches: [{ clientX: 187, clientY: 320 }] });
  truthy('拖动产生滚动', r.scrollY > 0);

  var back = centerOf(r.back);
  tap(back.x, back.y);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n[4] 联机大厅：软键盘录入房间号');
(function () {
  var c = buttonCenter(manager.current, 'online');
  tap(c.x, c.y);
  assert('进入大厅场景', manager.current.name, 'lobby');
  var l = manager.current;

  var ib = centerOf(l.inputBox);
  tap(ib.x, ib.y);
  assert('点输入框唤起软键盘', keyboardShown, 1);
  keyboardHandlers.input({ value: 'ab12' });
  assert('键盘输入写入并转大写', l.code, 'AB12');

  // 云未就绪时创建/加入应提示而非崩溃
  l.onCreate();
  truthy('云未就绪给出提示', shownToasts.indexOf('云开发未就绪') >= 0);

  var back = buttonCenter(l, 'back');
  tap(back.x, back.y);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n[5] 联机对局：回环双会话同步与退出清理');
(function () {
  var pair = NT.createLoopbackPair();
  var host = new OnlineSession(pair[0], { clientId: 'host' });
  var guest = new OnlineSession(pair[1], { clientId: 'guest' });
  host.createRoom('GM01');
  guest.joinRoom('GM01');
  assert('回环双方进入对局', host.state === 'playing' && guest.state === 'playing', true);

  app.session = host;
  app.transport = pair[0];
  app.go('board', { mode: 'online' });
  var b = manager.current;
  assert('进入联机对局', b.name, 'board');
  assert('使用会话对局', b.game === host.game, true);
  assert('房主执红', b.humanSide, 0);

  var from = b.layout.pointOf(54);
  var to = b.layout.pointOf(45);
  tap(b.boardX + from.x, b.boardTop + from.y);
  tap(b.boardX + to.x, b.boardTop + to.y);
  assert('本局走一手', b.game.history.length, 1);
  assert('对手已同步', guest.game.history.length, 1);

  guest.game.move(31, 40);
  guest.broadcastMove(31, 40);
  assert('重放对手着', b.game.history.length, 2);

  var back = centerOf(b.toolbar[4]);
  tap(back.x, back.y);
  assert('对手收到离开通知', guest.opponentConnected, false);
  assert('全局会话已清理', app.session, null);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m小游戏接线测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m小游戏接线全部测试通过\x1b[0m\n');
