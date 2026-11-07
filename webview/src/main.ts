import './assets/main.css'

import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { applyTheme, readTheme } from './lib/theme'

applyTheme(readTheme())

createApp(App).use(createPinia()).mount('#app')
