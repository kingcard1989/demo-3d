// Demo Store 适配层
//
// 复制的测量代码只依赖 DesignStore / EditorStore 的极小一部分能力：
//   DesignStore : components[] · panels[] · saveHistory() · addMeasurement() · updateMeasurement()
//   EditorStore : setTool()
// 这里按同样的语义实现，使主项目代码可以原样运行。

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  CabinPanel,
  SatelliteComponent,
  MeasureAnnotation,
  EditorTool,
} from '@/core/measure/satelliteTypes'
import { createDemoScene } from '@/data/demoScene'

/** 标注的世界坐标点（含法线与方向），与 MeasurementObject.commitRebuild 的产出结构一致 */
export interface MeasurementWorldPoint {
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  dx?: number
  dy?: number
  dz?: number
}

export const useDesignStore = defineStore('design', () => {
  // ========== 场景数据 ==========

  const initial = createDemoScene()
  const panels = ref<CabinPanel[]>(initial.panels)
  const components = ref<SatelliteComponent[]>(initial.components)

  /** 测量标注（镜像 measurementStore，用于撤销/重做时同步） */
  const measurements = ref<MeasureAnnotation[]>([])

  // ========== 撤销栈 ==========

  /** 每次会改动标注的操作前拍一张快照 */
  const history = ref<MeasureAnnotation[][]>([])

  /** 快照当前标注状态（在改动前调用） */
  function saveHistory(): void {
    history.value.push(JSON.parse(JSON.stringify(measurements.value)))
    if (history.value.length > 50) history.value.shift()
  }

  function undo(): void {
    const snapshot = history.value.pop()
    if (!snapshot) return
    measurements.value = snapshot
  }

  const canUndo = computed(() => history.value.length > 0)

  // ========== 标注同步 ==========

  function addMeasurement(annotation: MeasureAnnotation): void {
    measurements.value.push(JSON.parse(JSON.stringify(annotation)))
  }

  /** 被测物体移动后重算世界坐标点（不拍快照，与主项目语义一致） */
  function updateMeasurement(id: string, worldPoints: MeasurementWorldPoint[]): void {
    const target = measurements.value.find(m => m.id === id)
    if (!target) return
    target._worldPoints = JSON.parse(JSON.stringify(worldPoints))
  }

  function removeMeasurement(id: string): void {
    measurements.value = measurements.value.filter(m => m.id !== id)
  }

  /** 清空全部标注（保留撤销栈，使「清空」本身可撤销） */
  function removeAllMeasurements(): void {
    measurements.value = []
  }

  return {
    panels,
    components,
    measurements,
    canUndo,
    saveHistory,
    undo,
    addMeasurement,
    updateMeasurement,
    removeMeasurement,
    removeAllMeasurements,
  }
})

export const useSatelliteEditorStore = defineStore('satelliteEditor', () => {
  /** 当前编辑器工具 */
  const tool = ref<EditorTool>('select')

  function setTool(next: EditorTool): void {
    tool.value = next
  }

  return { tool, setTool }
})
