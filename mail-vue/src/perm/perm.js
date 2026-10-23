import {useUserStore} from "@/store/user.js";
import SendView from '@/views/send/index.vue';
import DraftView from '@/views/draft/index.vue';
import UserView from '@/views/user/index.vue';
import RoleView from '@/views/role/index.vue';
import SysSettingView from '@/views/sys-setting/index.vue';
import RegKeyView from '@/views/reg-key/index.vue';
import AllEmailView from '@/views/all-email/index.vue';
import AnalysisView from '@/views/analysis/index.vue';

export default {
    mounted(el, binding) {
        const userStore = useUserStore();
        const permKeys = userStore.user.permKeys;
        const value = binding.value;

        if (permKeys.includes('*')) {
            return;
        }

        const hasPermission = Array.isArray(value)
            ? value.some(key => permKeys.includes(key))
            : permKeys.includes(value);

        if (!hasPermission) {
            el.parentNode && el.parentNode.removeChild(el);
        }
    }
}

export function hasPerm(permKey) {
    const {permKeys} = useUserStore().user;
    return permKeys.includes('*') || permKeys.includes(permKey);
}


export function permsToRouter(permKeys) {
    const routerList = []
    Object.keys(routers).forEach(perm => {
        if (permKeys.includes(perm) || permKeys.includes('*')) {
            routerList.push(...routers[perm])
        }
    })
    return routerList;
}

const routers = {
    'email:send': [
        {
            path: '/sent',
            name: 'send',
            component: SendView,
            meta: {
                title: 'sent',
                name: 'send',
                menu: true
            }
        },
        {
            path: '/drafts',
            name: 'draft',
            component: DraftView,
            meta: {
                title: 'drafts',
                name: 'draft',
                menu: true
            }
        }
    ],
    'user:query': [{
        path: '/all-users',
        name: 'user',
        component: UserView,
        meta: {
            title: 'allUsers',
            name: 'user',
            menu: true
        }
    }],
    'role:query': [{
        path: '/role',
        name: 'role',
        component: RoleView,
        meta: {
            title: 'permissions',
            name: 'role',
            menu: true
        }
    }],
    'setting:query': [{
        path: '/system-setting',
        name: 'sys-setting',
        component: SysSettingView,
        meta: {
            title: 'SystemSettings',
            name: 'sys-setting',
            menu: true
        }
    }],
    'reg-key:query': [{
        path: '/invite-code',
        name: 'reg-key',
        component: RegKeyView,
        meta: {
            title: 'inviteCode',
            name: 'reg-key',
            menu: true
        }
    }],
    'all-email:query': [{
        path: '/all-mail',
        name: 'all-email',
        component: AllEmailView,
        meta: {
            title: 'allMail',
            name: 'all-email',
            menu: true
        }
    }],
    'analysis:query': [{
        path: '/analysis',
        name: 'analysis',
        component: AnalysisView,
        meta: {
            title: 'analytics',
            name: 'analysis',
            menu: true
        }
    }]
}