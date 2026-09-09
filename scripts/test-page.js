/**
 * 页面接线冒烟测试（node scripts/test-page.js）
 *
 * 小程序页面无法直接在 node 运行，这里桩掉 wx / Page / getApp / Canvas，
 * 真实加载 pages/game/game.js 与 pages/index/index.js，驱动完整链路：
 *   初始化（Canvas 尺寸、Layout、Controller）-> 人手走子 -> AI 应招
 *   -> 悔棋/提示/翻转/重开 -> 本地双人模式不触发 AI。
 * 目的是在不开微信开发者工具的前提下，抓住页面与 core/ui 模块之间的接线错误。
 */

var fs = require('fs');
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

function truthy(name, actual) {
  assert(name, !!actual, true);
}

// ---------------------------------------------------------------------------
// 桩 Canvas 2D 上下文
// ---------------------------------------------------------------------------

function gradientStub() {
  return { stops: [], addColorStop: function () {} };
}

function createStubContext() {
  var calls = { clearRect: 0, fillText: [], arc: 0 };
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
    stroke: function () {}, fill: function () {},
    save: function () {}, restore: function () {},
    scale: function () {}, setTransform: function () {},
    fillText: function (t) { calls.fillText.push(t); },
    createLinearGradient: gradientStub,
    createRadialGradient: gradientStub
  };
}

// ---------------------------------------------------------------------------
// 桩 wx / Page / getApp
// ---------------------------------------------------------------------------

var RECT_TOP = 100; // 画布距视口顶部，用于验证触摸坐标换算

function installGlobals() {
  var pages = {};
  var canvasNode = null;

  global.Page = function (config) {
    pages[pages.__last] = config;
    return config;
  };
  global.App = function (config) { return config; };
  var appSingleton = { globalData: { difficulty: 'normal', session: null, transport: null, cloudReady: false } };
  global.getApp = function () { return appSingleton; };

  global.wx = {
    getSystemInfoSync: function () { return { pixelRatio: 2 }; },
    showToast: function () {},
    showModal: function () {},
    vibrateShort: function () {},
    navigateTo: function () {},
    navigateBack: function () {},
    createSelectorQuery: function () {
      var q = {
        _rectCb: null,
        select: function () { return q; },
        fields: function () { return q; },
        boundingClientRect: function (cb) { q._rectCb = cb; return q; },
        exec: function (cb) {
          if (q._rectCb) {
            q._rectCb({ left: 0, top: RECT_TOP, width: 375, height: 400 });
          } else if (cb) {
            cb([{ node: canvasNode, width: 375, height: 400 }]);
          }
          return q;
        }
      };
      return q;
    }
  };

  // setTimeout 同步执行，让 AI 回合在测试里立即落子
  global.setTimeout = function (fn) { fn(); return 0; };

  function makeCanvas() {
    var ctx = createStubContext();
    var node = {
      width: 0, height: 0, _raf: null, ctx: ctx,
      getContext: function () { return ctx; },
      requestAnimationFrame: function (cb) { node._raf = cb; return cb; }
    };
    return node;
  }

  return {
    pages: pages,
    setCanvas: function (n) { canvasNode = n; },
    makeCanvas: makeCanvas
  };
}

// 先装好全局，再 require 页面模块（页面在加载时调用 Page(...)）
var env = installGlobals();

function loadPage(relPath, key) {
  env.pages.__last = key;
  var full = path.join(__dirname, '..', 'miniprogram', relPath);
  delete require.cache[require.resolve(full)];
  require(full);
  return env.pages[key];
}

/** 造一个可用的 page 实例（补齐 data / setData） */
function instantiate(config) {
  var page = Object.assign({}, config);
  page.data = Object.assign({}, config.data || {});
  page.setData = function (patch) { Object.assign(page.data, patch); };
  return page;
}

/** 驱动一帧渲染 */
function pump(page, ts) {
  if (page.canvas && page.canvas._raf) page.canvas._raf(ts || 16);
}

