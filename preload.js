const { contextBridge, clipboard } = require('electron')

// 暴露系统剪切板读取能力给渲染进程
contextBridge.exposeInMainWorld('__clipboard', {
  readText: () => clipboard.readText()
})
