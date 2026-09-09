/**
 * 联机对局会话（OnlineSession）
 *
 * 与传输通道解耦的房间状态机：建房 / 加入 / 座位分配 / 走法双向同步 /
 * 乱序与重复着法检测 / 断线重连全量重同步 / 终局广播 / 离开通知。
 *
 * 座位约定：建房者执红（先手），加入者执黑。
 * 同步约定：走法只传 (from, to, ply)，接收方在本地 Game 上校验并重放；
 *           一旦对不上（漏收/乱序）即发 stateReq 请求全量状态（起始 FEN + 着法序列），
 *           复用 core/game.js 已有的 toJSON / fromJSON 序列化格式。
 *
 * 纯 JavaScript，无 wx 依赖，可在 node 下用回环传输测试。
 */

var Game = require('../core/game.js');
var C = require('../core/constants.js');
var NT = require('./transport.js');

var STATE = {
  IDLE: 'idle',
  WAITING: 'waiting',   // 已建房，等待对手
  JOINING: 'joining',   // 已发加入请求，等待欢迎
  PLAYING: 'playing',
  ENDED: 'ended'
};

/**
 * @constructor
 * @param {object} transport 见 transport.js 的接口约定
 * @param {object} [options] {
 *   clientId: string,
 *   onStateChange: function(state),
 *   onSeatAssigned: function(side),
 *   onRemoteMove: function(result),     对手着法已在本地重放成功
 *   onResync: function(game),           全量重同步后，页面需重新绑定 controller
 *   onResult: function(result),
 *   onOpponentLeft: function(),
 *   onOpponentJoined: function()
 * }
 */
function OnlineSession(transport, options) {
  this.transport = transport;
  this.options = options || {};
  this.clientId = this.options.clientId || NT.randomClientId();

  this.room = null;
  this.state = STATE.IDLE;
  this.mySide = -1;
  this.game = null;
  this.opponentId = null;
  this.opponentConnected = false;
  this._resultSent = false;

  var self = this;
  transport.onMessage(function (msg) { self._handle(msg); });
  transport.onStatus(function (status) {
    if (status === 'close' && self.state === STATE.PLAYING) {
      self.opponentConnected = false;
      self._emit('onOpponentLeft');
    }
  });
}

OnlineSession.STATE = STATE;

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/** 建房：自己执红，等待对手加入 */
OnlineSession.prototype.createRoom = function (code) {
  this.room = code || NT.randomRoomCode();
  this.mySide = C.RED;
  this.game = new Game();
  this.opponentConnected = false;
  this._resultSent = false;
  this._setState(STATE.WAITING);
  this._emit('onSeatAssigned', this.mySide);
  return this.room;
};

/** 加入房间：发送 join，等待 welcome 分配座位与局面 */
OnlineSession.prototype.joinRoom = function (code) {
  this.room = code;
  this.mySide = -1;
  this.game = null;
  this._setState(STATE.JOINING);
  this._send({ type: 'join' });
  return this.room;
};

/** 主动离开：通知对手并关闭传输（无论是否终局都应通知） */
OnlineSession.prototype.leave = function () {
  if (this.room && this.opponentId) {
    this._send({ type: 'bye' });
  }
  this.state = STATE.IDLE;
  this.opponentConnected = false;
  if (this.transport.close) this.transport.close();
};

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 是否轮到自己走子（不含对手在线判断） */
OnlineSession.prototype.isMyTurn = function () {
  return this.state === STATE.PLAYING && !!this.game &&
    !this.game.result && this.game.pos.side === this.mySide;
};

/** 对局是否可进行（轮到自己且对手在线） */
OnlineSession.prototype.canPlay = function () {
  return this.isMyTurn() && this.opponentConnected;
};

// ---------------------------------------------------------------------------
// 对外动作
// ---------------------------------------------------------------------------

/**
 * 广播自己刚走完的一步（页面在 controller 落子后调用）
 * 若本步直接终局，顺带广播终局
 */
OnlineSession.prototype.broadcastMove = function (from, to) {
  if (!this.game) return false;
  this._send({ type: 'move', seat: this.mySide, from: from, to: to, ply: this.game.plyCount() });
  if (this.game.result) this.broadcastResult(this.game.result);
  return true;
};

/** 广播终局结果 */
OnlineSession.prototype.broadcastResult = function (result) {
  if (!result || this._resultSent) return false;
  this._resultSent = true;
  this._send({ type: 'result', winner: result.winner, reason: result.reason });
  this._setState(STATE.ENDED);
  return true;
};

