/**
 * 联机大厅：创建房间 / 输入房间号加入
 *
 * 会话与传输创建后放入 globalData，交由对局页消费；
 * 一旦进入 playing 状态即跳转对局页。
 */
var OnlineSession = require('../../net/session.js');
var NT = require('../../net/transport.js');
var CloudTransport = require('../../net/cloud-transport.js');

Page({
  data: {
    inputCode: '',
    myCode: '',
    statusText: '',
    busy: false
  },

  onLoad: function () {
    this.navigated = false;
  },

  onUnload: function () {
    // 未进入对局就退出大厅：清理会话，避免残留房间
    if (!this.navigated) this._teardown();
  },

  onInputCode: function (e) {
    this.setData({ inputCode: (e.detail.value || '').toUpperCase() });
  },

  // -------------------------------------------------------------------------

  _makeTransport: function () {
    var app = getApp();
    var clientId = NT.randomClientId();
    var transport = new CloudTransport({ clientId: clientId });
    app.globalData.transport = transport;
    return transport;
  },

  _makeSession: function (transport) {
    var self = this;
    var session = new OnlineSession(transport, {
      onStateChange: function (st) {
        self._refreshStatus(session);
        if (st === 'playing') self._goGame();
      },
      onOpponentJoined: function () {
        self._refreshStatus(session);
        self._goGame();
      },
      onSeatAssigned: function () { self._refreshStatus(session); }
    });
    getApp().globalData.session = session;
    return session;
  },

  _refreshStatus: function (session) {
    var text;
    switch (session.state) {
      case 'waiting': text = '房间号 ' + session.room + '，等待好友加入…'; break;
      case 'joining': text = '正在加入房间…'; break;
      case 'playing': text = '对手已就位，进入对局'; break;
      default: text = '';
    }
    this.setData({ statusText: text, myCode: session.room || '' });
  },

  _goGame: function () {
    if (this.navigated) return;
    this.navigated = true;
    wx.navigateTo({ url: '../game/game?mode=online' });
  },

  _teardown: function () {
    var app = getApp();
    if (app.globalData.session) app.globalData.session.leave();
    app.globalData.session = null;
    app.globalData.transport = null;
  },

  // -------------------------------------------------------------------------

  onCreate: function () {
    var self = this;
    var app = getApp();
    if (!app.globalData.cloudReady) {
      wx.showToast({ title: '云开发未就绪', icon: 'none' });
      return;
    }
    this.setData({ busy: true });

    var transport = this._makeTransport();
    var code = NT.randomRoomCode();

    transport.createRoomDoc(code).then(function () {
      transport.attach(code);
      var session = self._makeSession(transport);
      session.createRoom(code);
      self._refreshStatus(session);
      self.setData({ busy: false });
    }).catch(function (err) {
      self.setData({ busy: false });
      wx.showToast({ title: '建房失败，请重试', icon: 'none' });
    });
  },

  onJoin: function () {
    var self = this;
    var app = getApp();
    var code = this.data.inputCode;
    if (!code) {
      wx.showToast({ title: '请输入房间号', icon: 'none' });
      return;
    }
    if (!app.globalData.cloudReady) {
      wx.showToast({ title: '云开发未就绪', icon: 'none' });
      return;
    }
    this.setData({ busy: true });

    var transport = this._makeTransport();
    transport.roomExists(code).then(function (ok) {
      if (!ok) {
        self.setData({ busy: false });
        wx.showToast({ title: '房间不存在', icon: 'none' });
        return;
      }
      transport.attach(code);
      var session = self._makeSession(transport);
      session.joinRoom(code);
      self._refreshStatus(session);
      self.setData({ busy: false });
    }).catch(function () {
      self.setData({ busy: false });
      wx.showToast({ title: '加入失败，请重试', icon: 'none' });
    });
  }
});
