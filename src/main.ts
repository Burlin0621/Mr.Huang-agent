import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { installBuiltinPackages } from './lib/builtin-packages'
import { initStorage } from './lib/storage'
import router from './router'

import './styles/tokens.css'
import './styles/base.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

/** 先初始化统一存储层（桌面端加载文件存储 + 一次性迁移 localStorage 旧数据），再安装内置包并挂载 */
void initStorage()
  .catch(() => {
    // 初始化失败不阻断启动（存储层内部已降级）
  })
  .then(() => {
    // 启动时异步安装内置技能合集包（幂等，不阻塞首屏；失败仅告警）
    installBuiltinPackages()

    void router.isReady().then(() => {
      app.mount('#app')
    })
  })
