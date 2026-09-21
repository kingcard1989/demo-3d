import { createRouter, createWebHashHistory } from 'vue-router'

// 使用 hash 路由：GitHub Pages 是纯静态托管，无法配置服务端 rewrite，
// history 模式下直接访问 /octree 会 404；hash 模式刷新永远命中 index.html。
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
      meta: { title: '首页' },
    },
    {
      path: '/octree',
      name: 'octree',
      component: () => import('@/views/OctreeDemo.vue'),
      meta: { title: '八叉树碰撞检测' },
    },
    {
      path: '/measure',
      name: 'measure',
      component: () => import('@/views/MeasureDemo.vue'),
      meta: { title: '3D 测量' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

router.afterEach(to => {
  const title = (to.meta.title as string) || ''
  document.title = title ? `${title} · 技术展示` : '技术展示'
})

export default router