/** 生成带视口偏移的触摸事件 */
function touch(page, pt) {
  return { touches: [{ clientX: pt.x, clientY: pt.y + RECT_TOP }], changedTouches: [{ clientX: pt.x, clientY: pt.y + RECT_TOP }] };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

console.log('\n[1] 主页加载与难度数据');
(function () {
  var indexCfg = loadPage('pages/index/index.js', 'index');
  truthy('主页配置加载', indexCfg);
  var idx = instantiate(indexCfg);
  idx.onLoad();
  assert('难度档位数量', idx.data.levels.length, 5);
  assert('缺省难度', idx.data.difficulty, 'normal');
  idx.onPickLevel({ currentTarget: { dataset: { key: 'hard' } } });
  assert('可切换难度', idx.data.difficulty, 'hard');
})();

console.log('\n[2] 对局页初始化（人机）');
var aiPage = null;
(function () {
  var gameCfg = loadPage('pages/game/game.js', 'game');
  truthy('对局页配置加载', gameCfg);
  env.setCanvas(env.makeCanvas());

  aiPage = instantiate(gameCfg);
  aiPage.onLoad({ mode: 'ai', difficulty: 'beginner' });
  aiPage.onReady();

  truthy('Canvas 节点已挂载', aiPage.canvas);
  truthy('Layout 已创建', aiPage.layout);
  truthy('Controller 已创建', aiPage.controller);
  truthy('对局已创建', aiPage.game);
  assert('画布高度写入 data', aiPage.data.canvasHeight > 0, true);
  assert('模式标签', aiPage.data.modeLabel.indexOf('人机') === 0, true);
  assert('初始轮到红方（人手）', aiPage.game.pos.side, 0);

  pump(aiPage, 16);
  assert('首帧已绘制', aiPage.canvas.ctx.calls.clearRect > 0, true);
  // 过滤带空格的「楚河/汉界」标题，只统计棋子单字
  var pieceTexts = aiPage.canvas.ctx.calls.fillText.filter(function (t) { return t.indexOf(' ') < 0; });
  assert('首帧画出 32 枚棋子', pieceTexts.length, 32);
})();

console.log('\n[3] 人手走子后 AI 自动应招');
(function () {
  var from = aiPage.layout.pointOf(54);
  var to = aiPage.layout.pointOf(45);

  aiPage.onTouchStart(touch(aiPage, from));
  aiPage.onTouchEnd(touch(aiPage, from));
  assert('点选后已选中', aiPage.controller.selected, 54);

  aiPage.onTouchStart(touch(aiPage, to));
  assert('人手走子成功', aiPage.game.history.length >= 1, true);

  // setTimeout 被桩为同步，AI 应招应已发生
  assert('AI 已应招（共两手）', aiPage.game.history.length, 2);
  assert('应招后轮回到红方', aiPage.game.pos.side, 0);
  assert('状态栏已刷新', typeof aiPage.data.statusText === 'string' && aiPage.data.statusText.length > 0, true);

  pump(aiPage, 32);
  assert('走子后重绘', aiPage.canvas.ctx.calls.clearRect >= 2, true);
})();

console.log('\n[4] 工具栏：悔棋 / 提示 / 翻转 / 重开');
(function () {
  aiPage.onUndo(); // 人机模式回退两手
  assert('悔棋后回到空局', aiPage.game.history.length, 0);

  aiPage.onHint();
  truthy('提示已设置', aiPage.controller.hint);

  var before = aiPage.layout.flipped;
  aiPage.onFlip();
  assert('翻转视角生效', aiPage.layout.flipped, !before);
  aiPage.onFlip();

  // 走一手再重开（点选式需先抬手，符合单手势模型）
  var f = aiPage.layout.pointOf(54);
  var t = aiPage.layout.pointOf(45);
  aiPage.onTouchStart(touch(aiPage, f));
  aiPage.onTouchEnd(touch(aiPage, f));
  aiPage.onTouchStart(touch(aiPage, t));
  truthy('重开前有走子', aiPage.game.history.length > 0);
  aiPage.onRestart();
  assert('重开后为空局', aiPage.game.history.length, 0);
  assert('重开后选中清空', aiPage.controller.selected, -1);
})();

console.log('\n[5] 本地双人模式不触发 AI');
(function () {
  env.setCanvas(env.makeCanvas());
  var gameCfg = env.pages['game'];
  var local = instantiate(gameCfg);
  local.onLoad({ mode: 'local' });
  local.onReady();

  var f = local.layout.pointOf(54);
  var t = local.layout.pointOf(45);
  local.onTouchStart(touch(local, f));
  local.onTouchEnd(touch(local, f));
  local.onTouchStart(touch(local, t));

  assert('本地模式仅一手', local.game.history.length, 1);
  assert('本地模式轮到黑方', local.game.pos.side, 1);
  assert('本地模式标签', local.data.modeLabel, '本地双人');

  // 黑方接着走：黑卒 31 -> 40（同样先抬手）
  var bf = local.layout.pointOf(31);
  var bt = local.layout.pointOf(40);
  local.onTouchStart(touch(local, bf));
  local.onTouchEnd(touch(local, bf));
  local.onTouchStart(touch(local, bt));
  assert('黑方接续走子', local.game.history.length, 2);
  assert('又轮回红方', local.game.pos.side, 0);
})();

console.log('\n[6] 联机模式：页面与会话双向接线');
(function () {
  var pair = NT.createLoopbackPair();
  var host = new OnlineSession(pair[0], { clientId: 'host' });
  var guest = new OnlineSession(pair[1], { clientId: 'guest' });
  host.createRoom('PG01');
  guest.joinRoom('PG01');
  assert('回环下双方进入对局', host.state === 'playing' && guest.state === 'playing', true);

  // 把房主会话注入全局，模拟大厅页交接
  getApp().globalData.session = host;

  env.setCanvas(env.makeCanvas());
  var gameCfg = env.pages['game'];
  var pg = instantiate(gameCfg);
  pg.onLoad({ mode: 'online' });
  pg.onReady();

  assert('联机模式标签', pg.data.modeLabel.indexOf('联机') === 0, true);
  assert('页面使用会话的对局', pg.game === host.game, true);
  assert('房主执红', pg.humanSide, 0);
  assert('联机可以走子', pg.controller.canOperate(), true);

  // 人手（红）走 54->45，应广播到对手会话
  var f = pg.layout.pointOf(54);
  var t = pg.layout.pointOf(45);
  pg.onTouchStart(touch(pg, f));
  pg.onTouchEnd(touch(pg, f));
  pg.onTouchStart(touch(pg, t));
  assert('本局已走一手', pg.game.history.length, 1);
  assert('对手会话已同步', guest.game.history.length, 1);

  // 对手（黑）回 31->40，应回放到页面所绑定的对局
  guest.game.move(31, 40);
  guest.broadcastMove(31, 40);
  assert('页面已重放对手着', pg.game.history.length, 2);
  assert('联机轮到自己才可走', pg.controller.canOperate(), true);

  // 联机禁用悔棋/重开
  var plyBefore = pg.game.history.length;
  pg.onUndo();
  pg.onRestart();
  assert('联机悔棋/重开被拒', pg.game.history.length, plyBefore);

  // 退出：通知对手并清理全局会话
  pg.onBack();
  assert('对手收到离开通知', guest.opponentConnected, false);
  assert('全局会话已清理', getApp().globalData.session, null);
})();

console.log('\n----------------------------------------');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) {
  console.log('\x1b[31m页面接线测试未通过\x1b[0m\n');
  process.exit(1);
}
console.log('\x1b[32m页面接线全部测试通过\x1b[0m\n');
