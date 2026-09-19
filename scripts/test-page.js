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
var CloudTransport = require('../miniprogram/net/cloud-transport.js');
var NT = require('../miniprogram/net/transport.js');

// 本测试的假云总线基于 CloudTransport，故把通道配置切到 cloud（ws 通道见 test-ws.js）
require('../miniprogram/net/config.js').kind = 'cloud';

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
var sharedCards = [];
var showHandlers = [];
var menuShareHandler = null;
var keyboardShown = 0;

/** 同步 thenable：让 promise 链在当前同步流程内执行，便于断言 */
function syncPromise(value, reject) {
  var p = {
    then: function (cb) { if (!reject && cb) cb(value); return p; },
    catch: function (cb) { if (reject && cb) cb(new Error('stub')); return p; }
  };
  return p;
}

/** 内存假云：rooms + msgs + watch 广播总线（与 test-cloud 同构的精简版） */
function createFakeCloud() {
  var rooms = {};
  var msgs = [];
  var watchers = [];
  var seq = 0;
  function notify(room) {
    watchers.slice().forEach(function (w) {
      if (w.room === room && w.onChange) {
        w.onChange({ type: 'queue', docs: msgs.filter(function (m) { return m.room === room; }) });
      }
    });
  }
  return {
    rooms: rooms,
    db: {
      collection: function (name) {
        if (name === 'chess_rooms') {
          return {
            add: function (arg) {
              var d = arg.data;
              if (rooms[d._id]) return syncPromise(null, true);
              rooms[d._id] = d;
              return syncPromise({ _id: d._id }, false);
            },
            doc: function (id) {
              return {
                get: function () { return rooms[id] ? syncPromise({ data: rooms[id] }, false) : syncPromise(null, true); },
                remove: function () { if (rooms[id]) delete rooms[id]; return syncPromise({}, false); }
              };
            }
          };
        }
        return {
          add: function (arg) {
            var d = arg.data; d._id = 'm' + (++seq); msgs.push(d); notify(d.room);
            return syncPromise({ _id: d._id }, false);
          },
          where: function (q) {
            return {
              watch: function (handlers) {
                var w = { room: q.room, onChange: handlers.onChange };
                watchers.push(w);
                handlers.onChange({ type: 'init', docs: msgs.filter(function (m) { return m.room === q.room; }) });
                return { close: function () { var i = watchers.indexOf(w); if (i >= 0) watchers.splice(i, 1); } };
              }
            };
          }
        };
      }
    }
  };
}
var fakeCloud = createFakeCloud();

/** 记录所有被播放的音频源，用于验证绝杀语音确实被请求 */
var audioSrcs = [];

function makeAudioCtx() {
  var c = {
    src: '', loop: false, volume: 1, currentTime: 0, plays: 0,
    play: function () { c.plays++; audioSrcs.push(c.src); },
    pause: function () {},
    stop: function () {},
    onEnded: function () {}
  };
  return c;
}

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
  offKeyboardComplete: function () {},
  shareAppMessage: function (o) { sharedCards.push(o); },
  showShareMenu: function () {},
  onShareAppMessage: function (cb) { menuShareHandler = cb; },
  onShow: function (cb) { showHandlers.push(cb); },
  onHide: function () {},
  createInnerAudioContext: makeAudioCtx,
  cloud: { database: function () { return fakeCloud.db; }, init: function () {} }
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

/**
 * 推进 ms 毫秒的 rAF 帧
 *
 * 主循环按帧间 dt 驱动走子动画，故时间戳必须单调累积；
 * 落子动画播完才会轮到 AI 应招，测试里靠这个把时间推过去。
 */
