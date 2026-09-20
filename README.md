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
scripts/                     node 测试（每层一个 test-*.js）+ 音效合成 gen-sfx.js + 杀法语音 gen-mate-voice.js
server/                      自建联机中继（零依赖 Node WebSocket）
  relay.js                   房间中继纯逻辑（可单测）
  room-server.js             WS 服务端：握手 ?room= 登记 + 按房间广播
miniprogram/
  game.js                    入口：Canvas/dpr、全局触摸、rAF 主循环、云初始化、场景调度
  game.json                  小游戏配置（竖屏等）
  core/                      对局核心（纯 JS）：constants/position/movegen/evaluate/ai/book/game/notation/mate
  ui/
    layout.js                棋盘索引 <-> 像素换算、翻转、触摸命中
    renderer.js              棋盘分层绘制（仅依赖 Canvas 2D）
    controller.js            触摸状态机：点选+拖拽、canMove 门控、renderState
    widgets.js               小游戏自绘 UI：按钮/分段/文本换行/命中测试
    audio.js                 音频管理器：BGM loop + SFX 池 + 杀法语音 + 开关持久化
    endgame.js               绝杀演出：三拍时间线 + 15 种杀法母题 + 结算卡
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
- **绝杀语音**：`audio/mate-<key>.m4a`，终局判出杀法时把名字念出来（不只是弹窗显示）。由 `npm run gen:voice`（`scripts/gen-mate-voice.js`）用 macOS 自带的 `say` + `afconvert` 合成，11 条约 88KB；清单以 `core/mate.js` 为单一数据源，改名只需重跑脚本。音频按需创建上下文，不在启动时占用。

## 杀法识别

绝杀时会判出杀法名（如「马后炮」），既写进终局文案，也朗读出来。实现在 `core/mate.js`。

**只覆盖名字能从终局还原的那一类**，共 15 种，分两类：

| 类别 | 数量 | 名字在描述什么 | 名单 |
|---|---|---|---|
| **几何型** | 11 | 终局形态，判据唯一 | 对面笑、马后炮、重炮、闷宫、双车错、卧槽马、挂角马、钓鱼马、侧面虎、二鬼拍门、闷杀 |
| **阵形型** | 4 | 攻杀阵形，天然会与几何型重叠 | 天地炮、夹车炮、铁门栓、海底捞月 |

两类都不认的，是名字描述**过程**或**威胁**的那些，终局里已无从还原，**一律不猜**——认不出时返回 `null`，文案退回「绝杀无解」：

- 讲「怎么杀的」：大胆穿心、炮碾丹砂、送佛归殿、老兵搜山、拔簧马、双马饮泉
- 讲「阵形威胁」：**空头炮**——炮与将同一直线、中间无子，看着像，但炮要炮架才能吃子，没有炮架它既将军不了也封不住格子，在终局里是个旁观者。实测把那一枚炮整枚拿掉，局面**照样是将死**，足以证明它没参与这一杀

这也是阵形型里另外 4 种能命名、空头炮不能的原因：**那 4 种的棋子都实打实参与杀**（两炮都在将军 / 车真的封了口 / 中炮正是士不敢吃车的原因 / 将军子确实沉在底线）。

### 阵形型与几何型撞名怎么解

同一个终局可以既像闷宫又像天地炮，这不是技术问题而是语义重叠。解法**不是拍一张优先级表**，而是给判据补上区分性条件，让每种各归各位：

- **闷宫要求「单炮将军」**——中炮与沉底炮同时将军是天地炮，不是闷宫
- **重炮要求「无车参与」**——双炮并线时若有车配合封口，那是夹车炮

剩下少量顺序依赖，用 `mate.js` 里 `MATCHERS` 数组的排列显式表达：越具体的排越前。`test-mate.js` 的 [8] 节把每条区分条件都钉住（含反向用例：有车占将门但没有中炮时归双车错，不归铁门栓）。

### 各杀法的判据要点

- 炮系看**炮架是谁**：己方马→马后炮；己方炮→重炮；敌士且将紧贴→闷宫；其他敌子→闷杀
- 马系查**「路 × 横线」换算出的精确格位**
- 车系要求**另一车确实攻击将的相邻格**（只数「还有一辆车」会把单车杀误判成双车错）
- 天地炮＝中炮在将的纵线 ＋ 沉底炮在对方底线；夹车炮＝双炮并线 ＋ 有车参与
- 铁门栓＝中炮 ＋ 车/兵占住将门（将正前方那格）；海底捞月＝将军子沉在底线正对将背后（将不在底线）

判据依赖一套坐标记法（攻击方看「路」，防守方看「横线」），马位术语因此都是精确格位：

```
路   = 攻击方纵线编号：红攻黑时 路 = 9 - file；黑攻红时 路 = file + 1
横线 = 防守方横线编号：黑守时 横线 = rank + 1；红守时 横线 = 10 - rank

卧槽马 (2,1)/(6,1)   挂角马 (3,2)/(5,2)   钓鱼马 (2,2)/(6,2)   侧面虎 (2,3)/(6,3)
```

`result` 上会多出 `mate`（中文名）与 `mateKey`（ASCII key，供语音等资源引用）两个字段。

**闷宫与闷杀的分界**：闷宫的炮架**一定是对方的士**，且将紧贴炮架；炮架是士以外的子力（或将已离位）就是闷杀。两者常合称「闷将杀」。

### 多音字

朗读用的文本不等于显示名——象棋术语里多音字不少，TTS 会挑最常用的读音，往往不是术语那一个。`MATE_PATTERNS` 里的 `speech` 字段用**同音字**把读音锁死（显示仍是原字）：

