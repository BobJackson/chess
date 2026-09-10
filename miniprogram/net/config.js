/**
 * 联机通道配置
 *
 * kind = 'ws'    自建 WebSocket 服务器（免费，需备案域名 + wss 证书 + mp 控制台 socket 合法域名）
 * kind = 'cloud' 微信云开发（需开通云开发并创建 chess_rooms / chess_msgs 集合）
 *
 * 使用自建服务器时：
 *   1. 服务器运行 node server/room-server.js 8787
 *   2. nginx 反代 wss://你的域名/ws -> http://127.0.0.1:8787/ws
 *   3. mp 控制台「开发设置 → 服务器域名」socket 合法域名填 wss://你的域名
 *   4. 把下面 wsUrl 换成你的地址
 */
module.exports = {
  kind: 'ws',
  wsUrl: 'wss://chess.wangyousong.com/ws'
};
