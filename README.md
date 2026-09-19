# 松风桂月（微信象棋小游戏）

> 松风起，桂子落，来一盘。—— 松树与桂花的象棋。

一个运行在**微信小游戏**上的中国象棋：人机对战（五档难度）、本地双人、好友联机（云开发 / 自建 WebSocket 中继）。

核心设计原则：**对局逻辑、棋盘渲染、触摸状态机、联机会话全部是纯 JavaScript**，不依赖小游戏/小程序的页面 API，因此都能在 node 下直接单元测试；只有最外层的"场景外壳"（自绘 UI + 全局触摸 + 主循环）与小游戏环境耦合。

> 历史版本：本项目曾以**小程序**（pages + WXML）形态实现，完整保留在 git 分支 `miniprogram-version`。因发布账号为小游戏类型，主干已改造为小游戏形态。

## 小游戏与小程序的差异（本项目的应对）

| 小程序有、小游戏没有 | 本项目的替代方案 |
|---|---|
| `app.json` + `pages/` 路由 | `game.json` + `scenes/` 场景状态机（`scenes/manager.js`） |
| WXML/WXSS 组件（button/input…） | Canvas 自绘组件（`ui/widgets.js`）+ 命中测试 |
| `Page()` 生命周期 | 场景协议 `onEnter/onExit/onTouch/render/shouldRender` |
| `input` 输入框 | `wx.showKeyboard` 软键盘（大厅录入房间号） |
| 组件级 `bindtouchstart` | 全局 `wx.onTouchStart/Move/End/Cancel` 分发到当前场景 |

## 目录结构

```
project.config.json          compileType = "game"
package.json                 测试脚本入口（npm test）
scripts/                     node 测试（每层一个 test-*.js）+ 音效合成 gen-sfx.js
server/                      自建联机中继（零依赖 Node WebSocket）
  relay.js                   房间中继纯逻辑（可单测）
  room-server.js             WS 服务端：握手 ?room= 登记 + 按房间广播
miniprogram/
  game.js                    入口：Canvas/dpr、全局触摸、rAF 主循环、云初始化、场景调度
  game.json                  小游戏配置（竖屏等）
  core/                      对局核心（纯 JS）：constants/position/movegen/evaluate/ai/book/game/notation
  ui/
    layout.js                棋盘索引 <-> 像素换算、翻转、触摸命中
    renderer.js              棋盘分层绘制（仅依赖 Canvas 2D）
    controller.js            触摸状态机：点选+拖拽、canMove 门控、renderState
    widgets.js               小游戏自绘 UI：按钮/分段/文本换行/命中测试
    audio.js                 音频管理器：BGM loop + SFX 池 + 开关持久化
  audio/
    bgm.mp3                  中国风 BGM（64s 循环段，56kbps 单声道）
    *.wav                    合成音效：落子/吃子/将军/胜/负/按钮/悔棋
  net/
    transport.js             传输接口约定 + 回环传输对（测试用）
    session.js               OnlineSession 房间状态机（与通道解耦）
    cloud-transport.js       云开发 database watch 适配器
    ws-transport.js          自建 WebSocket 适配器（wx.connectSocket）
    config.js                通道开关：kind 'ws'（免费自建）/ 'cloud'（云开发）
  scenes/
    manager.js               场景状态机（替代路由）
    menu.js                  主菜单：难度分段 + 三模式入口
    board.js                 对局：状态栏+棋盘+工具栏，ai/local/online 三模式
    lobby.js                 联机大厅：建房/加入 + 软键盘房间号
    rules.js                 规则：可滚动文本
```

## 快速开始

1. 用微信开发者工具导入本目录（`project.config.json` 所在处），`compileType` 已为 `game`。
2. `project.config.json` 的 `appid` 需为**小游戏类型**账号（本项目即因账号为小游戏而采用此形态）。
3. 人机 / 本地双人：直接编译即可玩，无需后端。
4. 好友联机：见下「云开发配置」。

## 云开发配置（好友联机）

1. 开通云开发（小游戏同样支持 `wx.cloud`）。
2. 创建集合 `chess_rooms`（`_id` 为房间号，`{creator,createdAt}`）与 `chess_msgs`（`{room,clientId,type,...}`），权限「所有用户可读写」。
3. 多环境时在 `game.js` 的 `wx.cloud.init({ env:'环境ID' })` 指定。
4. 一方「创建房间」得 4 位房间号 → 另一方输入加入 → 建房者执红。
5. **邀请好友**：等待态点「邀请好友」生成微信分享卡片（`query=room=房间号`）；好友点卡片启动时 `onShow` 捕获房间号，自动进大厅加入并直接进入对局，无需手输。
6. 房主「取消房间」或退出时会删除房间登记（`removeRoom`），避免垃圾房间堆积；建房遇房号冲突自动换号重试（最多 3 次）。

