<script setup lang="ts">
// 3D 测量演示
//
// 本页几乎不含业务实现：MeasurementObject / MeasurementEventHandler /
// MeasurementObject 的几何工具全部来自工程项目的原样代码，
// 这里只负责搭场景、接事件、提供工具栏。
//
// 三级吸附（点 → 边 → 面）的判定、Line2 粗线渲染、Sprite 标签、
// 角度弧线、面面平行判定等，都在复制过来的模块里完成。

import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import { Viewer } from '@/engine/Viewer'
import { SatelliteSceneManager } from '@/engine/SatelliteSceneManager'
import { MeasurementObject } from '@/core/measure/MeasurementObject'
import { MeasurementEventHandler } from '@/core/measure/MeasurementEventHandler'
import { useMeasurementStore } from '@/core/measure/measurementStore'
import { useDesignStore, useSatelliteEditorStore } from '@/stores/demoStores'
import type { MeasureType, MeasureAnnotation } from '@/core/measure/satelliteTypes'

// ==================== 测量类型定义 ====================

interface ToolItem {
  type: MeasureType
  label: string
  hint: string
}

const TOOL_GROUPS: Array<{ name: string; tools: ToolItem[] }> = [
  {
    name: '距离',
    tools: [
      { type: 'distance-point-to-point', label: '点 → 点', hint: '任意面 → 任意面' },
      { type: 'distance-point-to-line', label: '点 → 线', hint: '任意面 → 棱边' },
      { type: 'distance-line-to-line', label: '线 → 线', hint: '棱边 → 棱边' },
      { type: 'distance-line-to-face', label: '线 → 面', hint: '棱边 → 平面' },
      { type: 'distance-face-to-face', label: '面 → 面', hint: '平面 → 平面（需平行）' },
    ],
  },
  {
    name: '半径',
    tools: [{ type: 'radius', label: '半径 / 直径', hint: '任意面 → 任意面' }],
  },
  {
    name: '角度',
    tools: [
      { type: 'angle-three-point', label: '三点夹角', hint: '顶点 → 边 → 边' },
      { type: 'angle-line-to-line', label: '线 → 线', hint: '棱边 → 棱边' },
      { type: 'angle-line-to-face', label: '线 → 面', hint: '棱边 → 平面' },
      { type: 'angle-face-to-face', label: '面 → 面', hint: '平面 → 平面' },
    ],
  },
]

// ==================== 状态 ====================

const canvasRef = ref<HTMLElement | null>(null)

const measurementStore = useMeasurementStore()
const designStore = useDesignStore()
const editorStore = useSatelliteEditorStore()

/** 标注 id → 3D 标签文本（角度类标注的数值由 3D 对象算出，直接读回来最可靠） */
const labelTexts = ref<Map<string, string>>(new Map())

const active = computed(() => editorStore.tool === 'measure')

// ==================== 三维资源 ====================

let viewer: Viewer | null = null
let measureObject: MeasurementObject | null = null
let handler: MeasurementEventHandler | null = null
let resizeObserver: ResizeObserver | null = null

/** 模板里的可见性开关要用到，故用 shallowRef 保持响应性 */
const sceneMgr = shallowRef<SatelliteSceneManager | null>(null)

// ==================== 标注显示 ====================

/** 从已生成的 3D 标注里读回角度类标签文本（距离/半径类标签是画进贴图的，需自行计算） */
function refreshLabels(): void {
  const map = new Map<string, string>()
  const root = measureObject?.group
  if (root) {
    for (const child of root.children) {
      const id = child.userData?.measureId as string | undefined
      if (!id) continue
      child.traverse(node => {
        if (node.userData?.type === 'measurement-label' && node.userData?.labelText) {
          map.set(id, node.userData.labelText as string)
        }
      })
    }
  }
  labelTexts.value = map
}

/**
 * 标注数值文本。
 * 与 MeasurementObject.recomputeLabelText 的约定保持一致：
 * 距离/半径取首段线的两端点距离，角度直接读 3D 标签。
 */
function annotationValue(ann: MeasureAnnotation): string {
  const wp = ann._worldPoints
  if (!wp || wp.length < 2) return '—'

  if (ann.type.startsWith('distance-') || ann.type === 'radius') {
    const [a, b] = wp
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    return ann.type === 'radius' ? `R ${d.toFixed(1)} mm` : `${d.toFixed(1)} mm`
  }

  return labelTexts.value.get(ann.id) ?? '—'
}

