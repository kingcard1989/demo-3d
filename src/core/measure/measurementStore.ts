// 测量 Store —— 管理测量标注数据、当前子模式、激活状态
// 仅会话生命周期，不持久化

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { MeasureType, MeasureAnnotation } from './satelliteTypes'

/** 生成唯一测量 ID */
function generateMeasureId(): string {
  return `measure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const useMeasurementStore = defineStore('measurement', () => {
  // ========== State ==========

  /** 所有已确认的测量标注 */
  const annotations = ref<MeasureAnnotation[]>([])

  /** 当前测量子工具 */
  const currentSubTool = ref<MeasureType>('distance-point-to-point')

  /** 测量模式是否激活 */
  const isActive = ref(false)

  /** 当前选中的测量标注 ID（用于 Delete 键删除） */
  const selectedMeasurementId = ref<string | null>(null)

  // ========== Getters ==========

  const annotationCount = computed(() => annotations.value.length)

  // ========== Actions ==========

  /** 从快照恢复所有标注（用于 undo/redo 联动） */
  /** 从 ProjectDocument.measurements 同步到 store（由 DesignStore undo/redo 触发） */
  function syncFromDocument(measurements: MeasureAnnotation[]) {
    annotations.value = JSON.parse(JSON.stringify(measurements))
  }

  /** 进入测量模式 */
  function activate(subTool?: MeasureType) {
    isActive.value = true
    if (subTool) currentSubTool.value = subTool
  }

  /** 退出测量模式 */
  function deactivate() {
    isActive.value = false
  }

  /** 切换测量子工具（距离/半径/角度） */
  function setSubTool(type: MeasureType) {
    currentSubTool.value = type
  }

  /** 添加一条已确认的标注 */
  function addAnnotation(annotation: MeasureAnnotation) {
    annotations.value.push(annotation)
  }

  /** 删除指定标注 */
  function removeAnnotation(id: string) {
    const idx = annotations.value.findIndex(a => a.id === id)
    if (idx >= 0) annotations.value.splice(idx, 1)
    if (selectedMeasurementId.value === id) {
      selectedMeasurementId.value = null
    }
  }

  /** 选中测量标注（由 SatelliteEditorHandler 的点击驱动） */
  function selectAnnotation(id: string | null) {
    selectedMeasurementId.value = id
  }

  /** 清除测量选中 */
  function clearSelection() {
    selectedMeasurementId.value = null
  }

  /** 级联删除：当被测物体被删除时，移除所有关联标注 */
  function removeAnnotationsForObject(objectId: string) {
    annotations.value = annotations.value.filter(
      a => !a.points.some(p => p.objectId === objectId),
    )
  }

  /** 清除全部标注 */
  function clearAll() {
    annotations.value = []
  }

  /** 查询某个物体上的所有标注（用于级联删除前检查） */
  function getAnnotationsForObject(objectId: string): MeasureAnnotation[] {
    return annotations.value.filter(
      a => a.points.some(p => p.objectId === objectId),
    )
  }

  /** 创建标注的工厂方法（自动生成 id + 时间戳） */
  function createAnnotation(
    type: MeasureType,
    points: MeasureAnnotation['points'],
  ): MeasureAnnotation {
    return {
      id: generateMeasureId(),
      type,
      points,
      confirmed: true,
      createdAt: Date.now(),
    }
  }

  return {
    // State
    annotations,
    currentSubTool,
    isActive,
    selectedMeasurementId,

    // Getters
    annotationCount,

    // Actions
    syncFromDocument,
    activate,
    deactivate,
    setSubTool,
    addAnnotation,
    removeAnnotation,
    selectAnnotation,
    clearSelection,
    removeAnnotationsForObject,
    clearAll,
    getAnnotationsForObject,
    createAnnotation,
  }
})
