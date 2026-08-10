const { app, BrowserWindow, session, shell } = require('electron')
const path = require('path')
const fs = require('fs')

// ========== 调试模式 ==========
const _debugMode = process.argv.includes('--debug')
let logPath = null
const origLog = console.log
const origErr = console.error

function pickWritableLogPath () {
  const dirs = [
    path.dirname(app.getPath('exe')),
    app.getPath('userData'),
    path.join(app.getPath('temp'), 'NoVNC-Nav-Client')
  ]
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const candidate = path.join(dir, 'Log.txt')
      fs.writeFileSync(candidate, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] === NoVNC 导航客户端启动 (调试模式) ===\n`, 'utf-8')
      return candidate
    } catch (e) {}
  }
  return path.join(path.dirname(app.getPath('exe')), 'Log.txt')
}

let _logBuffer = []
let _logFlushTimer = null

function writeLog (msg) {
  if (!_debugMode) return
  if (!logPath) logPath = pickWritableLogPath()
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`
  _logBuffer.push(line)
  if (_logBuffer.length >= 100) flushLog()
  else if (!_logFlushTimer) _logFlushTimer = setTimeout(flushLog, 3000)
}

function flushLog () {
  if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null }
  if (_logBuffer.length === 0) return
  const data = _logBuffer.join('')
  _logBuffer = []
  if (!logPath) return
  fs.writeFile(logPath, data, { flag: 'a', encoding: 'utf-8' }, (err) => {
    if (!err) return
    logPath = pickWritableLogPath()
    fs.writeFile(logPath, data, { flag: 'a', encoding: 'utf-8' }, () => {})
  })
}

console.log = function () { writeLog([...arguments].map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); origLog.apply(console, arguments) }
console.error = function () { writeLog('ERR: ' + [...arguments].map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); origErr.apply(console, arguments) }

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && (err.stack || err.message || err))
  try { require('electron').dialog.showErrorBox('启动失败', err && (err.stack || err.message || String(err))) } catch (e) {}
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && (reason.stack || reason.message || reason))
})

// ========== Chromium 内存优化参数 ==========
app.commandLine.appendSwitch('disable-direct-composition')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('enable-gpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess')
app.commandLine.appendSwitch('mute-audio')
app.commandLine.appendSwitch('enable-zero-copy')
// ★ 内存优化：限制缓存大小，定期清理
app.commandLine.appendSwitch('disk-cache-size', '10485760') // 10MB 磁盘缓存上限
app.commandLine.appendSwitch('disable-http-cache')            // 禁用 HTTP 缓存（noVNC 是 WebSocket 不需要）

// ========== 全局状态 ==========
let mainWindow = null
const controlWindows = new Set()  // 所有控制窗口（单控+群控）
const WEB_ROOT = path.join(__dirname, 'web')

// ========== 主导航窗口 ==========
function createMainWindow () {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'NoVNC 控制台',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWindow.loadFile(path.join(WEB_ROOT, 'index.html'))

  // ★ 拦截导航：点击设备/群控链接时，打开新窗口而不是在当前页导航
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openControlWindow(url, mainWindow)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openControlWindow(url, mainWindow)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  console.log('主导航窗口已创建')
}

