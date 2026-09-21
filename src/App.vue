<script setup lang="ts">
import { RouterView, RouterLink, useRoute } from 'vue-router'
import { computed } from 'vue'

const route = useRoute()

const navItems = [
  { to: '/', label: '首页' },
  { to: '/octree', label: '八叉树碰撞检测' },
  { to: '/measure', label: '3D 测量' },
]

// 两个演示页都是「画布铺满 + 悬浮面板」，不需要外层滚动的留白
const isFullBleed = computed(() => route.path === '/octree' || route.path === '/measure')
</script>

<template>
  <div class="app-shell" :class="{ 'full-bleed': isFullBleed }">
    <header class="topbar">
      <div class="brand">
        <span class="dot" />
        <strong>技术展示</strong>
        <span class="dim">3D 可视化 · 空间索引</span>
      </div>

      <nav>
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          :class="{ active: route.path === item.to }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
    </header>

    <main class="content">
      <RouterView v-slot="{ Component }">
        <component :is="Component" />
      </RouterView>
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  flex-shrink: 0;
  height: 52px;
  padding: 0 20px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
  white-space: nowrap;
}

.brand .dim {
  font-size: 12px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-2);
  box-shadow: 0 0 8px var(--accent-2);
}

nav {
  display: flex;
  gap: 4px;
}

.nav-link {
  padding: 6px 14px;
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 13px;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}

.nav-link:hover {
  background: var(--bg-panel-2);
  color: var(--text);
  text-decoration: none;
}

.nav-link.active {
  background: #1c4f8a;
  color: #fff;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* 全屏演示页：内容区不再滚动，交给页面内部管理 */
.full-bleed .content {
  overflow: hidden;
}
</style>
