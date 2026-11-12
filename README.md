# 旷野 · Open World 3D

一个单文件、零依赖的第三人称开放世界小游戏。前端是纯 `index.html`（Three.js + 程序化地形 + 程序化音频），联机部分由一个自研的 Node.js WebSocket 服务承担（手写帧解析，无第三方依赖）。

![单文件](https://img.shields.io/badge/frontend-single%20html-2f5f96) ![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a) ![License](https://img.shields.io/badge/license-MIT-blue)

## 功能

- **程序化无限世界**：基于哈希噪声的 `heightAt()` 生成地形，区块按 40 m 分块流式加载，树木 / 岩石 / 花草全部走 `InstancedMesh`，同一屏几百个物体只有个位数 draw call。
- **第三人称角色**：可跑跳、疾走、游泳（入水自动切换姿态并浮在水面），角色带两节手臂 / 两节腿的步态动画。
- **采集与战斗**：树木、岩石、蘑菇可采集；五种武器（手枪 / 步枪 / 霰弹枪 / 长剑 / 战斧）各有 3D 模型、伤害、冷却与手感；夜晚出没暗影兽，击杀掉落材料。
- **载具**：汽车（贴地）、船（贴水面）、飞机（滑跑加速到阈值后起飞，有俯仰与失速判定）。
- **多端同世界**：位置广播、在线人数、公屏到访记录、语音对讲（录片段转发）、世界留言板。
- **地图**：右上角随朝向旋转的小地图 + 可缩放的大地图 + 路标。
- **程序化音频**：不加载任何音频文件。风声、水声、鸟鸣、虫鸣、三种枪声、挥砍破风、引擎随速度变调、脚步与受伤反馈，全部用 Web Audio 实时合成。

## 快速开始

前端是单文件，任何静态服务器都能托管：

```bash
# 任选其一
python3 -m http.server 8080
npx serve .
```

浏览器打开 `http://localhost:8080/`，点「进入」即可。**首次点击之后才会有声音**（浏览器自动播放策略），右上角 `♪` 可静音。

联机需要再起一个 WebSocket 服务：

```bash
node server.js          # 默认监听 127.0.0.1:8787
```

前端默认连 `ws(s)://<当前页面 host>/ws`，所以生产环境通常用 Caddy / Nginx 把 `/ws` 反代到 `127.0.0.1:8787`。开发时也可以直接指定：

```
http://localhost:8080/?ws=ws://localhost:8787
```

## 环境变量（服务端）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OW_PORT` | `8787` | 监听端口 |
| `OW_HOST` | `127.0.0.1` | 监听地址，前面挂反代时保持默认即可 |
| `OW_DATA` | `./data` | 留言与到访记录的存放目录 |

## 部署参考

**Caddy**

```
example.com {
    root * /srv/open-world
    file_server
    handle /ws* {
        reverse_proxy 127.0.0.1:8787
    }
}
```

**systemd**

```ini
[Unit]
Description=Open World sync server
After=network.target

[Service]
WorkingDirectory=/srv/open-world
Environment=OW_PORT=8787
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## 操作

| 按键 | 作用 |
|---|---|
| `W A S D` | 移动 |
| `Shift` | 疾走 / 载具加力 |
| `Space` | 跳跃 / 飞机拉升 |
| 鼠标移动 | 转视角（无需按住） |
| 滚轮 | 拉近拉远 |
| 点击 | 射击 / 挥砍 |
| `1`–`5` | 换武器 |
| `F` | 采集 / 上下载具 |
| `M` | 大地图 |
| `V` | 语音对讲 |
| `L` | 留言板 |

## 存档与隐私

- 进度存在浏览器 `localStorage`（`ow_save_v3`），7 天有效，不上传服务器。
- 服务端会把到访 IP 记录在 `data/visits.json`，用于公屏展示；公屏上前两段打码，完整 IP 只留在服务器本地。**介意的部署者可以删掉 `recordVisit()` 相关逻辑。**

## 许可

MIT，见 [LICENSE](LICENSE)。
