/**
 * 联机大厅场景：创建房间 / 输入房间号加入
 *
 * 小游戏没有 input 组件，房间号通过 wx.showKeyboard 软键盘录入。
 * 会话与传输创建后挂在 app 上，交由对局场景消费。
 */
var OnlineSession = require('../net/session.js');
var NT = require('../net/transport.js');
var CloudTransport = require('../net/cloud-transport.js');
var WsTransport = require('../net/ws-transport.js');
var NET_CONFIG = require('../net/config.js');
var W = require('../ui/widgets.js');

function createLobbyScene(app) {
  var scene = {
    name: 'lobby',
    app: app,
    code: '',
    myCode: '',
    statusText: '',
    busy: false,
    navigated: false,
    session: null,
    buttons: [],
    inputBox: null
  };

  scene.onEnter = function (params) {
    var w = app.w, h = app.h;
    var pad = 28, bw = w - pad * 2;
    scene.inputBox = { x: pad, y: h * 0.30, w: bw, h: 52 };
    scene.buildButtons('idle');
    scene.code = '';
    scene.myCode = '';
    scene.statusText = '';
    scene.navigated = false;
    scene.isCreator = false;
    scene.createdCode = null;

    // 分享卡片回流 / 上次未消费的房间号：自动填入并加入
    var auto = (params && params.room) || app.pendingRoom;
    if (auto) {
      app.pendingRoom = null;
      scene.code = String(auto).toUpperCase();
      scene.onJoin();
    }
  };

  /** idle：创建/加入/返回；waiting：邀请/取消/返回 */
  scene.buildButtons = function (mode) {
    var w = app.w, h = app.h;
    var pad = 28, bw = w - pad * 2;
    var y0 = h * 0.30 + 76;
    if (mode === 'waiting') {
      scene.buttons = [
        W.makeButton('invite', pad, y0, bw, 46, '邀请好友'),
        W.makeButton('cancel', pad, y0 + 60, bw, 46, '取消房间', 'ghost'),
        W.makeButton('back', pad, y0 + 120, bw, 46, '返回', 'ghost')
      ];
    } else {
      scene.buttons = [
        W.makeButton('create', pad, y0, bw, 46, '创建房间'),
        W.makeButton('join', pad, y0 + 60, bw, 46, '加入房间'),
        W.makeButton('back', pad, y0 + 120, bw, 46, '返回', 'ghost')
      ];
    }
  };

  scene.onExit = function () {
    if (!scene.navigated) scene.teardown();
  };

  scene.teardown = function () {
    if (scene.session) scene.session.leave();
    // 房主退出时删除房间登记，避免垃圾房间堆积
    if (scene.isCreator && scene.createdCode && app.transport && app.transport.removeRoom) {
      app.transport.removeRoom(scene.createdCode);
    }
    app.session = null;
    app.transport = null;
    scene.session = null;
    scene.isCreator = false;
    scene.createdCode = null;
  };

  // -------------------------------------------------------------------------

  scene.makeSession = function (transport) {
    var session = new OnlineSession(transport, {
      onStateChange: function (st) {
        scene.refresh();
        if (st === 'playing') scene.goGame();
      },
      onOpponentJoined: function () { scene.refresh(); scene.goGame(); },
      onSeatAssigned: function () { scene.refresh(); }
    });
    scene.session = session;
    app.session = session;
    app.transport = transport;
    return session;
  };

  scene.goGame = function () {
    if (scene.navigated) return;
    scene.navigated = true;
    app.go('board', { mode: 'online' });
  };

  scene.refresh = function () {
    var s = scene.session;
    if (!s) return;
    if (s.state === 'waiting') { scene.statusText = '房间号 ' + s.room + '，等待好友加入…'; scene.buildButtons('waiting'); }
    else if (s.state === 'joining') { scene.statusText = '正在加入房间…'; }
    else if (s.state === 'playing') { scene.statusText = '对手已就位，进入对局'; }
    scene.myCode = s.room || '';
  };

  /** 按 net/config.js 的 kind 创建传输（ws 自建服务器 / cloud 云开发） */
  scene.makeTransport = function () {
    var clientId = NT.randomClientId();
    if (NET_CONFIG.kind === 'ws') {
      return new WsTransport({ clientId: clientId, url: NET_CONFIG.wsUrl });
    }
    return new CloudTransport({ clientId: clientId });
  };

  /** 建房：ws 通道无需登记文档；cloud 通道登记并冲突换号重试（最多 3 次） */
  scene.onCreate = function () {
    if (!app.netReady) { app.toast('联机通道未配置'); return; }
    if (scene.busy) return;
    scene.busy = true;
    var transport = scene.makeTransport();
    var code = NT.randomRoomCode();

    if (NET_CONFIG.kind === 'ws') {
      transport.attach(code);
      var s = scene.makeSession(transport);
      scene.isCreator = true;
      scene.createdCode = code;
      s.createRoom(code);
      scene.refresh();
      scene.busy = false;
      return;
    }

    var attempt = 0;
    function tryCreate() {
      var c = NT.randomRoomCode();
      transport.createRoomDoc(c).then(function () {
        transport.attach(c);
        var session = scene.makeSession(transport);
        scene.isCreator = true;
        scene.createdCode = c;
        session.createRoom(c);
        scene.refresh();
        scene.busy = false;
      }).catch(function () {
        attempt++;
        if (attempt < 3) tryCreate();
        else {
          scene.busy = false;
          app.toast('建房失败，请重试');
        }
      });
    }
    tryCreate();
  };

  scene.onJoin = function () {
    if (!app.netReady) { app.toast('联机通道未配置'); return; }
    if (!scene.code) { app.toast('请输入房间号'); return; }
    if (scene.busy) return;
    scene.busy = true;
    var transport = scene.makeTransport();
    var code = scene.code;

    if (NET_CONFIG.kind === 'ws') {
      transport.attach(code);
      var s = scene.makeSession(transport);
      s.joinRoom(code);
      scene.refresh();
      scene.busy = false;
      return;
    }

    transport.roomExists(code).then(function (ok) {
      if (!ok) { scene.busy = false; app.toast('房间不存在'); return; }
      transport.attach(code);
      var session = scene.makeSession(transport);
      session.joinRoom(code);
      scene.refresh();
      scene.busy = false;
    }).catch(function () {
      scene.busy = false;
      app.toast('加入失败，请重试');
    });
  };

  scene.openKeyboard = function () {
    app.openKeyboard({
      maxLength: 4,
      onInput: function (text) { scene.code = (text || '').toUpperCase().slice(0, 4); },
      onComplete: function (text) { scene.code = (text || '').toUpperCase().slice(0, 4); }
    });
  };

  // -------------------------------------------------------------------------

  scene.onTouch = function (type, x, y) {
    if (type !== 'start' && type !== 'end') return;
    if (type === 'start') {
      var b = scene.inputBox;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { scene.openKeyboard(); return; }
      scene.pressed = null;
      for (var i = 0; i < scene.buttons.length; i++) {
        if (W.hitButton(scene.buttons[i], x, y)) { scene.pressed = scene.buttons[i].id; return; }
      }
      return;
    }
    var id = scene.pressed;
    scene.pressed = null;
    if (!id) return;
    for (var k = 0; k < scene.buttons.length; k++) {
      var btn = scene.buttons[k];
      if (btn.id === id && W.hitButton(btn, x, y)) {
        app.audio.play('tap');
        if (id === 'create') scene.onCreate();
        else if (id === 'join') scene.onJoin();
        else if (id === 'invite') {
          if (scene.session) app.shareRoom(scene.session.room);
        }
        else if (id === 'cancel') {
          scene.teardown();
          scene.buildButtons('idle');
          scene.statusText = '';
          scene.myCode = '';
        }
        else if (id === 'back') app.go('menu');
        return;
      }
    }
  };

  scene.render = function (ctx, w, h) {
    W.fillBackground(ctx, w, h);
    W.drawText(ctx, '好友联机', w / 2, h * 0.14, 26, W.THEME.title, 'center', true);
    W.drawText(ctx, '创建房间或输入房间号与好友对弈', w / 2, h * 0.14 + 26, 13, W.THEME.subtitle, 'center');

    // 输入框
    var b = scene.inputBox;
    ctx.save();
    ctx.fillStyle = W.THEME.inputFill;
    W.roundRectPath(ctx, b.x, b.y, b.w, b.h, 10);
    ctx.fill();
    ctx.strokeStyle = W.THEME.inputEdge;
    ctx.lineWidth = 1.5;
    W.roundRectPath(ctx, b.x, b.y, b.w, b.h, 10);
    ctx.stroke();
    ctx.restore();
    if (scene.code) {
      W.drawText(ctx, scene.code, b.x + b.w / 2, b.y + b.h / 2, 22, W.THEME.title, 'center', true);
    } else {
      W.drawText(ctx, '点此输入 4 位房间号', b.x + b.w / 2, b.y + b.h / 2, 14, W.THEME.inputHint, 'center');
    }

    for (var i = 0; i < scene.buttons.length; i++) {
      W.drawButton(ctx, scene.buttons[i], scene.pressed === scene.buttons[i].id);
    }

    if (scene.myCode && scene.session && scene.session.state === 'waiting') {
      W.drawText(ctx, '房间号 ' + scene.myCode, w / 2, h * 0.30 - 26, 20, W.THEME.danger, 'center', true);
    }
    if (scene.statusText) {
      W.drawText(ctx, scene.statusText, w / 2, h - 40, 13, W.THEME.body, 'center');
    }
  };

  return scene;
}

module.exports = createLobbyScene;
