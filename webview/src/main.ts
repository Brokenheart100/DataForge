import './assets/main.css'

import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { applyDocumentLang } from './lib/i18n'
import { applyTheme, readTheme } from './lib/theme'

applyTheme(readTheme())
applyDocumentLang()

createApp(App).use(createPinia()).mount('#app')
