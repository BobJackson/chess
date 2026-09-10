/**
 * WebSocket 传输适配器（自建服务器通道）
 *
 * 实现 transport.js 的接口约定：send / onMessage / onStatus / close。
 * 服务端（server/room-server.js）按每条消息的 msg.room 路由广播，
 * 因此本适配器无需"订阅房间"，attach 仅记录房间并确保连接建立。
 * 连接建立前的 send 会入队，open 后自动flush。
 *
 * 小游戏要求 wss:// 且域名在 mp 控制台配置为 socket 合法域名。
 */
function WsTransport(options) {
  options = options || {};
  this.clientId = options.clientId;
  this.url = options.url;
  this.room = null;
  this.sock = null;
  this.open = false;
  this.closed = false;
  this.queue = [];
  this._msg = null;
  this._status = null;
}

WsTransport.prototype.onMessage = function (cb) { this._msg = cb; return this; };
WsTransport.prototype.onStatus = function (cb) { this._status = cb; return this; };

WsTransport.prototype.connect = function () {
  if (this.sock || !this.url) return this;
  var self = this;
  // 房间随连接声明：服务端握手时即把本连接登记进房间，
  // 从而像云开发 watch 一样"订阅即收"，无需先发消息
  var sep = this.url.indexOf('?') < 0 ? '?' : '&';
  var url = this.url + sep + 'room=' + encodeURIComponent(this.room || '');
  var s = wx.connectSocket({ url: url });
  this.sock = s;

  s.onOpen(function () {
    if (self.closed) return;
    self.open = true;
    if (self._status) self._status('open');
    // flush 排队消息
    while (self.queue.length && self.open && !self.closed) {
      var data = self.queue.shift();
      try { s.send({ data: data }); } catch (e) { break; }
    }
  });
  s.onMessage(function (res) {
    if (self.closed) return;
    var m = null;
    try { m = JSON.parse(res.data); } catch (e) { return; }
    if (!m || m.clientId === self.clientId) return; // 过滤自身回传
    if (self._msg) self._msg(m);
  });
  s.onClose(function () {
    if (self.closed) return;
    self.closed = true;
    self.open = false;
    if (self._status) self._status('close');
  });
  s.onError(function () {
    if (self._status) self._status('error');
  });
  return this;
};

/** 记录房间并确保连接（连接建立前的消息会排队） */
WsTransport.prototype.attach = function (room) {
  this.room = room;
  this.closed = false;
  this.connect();
  if (this._status && this.open) this._status('open');
  return this;
};

WsTransport.prototype.send = function (msg) {
  if (this.closed) return false;
  msg.clientId = this.clientId;
  var data = JSON.stringify(msg);
  if (this.open && this.sock) {
    try { this.sock.send({ data: data }); } catch (e) { this.queue.push(data); }
  } else {
    this.queue.push(data);
    this.connect();
  }
  return true;
};

WsTransport.prototype.close = function () {
  if (this.closed) return;
  this.closed = true;
  this.open = false;
  if (this.sock && this.sock.close) {
    try { this.sock.close({}); } catch (e) {}
  }
  if (this._status) this._status('close');
};

module.exports = WsTransport;
