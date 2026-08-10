# NoVNC 导航控制台本地客户端

## 背景

原 noVNC 导航系统是部署在服务器上的静态网页，在浏览器中打开后，每个 noVNC 画面的缓存会持续堆积，即使单控一个 noVNC 也会导致内存爆满、电脑卡死。

本客户端将导航系统打包为 Electron 本地应用，利用 **进程级隔离** 彻底解决内存堆积问题。

## 内存优化原理

| 浏览器（有问题） | 本客户端（已解决） |
|---|---|
| 所有 iframe 共享同一个渲染进程 | 每个控制窗口 = 独立渲染进程 |
| 切换设备时旧 iframe 内存不释放 | 关闭窗口即杀死进程，内存彻底释放 |
| 长时间使用缓存持续堆积 | 每个窗口用独立 session partition，关闭后自动清理缓存 |
| 无法控制内存上限 | Chromium 参数限制缓存 + 定期 GC |

### 核心机制

1. **进程隔离**：每个设备/群控页面在独立的 BrowserWindow 中打开，拥有独立的渲染进程
2. **关闭即释放**：关闭控制窗口时，渲染进程被杀死，所有 noVNC 的 canvas/解码器/WebSocket 缓存随进程一起释放
3. **Session 隔离**：每个窗口使用独立的 partition session，关闭后自动 `clearCache()` + `clearStorageData()`
4. **定期清理**：主窗口每 5 分钟清理缓存，控制窗口每 10 分钟触发 GC
5. **Chromium 优化参数**：禁用 HTTP 缓存、限制磁盘缓存 10MB、禁用音频进程、强制 DPI=1

## 功能

完全保留原导航系统所有功能：

- 网线 A-F 组单控（每组 6 台 iPhone）
- WiFi A-F 组单控（每组 6 台 iPhone）
- 全部控制 A-F 群控（每组 5 台同步操作）
- 旋转画面 / Auto Touch 切换
- 仓库入库 / 背包出售 批量操作
- 同步操作（主控选择 + 鼠标/键盘/滚轮同步）
- 设置剪贴板

## 使用方法

### 方式一：下载构建版本

1. 从 GitHub Actions 下载最新构建产物
2. 解压后运行 `NoVNC导航控制台.exe`
3. 主窗口显示导航页面，点击设备链接自动打开新窗口

### 方式二：本地开发运行

```bash
npm install
npm start          # 正常启动
npm run debug      # 调试模式（生成 Log.txt）
```

### 构建打包

```bash
npm run build:win  # 构建到 dist/ 目录
```

## 操作说明

1. 启动后显示导航主页（与原网页导航完全一致）
2. 点击导航栏中的设备名称 → 打开新的控制窗口
3. 单控窗口中切换设备时，旧窗口自动关闭，新窗口打开
4. 群控窗口独立运行，不会自动关闭
5. 关闭控制窗口即彻底释放该窗口的所有内存
6. 不再使用的窗口请及时关闭

## 与 novnc-cef-client 的区别

| 特性 | novnc-cef-client | 本客户端（novnc-nav-client） |
|---|---|---|
| 用途 | 多窗口群控（配置文件驱动） | 导航页面浏览 + 单控/群控 |
| 界面 | 选组 → 多窗口排列 | 导航页 → 点击打开控制窗口 |
| 配置 | 需要 `配置文件.int` | 无需配置，内置导航页面 |
| 适用场景 | 固定分组批量操作 | 临时查看/控制任意设备 |

## 技术细节

- Electron 41.x
- 所有静态资源打包在 `web/` 目录
- HTML 文件路径已改为本地相对路径（原 `http://neiwang.hogan.ltd/novnc/static/` → `static/`）
- noVNC 服务器地址保持不变（`http://172.16.102.229:8080/vnc_lite.html`）
- AutoTouch 地址保持不变（`http://d.autotouch.net/`）

## 文件结构

```
novnc-nav-client/
├── index.js              # Electron 主进程
├── package.json
├── web/                  # 静态网页资源
│   ├── index.html        # 导航主页
│   ├── iPhone.html       # 单控（网线）
│   ├── iPhone_wifi.html  # 单控（WiFi）
│   ├── 全部控制A-F.html   # 群控页面
│   └── static/           # CSS/JS/图标
│       ├── 导航.html      # 导航栏组件
│       ├── bootstrap.min.css
│       ├── bootstrap.bundle.min.js
│       ├── jquery.slim.min.js
│       ├── hogan_853x480.css
│       ├── hogan1_853x480.css
│       └── favicon.ico
└── .github/workflows/
    └── build.yml         # GitHub Actions 自动构建
```

## 调试

启动时加 `--debug` 参数会在 exe 同目录生成 `Log.txt` 日志文件：

```bash
NoVNC导航控制台.exe --debug
```