/** 请求对手发送全量状态 */
OnlineSession.prototype.requestState = function () {
  this._send({ type: 'stateReq' });
};

/** 发送全量状态（起始 FEN + 着法序列 + 终局） */
OnlineSession.prototype.sendState = function () {
  if (!this.game) return false;
  var data = this.game.toJSON();
  this._send({
    type: 'state',
    fen: data.fen,
    moves: data.moves,
    result: data.result || null
  });
  return true;
};

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------

OnlineSession.prototype._handle = function (msg) {
  if (!msg || msg.clientId === this.clientId) return; // 广播总线会回传自己的消息
  if (msg.room && this.room && msg.room !== this.room) return;

  switch (msg.type) {
    case 'join': this._onJoin(msg); break;
    case 'welcome': this._onWelcome(msg); break;
    case 'move': this._onMove(msg); break;
    case 'stateReq': this.sendState(); break;
    case 'state': this._onState(msg); break;
    case 'result': this._onResult(msg); break;
    case 'bye': this._onBye(); break;
    default: break;
  }
};

/** 房主收到加入请求：分配黑方并回欢迎（附带当前局面，兼容重连） */
OnlineSession.prototype._onJoin = function (msg) {
  if (this.mySide !== C.RED || !this.game) return;
  var isFirst = !this.opponentId;
  var isSame = this.opponentId === msg.clientId;
  if (!isFirst && !isSame) return; // 房间已满且不是重连

  this.opponentId = msg.clientId;
  this.opponentConnected = true;
  if (this.state === STATE.WAITING) this._setState(STATE.PLAYING);

  var data = this.game.toJSON();
  this._send({
    type: 'welcome',
    to: msg.clientId,
    seat: C.BLACK,
    fen: data.fen,
    moves: data.moves,
    result: data.result || null
  });
  if (isFirst) this._emit('onOpponentJoined');
};

/** 加入者收到欢迎：确定座位并重建局面（welcome 为定向消息，他人收到需忽略） */
OnlineSession.prototype._onWelcome = function (msg) {
  if (msg.to && msg.to !== this.clientId) return;
  this.mySide = msg.seat;
  this.opponentId = msg.clientId;
  this.opponentConnected = true;
  this._rebuild(msg.fen, msg.moves, msg.result);
  this._emit('onSeatAssigned', this.mySide);
};

/** 收到对手着法：本地校验并重放 */
OnlineSession.prototype._onMove = function (msg) {
  if (this.state !== STATE.PLAYING || !this.game) return;
  var expected = 1 - this.mySide;
  if (msg.seat !== expected) return;

  var myPly = this.game.plyCount();
  if (this.game.pos.side !== expected) {
    // 本地轮次对不上：要么是重复着法（已应用过），要么漏收了之前的着法
    if (typeof msg.ply === 'number' && msg.ply <= myPly) return; // 重复，忽略
    this.requestState();
    return;
  }

  var res = this.game.move(msg.from, msg.to);
  if (!res.ok) {
    this.requestState();
    return;
  }
  if (this.game.result) {
    this._setState(STATE.ENDED);
    this._emit('onResult', this.game.result);
  }
  this._emit('onRemoteMove', res);
};

/** 收到全量状态：重建对局 */
OnlineSession.prototype._onState = function (msg) {
  if (!this.game && this.state === STATE.JOINING) return; // 还没拿到座位，等 welcome
  this._rebuild(msg.fen, msg.moves, msg.result);
  this._emit('onResync', this.game);
};

OnlineSession.prototype._onResult = function (msg) {
  if (!this.game || this.game.result) return;
  this.game.finish(msg.winner, msg.reason || '对局结束');
  this._setState(STATE.ENDED);
  this._emit('onResult', this.game.result);
};

OnlineSession.prototype._onBye = function () {
  this.opponentConnected = false;
  this._emit('onOpponentLeft');
};

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

OnlineSession.prototype._rebuild = function (fen, moves, result) {
  this.game = Game.fromJSON({ fen: fen, moves: moves, result: result || null });
  this._resultSent = !!result;
  this._setState(result ? STATE.ENDED : STATE.PLAYING);
};

OnlineSession.prototype._setState = function (s) {
  if (this.state === s) return;
  this.state = s;
  this._emit('onStateChange', s);
};

OnlineSession.prototype._emit = function (name, arg) {
  var fn = this.options[name];
  if (typeof fn === 'function') fn(arg);
};

OnlineSession.prototype._send = function (msg) {
  msg.clientId = this.clientId;
  msg.room = this.room;
  return this.transport.send(msg);
};

module.exports = OnlineSession;
module.exports.STATE = STATE;
