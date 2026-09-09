# 微信中国象棋（小游戏）

一个运行在**微信小游戏**上的中国象棋：人机对战（五档难度）、本地双人、好友联机（云开发）。

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
scripts/                     node 测试（每层一个 test-*.js）
miniprogram/
  game.js                    入口：Canvas/dpr、全局触摸、rAF 主循环、云初始化、场景调度
  game.json                  小游戏配置（竖屏等）
  core/                      对局核心（纯 JS）：constants/position/movegen/evaluate/ai/book/game/notation
  ui/
    layout.js                棋盘索引 <-> 像素换算、翻转、触摸命中
    renderer.js              棋盘分层绘制（仅依赖 Canvas 2D）
    controller.js            触摸状态机：点选+拖拽、canMove 门控、renderState
    widgets.js               小游戏自绘 UI：按钮/分段/文本换行/命中测试
  net/
    transport.js             传输接口约定 + 回环传输对（测试用）
    session.js               OnlineSession 房间状态机（与通道解耦）
    cloud-transport.js       云开发 database watch 适配器
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

联机协议见 `net/session.js`：`join/welcome/move/stateReq/state/result/bye`；走法只传 `(from,to,ply)` 本地校验重放，乱序自动全量重同步，同 `clientId` 重加入即断线重连。

## 测试

```bash
npm test                 # 串联全部，当前 541 项
npm run test:engine      # 引擎 61
npm run test:ai          # AI 24
npm run test:game        # 对局 117
npm run test:ui          # 布局/渲染 93
npm run test:controller  # 触摸状态机 171
npm run test:net         # 联机会话 41
npm run test:page        # 小游戏接线冒烟 34（桩 wx.createCanvas/全局触摸/软键盘）
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