function typeLabel(type: MeasureType): string {
  for (const group of TOOL_GROUPS) {
    const found = group.tools.find(t => t.type === type)
    if (found) return `${group.name} · ${found.label}`
  }
  return type
}

/** 标注涉及的对象名（组件/舱板） */
function annotationObjects(ann: MeasureAnnotation): string {
  const names = new Set<string>()
  for (const point of ann.points) {
    if (point.objectType === 'panel') {
      const panel = designStore.panels.find(p => p.id === point.objectId)
      if (panel) names.add(panel.name)
    } else if (point.objectType === 'component') {
      const comp = designStore.components.find(c => c.id === point.objectId)
      if (comp) names.add(comp.name)
    }
  }
  return [...names].join(' ↔ ')
}

// ==================== 工具栏动作 ====================

/**
 * 切换测量子类型。
 *
 * switchSubTool 在主项目里是私有方法（由快捷键触发），Demo 工具栏需要直接调用它 ——
 * 这里用一次显式断言进入，而不去复制它的逻辑：它除了设置子类型，还要丢弃
 * 未完成的取点状态、清掉预览与高亮，这些必须走同一份实现。
 */
function selectTool(type: MeasureType): void {
  if (!handler) return
  const switcher = handler as unknown as { switchSubTool(t: MeasureType): void }
  switcher.switchSubTool(type)
  viewer?.update()
}

function removeAnnotation(id: string): void {
  designStore.saveHistory()
  measurementStore.removeAnnotation(id)
  designStore.removeMeasurement(id)
  measureObject?.removeAnnotationById(id)
  refreshLabels()
  viewer?.update()
}

function undo(): void {
  designStore.undo()
  measurementStore.syncFromDocument(designStore.measurements)
  measureObject?.rebuildFromAnnotations(designStore.measurements)
  refreshLabels()
  viewer?.update()
}

function clearAll(): void {
  if (measurementStore.annotations.length === 0) return
  designStore.saveHistory()
  measurementStore.clearAll()
  designStore.removeAllMeasurements()
  measureObject?.clearAll()
  refreshLabels()
  viewer?.update()
}

/** 进入测量模式（Escape 退出后可再次进入） */
function enterMeasure(): void {
  if (!viewer || !handler) return
  editorStore.setTool('measure')
  viewer.setEventHandler(handler)
  viewer.setOrbitEnabled(false)
}

// Escape 退出测量 → editorStore.tool 变为 select
watch(
  () => editorStore.tool,
  tool => {
    if (tool === 'measure') return
    viewer?.setEventHandler(null)
    viewer?.setOrbitEnabled(true)
  },
)

watch(
  () => measurementStore.annotationCount,
  () => {
    // 3D 对象在 addAnnotation 之前就已创建，此处直接读取即可
    refreshLabels()
  },
)

// ==================== 生命周期 ====================

function syncResolution(): void {
  if (!canvasRef.value || !measureObject) return
  measureObject.setResolution(canvasRef.value.clientWidth, canvasRef.value.clientHeight)
}

onMounted(() => {
  const container = canvasRef.value
  if (!container) return

  viewer = new Viewer(container)
  const mgr = new SatelliteSceneManager(viewer)
  sceneMgr.value = mgr
  mgr.build()

  measureObject = new MeasurementObject()
  viewer.getScene().add(measureObject.group)

  handler = new MeasurementEventHandler(viewer, mgr, measureObject)
  enterMeasure()

  // 取景到整个舱体（所有网格挂在同一个根 Group 下）
  const root = mgr.getSelectableObjects()[0]?.parent
  const box = root ? new THREE.Box3().setFromObject(root) : new THREE.Box3()
  viewer.fitToBox(box)

  syncResolution()
  resizeObserver = new ResizeObserver(() => syncResolution())
  resizeObserver.observe(container)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  viewer?.dispose()
  viewer = null
  sceneMgr.value = null
  measureObject = null
  handler = null
})
</script>

