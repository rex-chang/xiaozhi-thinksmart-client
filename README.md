# xiaozhi-thinksmart-client

联想 ThinkSmart View（CD-18781Y）上的语音客户端：本地唤醒词「小麦小麦」、回声消除、按小智协议连 [xiaozhi-hub-server](https://github.com/justhalfbit/xiaozhi-hub-server)，并在 `127.0.0.1:8090` 提供展示屏上的对话界面。

它是 [thinksmart-ubuntu-image](https://github.com/justhalfbit/thinksmart-ubuntu-image) 系统镜像的一部分，刷机和安装见那边的 README；装好的设备在设置页「软件更新」里从本仓库的 Release 在线更新（系统镜像的系统层更新包也放在本仓库的 Release 里，和客户端一起显示、一起装；这些文件是设备自动下载的，刷机镜像在系统镜像仓库）。

## 定制集成版 0.1.9

`dev` 分支完整合并上游 `e7ec0de`（0.1.6）：蓝牙 A2DP 接收、音频混音与回声消除、Wi-Fi 设置、系统层更新和追问等待修复；同时保留网易云播放器、歌词/歌单/队列、设备状态页及语音触发的扫码登录卡片。登录凭据由 Hub 保存，不包含在客户端发布包中。

本仓库是完整客户端源码入口，不再从旧发布包或只覆盖 `app.py`/`web.py` 打补丁部署。用系统镜像仓库的 `update/make-release.py` 从已提交的 `dev` 打包，再经 `thinksmart-update` 安装和自检；用户配置、聊天记录、闹钟和 Hub 登录态不随版本目录替换。蓝牙配对需要在设置页手动打开 3 分钟“添加手机”窗口，手机声音经客户端混音输出。

## 结构

| 位置 | 作用 |
| --- | --- |
| `thinksmart_client/app.py` | 状态机：唤醒 → 聆听 → 回复 → 10 秒追问窗口 → 待机；打断（回复期间麦克风不上传，只有唤醒词或按钮能打断，打断时告诉网关播了多少毫秒；网关识别中、思考中也能打断，那句话作废，网关确认打断之前收到的旧一轮文字和回复都不要）、按住说话、文字提问、按模型分开的对话记录 |
| `tests/` | 单元测试（不需要设备的声卡和库），运行方法见文件开头 |
| `thinksmart_client/audio.py` | 麦克风 16 kHz、扬声器 48 kHz，都走 PipeWire；回声消除只在对话中或刚播过声音时运行 |
| `thinksmart_client/aec.py` | WebRTC APM 回声消除（改自 py-xiaozhi 的 AecEngine） |
| `thinksmart_client/kws.py` | sherpa-onnx 唤醒词，单线程、40 ms 一批、安静时跳过（声音停后再解码 1 秒）、模型前加 10 dB 增益 |
| `thinksmart_client/wake_verify.py` | 唤醒二次确认（默认关，`wake_verify: 'hub'` 打开）：命中后把最近 3 秒交给网关识别（`POST /kiosk/asr`），按拼音比对唤醒词；`pinyin.txt` 是它用的常用字拼音表（`eval/wake/make_pinyin.py` 生成） |
| `eval/wake/` | 唤醒评测：漏唤醒率、误唤醒率，见其中 README |
| `thinksmart_client/hub.py` | 小智 WebSocket 协议（hello 只声明 `mcp`：不让网关一听到声音就打断回复） |
| `thinksmart_client/mcp.py` | 给模型用的设备工具：音量、睡眠时段、屏幕亮度、倒计时/闹钟/提醒（新建、查看、取消、再睡）、闹钟音量 |
| `thinksmart_client/alarms.py` | 倒计时、闹钟、提醒（共用一种数据，可循环：每天、工作日、每周几、每月几号）：模型只传意思，几点由这里算；存在 `~/.local/share/thinksmart-client/alarms/`（临时文件 + fsync + 改名，防断电）；系统对时前不判断；关机错过不到 1 小时的开机补响一次；闹钟和倒计时没人停就响 10 分钟，提醒是短钢琴和弦加念内容、反复 3 分钟；错过的显示在首页，点「知道了」清掉；铃声 5 选 1：钢琴曲「咖啡时光」（默认）「晨曦」「元气早晨」「阳光小跳跃」和程序合成的木琴 |
| `thinksmart_client/device.py` | 屏幕和按键：给系统熄屏程序写提示（对话中不熄屏、用户设的自动熄屏（1/3/5/10/30 分钟或不熄，默认 5 分钟，触摸和对话结束都按它）、唤醒词亮屏、睡眠时段调暗、用户设的亮度 0-100），读音量键和麦克风开关 |
| `thinksmart_client/sleep.py` | 睡眠时段（可跨午夜）：回复音量减半、屏幕调暗、补报不主动念；设置存在用户配置里（`config.save`），页面设置页和语音工具都能改 |
| `thinksmart_client/bt.py`、`bt_helper.py` | 蓝牙音箱：手机配对后把歌放到设备上。`bt_helper.py` 用系统自带的 python3（dbus、GLib）管 BlueZ：配对代理（免密码，只在设置页点了「添加手机」后的 3 分钟内接受，配过的手机设为信任、以后点一下就重连）、开关、忘记手机、闹钟响时让手机暂停；`bt.py` 在手机推流时用 `pw-record` 录它的音源，混进 `audio.Background`（和回复相加后送喇叭，回声消除知道它，放歌时照样能唤醒）；对话时压到 20%、闹钟响或试听铃声时静音。需要系统层的 `bluetooth/` 配置（手机的声音变成音源而不是直接送喇叭）；没有时手机照样能放，但声音绕过客户端，放歌时很难唤醒，设置页会提示 |
| `thinksmart_client/opus.py` | 系统 libopus 的 ctypes 封装 |
| `thinksmart_client/web.py` | 页面、事件流（SSE）、按钮接口 |
| `web/` | 界面（设置页里的 WiFi 由展示屏外壳执行：页面通过 WebKit 的 `thinksmart` 消息通道请外壳扫描、连接、忘记网络，和系统镜像欢迎页同一套代码；输入框用外壳注入的系统键盘；外壳太旧时卡片只提示）：正式版是 `v2/`（带表情的光球，首页 `/` 和 `/v2`），第一版 `index.html`、`app.css`、`app.js` 留在 `/v1`；`test/` 是 GPU 排查用的测试页；另有提示音、厂商图标 |
| `models/kws-zh/` | 唤醒词模型 |
| `deploy/thinksmart-client.service` | 系统服务 |
| `deploy/bootstrap-updater` | 服务启动前以 root 运行：20261101 镜像的设备上更新服务只认客户端，发布包里带了新的（`deploy/updater/`，发布时由系统镜像仓库的 `make-release.py --system` 放进去），比设备上的新就换上；已经是新的就什么都不做 |

## 接口（只监听本机）

- `GET /events`：事件流，`snapshot`、`state`、`message`、`thread`、`model`、`level`、`toast`、`volume`（`source`：`key`/`voice`/`page`；`ring` 为 true 是响铃时音量键调的这一次铃声）、`alarms`（列表、错过的、是否对过时、正在响的、闹钟音量和铃声）、`bluetooth`（见 `/api/bluetooth`）
- `POST /api/wake`、`/api/end`、`/api/abort`、`/api/ptt/start`、`/api/ptt/stop`
- `POST /api/text {"text": "..."}`：文字提问（服务端按识别出的话处理）
- `POST /api/model {"kind": "...", "vendor": "..."}`：切换模型（转给服务端的 `/kiosk/llm/use`）
- `POST /api/brightness {"level": 0-100}`：屏幕亮度（存用户配置，默认 100，没有自动亮度；睡眠时段内设的亮度用到时段结束）
- `POST /api/screen-off {"enabled": true, "minutes": 1|3|5|10|30}`：自动熄屏（两个字段可以只传一个；存用户配置，默认开、5 分钟；关掉就不熄屏）
- `POST /api/volume {"volume": 0-100}`：设备音量（和音量键、语音同一个值；响铃时改的是响完要恢复的那个）
- `POST /api/alarm-volume {"volume": 0-100}`：闹钟音量（存用户配置，默认 70）；`POST /api/alarm-tone {"tone": "coffee|morning|bright|hop|marimba", "preview": false}`：选铃声，`preview` 为 true 时用闹钟音量试听一段（前 8 秒），`{"stop": true}` 停止试听（关设置页时页面会发）
- `POST /api/alarms/delete {"id": n}`、`/api/alarms/stop`、`/api/alarms/snooze`（正在响或 15 分钟内响过的那条 10 分钟后再响）、`/api/alarms/missed/clear`
- `POST /api/bluetooth`：`{"enabled": bool}` 蓝牙音箱开关（存用户配置 `bluetooth`，关掉就让蓝牙断电），`{"window": bool}` 打开或关掉 3 分钟的「添加手机」，`{"remove": "地址"}` 忘记一台手机，`{"disconnect": "地址"}` 断开。状态在事件 `bluetooth`（快照里也有）：`available`、`enabled`、`powered`、`window`（剩余秒数）、`name`（手机上看到的名字）、`direct`（手机的声音绕过了客户端：系统层太旧）、`devices`（`address`、`name`、`paired`、`connected`、`streaming`、`title`、`artist`）
- `POST /api/power-off`：关机（`systemctl halt`，插着电也不会自己重新开机，屏幕变黑后等 10 秒再拔电源；正在更新时不执行）。页面先收到 `power {"state": "off"}` 显示「正在关机」
- `POST /api/history/clear {}` 或 `{"memory_only": true}`：清除聊天记录（转给服务端的 `/kiosk/chat/clear`，只清服务端本机存的所有模型的记录和总结记忆，Claude Code、Grok Bot 自己的会话不动；`memory_only` 只清记忆）。聊天页的记录来自服务端存的 `GET /kiosk/chat/history`（每个模型最近 50 条），没连着时载入，断开、重启后还在；说「清除聊天记录」确认后服务端发 `{"type": "chat_history", "state": "cleared"}`，页面清空

## 第三方

- `thinksmart_client/webrtc_apm/`：py-xiaozhi 的 WebRTC APM ctypes 封装和 arm64 库，MIT（`LICENSE-py-xiaozhi`）
- `models/kws-zh/`：sherpa-onnx 中文唤醒词模型（wenetspeech），Apache-2.0
- `web/logos/`：LobeHub icons 1.95.1，MIT
- `web/sounds/alarm-*.ogg`（Ogg Opus 64 kbit/s，客户端用系统 libopus 解码）：闹钟铃声（原创曲「咖啡时光」「晨曦」「元气早晨」「阳光小跳跃」和提醒用的短和弦），用 [Salamander Grand Piano V3](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) 的采样渲染（Alexander Holm，CC BY 3.0）；渲染脚本在 `tools/ringtone/`
- 依赖：numpy、sounddevice、soxr、websockets、aiohttp、sherpa-onnx

## 许可

MIT，见 [LICENSE](LICENSE)。各厂商 logo 是其所有者的商标，只用来标识对应的服务。本项目是个人项目，与联想（Lenovo）及各模型厂商没有任何关系。