联机协议见 `net/session.js`：`join/welcome/move/stateReq/state/result/bye`；走法只传 `(from,to,ply)` 本地校验重放，乱序自动全量重同步，同 `clientId` 重加入即断线重连。

## 自建服务器联机（免云开发费用）

有备案域名与服务器时，可改用自建 WebSocket 中继，**零云开发费用**：

1. **部署中继**：把 `server/` 目录上传服务器，`node room-server.js 8787`（零第三方依赖；建议 pm2/systemd 守护）。
2. **nginx 反代 wss**（证书用你已有的）：仓库已提供现成配置 `deploy/nginx/chess.wangyousong.com.conf`（含 80→443 跳转、`/ws` 升级头与长超时、`/healthz` 健康检查），拷贝到 `/etc/nginx/conf.d/` 后 `nginx -t && nginx -s reload`。手动配置参考：
   ```nginx
   location /ws {
     proxy_pass http://127.0.0.1:8787;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_read_timeout 3600s;
   }
   ```
3. **mp 控制台**：「开发设置 → 服务器域名 → socket 合法域名」添加 `wss://chess.wangyousong.com`。
4. **切换通道**：编辑 `miniprogram/net/config.js`（当前已配置为真实域名）：
   ```js
   module.exports = { kind: 'ws', wsUrl: 'wss://chess.wangyousong.com/ws' };
   ```
   `kind: 'cloud'` 则走微信云开发。大厅/对局代码无需改动（传输工厂按配置选择适配器）。
5. 服务端只做**按房间广播中继**（握手 URL `?room=` 登记房间），不解析棋局、不做裁判；校验与重同步均在客户端 `net/session.js` 完成。

### Docker 部署（服务器已有 Docker 时推荐）

```bash
docker build -t chess-room ./server
docker run -d --name chess-room --restart unless-stopped -p 127.0.0.1:8787:8787 chess-room
# 或用编排（仓库根目录）
docker compose up -d
```

- 镜像基于 `node:20-alpine`、仅复制两个运行文件、以非 root 用户运行；端口经 `PORT` 环境变量配置（默认 8787）
- 端口只绑定 `127.0.0.1`，对外仍由 nginx 以 `wss://你的域名/ws` 反代（见上）
- 部署后冒烟验证（两个裸 WS 客户端验证同房间广播与跨房间隔离）：
  ```bash
  npm run smoke:ws            # 默认连 ws://127.0.0.1:18787/ws，可传参改地址
  ```

## 音频与沉浸感

- **BGM**：`audio/bgm.mp3`，中国风古筝/箫氛围循环段；`InnerAudioContext.loop` 循环，切后台自动暂停、回前台恢复；受 iOS 限制在**首次触摸**后启动。
- **音效**：`audio/*.wav` 由 `npm run gen:sfx`（`scripts/gen-sfx.js`）纯数学合成，无外部素材——落子木质"笃"、吃子闷响、将军两声警示钟、胜/负五声琶音与低锣、按钮轻击、悔棋上挑。
- **触发点**：落子/吃子/将军/终局/工具栏/菜单/大厅按钮；菜单提供「音乐」「音效」独立开关，与静音状态一起用 `wx.setStorageSync` 持久化。
- 重新生成音效：`npm run gen:sfx`；替换 BGM 只需覆盖 `audio/bgm.mp3`（建议 ≤64s、单声道 ≤64kbps 以控制包体）。

## 测试

```bash
npm test                 # 串联全部，当前 626 项
npm run test:engine      # 引擎 61
npm run test:ai          # AI 24
npm run test:game        # 对局 117
npm run test:ui          # 布局/渲染 97
npm run test:controller  # 触摸状态机 171
npm run test:net         # 联机会话（回环）41
npm run test:cloud       # 云适配器集成（内存假云）21
npm run test:ws          # 自建 WS 通道（relay+适配器+假服务端）22
npm run test:audio       # 音频管理器 23
npm run test:page        # 小游戏接线冒烟（含邀请回流）49
```

## 操作

- 点选：先点己方棋子再点绿色落点；拖拽：按住拖到落点松手（拖拽中高亮落点）。
- 工具栏（自绘于棋盘下方）：悔棋 / 提示 / 翻转 / 重开 / 菜单；联机时悔棋与重开禁用。
- 规则页支持上下拖动滚动。

## 规则实现

将死与困毙均判负；长将判负；三次重复判和；连续 120 手无吃子判和；将帅不照面。

## 已知限制

- AI 同步搜索，思考时主线程短暂卡顿（可移 Worker 优化）。
- 自绘 UI 为最小可用组件集，未做动画过渡与音效体系。
- 联机未做观战/战绩/邀请卡片，可在现有协议上扩展。