<template>
  <div class="demo">
    <div ref="canvasRef" class="canvas-wrap">
      <div class="viewport-hint">
        <span>左键：取点</span>
        <span>右键拖拽：旋转</span>
        <span>中键拖拽：平移</span>
        <span>滚轮：缩放</span>
        <span>Esc：取消 / 退出</span>
      </div>

      <div v-if="!active" class="paused">
        <p>已退出测量模式</p>
        <button class="primary" @click="enterMeasure">重新进入测量</button>
      </div>
    </div>

    <aside class="panel">
      <section class="block">
        <h3>测量类型</h3>
        <div v-for="group in TOOL_GROUPS" :key="group.name" class="tool-group">
          <div class="group-name">{{ group.name }}</div>
          <div class="tool-list">
            <button
              v-for="tool in group.tools"
              :key="tool.type"
              :class="{ active: measurementStore.currentSubTool === tool.type }"
              :disabled="!active"
              :title="tool.hint"
              @click="selectTool(tool.type)"
            >
              {{ tool.label }}
            </button>
          </div>
        </div>
        <p class="hint">
          按提示依次拾取：<strong>{{ TOOL_GROUPS.flatMap(g => g.tools).find(t => t.type === measurementStore.currentSubTool)?.hint }}</strong>
        </p>
      </section>

      <section class="block">
        <h3>
          已生成标注
          <span class="count mono">{{ measurementStore.annotationCount }}</span>
        </h3>

        <ul v-if="measurementStore.annotations.length" class="ann-list">
          <li v-for="ann in measurementStore.annotations" :key="ann.id">
            <div class="ann-main">
              <div class="ann-value mono">{{ annotationValue(ann) }}</div>
              <div class="ann-meta">
                <span>{{ typeLabel(ann.type) }}</span>
                <span class="dim">{{ annotationObjects(ann) }}</span>
              </div>
            </div>
            <button class="icon" title="删除该标注" @click="removeAnnotation(ann.id)">✕</button>
          </li>
        </ul>
        <p v-else class="empty">左键点选几何元素开始测量</p>

        <div class="actions">
          <button :disabled="!designStore.canUndo" @click="undo">撤销</button>
          <button :disabled="!measurementStore.annotationCount" @click="clearAll">清空</button>
        </div>
      </section>

      <section class="block">
        <div class="toggles">
          <label>
            <input
              type="checkbox"
              checked
              @change="e => sceneMgr?.setPanelsVisible((e.target as HTMLInputElement).checked)"
            />
            显示舱板
          </label>
          <label>
            <input
              type="checkbox"
              checked
              @change="e => sceneMgr?.setComponentsVisible((e.target as HTMLInputElement).checked)"
            />
            显示设备
          </label>
        </div>
      </section>
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

.viewport-hint {
  position: absolute;
  left: 14px;
  bottom: 12px;
  display: flex;
  gap: 14px;
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(14, 17, 22, 0.72);
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-dim);
  pointer-events: none;
}

.paused {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(14, 17, 22, 0.55);
  font-size: 14px;
  color: var(--text-dim);
  /* 遮罩不拦截指针：退出测量后仍需能拖动旋转视角 */
  pointer-events: none;
}

.paused button {
  pointer-events: auto;
}

.paused p {
  margin: 0;
}

.panel {
  flex-shrink: 0;
  width: 320px;
  padding: 16px 16px 40px;
  overflow-y: auto;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}

.block {
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.block:last-of-type {
  border-bottom: none;
}

.block h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.count {
  padding: 0 6px;
  border-radius: 9px;
  background: var(--bg-panel-2);
  font-size: 11px;
  letter-spacing: 0;
}

.tool-group {
  margin-bottom: 10px;
}

.group-name {
  margin-bottom: 5px;
  font-size: 11.5px;
  color: var(--text-faint);
}

.tool-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.tool-list button {
  padding: 5px 10px;
  font-size: 12px;
}

.hint {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-faint);
}

.hint strong {
  color: var(--accent-2);
  font-weight: 500;
}

.ann-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ann-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.ann-list li:last-child {
  border-bottom: none;
}

.ann-main {
  flex: 1;
  min-width: 0;
}

.ann-value {
  font-size: 14px;
  color: var(--accent-2);
}

.ann-meta {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
}

.ann-meta .dim {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon {
  flex-shrink: 0;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--text-faint);
}

.icon:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}

.empty {
  margin: 0;
  padding: 12px 0;
  font-size: 12px;
  color: var(--text-faint);
}

.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 12px;
}

.toggles {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 12px;
  font-size: 12.5px;
}

.toggles label {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
</style>