// ========== 控制窗口（每个独立渲染进程，关闭即释放全部内存）==========
function openControlWindow (url, sourceWindow) {
  // 解析 URL，确定页面类型
  let htmlFile = null
  let title = 'NoVNC 控制'
  let queryStr = ''

  // 从 file:// 或 http:// URL 中提取文件名和查询参数
  const urlObj = new URL(url)
  const pathname = urlObj.pathname
  const basename = path.basename(decodeURIComponent(pathname))

  console.log(`打开控制窗口: ${basename}, 查询: ${urlObj.search}`)

  if (basename.startsWith('iPhone_wifi')) {
    htmlFile = 'iPhone_wifi.html'
    const ip = urlObj.searchParams.get('IP') || ''
    title = `iPhone WiFi ${ip}`
    queryStr = urlObj.search
  } else if (basename.startsWith('iPhone')) {
    htmlFile = 'iPhone.html'
    const ip = urlObj.searchParams.get('IP') || ''
    title = `iPhone ${ip}`
    queryStr = urlObj.search
  } else if (basename.startsWith('全部控制')) {
    htmlFile = basename
    const groupMatch = basename.match(/全部控制([A-F])/)
    title = `全部控制 ${groupMatch ? groupMatch[1] : ''}`
  } else {
    console.log(`未知页面类型，忽略: ${basename}`)
    return
  }

  const filePath = path.join(WEB_ROOT, htmlFile)
  if (!fs.existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`)
    return
  }

  // ★ 使用独立 partition 实现进程级隔离
  // 每个控制窗口用自己的 session partition，关闭后彻底清理
  const partition = `control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: title,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      partition: partition,
      // ★ 允许 noVNC iframe 正常运行
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  // 加载本地 HTML 文件（保留查询参数供页面 JS 读取 IP）
  if (queryStr) {
    win.loadURL(`file://${filePath}${queryStr}`)
  } else {
    win.loadFile(filePath)
  }

  // ★ 控制窗口也拦截导航（导航栏链接 → 开新窗口）
  win.webContents.on('will-navigate', (event, navUrl) => {
    event.preventDefault()
    openControlWindow(navUrl, win)
  })

  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    openControlWindow(openUrl, win)
    return { action: 'deny' }
  })

  // ★ 窗口关闭时：彻底清理该窗口的 session 缓存 + 释放内存
  win.on('closed', () => {
    controlWindows.delete(win)
    // 清理该窗口的 partition session 缓存
    const winSession = session.fromPartition(partition)
    winSession.clearCache().then(() => {
      console.log(`窗口 ${title} 的 session 缓存已清理`)
    }).catch(() => {})
    winSession.clearStorageData({
      storages: ['cachestorage', 'shadercache', 'serviceworkers']
    }).then(() => {
      console.log(`窗口 ${title} 的存储数据已清理`)
    }).catch(() => {})
    console.log(`控制窗口已关闭: ${title} (剩余 ${controlWindows.size} 个)`)
  })

  controlWindows.add(win)
  console.log(`控制窗口已打开: ${title} (共 ${controlWindows.size} 个)`)

  // ★ 如果是单控窗口且来源也是单控窗口，关闭来源窗口（切换设备场景）
  if (sourceWindow && sourceWindow !== mainWindow && !sourceWindow.isDestroyed()) {
    const sourceTitle = sourceWindow.getTitle()
    // 群控窗口不自动关闭，单控窗口切换时关闭旧的
    if (!sourceTitle.includes('全部控制')) {
      console.log(`关闭来源单控窗口: ${sourceTitle}`)
      sourceWindow.close()
    }
  }
}

// ========== 定期内存清理 ==========
function startMemoryCleanup () {
  // 每 5 分钟清理主 session 的缓存
  setInterval(() => {
    console.log('定期清理主 session 缓存...')
    session.defaultSession.clearCache().catch(() => {})
  }, 5 * 60 * 1000)

  // 每 10 分钟对所有控制窗口执行 GC（如果 V8 暴露了 gc）
  setInterval(() => {
    for (const win of controlWindows) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.executeJavaScript('if(typeof gc==="function")gc()', true).catch(() => {})
      } catch (e) {}
    }
  }, 10 * 60 * 1000)
}

// ========== 应用启动 ==========
app.whenReady().then(() => {
  console.log('NoVNC 导航客户端启动')
  console.log('Web根目录:', WEB_ROOT)

  createMainWindow()
  startMemoryCleanup()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  console.log('所有窗口已关闭，退出应用')
  app.quit()
})

// 外部链接用系统浏览器打开
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // noVNC 服务器和 AutoTouch 的链接由 openControlWindow 处理，不在这里拦截
      // 这里只处理非 noVNC 的外部链接
      if (!url.includes('vnc_lite.html') && !url.includes('autotouch.net') && !url.includes('vnc_853x480')) {
        shell.openExternal(url)
        return { action: 'deny' }
      }
    }
    return { action: 'deny' }
  })
})
