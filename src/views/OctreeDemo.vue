<script setup lang="ts">
// 八叉树碰撞检测演示
//
// 用真实的 Octree 实现跑「大量 AABB 两两求交」，并与暴力双重循环对比：
//   · 暴力：n(n-1)/2 次 bbox 相交测试，无剪枝
//   · 八叉树：建树一次，之后每个元素只查询自身包围盒所在的局部区域
// 关键点：八叉树只做剪枝，不改变结果集合 —— 页面会实时校验两者碰撞对完全一致。

import { ref, watch, onMounted, onBeforeUnmount, computed, shallowRef } from 'vue'
import * as THREE from 'three'
import { Viewer } from '@/engine/Viewer'
import { Octree, bbox3DIntersect } from '@/core/spatial/Octree'
import type { BBox3D, OctreeItem } from '@/core/spatial/types'

// ==================== 常量 ====================

/** 预设规模 */
const SIZES = [50, 200, 1000, 5000]

/** 盒子边长范围（mm） */
const BOX_MIN = 60
const BOX_MAX = 100

/** 目标填充率：盒子总体积 / 空间体积。固定它，才能让不同 N 的加速比可比 */
const TARGET_FILL = 0.06

/** 每轮测量重复次数，取中位数抗抖动 */
const RUNS = 3

// ==================== 状态 ====================

const canvasRef = ref<HTMLElement | null>(null)

const count = ref(1000)
const capacity = ref(8)
const maxDepth = ref(6)
const showTree = ref(true)
const showCollisions = ref(true)
const running = ref(false)

interface Timing {
  /** 窄相位之前的候选检测次数 */
  tests: number
  /** 毫秒（中位数） */
  ms: number
}

interface Result {
  n: number
  brute: Timing
  /** 建树耗时 */
  buildMs: number
  /** 查询耗时（已含建树，便于对比总成本） */
  queryMs: number
  octree: Timing
  pairs: number
  nodes: number
  maxDepthActual: number
  consistent: boolean
}

const result = shallowRef<Result | null>(null)

const speedup = computed(() => {
  const r = result.value
  if (!r || r.brute.ms === 0 || r.octree.ms === 0) return null
  return r.brute.ms / r.octree.ms
})

const reduction = computed(() => {
  const r = result.value
  if (!r || r.brute.tests === 0) return null
  return r.brute.tests / Math.max(r.octree.tests, 1)
})

// ==================== 三维资源 ====================

let viewer: Viewer | null = null
let boxMesh: THREE.InstancedMesh | null = null
let treeLines: THREE.LineSegments | null = null

let items: OctreeItem<number>[] = []
let rootBounds: BBox3D = { x: 0, y: 0, z: 0, width: 1, height: 1, depth: 1 }
let lastPairs: Array<[number, number]> = []

// ==================== 随机数（固定种子，结果可复现） ====================

/** mulberry32：小而快的确定性 PRNG，保证同一组参数每次生成同一批盒子 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ==================== 数据生成 ====================

/**
 * 生成 n 个随机 AABB。
 * 空间尺度随 n 自动放大，使填充率恒为 TARGET_FILL —— 否则 N 越大越拥挤，
 * 八叉树的剪枝效果会被密度变化掩盖，加速比失去可比性。
 */
function generateItems(n: number): { items: OctreeItem<number>[]; bounds: BBox3D } {
  const avgBox = Math.pow((BOX_MIN + BOX_MAX) / 2, 3)
  // 空间取扁立方体（高 = 0.55 × 边长），视觉上比正方体更易读
  const side = Math.cbrt((n * avgBox) / (TARGET_FILL * 0.55))
  const bounds: BBox3D = { x: 0, y: 0, z: 0, width: side, height: side * 0.55, depth: side }

  const rand = makeRandom(0x9e3779b9 ^ n)
  const list: OctreeItem<number>[] = []

  for (let i = 0; i < n; i++) {
    const w = BOX_MIN + rand() * (BOX_MAX - BOX_MIN)
    const h = BOX_MIN + rand() * (BOX_MAX - BOX_MIN)
    const d = BOX_MIN + rand() * (BOX_MAX - BOX_MIN)
    list.push({
      bbox: {
        x: rand() * (bounds.width - w),
        y: rand() * (bounds.height - h),
        z: rand() * (bounds.depth - d),
        width: w,
        height: h,
        depth: d,
      },
      data: i,
    })
  }
  return { items: list, bounds }
}