| 术语 | 正确读音 | TTS 默认 | 朗读文本 |
|---|---|---|---|
| 重炮 | chóng（叠炮） | zhòng ✗ | 虫炮 |
| 双车错 | jū（象棋里的车） | chē ✗ | 双居错 |
| 夹车炮 | jū | chē ✗ | 夹居炮 |

改法：在 `core/mate.js` 对应条目加 `speech`，再跑 `npm run gen:voice`。

**生成脚本是增量的**：它读一份 `audio/mate-voice.json` 朗读文本清单，文本没变就跳过。这是必须的——`afconvert` 出来的 m4a 是非确定性的（同一段文本连跑两次字节就不同，但解码后 PCM 完全一致，差的是容器元数据），不做跳过的话每跑一次都会把全部文件标记成已修改。要强制全量重生成用 `npm run gen:voice -- --force`。

**没有耳朵也能验收**：`say` 出来的音频可以解成 PCM 做基频曲线分析，用声调走向判断读的是哪个音——二声（阳平）先微降后上扬，四声（去声）单调下降。改「重炮」时就是用这个方法确认的（旧版第 1 音节 327→204Hz 单调降＝zhòng，新版 208→94→208Hz 先降后扬＝chóng）。

## 绝杀演出

终局不用 `wx.showModal`——纯文字弹窗太单薄，而且和前面刚做完的走子动画、持续发光、绝杀语音气质是断的。改为在画布上自绘一段**三拍演出**（`ui/endgame.js`）：

| 拍 | 时长 | 内容 |
|---|---|---|
| ① 压暗 | 0.35s | 整屏蒙一层暗场（连工具栏一起盖住），其余棋子沉下去 |
| ② 演示 | 0.7s | 按 `result.mateInfo` 的几何画出该杀法的专属母题 |
| ③ 落款 | 0.7s | 杀法名以书法字放大落款 + 胜负，按钮再晚一拍浮出 |

演出期间点屏幕任意处**立即跳到落款**——每局等两秒会烦。落款给「再来一局 / 回菜单」；
联机不能重开，只给「回菜单」。认输 / 困毙 / 对手离开等非杀法终局走同一套，但没有母题，
标题用终局原因（认输不该演「绝杀」）。

### 15 种杀法的母题

母题要回答的是「**这一招凭什么成立**」，所以每种都点在自己的关键处：

| 杀法 | 母题 |
|---|---|
| 马后炮 | 将军线由炮经马扫向将，扫到马身时脉动一圈（点出「马是炮架」） |
| 重炮 | 同上，但炮架处脉动**两圈**（点出「两炮」） |
| 闷宫 / 闷杀 | 先扫将军线，再把将四周四道短线**合拢成框**（被自家子堵死） |
| 双车错 / 天地炮 / 夹车炮 | 各子**错开一拍**各拉一条线指向将（两条 / 两条 / 三条） |
| 卧槽马 / 挂角马 / 钓鱼马 / 侧面虎 | 从马到将画一条**「日」字轨迹**（先长边后短边），落点闪一下 |
| 对面笑 | 两帅之间一道**光柱**贯穿 |
| 二鬼拍门 | 两条封线从两兵向外拉开，**锁住两条肋道** |
| 铁门栓 | 将门上**落下一道门闩**，车与中炮各拉一条线 |
| 海底捞月 | 底线那条将军线 ＋ 一弯**月弧**从将的下方兜上来 |
| 认不出杀法 | 不画母题，只压暗 + 落款「绝杀」 |

母题靠 `mate.js` 返回的几何驱动（`checker` / `screen` / `king` / `pieces`），不是硬编码局面。
`test-endgame.js` 对每种杀法都断言**母题的第一笔落在预期的关键子上**——演出画错位置比不画更糟。

## 测试

```bash
npm test                 # 串联全部，当前 1122 项
npm run test:engine      # 引擎 64
npm run test:ai          # AI 24
npm run test:game        # 对局 117
npm run test:mate        # 杀法识别 161
npm run test:ui          # 布局/渲染 167
npm run test:controller  # 触摸状态机 249
npm run test:endgame     # 绝杀演出 124
npm run test:net         # 联机会话（回环）41
npm run test:cloud       # 云适配器集成（内存假云）21
npm run test:ws          # 自建 WS 通道（relay+适配器+假服务端）22
npm run test:audio       # 音频管理器 47
npm run test:page        # 小游戏接线冒烟（含邀请回流、绝杀演出）85
```

杀法的测试局面（15 个已用引擎确认过的将死局面）放在 `scripts/fixtures/mate-cases.js`，
由 `test-mate`（验识别）与 `test-endgame`（验演出母题）共用，避免同一份局面写两遍。

## 操作

- 点选：先点己方棋子再点绿色落点；拖拽：按住拖到落点松手（拖拽中高亮落点）。
- 工具栏（自绘于棋盘下方）：悔棋 / 提示 / 翻转 / 重开 / 菜单；联机时悔棋与重开禁用。
- 规则页支持上下拖动滚动。

## 规则实现

将死与困毙均判负；长将判负；三次重复判和；连续 120 手无吃子判和；将帅不照面。

## 已知限制

- AI 同步搜索，思考时主线程短暂卡顿（可移 Worker 优化）。
- 自绘 UI 为最小可用组件集（动画与音效已具备，但没有过渡曲线体系）。
- 联机未做观战/战绩/邀请卡片，可在现有协议上扩展。
