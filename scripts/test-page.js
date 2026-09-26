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
    rect: function () {}, clip: function () {},
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

/** 内存 wx storage（松桂账本持久化） */
var storageData = {};

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
  getStorageSync: function (k) { return storageData[k] || ''; },
  setStorageSync: function (k, v) { storageData[k] = v; },
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
  assert('桩环境无刘海下沉量', app.topInset, 0);
  truthy('菜单按钮已布局', manager.current.buttons.length === 5);
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

console.log('\n[8] 绝杀演出：替代系统弹窗 + 朗读杀法名');
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
  assert('结果带演出几何（炮架）', b.game.result.mateInfo.screen, C.idxOf(5, 0));
  assert('落子动画期间还没起演出', b.endgame.isActive(), false);

  pumpMs(600);
  assert('动画播完后起演出', b.endgame.isActive(), true);
  assert('不再弹系统窗', shownModals.length, 0);
  assert('落款标题是杀法名', b.endgame.title(), '马后炮');
  assert('落款副标题是胜负', b.endgame.subtitle(), '红方胜');
  truthy('朗读了对应杀法', audioSrcs.indexOf('/audio/mate-mahoupao.m4a') >= 0);

  // 演出期间棋盘与工具栏都不响应；按钮未浮现时点按只算跳过
  pumpMs(300);
  assert('演出未播完时按钮不可点', b.endgame.hitButtonAt(app.w / 2, app.h / 2), null);
  assert('演出期间棋盘不吃触摸', b.controller.selected, -1);

  tap(app.w / 2, 40);
  assert('点空白处跳过演出', b.endgame.isDone(), true);

  // 落款按钮：再来一局
  var again = null;
  b.endgame.buttons.forEach(function (x) { if (x.id === 'again') again = x; });
  truthy('有「再来一局」按钮', again);
  tap(again.x + again.w / 2, again.y + again.h / 2);
  assert('点再来一局后重开', b.game.plyCount(), 0);
  assert('重开后演出收起', b.endgame.isActive(), false);

  // 非杀法终局：演出照起，但不朗读、标题用终局原因
  b.game = new Game();
  b.controller.setGame(b.game);
  b.resultShown = false;
  audioSrcs.length = 0;
  b.game.finish(C.BLACK, '认输');
  b.showResult();
  pumpMs(16);
  assert('认输也起演出', b.endgame.isActive(), true);
  assert('认输标题用终局原因', b.endgame.title(), '认输');
  assert('认输副标题', b.endgame.subtitle(), '黑方胜');
  // 胜负音效照常播，但不应有杀法语音
  var mateVoices = audioSrcs.filter(function (s) { return s.indexOf('/audio/mate-') === 0; });
  assert('认输不朗读杀法', mateVoices.length, 0);
  truthy('认输仍播胜负音效', audioSrcs.length > 0);

  // 落款按钮：回菜单
  b.endgame.skip();
  pumpMs(16);
  var menuBtn = null;
  b.endgame.buttons.forEach(function (x) { if (x.id === 'menu') menuBtn = x; });
  truthy('有「回菜单」按钮', menuBtn);
  tap(menuBtn.x + menuBtn.w / 2, menuBtn.y + menuBtn.h / 2);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n[9] 联机终局不给「再来一局」');
(function () {
  // 联机不能重开，演出就不该给「再来一局」这个按钮；复盘两边都有
  var Endgame = require(path.join(__dirname, '..', 'miniprogram', 'ui', 'endgame.js'));
  var eg = new Endgame();
  eg.start({ winner: 0, reason: '将死' }, { online: true });
  var ids = eg.layoutButtons(375, 700).map(function (x) { return x.id; });
  assert('联机：复盘 + 回菜单', ids.join(','), 'replay,menu');

  var eg2 = new Endgame();
  eg2.start({ winner: 0, reason: '将死' }, { online: false });
  var ids2 = eg2.layoutButtons(375, 700).map(function (x) { return x.id; });
  assert('人机/本地：复盘 + 再来一局 + 回菜单', ids2.join(','), 'replay,again,menu');
})();

