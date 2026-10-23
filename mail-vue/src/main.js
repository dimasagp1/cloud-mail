import pinia from './store/pinia.js';
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { init } from '@/init/init.js';
import 'element-plus/theme-chalk/dark/css-vars.css';
import 'nprogress/nprogress.css';
import perm from '@/perm/perm.js';
import i18n from '@/i18n/index.js';

const app = createApp(App).use(pinia);
await init();
app.use(router).use(i18n).directive('perm', perm);
app.config.devtools = true;

app.mount('#app');
