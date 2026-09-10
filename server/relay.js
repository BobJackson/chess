/**
 * 房间中继（纯逻辑，无 IO 依赖，可单测）
 *
 * 维护 room -> sockets 映射；broadcast 把消息对象投递给房间内所有连接。
 * 会话层（net/session.js）会按 clientId 过滤自身消息，因此这里回声给发送者也没关系。
 */
function Relay() {
  this.rooms = {};
}

/** 把连接加入房间（一个连接只属于一个房间） */
Relay.prototype.add = function (room, sock) {
  if (!room || !sock) return;
  if (sock.__room && sock.__room !== room) this.remove(sock);
  var list = this.rooms[room] || (this.rooms[room] = []);
  if (list.indexOf(sock) < 0) list.push(sock);
  sock.__room = room;
};

/** 连接断开时移出房间；空房间回收 */
Relay.prototype.remove = function (sock) {
  var room = sock && sock.__room;
  if (!room) return;
  var list = this.rooms[room];
  if (!list) return;
  var i = list.indexOf(sock);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) delete this.rooms[room];
  sock.__room = null;
};

/** 广播消息对象到房间；except 可排除某个连接 */
Relay.prototype.broadcast = function (room, msg, except) {
  var list = this.rooms[room];
  if (!list) return 0;
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    if (list[i] === except) continue;
    if (list[i].send) { list[i].send(msg); n++; }
  }
  return n;
};

Relay.prototype.count = function (room) {
  return (this.rooms[room] || []).length;
};

module.exports = Relay;