console.log('\n[10] 松桂账本：人对人记账与菜单展示');
(function () {
  var Game = require(path.join(__dirname, '..', 'miniprogram', 'core', 'game.js'));
  var C = require(path.join(__dirname, '..', 'miniprogram', 'core', 'constants.js'));
  var texts = global.__canvas.ctx.calls.fillText;

  // 第 [1] 节菜单首绘时账本还是空的，空账文案应已上过屏
  truthy('空账文案上过屏', texts.indexOf('松桂账本 · 待首局开枰') >= 0);

  /** 终局演出 → 跳过 → 点「回菜单」 */
  function leaveViaEndgame(b) {
    b.endgame.skip();
    pumpMs(16);
    var menuBtn = null;
    b.endgame.buttons.forEach(function (x) { if (x.id === 'menu') menuBtn = x; });
    truthy('演出有「回菜单」按钮', menuBtn);
    tap(menuBtn.x + menuBtn.w / 2, menuBtn.y + menuBtn.h / 2);
  }

  // 本地双人：黑胜 → 桂记一胜（本地红=松、黑=桂）
  var c = buttonCenter(manager.current, 'local');
  tap(c.x, c.y);
  assert('进入本地双人', manager.current.name, 'board');
  var b = manager.current;
  b.game.finish(C.BLACK, '将死');
  b.showResult();
  var s1 = app.ledger.summary();
  assert('黑胜记入桂', s1.gui, 1);
  assert('松仍为零', s1.song, 0);
  assert('总局数为 1', s1.total, 1);
  leaveViaEndgame(b);
  assert('返回菜单', manager.current.name, 'menu');
  pump(16);
  truthy('菜单比分行上过屏', texts.indexOf('松 0 : 1 桂') >= 0);
  truthy('最近局文案格式', /^上局 桂胜 · 双人 · \d{2}-\d{2}$/.test(app.ledger.lastLine()));

  // 联机：本机（房主执红）胜 → 松记一胜
  var pair = NT.createLoopbackPair();
  var host = new OnlineSession(pair[0], { clientId: 'h2' });
  var guest = new OnlineSession(pair[1], { clientId: 'g2' });
  host.createRoom('LG01');
  guest.joinRoom('LG01');
  app.session = host;
  app.transport = pair[0];
  app.go('board', { mode: 'online' });
  var ob = manager.current;
  ob.game.finish(ob.humanSide, '将死');
  ob.showResult();
  var s2 = app.ledger.summary();
  assert('联机本机胜记入松', s2.song, 1);
  assert('总局数累加到 2', s2.total, 2);
  leaveViaEndgame(ob);
  assert('联机退出回菜单', manager.current.name, 'menu');
  assert('联机退出清理会话', app.session, null);
  pump(16);
  truthy('累计比分行上过屏', texts.indexOf('松 1 : 1 桂') >= 0);
  truthy('最近局为联机', app.ledger.lastLine().indexOf('联机') >= 0);

  // 人机：练棋不入账
  var c2 = buttonCenter(manager.current, 'ai');
  tap(c2.x, c2.y);
  var ab = manager.current;
  ab.game.finish(ab.humanSide, '将死');
  ab.showResult();
  assert('人机局不入账', app.ledger.summary().total, 2);
  leaveViaEndgame(ab);
  assert('返回菜单收尾', manager.current.name, 'menu');

  // 账本已写入 wx storage（下次启动可读）
  truthy('账本已持久化到 storage', !!storageData['songgui-ledger-v1']);
  assert('存储中的总局数', storageData['songgui-ledger-v1'].total, 2);
})();

