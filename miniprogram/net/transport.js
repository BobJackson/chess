/**
 * 联机传输层
 *
 * 只定义「消息总线」的最小约定，具体通道（云开发 / WebSocket / 回环）各自实现：
 *   send(msg)            发送一条消息（对象，可 JSON 化）
 *   onMessage(cb)        注册接收回调 cb(msg)
 *   onStatus(cb)         注册状态回调 cb(status, detail)，status: 'open' | 'close' | 'error'
 *   close()              关闭连接
 *
 * 通道可以是「点对点」（对方才收到）或「广播总线」（自己也收到自己的消息），
 * OnlineSession 会按 clientId 过滤自身消息，两种都兼容。
 *
 * 本文件提供 createLoopbackPair()：一对互相直连的内存传输，
 * 用于单元测试与单机演示，不依赖任何微信 API。
 */

/**
 * 创建一对回环传输 [a, b]：a.send 投递给 b，b.send 投递给 a。
 * @param {object} [options] { async: boolean } async 为 true 时用微任务投递（更接近真实网络）
 * @returns {Array<object>}
 */
function createLoopbackPair(options) {
  options = options || {};
  var useAsync = !!options.async;

  function make(name) {
    return {
      name: name,
      peer: null,
      closed: false,
      _msg: null,
      _status: null,
      onMessage: function (cb) { this._msg = cb; return this; },
      onStatus: function (cb) { this._status = cb; return this; },
      send: function (msg) {
        if (this.closed) return false;
        var peer = this.peer;
        if (!peer || peer.closed || !peer._msg) return false;
        // 复制一份，避免两端共享同一对象引用造成假同步
        var copy = JSON.parse(JSON.stringify(msg));
        if (useAsync) {
          setTimeout(function () { if (!peer.closed && peer._msg) peer._msg(copy); }, 0);
        } else {
          peer._msg(copy);
        }
        return true;
      },
      close: function () {
        if (this.closed) return;
        this.closed = true;
        if (this._status) this._status('close');
        var peer = this.peer;
        if (peer && !peer.closed && peer._status) peer._status('close');
      }
    };
  }

  var a = make('a');
  var b = make('b');
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** 生成一个短随机客户端 id（不依赖微信 API，node 下也可用） */
function randomClientId() {
  var s = '';
  for (var i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 36).toString(36);
  }
  return 'c' + s + Date.now().toString(36).slice(-4);
}

/** 生成房间号：4 位大写字母数字，去掉易混字符 */
function randomRoomCode() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 4; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

module.exports = {
  createLoopbackPair: createLoopbackPair,
  randomClientId: randomClientId,
  randomRoomCode: randomRoomCode
};