// ==================== 两种算法 ====================

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/** 暴力：全部两两检测 */
function bruteForce(list: OctreeItem<number>[]): { pairs: Set<string>; tests: number; ms: number } {
  const t0 = performance.now()
  const pairs = new Set<string>()
  const n = list.length
  let tests = 0

  for (let i = 0; i < n; i++) {
    const a = list[i].bbox
    for (let j = i + 1; j < n; j++) {
      tests++
      if (bbox3DIntersect(a, list[j].bbox)) pairs.add(pairKey(i, j))
    }
  }

  return { pairs, tests, ms: performance.now() - t0 }
}

/** 八叉树：建树 + 逐元素局部查询 */
function octreeCollide(
  list: OctreeItem<number>[],
  bounds: BBox3D,
  cap: number,
  depth: number,
): {
  pairs: Set<string>
  tests: number
  buildMs: number
  queryMs: number
  nodes: number
  maxDepthActual: number
} {
  const t0 = performance.now()
  const tree = new Octree<number>(bounds, cap, depth)
  for (const item of list) tree.insert(item)
  const buildMs = performance.now() - t0

  const t1 = performance.now()
  const pairs = new Set<string>()
  let tests = 0

  for (let i = 0; i < list.length; i++) {
    // query 内部已保证 bbox 相交，这里只需排除自反与重复
    const hits = tree.query(list[i].bbox)
    tests += hits.length
    for (const hit of hits) {
      const j = hit.data
      if (j > i) pairs.add(pairKey(i, j))
    }
  }
  const queryMs = performance.now() - t1

  const nodes = tree.collectNodes()
  let maxDepthActual = 0
  for (const node of nodes) {
    if (node.depth > maxDepthActual) maxDepthActual = node.depth
  }

  return { pairs, tests, buildMs, queryMs, nodes: nodes.length, maxDepthActual }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// ==================== 主流程 ====================

function rebuild(): void {
  if (!viewer) return
  const generated = generateItems(count.value)
  items = generated.items
  rootBounds = generated.bounds

  buildInstancedBoxes()
  if (viewer) viewer.fitToBox(new THREE.Box3(
    new THREE.Vector3(rootBounds.x, rootBounds.y, rootBounds.z),
    new THREE.Vector3(
      rootBounds.x + rootBounds.width,
      rootBounds.y + rootBounds.height,
      rootBounds.z + rootBounds.depth,
    ),
  ))
  run()
}

function run(): void {
  if (!viewer || items.length === 0) return
  running.value = true

  // 让出一次事件循环，先把「计算中」画出来，避免大 N 时界面看起来卡死
  setTimeout(() => {
    try {
      const bruteTimes: number[] = []
      let brute: { pairs: Set<string>; tests: number; ms: number } | null = null
      for (let r = 0; r < RUNS; r++) {
        brute = bruteForce(items)
        bruteTimes.push(brute.ms)
      }

      const buildTimes: number[] = []
      const queryTimes: number[] = []
      let oct: ReturnType<typeof octreeCollide> | null = null
      for (let r = 0; r < RUNS; r++) {
        oct = octreeCollide(items, rootBounds, capacity.value, maxDepth.value)
        buildTimes.push(oct.buildMs)
        queryTimes.push(oct.queryMs)
      }

      if (!brute || !oct) return

      // 一致性校验：剪枝不能改变碰撞对集合
      let consistent = brute.pairs.size === oct.pairs.size
      if (consistent) {
        for (const key of brute.pairs) {
          if (!oct.pairs.has(key)) {
            consistent = false
            break
          }
        }
      }

      const buildMs = median(buildTimes)
      const queryMs = median(queryTimes)

      result.value = {
        n: items.length,
        brute: { tests: (items.length * (items.length - 1)) / 2, ms: median(bruteTimes) },
        buildMs,
        queryMs,
        // 八叉树总成本 = 建树 + 查询（这才是公平对比：暴力无需预处理）
        octree: { tests: oct.tests, ms: buildMs + queryMs },
        pairs: brute.pairs.size,
        nodes: oct.nodes,
        maxDepthActual: oct.maxDepthActual,
        consistent,
      }

      lastPairs = [...brute.pairs].map(key => {
        const [a, b] = key.split(':')
        return [Number(a), Number(b)] as [number, number]
      })

      drawTree()
      applyColors()
    } finally {
      running.value = false
    }
  }, 16)
}

// ==================== 渲染 ====================

function buildInstancedBoxes(): void {
  if (!viewer) return
  const scene = viewer.getScene()

  if (boxMesh) {
    scene.remove(boxMesh)
    boxMesh.geometry.dispose()
    ;(boxMesh.material as THREE.Material).dispose()
    boxMesh.dispose()
    boxMesh = null
  }

  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.7 })
  const mesh = new THREE.InstancedMesh(geometry, material, items.length)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  const matrix = new THREE.Matrix4()
  for (let i = 0; i < items.length; i++) {
    const b = items[i].bbox
    matrix.compose(
      new THREE.Vector3(b.x + b.width / 2, b.y + b.height / 2, b.z + b.depth / 2),
      new THREE.Quaternion(),
      new THREE.Vector3(b.width, b.height, b.depth),
    )
    mesh.setMatrixAt(i, matrix)
  }
  mesh.instanceMatrix.needsUpdate = true

  boxMesh = mesh
  scene.add(mesh)
  applyColors()
}

