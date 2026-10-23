import { createPinia, setActivePinia } from 'pinia';
import piniaPersistedState from 'pinia-plugin-persistedstate';

const pinia = createPinia().use(piniaPersistedState);
setActivePinia(pinia);

export default pinia;
