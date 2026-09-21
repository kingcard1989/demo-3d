<script setup lang="ts">
import { RouterLink } from 'vue-router'

const cards = [
  {
    to: '/octree',
    title: '八叉树碰撞检测',
    tagline: '把 O(n²) 的全量两两检测剪枝成局部候选集',
    points: [
      '自实现泛型八叉树（3D AABB），节点容量与最大深度可调',
      '与暴力双重循环实时对比：检测次数、耗时、加速比',
      '树结构线框按深度着色，可直观看到空间划分过程',
      '结果一致性自动校验 —— 剪枝不改变碰撞对集合',
    ],
  },
  {
    to: '/measure',
    title: '3D 测量',
    tagline: '点 / 边 / 面三级吸附的交互式尺寸标注',
    points: [
      '10 种测量类型：点对点、点对面、面对面的距离与夹角、半径等',
      '屏幕像素阈值 → 世界距离换算，吸附手感不随缩放变化',
      'Line2 粗线 + Sprite 标签，标注在任意视角下保持可读',
      '标注绑定被测物体的局部坐标，物体移动后可重新求解',
    ],
  },
]

const stack = [
  { name: 'Vue 3.4', note: 'Composition API + <script setup>' },
  { name: 'TypeScript 5.3', note: 'strict 模式，类型检查零错误' },
  { name: 'Three.js r183', note: 'WebGL 渲染 / Raycaster 拾取' },
  { name: 'Pinia 2.1', note: '测量状态与撤销栈' },
  { name: 'Vite 5', note: '构建与静态部署' },
]
</script>

<template>
  <div class="home">
    <section class="hero">
      <h1>3D 可视化与空间索引 · 技术展示</h1>
      <p class="muted">
        以下两个演示页共用同一套自研三维内核：一个用真实算法跑性能对比，一个做完整的
        CAD 式交互测量。页面代码由工程项目中抽取，非演示而写的简化版本。
      </p>
    </section>

    <section class="cards">
      <RouterLink v-for="card in cards" :key="card.to" :to="card.to" class="card demo-card">
        <h2>{{ card.title }}</h2>
        <p class="tagline">{{ card.tagline }}</p>
        <ul>
          <li v-for="point in card.points" :key="point">{{ point }}</li>
        </ul>
        <span class="enter">进入演示 →</span>
      </RouterLink>
    </section>

    <section class="card stack-card">
      <h3>技术栈</h3>
      <div class="stack-list">
        <div v-for="item in stack" :key="item.name" class="stack-item">
          <code>{{ item.name }}</code>
          <span class="muted">{{ item.note }}</span>
        </div>
      </div>
    </section>

    <section class="card notes-card">
      <h3>实现说明</h3>
      <ul class="notes">
        <li>
          <strong>为什么两者放在一起：</strong>
          八叉树解决的是「大量实体两两求交」这类空间查询的复杂度问题；测量解决的是
          「在三维场景里精确拾取几何元素」的交互精度问题。前者是算法，后者是几何与
          交互的配合，共用一个场景与相机体系。
        </li>
        <li>
          <strong>关于数据：</strong>
          Demo 场景单位是毫米，坐标系与真实布局一致（组件包络盒以几何中心定位，
          舱板为薄板），因此测量数值即为实际尺寸，没有做任何等比缩放。
        </li>
        <li>
          <strong>关于依赖：</strong>
          全站静态托管，无后端。三维部分只依赖 Three.js，八叉树与几何工具均为零依赖
          的纯 TypeScript 实现。
        </li>
        <li>
          <strong>关于代码来源：</strong>
          测量与八叉树两部分的算法实现原样取自工程项目（约 4.6k 行），页面只提供场景与
          交互接线。搬运过程中的几处实现观察记录在仓库 README 中。
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 1080px;
  margin: 0 auto;
  padding: 40px 24px 64px;
}

.hero h1 {
  font-size: 26px;
  letter-spacing: 0.2px;
}

.hero p {
  margin: 12px 0 0;
  max-width: 760px;
  font-size: 14px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 18px;
  margin: 32px 0 20px;
}

.demo-card {
  display: block;
  color: inherit;
  text-decoration: none;
  transition: border-color 0.15s, transform 0.15s;
}

.demo-card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
  text-decoration: none;
}

.demo-card h2 {
  font-size: 17px;
}

.demo-card .tagline {
  margin: 6px 0 14px;
  color: var(--accent-2);
  font-size: 13px;
}

.demo-card ul {
  margin: 0;
  padding-left: 18px;
  color: var(--text-dim);
  font-size: 13px;
}

.demo-card li {
  margin-bottom: 5px;
}

.enter {
  display: inline-block;
  margin-top: 16px;
  color: var(--accent);
  font-size: 13px;
}

.stack-card,
.notes-card {
  margin-top: 18px;
}

.stack-card h3,
.notes-card h3 {
  font-size: 15px;
  margin-bottom: 14px;
}

.stack-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 22px;
}

.stack-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.notes {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--text-dim);
}

.notes li {
  margin-bottom: 10px;
}

.notes strong {
  color: var(--text);
}
</style>