var frameClock = 32;
function pumpMs(ms) {
  for (var t = 0; t < ms; t += 16) {
    frameClock += 16;
    pump(frameClock);
  }
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

  // 布局：棋盘在状态栏与工具栏之间垂直居中，且侧边有边距
  var topGap = b.boardTop - b.areaTop;
  var bottomGap = b.areaBottom - (b.boardTop + b.boardHeight);
  assert('棋盘垂直居中（上下留白均分）', Math.abs(topGap - bottomGap) <= 1, true);
  truthy('侧边留有边距', b.boardX >= 12);

  pump(32);
  truthy('棋盘已绘制', global.__canvas.ctx.calls.fillText.length > 0);

  var from = b.layout.pointOf(54);
  var to = b.layout.pointOf(45);
  var sx = b.boardX, sy = b.boardTop;
  tap(sx + from.x, sy + from.y);
  assert('点选选中红兵', b.controller.selected, 54);
  tap(sx + to.x, sy + to.y);
  assert('人手走子成功', b.game.history.length >= 1, true);

  // 落子动画期间 AI 不抢手：先看见自己的兵走过去，再轮到对手
  assert('人手走子后进入落子动画', b.controller.isAnimating(), true);
  assert('动画未播完时 AI 不应招', b.game.history.length, 1);
  pumpMs(600);
  assert('AI 已应招（共两手）', b.game.history.length, 2);
  assert('双方落子动画均已播完', b.controller.isAnimating(), false);

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

console.log('\n[4] 联机大厅：建房/邀请/取消');
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

  // 建房（假云）→ 等待态，按钮切换为 邀请/取消/返回
  var createBtn = buttonCenter(l, 'create');
  tap(createBtn.x, createBtn.y);
  assert('建房后进入等待', l.session.state, 'waiting');
  assert('按钮切换为邀请', l.buttons[0].id, 'invite');
  truthy('房间文档已登记', !!fakeCloud.rooms[l.session.room]);

  // 邀请好友：分享卡片带房间号
  var inv = buttonCenter(l, 'invite');
  tap(inv.x, inv.y);
  assert('分享卡片已生成', sharedCards.length, 1);
  assert('卡片 query 带房间号', sharedCards[0].query, 'room=' + l.session.room);

  // 取消房间：回 idle 且房主清理房间文档
  var code = l.session.room;
  var cancel = buttonCenter(l, 'cancel');
  tap(cancel.x, cancel.y);
  assert('取消后回 idle', l.buttons[0].id, 'create');
  truthy('房间文档已清理', !fakeCloud.rooms[code]);

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

console.log('\n[6] 分享回流：好友点卡片自动加入');
(function () {
  // 先有一个房主在 QQ88 等待
  fakeCloud.rooms['QQ88'] = { _id: 'QQ88', creator: 'hostX', createdAt: 1 };
  var ht = new CloudTransport({ clientId: 'hostX' });
  ht.attach('QQ88');
  var host = new OnlineSession(ht, { clientId: 'hostX' });
  host.createRoom('QQ88');
  assert('房主等待中', host.state, 'waiting');

  // 好友点开分享卡片：onShow 带 query.room，自动进大厅并加入
  truthy('onShow 已注册', showHandlers.length >= 1);
  showHandlers[showHandlers.length - 1]({ query: { room: 'qq88' } });
  assert('自动进入对局', manager.current.name, 'board');
  assert('对局为联机模式', manager.current.mode, 'online');
  assert('房主侧进入对局', host.state, 'playing');

  // 退出：通知房主并清理
  var b = manager.current;
  var back = centerOf(b.toolbar[4]);
  tap(back.x, back.y);
  assert('回到菜单', manager.current.name, 'menu');
  assert('房主收到离开通知', host.opponentConnected, false);
})();

console.log('\n[7] 菜单被动分享：等待中携带房间号');
(function () {
  truthy('onShareAppMessage 已注册', menuShareHandler);

  // 无会话：通用邀请卡片，不带房间参数
  app.session = null;
  var generic = menuShareHandler();
  assert('无会话时标题不含房间', /房间/.test(generic.title), false);
  assert('无会话时 query 为空', generic.query, '');

  // 房主等待中：菜单分享携带房间号，好友点开即可入房
  var ht = new CloudTransport({ clientId: 'hostY' });
  ht.attach('MN55');
  var host = new OnlineSession(ht, { clientId: 'hostY' });
  host.createRoom('MN55');
  assert('房主等待中', host.state, 'waiting');
  app.session = host;
  var invite = menuShareHandler();
  truthy('标题含房间号', invite.title.indexOf('MN55') >= 0);
  assert('query 携带房间号', invite.query, 'room=MN55');

  // 对局进行中（非 waiting）：不再暴露房间号，避免好友加入已满房间
  host.state = 'playing';
  var inGame = menuShareHandler();
  assert('对局中 query 为空', inGame.query, '');

  host.leave();
  app.session = null;
})();

console.log('\n[8] 绝杀：弹窗带杀法名 + 朗读出来');
(function () {
  var Game = require(path.join(__dirname, '..', 'miniprogram', 'core', 'game.js'));
  var C = require(path.join(__dirname, '..', 'miniprogram', 'core', 'constants.js'));

  var c = buttonCenter(manager.current, 'ai');
  tap(c.x, c.y);
  assert('进入对局', manager.current.name, 'board');
  var b = manager.current;

  // 换成「红方一步成杀」的局面（炮二进一，以己方马为架）
  b.game = new Game('3akN3/4a3C/9/9/9/5R3/9/9/9/5K3 w - - 0 1');
  b.controller.setGame(b.game);
  b.resultShown = false;
  shownModals.length = 0;
  audioSrcs.length = 0;

  b.controller.requestMove(C.idxOf(8, 1), C.idxOf(8, 0));
  truthy('走出将死一手', b.game.result);
  assert('结果带杀法名', b.game.result.mate, '马后炮');
  assert('结果带杀法 key', b.game.result.mateKey, 'mahoupao');
  assert('落子动画期间先不弹窗', shownModals.length, 0);

  pumpMs(600);
  assert('动画播完后弹窗一次', shownModals.length, 1);
  assert('弹窗标题带杀法名', shownModals[0].title, '绝杀 · 马后炮');
  assert('弹窗正文带杀法名', shownModals[0].content, '马后炮，绝杀无解，红方胜');
  truthy('朗读了对应杀法', audioSrcs.indexOf('/audio/mate-mahoupao.m4a') >= 0);

  // 非杀法的终局不朗读、标题也不套杀法名
  b.resultShown = false;
  shownModals.length = 0;
  audioSrcs.length = 0;
  b.game = new Game();
  b.controller.setGame(b.game);
  b.game.finish(C.BLACK, '认输');
  b.showResult();
  assert('认输弹窗标题不带杀法名', shownModals[0].title, '对局结束');
  // 胜负音效照常播，但不应有杀法语音
  var mateVoices = audioSrcs.filter(function (s) { return s.indexOf('/audio/mate-') === 0; });
  assert('认输不朗读杀法', mateVoices.length, 0);
  truthy('认输仍播胜负音效', audioSrcs.length > 0);

  var back = centerOf(b.toolbar[4]);
  tap(back.x, back.y);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m小游戏接线测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m小游戏接线全部测试通过\x1b[0m\n');
