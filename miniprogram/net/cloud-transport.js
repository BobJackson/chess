/**
 * 微信云开发传输适配器
 *
 * 用云开发数据库充当「广播消息总线」，实现 transport.js 的接口约定：
 *   - 集合 chess_rooms：房间登记，_id 为房间号，{ creator, createdAt }，用于座位分配与存在性校验
 *   - 集合 chess_msgs ：消息流，{ room, clientId, type, ... }，用 db.watch 实时推送
 *
 * 座位由房间登记决定：creator 执红，加入者执黑（见 session.js）。
 * watch 的 init 快照只标记不回放（历史消息靠 welcome/state 全量同步），
 * 之后仅消费增量，从而避免重连时重复执行旧着法。
 *
 * 依赖 wx.cloud 已在 app.js 初始化。本文件只在真机/开发者工具有效，node 下不可用。
 */

var ROOMS = 'chess_rooms';
var MSGS = 'chess_msgs';

/**
 * @constructor
 * @param {object} [options] { clientId }
 */
function CloudTransport(options) {
  options = options || {};
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.database) {
    throw new Error('CloudTransport 需要微信云开发环境（wx.cloud）');
  }
  this.clientId = options.clientId;
  this.db = wx.cloud.database();
  this.room = null;
  this.watcher = null;
  this.seen = {};
  this.closed = false;
  this._msg = null;
  this._status = null;
}

CloudTransport.prototype.onMessage = function (cb) { this._msg = cb; return this; };
CloudTransport.prototype.onStatus = function (cb) { this._status = cb; return this; };

/** 登记房间（建房者调用）；房间号已存在时 reject */
CloudTransport.prototype.createRoomDoc = function (code) {
  return this.db.collection(ROOMS).add({
    data: { _id: code, creator: this.clientId, createdAt: Date.now() }
  });
};

/** 校验房间是否存在（加入者调用），resolve(true/false) */
CloudTransport.prototype.roomExists = function (code) {
  return this.db.collection(ROOMS).doc(code).get()
    .then(function (res) { return !!(res && res.data); })
    .catch(function () { return false; });
};

/** 开始监听房间消息流 */
CloudTransport.prototype.attach = function (room) {
  var self = this;
  this.room = room;
  this.closed = false;

  var query = this.db.collection(MSGS).where({ room: room });
  this.watcher = query.watch({
    onChange: function (snapshot) {
      if (self.closed) return;
      var docs = (snapshot && snapshot.docs) || [];
      for (var i = 0; i < docs.length; i++) {
        var doc = docs[i];
        if (!doc || !doc._id || self.seen[doc._id]) continue;
        self.seen[doc._id] = true;
        // init 快照为历史消息，只标记不回放；增量才投递
        if (snapshot.type === 'init') continue;
        if (doc.clientId === self.clientId) continue; // 过滤自身回传
        if (self._msg) self._msg(doc);
      }
    },
    onError: function (err) {
      if (self._status) self._status('error', err);
    }
  });

  if (this._status) this._status('open');
  return this;
};

/** 发送一条消息（写入消息流；异步落库，乐观返回 true） */
CloudTransport.prototype.send = function (msg) {
  if (this.closed || !this.room) return false;
  var data = {};
  for (var k in msg) {
    if (Object.prototype.hasOwnProperty.call(msg, k)) data[k] = msg[k];
  }
  data.room = this.room;
  data.ts = Date.now();
  this.db.collection(MSGS).add({ data: data });
  return true;
};

/** 关闭监听（不删除云端数据，重连可复用） */
CloudTransport.prototype.close = function () {
  if (this.closed) return;
  this.closed = true;
  if (this.watcher && this.watcher.close) this.watcher.close();
  this.watcher = null;
  if (this._status) this._status('close');
};

module.exports = CloudTransport;
module.exports.COLLECTION_ROOMS = ROOMS;
module.exports.COLLECTION_MSGS = MSGS;