/** 参与碰撞的盒子标红，其余按普通色 */
function applyColors(): void {
  if (!boxMesh) return

  const normal = new THREE.Color('#4a7fb5')
  const hit = new THREE.Color('#e5534b')

  const hitSet = new Set<number>()
  if (showCollisions.value) {
    for (const [a, b] of lastPairs) {
      hitSet.add(a)
      hitSet.add(b)
    }
  }

  for (let i = 0; i < items.length; i++) {
    boxMesh.setColorAt(i, hitSet.has(i) ? hit : normal)
  }
  if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true
  viewer?.update()
}

/** 按深度着色绘制八叉树节点线框 */
function drawTree(): void {
  if (!viewer) return
  const scene = viewer.getScene()

  if (treeLines) {
    scene.remove(treeLines)
    treeLines.geometry.dispose()
    ;(treeLines.material as THREE.Material).dispose()
    treeLines = null
  }
  if (!showTree.value) {
    viewer.update()
    return
  }

  // 重新建一棵同参数的树只为取节点（建树成本已单独统计，这里不影响结果）
  const tree = new Octree<number>(rootBounds, capacity.value, maxDepth.value)
  for (const item of items) tree.insert(item)
  const nodes = tree.collectNodes()

  const positions: number[] = []
  const colors: number[] = []

  for (const node of nodes) {
    const { x, y, z, width, height, depth } = node.bounds
    const x1 = x + width
    const y1 = y + height
    const z1 = z + depth

    // 12 条棱
    const corners: Array<[number, number, number]> = [
      [x, y, z], [x1, y, z], [x1, y1, z], [x, y1, z],
      [x, y, z1], [x1, y, z1], [x1, y1, z1], [x, y1, z1],
    ]
    const edges: Array<[number, number]> = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ]

    // 深度着色：浅青 → 洋红，越深越暖
    const t = Math.min(node.depth / 6, 1)
    const color = new THREE.Color().setHSL(0.5 - t * 0.42, 0.75, 0.35 + t * 0.25)

    for (const [a, b] of edges) {
      positions.push(...corners[a], ...corners[b])
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))

  treeLines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22 }),
  )
  scene.add(treeLines)
  viewer.update()
}

// ==================== 交互 ====================

function selectSize(n: number): void {
  if (count.value === n) return
  count.value = n
  rebuild()
}

/** 容量 / 深度变化只影响索引结构，数据不动 */
function reindex(): void {
  run()
}

function regenerate(): void {
  rebuild()
}

// ==================== 生命周期 ====================

onMounted(() => {
  if (!canvasRef.value) return
  viewer = new Viewer(canvasRef.value)
  rebuild()
})

onBeforeUnmount(() => {
  viewer?.dispose()
  viewer = null
  boxMesh = null
  treeLines = null
  items = []
})

// 开关切换
watch(showTree, () => drawTree())
watch(showCollisions, () => applyColors())
</script>