console.log('\n[11] 打击感：吃子震屏 + 木屑粒子 + 将军冲击波');
(function () {
  var Game = require(path.join(__dirname, '..', 'miniprogram', 'core', 'game.js'));
  var C = require(path.join(__dirname, '..', 'miniprogram', 'core', 'constants.js'));

  var c = buttonCenter(manager.current, 'local');
  tap(c.x, c.y);
  assert('进入本地双人', manager.current.name, 'board');
  var b = manager.current;

  // 红车吃黑车、且吃完与同列黑将照面（既吃子又将军）
  b.game = new Game('4k4/9/4r4/9/9/4R4/9/9/9/4K4 w - - 0 1');
  b.controller.setGame(b.game);
  b.fx.clear();
  b.shake = 0;

  b.controller.requestMove(C.idxOf(4, 5), C.idxOf(4, 2));
  assert('吃子走成', b.game.history.length, 1);
  assert('吃完将军', b.game.isChecked(), true);
  truthy('将军冲击波已入池', b.fx.count() > 0);

  // 走子动画 200ms：播到 240ms 时落定冲击（震屏/木屑）已触发且未衰减完
  pumpMs(240);
  truthy('吃子震屏中', b.shake > 0);
  truthy('木屑/桂花粒子活跃', b.fx.count() > 0);

  // 震屏 160ms 衰减完毕
  pumpMs(1000);
  assert('震屏已衰减归零', b.shake, 0);

  // 被吃棋子的击飞绘制不崩（动画期间的渲染路径已随 pump 覆盖）
  var back = centerOf(b.toolbar[4]);
  tap(back.x, back.y);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n[12] 菜单桂花粒子');
(function () {
  // 菜单每帧渲染，粒子按 380ms 间隔飘落；推 1.2s 应有花瓣入池
  var m = manager.current;
  m.fx.clear();
  pumpMs(1200);
  truthy('菜单桂花飘落中', m.fx.count() > 0);
  pumpMs(4000);
  truthy('花瓣数量受上限约束', m.fx.count() <= 16);
})();

console.log('\n[13] 设置页：音乐/配乐/音效/先后手/主题统一管理');
(function () {
  var C = require(path.join(__dirname, '..', 'miniprogram', 'core', 'constants.js'));
  var m = manager.current;
  assert('当前在菜单', m.name, 'menu');
  assert('菜单无音乐音效开关行', typeof m.toggles, 'undefined');

  // 进入设置页（「系统设置」按钮在查看规则之下）
  var gear = buttonCenter(m, 'settings');
  truthy('菜单有系统设置入口', gear);
  tap(gear.x, gear.y);
  assert('进入设置页', manager.current.name, 'settings');
  var s = manager.current;
  assert('五行设置项', s.rows.length, 5);
  assert('行序：音乐/配乐/音效/先后手/主题',
    s.rows.map(function (r) { return r.id; }).join(','), 'bgm,track,sfx,side,theme');
  pump(16);
  truthy('设置页已绘制', global.__canvas.ctx.calls.fillText.indexOf('系统设置') >= 0);

  function row(id) {
    for (var i = 0; i < s.rows.length; i++) if (s.rows[i].id === id) return s.rows[i];
    return null;
  }
  function tapSeg(r, frac) { tap(r.seg.x + r.seg.w * frac, r.seg.y + r.seg.h / 2); }

  // 音乐开关：关 → 开
  var bgmWasOn = app.audio.bgmOn;
  tapSeg(row('bgm'), bgmWasOn ? 0.25 : 0.75); // 拨到相反档
  assert('音乐开关已翻转', app.audio.bgmOn, !bgmWasOn);
  tapSeg(row('bgm'), bgmWasOn ? 0.75 : 0.25); // 拨回
  assert('音乐开关拨回', app.audio.bgmOn, bgmWasOn);

  // 配乐切换：松风 ↔ 桂月（换 src 且持久化）
  var t0 = app.audio.track;
  tapSeg(row('track'), t0 === 0 ? 0.75 : 0.25);
  assert('切曲生效', app.audio.track, 1 - t0);
  assert('BGM 源已换', app.audio.bgm.src, app.audio.BGM_TRACKS[1 - t0].src);
  tapSeg(row('track'), t0 === 0 ? 0.25 : 0.75);
  assert('切回原曲', app.audio.track, t0);

  // 音效开关
  var sfxWasOn = app.audio.sfxOn;
  tapSeg(row('sfx'), sfxWasOn ? 0.25 : 0.75);
  assert('音效开关已翻转', app.audio.sfxOn, !sfxWasOn);
  tapSeg(row('sfx'), sfxWasOn ? 0.75 : 0.25);

  // 先后手：默认执红 → 让先执黑
  assert('默认执红', app.humanSide, C.RED);
  tapSeg(row('side'), 0.75);
  assert('切到让先执黑', app.humanSide, C.BLACK);

  // 主题：松桂 → 紫金夜 → 切回（切回后色值还原）
  var Themes = require(path.join(__dirname, '..', 'miniprogram', 'ui', 'themes.js'));
  var Wm = require(path.join(__dirname, '..', 'miniprogram', 'ui', 'widgets.js'));
  var Rm = require(path.join(__dirname, '..', 'miniprogram', 'ui', 'renderer.js'));
  var Cm = require(path.join(__dirname, '..', 'miniprogram', 'ui', 'chrome.js'));
  assert('默认主题为松桂', Themes.key(), 'pine');
  var bgBefore = Wm.THEME.bg;
  tapSeg(row('theme'), 0.75);
  assert('切到紫金夜', Themes.key(), 'nebula');
  assert('控件底色已换', Wm.THEME.bg, '#1a1230');
  assert('棋盘格线已换金', Rm.THEME.line, '#d9b878');
  assert('屏幕底色已换深空', Cm.PALETTE.bgStops[0], '#1e1436');
  assert('主题已持久化', storageData.chess_theme, 'nebula');
  tapSeg(row('theme'), 0.25);
  assert('切回松桂', Themes.key(), 'pine');
  assert('控件底色还原', Wm.THEME.bg, bgBefore);
  assert('棋盘格线还原', Rm.THEME.line, '#5d4037');
  assert('持久化同步还原', storageData.chess_theme, 'pine');

  // 返回菜单
  tap(s.back.x + s.back.w / 2, s.back.y + s.back.h / 2);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n[14] 让先执黑：人机 AI 先手 + 本地账本按松的边记');
(function () {
  var C = require(path.join(__dirname, '..', 'miniprogram', 'core', 'constants.js'));
  assert('设置页选边已生效', app.humanSide, C.BLACK);

  // --- 人机：执黑 = AI 执红先手，棋盘整盘翻转 ---
  var c = buttonCenter(manager.current, 'ai');
  tap(c.x, c.y);
  assert('进入人机对局', manager.current.name, 'board');
  var b = manager.current;
  assert('人执黑', b.humanSide, C.BLACK);
  assert('AI 执红', b.aiSide, C.RED);
  assert('棋盘翻转为黑方视角', b.layout.flipped, true);
  truthy('模式文案含执黑', b.modeLabel.indexOf('执黑') >= 0);
  pumpMs(1500);
  truthy('AI 自动先走一步', b.game.plyCount() >= 1);
  assert('第一手是红方（AI）走的', b.game.history[0].side, C.RED);

  // 执黑悔棋的边角：悔回开局后轮到 AI，必须重新调度（否则卡死无人走子）
  while (b.game.plyCount() > 1) b.game.undo(1); // 收敛到只剩 AI 第一手
  b.controller.reset();
  var undoBtn = null;
  b.toolbar.forEach(function (x) { if (x.id === 'undo') undoBtn = x; });
  tap(undoBtn.x + undoBtn.w / 2, undoBtn.y + undoBtn.h / 2);
  // 测试里 setTimeout 是同步桩：悔回开局 → 重新调度 → AI 已同步走回一手
  assert('悔棋后 AI 立即重新执红先走', b.game.plyCount(), 1);
  assert('重走的是红方（AI）', b.game.history[0].side, C.RED);
  pumpMs(1500);
  truthy('棋局继续未卡死', b.game.plyCount() >= 1);
  var back = centerOf(b.toolbar[4]);
  tap(back.x, back.y);
  assert('返回菜单', manager.current.name, 'menu');

  // --- 本地双人：松执黑，黑胜记松 ---
  var c2 = buttonCenter(manager.current, 'local');
  tap(c2.x, c2.y);
  var lb = manager.current;
  assert('本地双人松执黑', lb.humanSide, C.BLACK);
  var before = app.ledger.summary();
  lb.game.finish(C.BLACK, '将死'); // 黑胜 = 松胜
  lb.showResult();
  var after = app.ledger.summary();
  assert('黑胜记入松', after.song, before.song + 1);
  assert('桂不加分', after.gui, before.gui);
  lb.endgame.skip();
  pumpMs(16);
  var menuBtn = null;
  lb.endgame.buttons.forEach(function (x) { if (x.id === 'menu') menuBtn = x; });
  tap(menuBtn.x + menuBtn.w / 2, menuBtn.y + menuBtn.h / 2);
  assert('收尾回菜单', manager.current.name, 'menu');

  // 还原默认：回设置页拨回执红，别污染后续启动的默认口径
  var m2 = manager.current;
  var gear2 = buttonCenter(m2, 'settings');
  tap(gear2.x, gear2.y);
  var s2 = manager.current;
  var sideRow = null;
  s2.rows.forEach(function (r) { if (r.id === 'side') sideRow = r; });
  tap(sideRow.seg.x + sideRow.seg.w * 0.25, sideRow.seg.y + sideRow.seg.h / 2);
  assert('拨回执红', app.humanSide, C.RED);
  tap(s2.back.x + s2.back.w / 2, s2.back.y + s2.back.h / 2);
  assert('回菜单收尾', manager.current.name, 'menu');
})();

console.log('\n[15] 账本详情页：比分/连胜/逐局列表/滚动');
(function () {
  var C = require(path.join(__dirname, '..', 'miniprogram', 'core', 'constants.js'));
  var m = manager.current;
  assert('当前在菜单', m.name, 'menu');
  pump(16);
  truthy('比分行带可点箭头', global.__canvas.ctx.calls.fillText.indexOf('›') >= 0);

  // 此前账本流水：[10] 桂胜(local) → 松胜(online) → [14] 松胜(local 执黑)
  // 旧→新 [gui, song, song]，应见「松 · 2 连胜」
  var lr = m.ledgerRect;
  truthy('账本行热区已建', lr);
  tap(lr.x + lr.w / 2, lr.y + lr.h / 2);
  assert('进入账本详情页', manager.current.name, 'ledger');
  var s = manager.current;
  assert('逐局行数', s.rows.length, 3);
  assert('最新局在上', s.rows[0].outcome, 'song');
  assert('大比分文案', s.scoreLine, '松 2 : 1 桂');
  assert('连胜横幅', s.streakLine, '松 · 2 连胜');
  pump(16);
  truthy('详情页标题已绘制', global.__canvas.ctx.calls.fillText.indexOf('松桂账本') >= 0);
  truthy('连胜横幅已绘制', global.__canvas.ctx.calls.fillText.indexOf('松 · 2 连胜') >= 0);

  // 补 20 局制造可滚动列表，重进页面验证滚动
  for (var i = 0; i < 20; i++) {
    app.ledger.record({ mode: 'local', result: { winner: C.RED, reason: '将死', text: '测试局 ' + (i + 1) } });
  }
  app.go('menu');
  var m2 = manager.current;
  tap(m2.ledgerRect.x + m2.ledgerRect.w / 2, m2.ledgerRect.y + m2.ledgerRect.h / 2);
  var s2 = manager.current;
  assert('补记后行数', s2.rows.length, 23);
  truthy('产生可滚动区间', s2.maxScroll > 0);
  var y0 = s2.listTop + 100;
  touchHandlers.start({ touches: [{ clientX: 187, clientY: y0 + 120 }] });
  touchHandlers.move({ touches: [{ clientX: 187, clientY: y0 }] });
  touchHandlers.end({ changedTouches: [{ clientX: 187, clientY: y0 }] });
  truthy('拖动产生滚动', s2.scrollY > 0);

  tap(s2.back.x + s2.back.w / 2, s2.back.y + s2.back.h / 2);
  assert('返回菜单', manager.current.name, 'menu');
})();

console.log('\n[16] 复盘：步进/回退/自动播放/绝杀重演');
(function () {
  var Game = require(path.join(__dirname, '..', 'miniprogram', 'core', 'game.js'));
  var C = require(path.join(__dirname, '..', 'miniprogram', 'core', 'constants.js'));

  /** 终局演出 → 跳过 → 点指定落款按钮 */
  function endgameTap(b, id) {
    b.endgame.skip();
    pumpMs(16);
    var btn = null;
    b.endgame.buttons.forEach(function (x) { if (x.id === id) btn = x; });
    truthy('演出有「' + id + '」按钮', btn);
    tap(btn.x + btn.w / 2, btn.y + btn.h / 2);
  }

  // --- A. 多手普通局（认输终局，无杀法）---
  var c = buttonCenter(manager.current, 'local');
  tap(c.x, c.y);
  assert('进入本地双人', manager.current.name, 'board');
  var b = manager.current;

  // 走四手经典开局：炮八平五 / 马8进7 / 马二进三 / 卒7进1
  b.controller.requestMove(C.idxOf(1, 7), C.idxOf(4, 7));
  b.controller.requestMove(C.idxOf(7, 0), C.idxOf(6, 2));
  b.controller.requestMove(C.idxOf(1, 9), C.idxOf(2, 7));
  b.controller.requestMove(C.idxOf(6, 3), C.idxOf(6, 4));
  assert('四手棋已走', b.game.plyCount(), 4);
  b.game.finish(C.RED, '认输');
  b.showResult();

  endgameTap(b, 'replay');
  assert('进入复盘场景', manager.current.name, 'replay');
  var r = manager.current;
  assert('复盘初始在开局', r.ply, 0);
  assert('复盘装载全部棋谱', r.moves.length, 4);
  assert('开局状态文案', r.statusText, '共 4 手');
  assert('中键初始为播放', r.toolbar[2].label, '播放');

  // 单步前进：带动画，状态栏出着法
  tap(centerOf(r.toolbar[3]).x, centerOf(r.toolbar[3]).y); // 下步
  assert('前进一步', r.ply, 1);
  assert('前进时播走子动画', r.controller.isAnimating(), true);
  pumpMs(300);
  assert('动画已落定', r.controller.isAnimating(), false);
  truthy('状态栏出着法', r.statusText.indexOf('第 1/4 手 · 炮八平五') >= 0);

  // 自动播放：到底自停
  tap(centerOf(r.toolbar[2]).x, centerOf(r.toolbar[2]).y); // 播放
  assert('自动播放中', r.playing, true);
  assert('播放中键变暂停', r.toolbar[2].label, '暂停');
  pumpMs(2000);
  truthy('自动推进中（' + r.ply + ' 手）', r.ply >= 3);
  pumpMs(3000);
  assert('播到终局', r.ply, 4);
  assert('到底自动停', r.playing, false);
  assert('无杀法中键仍是播放', r.toolbar[2].label, '播放');

  // 后退与跳回开局
  tap(centerOf(r.toolbar[1]).x, centerOf(r.toolbar[1]).y); // 上步
  assert('后退一步', r.ply, 3);
  tap(centerOf(r.toolbar[0]).x, centerOf(r.toolbar[0]).y); // 开局
  assert('跳回开局', r.ply, 0);
  assert('上一步在边界无效', r.stepBack(), false);

  // 棋盘不吃触摸：点棋盘不改变任何状态
  var bp = r.layout.pointOf(C.idxOf(4, 7));
  tap(r.boardX + bp.x, r.boardTop + bp.y);
  assert('点棋盘不选中棋子', r.controller.selected, -1);
  assert('点棋盘不改手数', r.ply, 0);

  // 跳到终局（静默连放）
  r.gotoEnd();
  assert('跳到终局', r.ply, 4);
  assert('跳终局不播动画', r.controller.isAnimating(), false);

  tap(centerOf(r.toolbar[4]).x, centerOf(r.toolbar[4]).y); // 退出
  assert('退出复盘回菜单', manager.current.name, 'menu');

  // --- B. 绝杀局：终局后中键变「绝杀」，可重演演出 ---
  var c2 = buttonCenter(manager.current, 'local');
  tap(c2.x, c2.y);
  var b2 = manager.current;
  b2.game = new Game('3akN3/4a3C/9/9/9/5R3/9/9/9/5K3 w - - 0 1');
  b2.controller.setGame(b2.game);
  b2.resultShown = false;
  b2.controller.requestMove(C.idxOf(8, 1), C.idxOf(8, 0)); // 炮二进一，马后炮
  truthy('走出将死', b2.game.result);
  pumpMs(600); // 落子动画播完才起演出
  assert('演出已起', b2.endgame.isActive(), true);

  endgameTap(b2, 'replay');
  assert('绝杀局进入复盘', manager.current.name, 'replay');
  var r2 = manager.current;
  r2.gotoEnd();
  assert('终局一手', r2.ply, 1);
  assert('中键变为绝杀', r2.toolbar[2].label, '绝杀');

  tap(centerOf(r2.toolbar[2]).x, centerOf(r2.toolbar[2]).y); // 绝杀
  assert('重演绝杀演出', r2.endgame.isActive(), true);
  pumpMs(100);
  tap(app.w / 2, 40); // 未播完：点屏跳过
  assert('点屏跳过演出', r2.endgame.isDone(), true);
  tap(app.w / 2, 40); // 已播完：点屏收起
  assert('演出已收起', r2.endgame.isActive(), false);

  tap(centerOf(r2.toolbar[4]).x, centerOf(r2.toolbar[4]).y);
  assert('收尾回菜单', manager.current.name, 'menu');
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m小游戏接线测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m小游戏接线全部测试通过\x1b[0m\n');
