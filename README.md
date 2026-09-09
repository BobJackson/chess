# 微信中国象棋小程序

一个纯本地逻辑 + 云开发联机的中国象棋微信小程序。支持**人机对战**（五档难度）、**本地双人**与**好友联机**三种模式。

核心设计原则：**所有对局逻辑均为纯 JavaScript、不依赖 `wx` API**，因此引擎、AI、渲染、触摸状态机、联机会话都可以在 node 下直接单元测试；页面层只负责把 Canvas 触摸事件与渲染循环接上去。

## 目录结构

```
project.config.json          微信工程配置（miniprogramRoot -> miniprogram/）
package.json                 测试脚本入口（npm test）
scripts/                     node 测试（每个模块一个 test-*.js）
miniprogram/
  app.js / app.json / app.wxss / sitemap.json
  core/                      对局核心（纯 JS）
    constants.js             棋盘尺寸、棋子编码、FEN、坐标换算
    position.js              局面表示与 make/unmake
    movegen.js               走法生成与合法性校验（含蹩马腿、塞象眼、将帅照面）
    evaluate.js              静态评估（子力 + 位置表）
    ai.js                    迭代加深 + Alpha-Beta + 静态搜索 + 杀手/历史/MVV-LVA
    book.js                  开局库（加权取着，制造开局变化）
    game.js                  对局流程：走子/悔棋/终局判定/FEN+着法序列化
    notation.js              中文着法与回合排版
  ui/                        视图层（纯 JS，仅依赖 Canvas 2D 接口）
    layout.js                棋盘索引 <-> 画布像素换算、翻转视角、触摸命中
    renderer.js              分层绘制：背景/网格/九宫/准星/楚河汉界/棋子/覆盖层
    controller.js            触摸状态机：点选 + 拖拽、canMove 门控、renderState
  net/                       联机层
    transport.js             传输接口约定 + 回环传输对（测试用）
    session.js               OnlineSession 房间状态机（与通道解耦）
    cloud-transport.js       微信云开发 database watch 适配器
  pages/
    index/                   主页：难度选择 + 三种模式入口
    game/                    对局页：Canvas 棋盘 + 触摸 + 工具栏
    online/                  联机大厅：建房 / 输入房间号加入
    rules/                   规则说明
```

## 快速开始

1. 用**微信开发者工具**导入本项目根目录（即 `project.config.json` 所在目录）。
2. 把 `project.config.json` 中的 `appid` 从占位的 `touristappid` 换成你自己的 AppID。
3. 只玩人机 / 本地双人：到此即可直接编译运行，无需任何后端。
4. 要玩好友联机：见下文「云开发配置」。

## 云开发配置（好友联机）

1. 在微信公众平台为小程序**开通云开发**。
2. 在云控制台创建两个集合：
   - `chess_rooms`：房间登记，文档 `_id` 为房间号，字段 `{ creator, createdAt }`
   - `chess_msgs`：消息流，字段 `{ room, clientId, type, ... }`
   权限建议设为「所有用户可读写」（或按需求收紧）。
3. 若使用多环境，在 `miniprogram/app.js` 的 `wx.cloud.init({ env: '你的环境ID' })` 中指定环境。
4. 联机流程：一方「创建房间」得到 4 位房间号 → 另一方输入房间号「加入房间」→ 双方自动进入对局（建房者执红）。

联机协议（`net/session.js`）与通道解耦，消息类型：`join` / `welcome`（定向，含 `to`）/ `move` / `stateReq` / `state` / `result` / `bye`。走法只传 `(from, to, ply)`，接收方本地校验重放；重复着法忽略，越权或乱序自动触发全量重同步（起始 FEN + 着法序列）；同 `clientId` 重新加入即断线重连。

## 测试

全部测试在 node 下运行，无需微信环境：

```bash
npm test              # 串联全部，当前 550 项
npm run test:engine   # 引擎：走法生成/perft/规则 61 项
npm run test:ai       # AI：难度基准/战术/确定性 24 项
npm run test:game     # 对局：终局判定/重复/限着/序列化 117 项
npm run test:ui       # 布局与渲染：坐标/线型/覆盖层 93 项
npm run test:controller  # 触摸状态机：点选/拖拽/门控/多指防护 171 项
npm run test:net      # 联机会话：同步/重连/终局/离开 41 项
npm run test:page     # 页面接线冒烟：桩 wx/Page/Canvas 驱动全链路 43 项
```

页面层测试通过桩掉 `wx` / `Page` / `getApp` / Canvas 上下文来真实加载页面模块；其中 `setTimeout` 被桩为同步执行，以便确定性地驱动 AI 回合与联机广播。

## 玩法与操作

- **点选**：先点己方棋子，再点绿色落点走子；可吃子位置显示红环。
- **拖拽**：按住棋子拖到落点松手；拖拽中高亮松手落点。
- **工具栏**：悔棋（人机回退两手）、提示、翻转视角、重开、返回。联机模式下悔棋与重开被禁用。
- **难度**：入门 / 简单 / 中等 / 困难 / 大师，对应搜索深度与随机化程度递增的克制。

## 规则实现

将死与困毙均判负；长将判负；三次重复局面判和；连续 120 手（60 回合）无吃子判和；将帅不能照面。

## 已知限制与后续方向

- AI 搜索为同步执行，思考时主线程短暂卡顿；如需更顺滑可移入 Worker 线程。
- 云开发 watch 在弱网下可能延迟，协议层已用全量重同步兜底。
- 联机暂未做观战、战绩保存与好友邀请卡片，可在此协议上扩展。