<template>
  <div class="demo">
    <div ref="canvasRef" class="canvas-wrap" />

    <aside class="panel">
      <section class="block">
        <h3>场景规模</h3>
        <div class="size-row">
          <button
            v-for="n in SIZES"
            :key="n"
            :class="{ active: count === n }"
            :disabled="running"
            @click="selectSize(n)"
          >
            {{ n.toLocaleString() }}
          </button>
        </div>
      </section>

      <section class="block">
        <h3>八叉树参数</h3>

        <label class="field">
          <span>节点容量 capacity</span>
          <span class="mono">{{ capacity }}</span>
        </label>
        <input
          v-model.number="capacity"
          type="range"
          min="2"
          max="32"
          step="1"
          :disabled="running"
          @change="reindex"
        />

        <label class="field">
          <span>深度阈值 maxDepth</span>
          <span class="mono">{{ maxDepth }}</span>
        </label>
        <input
          v-model.number="maxDepth"
          type="range"
          min="1"
          max="10"
          step="1"
          :disabled="running"
          @change="reindex"
        />

        <div class="toggles">
          <label><input v-model="showTree" type="checkbox" />显示树结构线框</label>
          <label><input v-model="showCollisions" type="checkbox" />高亮碰撞盒</label>
        </div>

        <button class="primary full" :disabled="running" @click="regenerate">
          重新生成数据
        </button>
      </section>

      <section v-if="result" class="block">
        <h3>对比结果</h3>

        <div class="verdict">
          <div class="verdict-main">
            <span class="mono big">{{ speedup ? speedup.toFixed(1) : '—' }}×</span>
            <span class="dim">整体加速比</span>
          </div>
          <div class="verdict-sub">
            <span class="mono">{{ reduction ? reduction.toFixed(0) : '—' }}×</span>
            <span class="dim">检测次数减少</span>
          </div>
        </div>

        <table class="metrics">
          <thead>
            <tr>
              <th />
              <th>暴力 O(n²)</th>
              <th>八叉树</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>检测次数</td>
              <td class="mono">{{ result.brute.tests.toLocaleString() }}</td>
              <td class="mono">{{ result.octree.tests.toLocaleString() }}</td>
            </tr>
            <tr>
              <td>耗时</td>
              <td class="mono">{{ result.brute.ms.toFixed(2) }} ms</td>
              <td class="mono">{{ result.octree.ms.toFixed(2) }} ms</td>
            </tr>
            <tr class="sub-row">
              <td>　├ 建树</td>
              <td class="dim">—</td>
              <td class="mono dim">{{ result.buildMs.toFixed(2) }} ms</td>
            </tr>
            <tr class="sub-row">
              <td>　└ 查询</td>
              <td class="dim">—</td>
              <td class="mono dim">{{ result.queryMs.toFixed(2) }} ms</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="result" class="block">
        <h3>索引与校验</h3>
        <dl class="kv">
          <dt>碰撞对</dt><dd class="mono">{{ result.pairs.toLocaleString() }}</dd>
          <dt>树节点数</dt><dd class="mono">{{ result.nodes.toLocaleString() }}</dd>
          <dt>实际最大深度</dt><dd class="mono">{{ result.maxDepthActual }}</dd>
          <dt>结果一致性</dt>
          <dd>
            <span :class="result.consistent ? 'ok' : 'bad'">
              {{ result.consistent ? '✓ 与暴力完全一致' : '✗ 存在差异' }}
            </span>
          </dd>
        </dl>
      </section>

      <p v-if="running" class="running">计算中…</p>
    </aside>
  </div>
</template>

<style scoped>
.demo {
  display: flex;
  height: 100%;
  min-height: 0;
}

.canvas-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}

.canvas-wrap :deep(canvas) {
  display: block;
}

.panel {
  flex-shrink: 0;
  width: 340px;
  padding: 16px 16px 40px;
  overflow-y: auto;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}

.block {
  padding-bottom: 18px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--border);
}

.block:last-of-type {
  border-bottom: none;
}

.block h3 {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.size-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.size-row button {
  padding: 6px 0;
}

.field {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 12px 0 4px;
  font-size: 13px;
}

input[type='range'] {
  width: 100%;
  margin: 0;
}

.toggles {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 14px 0;
  font-size: 13px;
}

.toggles label {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}

.full {
  width: 100%;
}

.verdict {
  display: flex;
  align-items: flex-end;
  gap: 20px;
  padding: 12px 14px;
  margin-bottom: 14px;
  background: var(--bg-panel-2);
  border-radius: var(--radius);
}

.verdict-main,
.verdict-sub {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.verdict-sub {
  padding-bottom: 3px;
}

.big {
  font-size: 30px;
  font-weight: 600;
  color: var(--accent-2);
}

.verdict-sub .mono {
  font-size: 16px;
  color: var(--accent);
}

.verdict span.dim {
  font-size: 11px;
}

.metrics {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.metrics th {
  padding: 4px 6px;
  color: var(--text-faint);
  font-weight: 500;
  text-align: right;
}

.metrics th:first-child {
  text-align: left;
}

.metrics td {
  padding: 5px 6px;
  text-align: right;
  border-top: 1px solid var(--border);
}

.metrics td:first-child {
  text-align: left;
  color: var(--text-dim);
}

.metrics .sub-row td {
  border-top: none;
  padding-top: 1px;
  padding-bottom: 1px;
  font-size: 11.5px;
}

.kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 12.5px;
}

.kv dt {
  color: var(--text-dim);
}

.kv dd {
  margin: 0;
  text-align: right;
}

.ok {
  color: var(--accent-2);
}

.bad {
  color: var(--danger);
}

.hint {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-faint);
}

.running {
  margin: 0;
  font-size: 12px;
  color: var(--warn);
  text-align: center;
}
</style>
