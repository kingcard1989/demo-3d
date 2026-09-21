// 测量事件处理器
// 处理 7 种测量模式的完整交互流程：
//   点→点 / 点→线 / 线→线 / 线→面 / 面→面 / 半径 / 角度
//   状态机 → 目标过滤 → 射线检测 → 预览更新 → 自动确认 → Store 写入
//
// 继承 BaseEventHandler，复用 Raycaster / screenToNDC

import * as THREE from 'three'
import { ElMessage } from '@/utils/message'
import { BaseEventHandler, type IEventHandler } from './IEventHandler'
import { Viewer } from '@/engine/Viewer'
import { SatelliteSceneManager } from '@/engine/SatelliteSceneManager'
import { MeasurementObject } from './MeasurementObject'
import { useMeasurementStore } from './measurementStore'
import { useSatelliteEditorStore } from '@/stores/demoStores'
import { useDesignStore } from '@/stores/demoStores'
import type { MeasureType, MeasurePoint, MeasureAnnotation, SnapTarget } from './satelliteTypes'
import {
  getBoxEdgesWorld,
  getBoxVerticesWorld,
  matchFaceIndex,
  getFaceNormalWorld,
  getFaceCenterWorld,
  closestPointRayToSegment,
  closestPointRayToPoint,
  closestPointsBetweenLines,
  distancePointToPlane,
  screenPxToWorldDistance,
  intersectLinePlane,
} from './geometryUtils'

// ===================== 状态机 =====================

/** 测量交互状态 */
interface MeasureState {
  /** 当前步骤 (0 = idle, 1/2/3 = 已放置的点数) */
  step: number
  /** 已放置的测量点（世界坐标 + 法线 + 关联物体信息） */
  points: PlacedPoint[]
}

/** 已放置的测量点 */
interface PlacedPoint {
  worldPos: THREE.Vector3
  normal: THREE.Vector3
  objectType: 'component' | 'panel' | 'wire'
  objectId: string
  localPos: THREE.Vector3
  /** 吸附目标类型 */
  snapTarget: SnapTarget
  /** 边索引（snapTarget='edge' 时有效） */
  edgeIndex?: number
  /** 面索引（snapTarget='face' 时有效） */
  faceIndex?: number
  /** 面法线局部坐标（snapTarget='face' 时有效） */
  faceNormal?: { x: number; y: number; z: number }
  /** 命中的物体根 Group 的 worldMatrix（用于 undo 重建边/面） */
  worldMatrix?: THREE.Matrix4
  /** 边方向或面法线（世界空间单位向量，角度测量用） */
  direction?: THREE.Vector3
}

// ===================== 阈值常量 =====================

/** 距离/半径最小有效值 (mm) */
const MIN_DISTANCE_MM = 0.5
/** 角度最小有效值 (度，0-90° 范围） */
const MIN_ANGLE_DEG = 0.5
/** 边检测屏幕空间阈值 (px) */
const EDGE_HIT_THRESHOLD_PX = 14
/** 顶点检测屏幕空间阈值 (px)，比边略宽松，角点更好点选 */
const VERTEX_HIT_THRESHOLD_PX = 18
/** 面∥面判定阈值：法线夹角 < 1°（cos(1°) ≈ 0.9998） */
const FACE_PARALLEL_EPS = 0.9998
/** 线∥面判定阈值：线方向与面法线夹角 < 1° 视为垂直（sin(1°) ≈ 0.01745） */
const LINE_FACE_PARALLEL_EPS = 0.01745

// ===================== 子模式最大步数 =====================

const MAX_STEPS: Record<MeasureType, number> = {
  'distance-point-to-point': 2,
  'distance-point-to-line': 2,
  'distance-line-to-line': 2,
  'distance-line-to-face': 2,
  'distance-face-to-face': 2,
  radius: 2,
  'angle-three-point': 3,
  'angle-line-to-line': 2,
  'angle-line-to-face': 2,
  'angle-face-to-face': 2,
}

// ===================== 目标类型映射 =====================

/** 每一步需要的目标类型 */
type RequiredTarget = 'any-surface' | 'edge-only' | 'face-only'

const STEP_TARGETS: Record<MeasureType, RequiredTarget[]> = {
  'distance-point-to-point': ['any-surface', 'any-surface'],
  'distance-point-to-line': ['any-surface', 'edge-only'],
  'distance-line-to-line': ['edge-only', 'edge-only'],
  'distance-line-to-face': ['edge-only', 'face-only'],
  'distance-face-to-face': ['face-only', 'face-only'],
  radius: ['any-surface', 'any-surface'],
  'angle-three-point': ['any-surface', 'any-surface', 'any-surface'],
  'angle-line-to-line': ['edge-only', 'edge-only'],
  'angle-line-to-face': ['edge-only', 'face-only'],
  'angle-face-to-face': ['face-only', 'face-only'],
}

// ===================== 处理器 =====================

export class MeasurementEventHandler extends BaseEventHandler implements IEventHandler {
  private satelliteSceneMgr: SatelliteSceneManager
  private measureObject: MeasurementObject
  private measurementStore: ReturnType<typeof useMeasurementStore>
  private editorStore: ReturnType<typeof useSatelliteEditorStore>

  /** 当前测量状态 */
  private state: MeasureState = { step: 0, points: [] }

  /** 当前鼠标下的世界坐标交点（无命中时为 null） */
  private currentMouseWorld: THREE.Vector3 | null = null

  /** 当前鼠标下的交点法线 */
  private currentMouseNormal: THREE.Vector3 | null = null

  /** 当前命中的物体信息 */
  private currentHitInfo: {
    type: 'component' | 'panel' | 'wire'
    id: string
    worldPos: THREE.Vector3
    snapTarget: SnapTarget
    edgeIndex?: number
    faceIndex?: number
    faceNormal?: { x: number; y: number; z: number }
    worldMatrix?: THREE.Matrix4
    /** 边方向（edge）或面法线（face），世界空间单位向量 */
    direction?: THREE.Vector3
  } | null = null

  /** 当前高亮的边/面对象（悬停黄色预览） */
  private currentHighlight: THREE.Object3D | null = null

  /** 已确认点的持久白色高亮（点击后保持，测量完成/取消时清除） */
  private confirmedHighlights: THREE.Object3D[] = []

  constructor(viewer: Viewer, satelliteSceneMgr: SatelliteSceneManager, measureObject: MeasurementObject) {
    super(viewer)
    this.satelliteSceneMgr = satelliteSceneMgr
    this.measureObject = measureObject
    this.measurementStore = useMeasurementStore()
    this.editorStore = useSatelliteEditorStore()
  }

  getName(): string {
    return 'MeasurementEventHandler'
  }

  getDescription(): string {
    return '3D 测量工具：点→点 / 点→线 / 线→线 / 线→面 / 面→面 / 半径 / 角度'
  }

  // ==================== 初始化 / 清理 ====================

  init(): void {
    if (import.meta.env.DEV) console.log(`[${this.getName()}] 进入测量模式`)
    this.resetState()
    this.measurementStore.activate()
    this.measureObject.updateSceneScale(this.satelliteSceneMgr.getSelectableObjects())
    this.viewer.setForceRender(true)
  }

  dispose(): void {
    if (import.meta.env.DEV) console.log(`[${this.getName()}] 退出测量模式`)
    this.clearCurrentHighlight()
    this.clearConfirmedHighlights()
    this.measureObject.clearPreview()
    this.measurementStore.deactivate()
    this.viewer.setForceRender(false)
  }

  // ==================== 指针按下 ====================

  pointerDown(_viewer: Viewer, event: PointerEvent): void {
    if (event.button !== 0) return

    const measureType = this.measurementStore.currentSubTool
    const maxSteps = MAX_STEPS[measureType]
    const requiredTarget = this.getRequiredTarget()

    // 根据当前步骤的目标类型，选择对应的检测方法
    let hit: {
      point: THREE.Vector3
      normal: THREE.Vector3
      objectType: 'component' | 'panel' | 'wire'
      objectId: string
      localPos: THREE.Vector3
      snapTarget: SnapTarget
      edgeIndex?: number
      faceIndex?: number
      faceNormal?: { x: number; y: number; z: number }
      worldMatrix?: THREE.Matrix4
      direction?: THREE.Vector3
    } | null = null

    switch (requiredTarget) {
      case 'edge-only':
        hit = this.raycastToEdge(event)
        break
      case 'face-only':
        hit = this.raycastToFace(event)
        break
      case 'any-surface':
      default:
        hit = this.raycastToScene(event)
        break
    }

    if (!hit) return

    // 存储交点信息
    const placedPoint: PlacedPoint = {
      worldPos: hit.point.clone(),
      normal: hit.normal.clone(),
      objectType: hit.objectType,
      objectId: hit.objectId,
      localPos: hit.localPos.clone(),
      snapTarget: hit.snapTarget,
      edgeIndex: hit.edgeIndex,
      faceIndex: hit.faceIndex,
      faceNormal: hit.faceNormal,
      worldMatrix: hit.worldMatrix,
      direction: hit.direction?.clone(),
    }

    this.state.step++
    this.state.points.push(placedPoint)

    // 边/面目标：创建白色持久高亮（确认选中反馈）
    this.clearCurrentHighlight()
    if (hit.snapTarget === 'edge' && hit.edgeIndex !== undefined && hit.worldMatrix) {
      const dims = this.getObjectDimensions(hit.objectType, hit.objectId)
      if (dims) {
        const hl = this.measureObject.createEdgeHighlight(dims, hit.worldMatrix, hit.edgeIndex, 0xffffff)
        this.confirmedHighlights.push(hl)
      }
    } else if (hit.snapTarget === 'face' && hit.faceIndex !== undefined && hit.worldMatrix) {
      const dims = this.getObjectDimensions(hit.objectType, hit.objectId)
      if (dims) {
        const hl = this.measureObject.createFaceHighlight(dims, hit.worldMatrix, hit.faceIndex, 0xffffff, true)
        this.confirmedHighlights.push(hl)
      }
    }

    if (this.state.step >= maxSteps) {
      // 无意义测量：用户可以操作，但不渲染标注，并给出轻提示
      const invalidReason = this.getInvalidReason()
      if (!invalidReason) {
        this.confirmMeasurement()
      } else {
        console.warn(`[Measurement] ${invalidReason}，已忽略`)
        ElMessage.warning({ message: invalidReason, duration: 2500 })
        // 弹回最后一步：保留已放置的点，用户可继续操作
        this.state.points.pop()
        this.state.step--
      }
    }

    this.updatePreviewFromState()
    this.viewer.update()
  }

  // ==================== 指针移动 ====================

  pointerMove(_viewer: Viewer, event: PointerEvent): void {
    // 无论是否已放置第一个点，都执行悬停检测：
    // 第一步（step 0）时也需要边/面高亮反馈，让用户知道当前会选中什么
    const requiredTarget = this.getRequiredTarget()
    let hit: {
      point: THREE.Vector3
      normal: THREE.Vector3
      objectType: 'component' | 'panel' | 'wire'
      objectId: string
      localPos: THREE.Vector3
      snapTarget: SnapTarget
      edgeIndex?: number
      faceIndex?: number
      faceNormal?: { x: number; y: number; z: number }
      worldMatrix?: THREE.Matrix4
      direction?: THREE.Vector3
    } | null = null

    switch (requiredTarget) {
      case 'edge-only':
        hit = this.raycastToEdge(event)
        break
      case 'face-only':
        hit = this.raycastToFace(event)
        break
      case 'any-surface':
      default:
        hit = this.raycastToScene(event)
        break
    }

    if (hit) {
      const offset = hit.normal.clone().multiplyScalar(this.measureObject.zFightingOffset)
      this.currentMouseWorld = hit.point.clone().add(offset)
      this.currentMouseNormal = hit.normal.clone()
      this.currentHitInfo = {
        type: hit.objectType,
        id: hit.objectId,
        worldPos: hit.point.clone(),
        snapTarget: hit.snapTarget,
        edgeIndex: hit.edgeIndex,
        faceIndex: hit.faceIndex,
        faceNormal: hit.faceNormal,
        worldMatrix: hit.worldMatrix,
        direction: 'direction' in hit && hit.direction ? hit.direction.clone() : undefined,
      }
      // 更新高亮
      this.updateHighlight(hit)
    } else {
      this.currentMouseWorld = null
      this.currentMouseNormal = null
      this.currentHitInfo = null
      this.clearCurrentHighlight()
    }

    this.updatePreviewFromState()
  }

  pointerOut(_viewer: Viewer, _event: PointerEvent): void {
    this.currentMouseWorld = null
    this.currentMouseNormal = null
    this.currentHitInfo = null
    this.clearCurrentHighlight()
    this.updatePreviewFromState()
  }

  // ==================== 键盘事件 ====================

  keyDown(_viewer: Viewer, event: KeyboardEvent): void {
    // Shift+1~7 → 切换子模式（丢弃未完成测量）
    if (event.shiftKey) {
      const subToolMap: Record<string, MeasureType> = {
        '1': 'distance-point-to-point',
        '2': 'distance-point-to-line',
        '3': 'distance-line-to-line',
        '4': 'distance-line-to-face',
        '5': 'distance-face-to-face',
        '6': 'radius',
        '7': 'angle-three-point',
        '8': 'angle-line-to-line',
        '9': 'angle-line-to-face',
        '0': 'angle-face-to-face',
      }
      const type = subToolMap[event.key]
      if (type) {
        event.preventDefault()
        this.switchSubTool(type)
        return
      }
    }

    // Escape → 取消当前测量 / 退出测量模式
    if (event.key === 'Escape') {
      event.preventDefault()
      if (this.state.step > 0) {
        this.resetState()
        this.measureObject.clearPreview()
        this.viewer.update()
      } else {
        this.exitMeasureMode()
      }
    }
  }

  // ==================== 目标类型判定 ====================

  /** 获取当前子模式 + 当前步骤所需的目标类型 */
  private getRequiredTarget(): RequiredTarget {
    const type = this.measurementStore.currentSubTool
    const targets = STEP_TARGETS[type]
    if (!targets) return 'any-surface'
    // step 已推进到下一步（0-index），取下一步需要的目标
    return targets[this.state.step] || 'any-surface'
  }

  // ==================== 射线检测：物体表面点 ====================

  private raycastToScene(event: PointerEvent): {
    point: THREE.Vector3
    normal: THREE.Vector3
    objectType: 'component' | 'panel' | 'wire'
    objectId: string
    localPos: THREE.Vector3
    snapTarget: SnapTarget
    edgeIndex?: number   // 边索引
    worldMatrix?: THREE.Matrix4  // 物体世界矩阵
    direction?: THREE.Vector3  // 射线方向
  } | null {
    const ndc = this.screenToNDC(event)
    this.raycaster.setFromCamera(ndc, this.viewer.getCamera())

    const componentMeshes = this.satelliteSceneMgr.getComponentMeshes().filter(m => m.parent?.visible !== false)
    const panelMeshes = this.satelliteSceneMgr.getPanelMeshes().filter(m => m.parent?.visible !== false)
    const allTargets = [...componentMeshes, ...panelMeshes]

    const intersections = this.raycaster.intersectObjects(allTargets, false)
    if (intersections.length === 0) return null

    const hit = intersections[0]
    const point = hit.point.clone()
    const normal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0)

    if (hit.object) {
      normal.transformDirection(hit.object.matrixWorld)
    }
    normal.normalize()

    const identified = this.satelliteSceneMgr.identifyObject(hit.object)
    if (!identified) return null

    // 使用被命中 mesh 的 worldMatrix（非 group），
    // 因为 PanelObject 的 mesh 在 group 内有 dim/2 偏移
    const worldMatrix = hit.object.matrixWorld
    const invMatrix = new THREE.Matrix4().copy(worldMatrix).invert()
    const localPos = point.clone().applyMatrix4(invMatrix)

    // ★ 顶点/边吸附（仅 component/panel，wire 无 box 尺寸）
    if (identified.type !== 'wire') {
      const dims = this.getObjectDimensions(identified.type, identified.id)
      if (dims) {
        const camera = this.viewer.getCamera() as THREE.PerspectiveCamera
        const rayOrigin = this.raycaster.ray.origin.clone()
        const rayDir = this.raycaster.ray.direction.clone().normalize()

        // 1) 顶点吸附
        const vertexThreshold = screenPxToWorldDistance(VERTEX_HIT_THRESHOLD_PX, point, camera)
        const vertices = getBoxVerticesWorld(dims, worldMatrix)  // 8个顶点
        let bestV: THREE.Vector3 | null = null
        let bestVDist = Infinity
        for (const v of vertices) {
          const { distance } = closestPointRayToPoint(rayOrigin, rayDir, v)
          if (distance < bestVDist) {
            bestVDist = distance
            bestV = v
          }
        }
        if (bestV && bestVDist < vertexThreshold) {
          const vLocal = bestV.clone().applyMatrix4(invMatrix)
          return {
            point: bestV,
            normal,
            objectType: identified.type,
            objectId: identified.id,
            localPos: vLocal,
            snapTarget: 'point',
          }
        }

        // 2) 边点吸附
        const edgeThreshold = screenPxToWorldDistance(EDGE_HIT_THRESHOLD_PX, point, camera)
        const edges = getBoxEdgesWorld(dims, worldMatrix)
        let bestEDist = Infinity
        let bestPointOnEdge = new THREE.Vector3()
        for (const edge of edges) {
          const { distance, pointOnSegment } = closestPointRayToSegment(rayOrigin, rayDir, edge.start, edge.end)
          if (distance < bestEDist) {
            bestEDist = distance
            bestPointOnEdge = pointOnSegment.clone()
          }
        }
        if (bestEDist < edgeThreshold) {
          const eLocal = bestPointOnEdge.clone().applyMatrix4(invMatrix)
          return {
            point: bestPointOnEdge,
            normal,
            objectType: identified.type,
            objectId: identified.id,
            localPos: eLocal,
            snapTarget: 'point',
          }
        }
      }
    }

    // 3) 表面点兜底
    return {
      point,
      normal,
      objectType: identified.type,
      objectId: identified.id,
      localPos,
      snapTarget: 'point',
    }
  }

  // ==================== 射线检测：边 ====================

  private raycastToEdge(event: PointerEvent): {
    point: THREE.Vector3
    normal: THREE.Vector3
    objectType: 'component' | 'panel' | 'wire'
    objectId: string
    localPos: THREE.Vector3
    snapTarget: SnapTarget
    edgeIndex: number
    worldMatrix: THREE.Matrix4
    direction: THREE.Vector3
  } | null {
    const ndc = this.screenToNDC(event)
    this.raycaster.setFromCamera(ndc, this.viewer.getCamera())

    const componentMeshes = this.satelliteSceneMgr.getComponentMeshes().filter(m => m.parent?.visible !== false)
    const panelMeshes = this.satelliteSceneMgr.getPanelMeshes().filter(m => m.parent?.visible !== false)
    const allTargets = [...componentMeshes, ...panelMeshes]

    const intersections = this.raycaster.intersectObjects(allTargets, false)
    if (intersections.length === 0) return null

    const hit = intersections[0]
    const hitPoint = hit.point.clone()

    const identified = this.satelliteSceneMgr.identifyObject(hit.object)
    if (!identified) return null

    // 使用被命中 mesh 的 worldMatrix（非 group），
    // 因为 PanelObject 的 mesh 在 group 内有 dim/2 偏移
    const worldMatrix = hit.object.matrixWorld

    // 从 DesignStore 获取物体尺寸
    const designStore = useDesignStore()
    let dimensions: THREE.Vector3 | null = null
    if (identified.type === 'panel') {
      const panel = designStore.panels.find(p => p.id === identified.id)
      if (panel) dimensions = new THREE.Vector3(panel.dimensions.x, panel.dimensions.y, panel.dimensions.z)
    } else if (identified.type === 'component') {
      const comp = designStore.components.find(c => c.id === identified.id)
      if (comp) dimensions = new THREE.Vector3(comp.dimensions.x, comp.dimensions.y, comp.dimensions.z)
    }
    if (!dimensions) return null

    // 获取该物体的所有世界空间边
    const edges = getBoxEdgesWorld(dimensions, worldMatrix)

    // 将屏幕阈值转为世界距离
    const camera = this.viewer.getCamera()
    const threshold = screenPxToWorldDistance(EDGE_HIT_THRESHOLD_PX, hitPoint, camera as THREE.PerspectiveCamera)

    // 找距离射线最近的边
    const rayOrigin = this.raycaster.ray.origin.clone()
    const rayDir = this.raycaster.ray.direction.clone().normalize()

    let bestEdge = null
    let bestDist = Infinity
    let bestPointOnEdge = new THREE.Vector3()

    for (const edge of edges) {
      const { distance, pointOnSegment } = closestPointRayToSegment(
        rayOrigin, rayDir, edge.start, edge.end,
      )
      if (distance < threshold && distance < bestDist) {
        bestDist = distance
        bestEdge = edge
        bestPointOnEdge = pointOnSegment.clone()
      }
    }

    if (!bestEdge) return null

    // 计算局部坐标
    const invMatrix = new THREE.Matrix4().copy(worldMatrix).invert()
    const localPos = bestPointOnEdge.clone().applyMatrix4(invMatrix)

    // 法线：使用物体表面的法线（从 hit 获取）
    const normal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0)
    normal.transformDirection(hit.object.matrixWorld).normalize()

    return {
      point: bestPointOnEdge,
      normal,
      objectType: identified.type,
      objectId: identified.id,
      localPos,
      snapTarget: 'edge',
      edgeIndex: bestEdge.index,
      worldMatrix: worldMatrix.clone(),
      direction: bestEdge.direction.clone(),
    }
  }

  // ==================== 射线检测：面 ====================

  private raycastToFace(event: PointerEvent): {
    point: THREE.Vector3
    normal: THREE.Vector3
    objectType: 'component' | 'panel' | 'wire'
    objectId: string
    localPos: THREE.Vector3
    snapTarget: SnapTarget
    faceIndex: number
    faceNormal: { x: number; y: number; z: number }
    worldMatrix: THREE.Matrix4
    direction: THREE.Vector3
  } | null {
    const ndc = this.screenToNDC(event)
    this.raycaster.setFromCamera(ndc, this.viewer.getCamera())

    const componentMeshes = this.satelliteSceneMgr.getComponentMeshes().filter(m => m.parent?.visible !== false)
    const panelMeshes = this.satelliteSceneMgr.getPanelMeshes().filter(m => m.parent?.visible !== false)
    const allTargets = [...componentMeshes, ...panelMeshes]

    const intersections = this.raycaster.intersectObjects(allTargets, false)
    if (intersections.length === 0) return null

    const hit = intersections[0]
    const point = hit.point.clone()
    // face normal 由 Three.js 提供
    const worldNormal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 1, 0)
    if (hit.object) {
      worldNormal.transformDirection(hit.object.matrixWorld)
    }
    worldNormal.normalize()

    const identified = this.satelliteSceneMgr.identifyObject(hit.object)
    if (!identified) return null

    // 使用被命中 mesh 的 worldMatrix（非 group），
    // 因为 PanelObject 的 mesh 在 group 内有 dim/2 偏移
    const worldMatrix = hit.object.matrixWorld

    // 匹配面索引
    const faceIndex = matchFaceIndex(worldNormal, worldMatrix)

    // 局部面法线
    const localFaceNormal = new THREE.Vector3()
    const invMatrix = new THREE.Matrix4().copy(worldMatrix).invert()
    localFaceNormal.copy(worldNormal).transformDirection(invMatrix).normalize()

    // 局部坐标
    const localPos = point.clone().applyMatrix4(invMatrix)

    return {
      point,
      normal: worldNormal,
      objectType: identified.type,
      objectId: identified.id,
      localPos,
      snapTarget: 'face',
      faceIndex,
      faceNormal: { x: localFaceNormal.x, y: localFaceNormal.y, z: localFaceNormal.z },
      worldMatrix: worldMatrix.clone(),
      direction: worldNormal.clone(),
    }
  }

  // ==================== 高亮管理 ====================

  /** 更新鼠标悬停高亮 */
  private updateHighlight(hit: {
    objectType: string
    objectId: string
    snapTarget: SnapTarget
    edgeIndex?: number
    faceIndex?: number
    worldMatrix?: THREE.Matrix4
  }): void {
    this.clearCurrentHighlight()

    const designStore = useDesignStore()
    let dimensions: THREE.Vector3 | null = null
    if (hit.objectType === 'panel') {
      const panel = designStore.panels.find(p => p.id === hit.objectId)
      if (panel) dimensions = new THREE.Vector3(panel.dimensions.x, panel.dimensions.y, panel.dimensions.z)
    } else if (hit.objectType === 'component') {
      const comp = designStore.components.find(c => c.id === hit.objectId)
      if (comp) dimensions = new THREE.Vector3(comp.dimensions.x, comp.dimensions.y, comp.dimensions.z)
    }

    if (!dimensions || !hit.worldMatrix) return

    if (hit.snapTarget === 'edge' && hit.edgeIndex !== undefined) {
      this.currentHighlight = this.measureObject.createEdgeHighlight(
        dimensions, hit.worldMatrix, hit.edgeIndex,
      )
    } else if (hit.snapTarget === 'face' && hit.faceIndex !== undefined) {
      this.currentHighlight = this.measureObject.createFaceHighlight(
        dimensions, hit.worldMatrix, hit.faceIndex,
      )
    }
  }

  /** 清除当前悬停高亮 */
  private clearCurrentHighlight(): void {
    if (this.currentHighlight) {
      this.measureObject.removeHighlight(this.currentHighlight)
      this.currentHighlight = null
    }
  }

  /** 从 DesignStore 获取物体尺寸（用于创建高亮） */
  private getObjectDimensions(objectType: string, objectId: string): THREE.Vector3 | null {
    const designStore = useDesignStore()
    if (objectType === 'panel') {
      const panel = designStore.panels.find(p => p.id === objectId)
      return panel ? new THREE.Vector3(panel.dimensions.x, panel.dimensions.y, panel.dimensions.z) : null
    }
    if (objectType === 'component') {
      const comp = designStore.components.find(c => c.id === objectId)
      return comp ? new THREE.Vector3(comp.dimensions.x, comp.dimensions.y, comp.dimensions.z) : null
    }
    return null
  }

  /** 清除所有已确认点的持久白色高亮 */
  private clearConfirmedHighlights(): void {
    for (const hl of this.confirmedHighlights) {
      this.measureObject.removeHighlight(hl)
    }
    this.confirmedHighlights = []
  }

  // ==================== 预览更新 ====================

  /** 根据当前状态刷新预览 */
  private updatePreviewFromState(): void {
    const placed = this.state.points.map(p => ({
      worldPos: p.worldPos,
      normal: p.normal,
      snapTarget: p.snapTarget,
      direction: p.direction,
    }))

    // 预览阶段同步过滤无意义组合：无效时不传鼠标位置（不渲染预览线/标签，仅保留放置点标记）
    let mousePoint = this.currentMouseWorld
    let mouseDirection = this.currentHitInfo?.direction ?? null
    if (mousePoint && !this.isPreviewCombinationValid(placed, mousePoint, mouseDirection)) {
      mousePoint = null
      mouseDirection = null
    }

    // ★ 仅选点目标（any-surface）传递鼠标吸附类型，用于渲染悬停吸附标记；
    //   边/面目标（edge-only/face-only）已有整边/整面高亮，不额外显示鼠标标记。
    const mouseSnapTarget = this.getRequiredTarget() === 'any-surface' && this.currentHitInfo
      ? this.currentHitInfo.snapTarget
      : null

    this.measureObject.updatePreview(
      this.measurementStore.currentSubTool,
      placed,
      mousePoint,
      mouseDirection,
      mouseSnapTarget,
    )
  }

  /**
   * 预览阶段组合有效性检查（与确认阶段 getInvalidReason 规则一致）
   * MeasurementObject 内部已处理线线相交/异面/线面平行/面面平行，
   * 这里补充需要面矩形信息的线→面角度"真实穿过"检查
   */
  private isPreviewCombinationValid(
    placed: Array<{ worldPos: THREE.Vector3; normal: THREE.Vector3; snapTarget: SnapTarget; direction?: THREE.Vector3 }>,
    mousePoint: THREE.Vector3,
    mouseDirection: THREE.Vector3 | null,
  ): boolean {
    const type = this.measurementStore.currentSubTool
    if (type === 'angle-line-to-face' && placed.length === 1 && mouseDirection && this.currentHitInfo) {
      const edgeDir = placed[0].direction
      if (!edgeDir) return true
      const intersection = intersectLinePlane(placed[0].worldPos, edgeDir, mousePoint, mouseDirection)
      if (!intersection) return false // 线与面平行（无夹角）
      // 交点必须落在面矩形内（真正穿过面板）
      return this.isPointOnFaceRect(intersection, {
        objectType: this.currentHitInfo.type,
        objectId: this.currentHitInfo.id,
        faceIndex: this.currentHitInfo.faceIndex,
        worldMatrix: this.currentHitInfo.worldMatrix,
      })
    }
    return true
  }

  // ==================== 验证（无意义组合集中检查） ====================

  /**
   * 获取当前测量无效的原因（null = 有效，可确认）
   * 无意义测量：用户可以操作，但不渲染标注
   */
  private getInvalidReason(): string | null {
    const type = this.measurementStore.currentSubTool
    const pts = this.state.points

    // 所有距离类型和半径：先检查 2 点间距离
    if (type.startsWith('distance-') || type === 'radius') {
      if (pts.length < 2) return null
      const dist = pts[0].worldPos.distanceTo(pts[1].worldPos)
      if (dist < MIN_DISTANCE_MM) {
        return type === 'radius' ? '半径过小，无法标注' : '距离过小，无法标注'
      }
      return this.getDistanceSpecificReason(type, pts)
    }

    // 角度类型（统一 0-90° 锐角）
    if (type.startsWith('angle-')) {
      return this.getAngleInvalidReason(type, pts)
    }

    return null
  }

  /** 距离类型各自的几何有效性检查（线线相交/线面不平行/面面相交等） */
  private getDistanceSpecificReason(type: MeasureType, pts: PlacedPoint[]): string | null {
    switch (type) {
      case 'distance-line-to-line': {
        // 两线相交（公垂距离 < 阈值）→ 无距离
        const d1 = pts[0].direction
        const d2 = pts[1].direction
        if (!d1 || !d2) return null
        const closest = closestPointsBetweenLines(pts[0].worldPos, d1, pts[1].worldPos, d2)
        if (closest && closest.pointOnLine1.distanceTo(closest.pointOnLine2) < MIN_DISTANCE_MM) {
          return '两线相交，无距离可标注'
        }
        return null
      }
      case 'distance-line-to-face': {
        // 线不平行于面 → 距离无意义
        const edgeDir = pts[0].direction
        const faceNormal = pts[1].direction ?? pts[1].normal
        if (!edgeDir || !faceNormal) return null
        const dot = Math.abs(edgeDir.dot(faceNormal))
        if (dot > LINE_FACE_PARALLEL_EPS) {
          return '线与面不平行，无距离可标注'
        }
        return null
      }
      case 'distance-face-to-face': {
        // 两面相交（不平行）→ 无距离
        const n1 = pts[0].direction
        const n2 = pts[1].direction
        if (!n1 || !n2) return null
        const dotN = Math.abs(n1.dot(n2))
        if (dotN <= FACE_PARALLEL_EPS) {
          return '两面相交，无距离可标注'
        }
        return null
      }
      default:
        return null
    }
  }

  /** 角度类型的几何有效性检查 */
  private getAngleInvalidReason(type: MeasureType, pts: PlacedPoint[]): string | null {
    switch (type) {
      // 三点角度：V → VA dir, V → VB dir
      case 'angle-three-point': {
        if (pts.length < 3) return null
        const v = pts[0].worldPos
        const a = pts[1].worldPos
        const b = pts[2].worldPos
        const dirA = new THREE.Vector3().copy(a).sub(v).normalize()
        const dirB = new THREE.Vector3().copy(b).sub(v).normalize()
        const angleDeg = this.computeAcuteAngle(dirA, dirB)
        return angleDeg >= MIN_ANGLE_DEG ? null : '三点共线，无夹角可标注'
      }

      // 线→线：两条边必须真实相交（平行或异面都无夹角）
      case 'angle-line-to-line': {
        if (pts.length < 2) return null
        const d1 = pts[0].direction
        const d2 = pts[1].direction
        if (!d1 || !d2) return null
        const angleDeg = this.computeAcuteAngle(d1, d2)
        if (angleDeg < MIN_ANGLE_DEG) return '两线平行，无夹角可标注'
        // 异面直线（公垂距离 ≥ 阈值）没有真实交点 → 无夹角
        const closest = closestPointsBetweenLines(pts[0].worldPos, d1, pts[1].worldPos, d2)
        if (closest && closest.pointOnLine1.distanceTo(closest.pointOnLine2) >= MIN_DISTANCE_MM) {
          return '两线异面不相交，无夹角可标注'
        }
        return null
      }

      // 线→面：线必须真正穿过面（交点落在面矩形内）
      case 'angle-line-to-face': {
        if (pts.length < 2) return null
        const edgeDir = pts[0].direction
        const faceNormal = pts[1].direction
        if (!edgeDir || !faceNormal) return null
        // 线与面法线的锐角 → 转为线与面平面的夹角
        const angleToNormal = Math.acos(Math.max(-1, Math.min(1, Math.abs(edgeDir.dot(faceNormal)))))
        const angleDeg = 90 - (angleToNormal * 180) / Math.PI
        if (angleDeg < MIN_ANGLE_DEG) return '线与面平行，无夹角可标注'
        // 交点必须落在面矩形内（真正穿过面板）
        const intersection = intersectLinePlane(pts[0].worldPos, edgeDir, pts[1].worldPos, faceNormal)
        if (!intersection) return '线与面平行，无夹角可标注'
        if (!this.isPointOnFaceRect(intersection, pts[1])) {
          return '线未穿过面，无夹角可标注'
        }
        return null
      }

      // 面→面：两个面法线（平行/共面无二面角）
      case 'angle-face-to-face': {
        if (pts.length < 2) return null
        const n1 = pts[0].direction
        const n2 = pts[1].direction
        if (!n1 || !n2) return null
        const angleDeg = this.computeAcuteAngle(n1, n2)
        return angleDeg >= MIN_ANGLE_DEG ? null : '两面平行/共面，无二面角可标注'
      }

      default:
        return null
    }
  }

  /** 计算两个方向向量的锐角（0-90°） */
  private computeAcuteAngle(dirA: THREE.Vector3, dirB: THREE.Vector3): number {
    const dot = Math.abs(dirA.dot(dirB))
    const clamped = Math.max(-1, Math.min(1, dot))
    return (Math.acos(clamped) * 180) / Math.PI
  }

  /** 判断世界坐标点是否落在指定面矩形内（用于线→面角度"真实穿过"判定） */
  private isPointOnFaceRect(
    worldPoint: THREE.Vector3,
    faceInfo: {
      objectType: 'component' | 'panel' | 'wire'
      objectId: string
      faceIndex?: number
      worldMatrix?: THREE.Matrix4
    },
  ): boolean {
    if (!faceInfo.worldMatrix || faceInfo.faceIndex === undefined) return true // 无信息时不拦截

    const invMatrix = new THREE.Matrix4().copy(faceInfo.worldMatrix).invert()
    const local = worldPoint.clone().applyMatrix4(invMatrix)

    const designStore = useDesignStore()
    let dims: THREE.Vector3 | null = null
    if (faceInfo.objectType === 'panel') {
      const p = designStore.panels.find(x => x.id === faceInfo.objectId)
      if (p) dims = new THREE.Vector3(p.dimensions.x, p.dimensions.y, p.dimensions.z)
    } else if (faceInfo.objectType === 'component') {
      const c = designStore.components.find(x => x.id === faceInfo.objectId)
      if (c) dims = new THREE.Vector3(c.dimensions.x, c.dimensions.y, c.dimensions.z)
    }
    if (!dims) return true

    const hw = dims.x / 2
    const hh = dims.y / 2
    const hd = dims.z / 2
    const eps = Math.max(hw, hh, hd) * 0.01 + MIN_DISTANCE_MM

    switch (faceInfo.faceIndex) {
      case 0: return Math.abs(local.x - hw) <= eps && Math.abs(local.y) <= hh + eps && Math.abs(local.z) <= hd + eps
      case 1: return Math.abs(local.x + hw) <= eps && Math.abs(local.y) <= hh + eps && Math.abs(local.z) <= hd + eps
      case 2: return Math.abs(local.y - hh) <= eps && Math.abs(local.x) <= hw + eps && Math.abs(local.z) <= hd + eps
      case 3: return Math.abs(local.y + hh) <= eps && Math.abs(local.x) <= hw + eps && Math.abs(local.z) <= hd + eps
      case 4: return Math.abs(local.z - hd) <= eps && Math.abs(local.x) <= hw + eps && Math.abs(local.y) <= hh + eps
      case 5: return Math.abs(local.z + hd) <= eps && Math.abs(local.x) <= hw + eps && Math.abs(local.y) <= hh + eps
      default: return true
    }
  }

  // ==================== 确认 ====================

  private confirmMeasurement(): void {
    const type = this.measurementStore.currentSubTool
    const pts = this.state.points

    // 对于点→线/线→线，需要重新计算垂足
    if (type === 'distance-point-to-line') {
      this.confirmPointToLine(type, pts)
      return
    }
    if (type === 'distance-line-to-line') {
      this.confirmLineToLine(type, pts)
      return
    }
    if (type === 'distance-line-to-face') {
      this.confirmLineToFace(type, pts)
      return
    }
    if (type === 'distance-face-to-face') {
      this.confirmFaceToFace(type, pts)
      return
    }

    // 点→点 / 半径 / 角度类型：使用标准确认
    this.confirmStandard(type, pts)
  }

  /** 标准确认（点→点 / 半径 / 角度） */
  private confirmStandard(
    type: MeasureType,
    pts: PlacedPoint[],
  ): void {
    const measurePoints: MeasurePoint[] = pts.map(p => ({
      objectType: p.objectType,
      objectId: p.objectId,
      localPosition: { x: p.localPos.x, y: p.localPos.y, z: p.localPos.z },
      snapTarget: p.snapTarget,
      edgeIndex: p.edgeIndex,
      faceIndex: p.faceIndex,
      faceNormal: p.faceNormal,
    }))

    this.commitAnnotation(type, pts, measurePoints)
  }

  /** 点→线 确认：计算点到直线的真正垂足 */
  private confirmPointToLine(
    type: MeasureType,
    pts: PlacedPoint[],
  ): void {
    const pointPt = pts[0]  // 表面点
    const edgePt = pts[1]   // 边上的点（射线检测得到的近似点）

    // ★ 重算：点到直线（无限延伸）的真正垂足
    const point = pointPt.worldPos.clone()
    const edgeOrigin = edgePt.worldPos.clone()
    const edgeDir = (edgePt.direction ?? new THREE.Vector3(1, 0, 0)).clone().normalize()
    const toPoint = point.clone().sub(edgeOrigin)
    const t = toPoint.dot(edgeDir)
    const footWorld = edgeOrigin.add(edgeDir.clone().multiplyScalar(t))

    // 更新边上点的世界坐标和局部坐标
    edgePt.worldPos.copy(footWorld)
    if (edgePt.worldMatrix) {
      const invMatrix = new THREE.Matrix4().copy(edgePt.worldMatrix).invert()
      edgePt.localPos.copy(footWorld.clone().applyMatrix4(invMatrix))
    }

    const measurePoints: MeasurePoint[] = [
      {
        objectType: pointPt.objectType,
        objectId: pointPt.objectId,
        localPosition: { x: pointPt.localPos.x, y: pointPt.localPos.y, z: pointPt.localPos.z },
        snapTarget: pointPt.snapTarget,
        edgeIndex: pointPt.edgeIndex,
      },
      {
        objectType: edgePt.objectType,
        objectId: edgePt.objectId,
        localPosition: { x: edgePt.localPos.x, y: edgePt.localPos.y, z: edgePt.localPos.z },
        snapTarget: 'edge',
        edgeIndex: edgePt.edgeIndex,
      },
    ]

    this.commitAnnotation(type, pts, measurePoints)
  }

  /** 线→线 确认：计算两条直线之间的公垂线（真正最短距离） */
  private confirmLineToLine(
    type: MeasureType,
    pts: PlacedPoint[],
  ): void {
    const d1 = (pts[0].direction ?? new THREE.Vector3(1, 0, 0)).clone().normalize()
    const d2 = (pts[1].direction ?? new THREE.Vector3(0, 1, 0)).clone().normalize()

    // ★ 重算：两条无限直线的公垂线交点对
    const closest = closestPointsBetweenLines(pts[0].worldPos, d1, pts[1].worldPos, d2)
    if (closest) {
      // 更新两条边上点的世界坐标
      pts[0].worldPos.copy(closest.pointOnLine1)
      pts[1].worldPos.copy(closest.pointOnLine2)
      // 同步局部坐标
      for (const p of pts) {
        if (p.worldMatrix) {
          const invMatrix = new THREE.Matrix4().copy(p.worldMatrix).invert()
          p.localPos.copy(p.worldPos.clone().applyMatrix4(invMatrix))
        }
      }
    }

    const measurePoints: MeasurePoint[] = pts.map(p => ({
      objectType: p.objectType,
      objectId: p.objectId,
      localPosition: { x: p.localPos.x, y: p.localPos.y, z: p.localPos.z },
      snapTarget: 'edge' as SnapTarget,
      edgeIndex: p.edgeIndex,
    }))

    this.commitAnnotation(type, pts, measurePoints)
  }

  /** 线→面 确认：计算边到面的垂直距离（边上点沿面法线投影到面平面） */
  private confirmLineToFace(
    type: MeasureType,
    pts: PlacedPoint[],
  ): void {
    const edgePt = pts[0]
    const facePt = pts[1]

    // ★ 重算：将边上点沿面法线方向投影到面平面上
    const faceNormal = (facePt.direction ?? facePt.normal).clone().normalize()
    const { footPoint } = distancePointToPlane(edgePt.worldPos, facePt.worldPos, faceNormal)

    // 更新面上点的世界坐标和局部坐标
    facePt.worldPos.copy(footPoint)
    if (facePt.worldMatrix) {
      const invMatrix = new THREE.Matrix4().copy(facePt.worldMatrix).invert()
      facePt.localPos.copy(footPoint.clone().applyMatrix4(invMatrix))
    }

    const measurePoints: MeasurePoint[] = [
      {
        objectType: edgePt.objectType,
        objectId: edgePt.objectId,
        localPosition: { x: edgePt.localPos.x, y: edgePt.localPos.y, z: edgePt.localPos.z },
        snapTarget: 'edge',
        edgeIndex: edgePt.edgeIndex,
      },
      {
        objectType: facePt.objectType,
        objectId: facePt.objectId,
        localPosition: { x: facePt.localPos.x, y: facePt.localPos.y, z: facePt.localPos.z },
        snapTarget: 'face',
        faceIndex: facePt.faceIndex,
        faceNormal: facePt.faceNormal,
      },
    ]

    this.commitAnnotation(type, pts, measurePoints)
  }

  /** 面→面 确认 */
  private confirmFaceToFace(
    type: MeasureType,
    pts: PlacedPoint[],
  ): void {
    // 规则：面距仅对平行/共面有意义
    // 相交（不平行）的面已在 getInvalidReason 中拦截，不会走到这里
    const face1Pt = pts[0]
    const face2Pt = pts[1]

    // 重新计算：使用面中心
    const designStore = useDesignStore()
    const getDimensions = (objectType: string, objectId: string): THREE.Vector3 | null => {
      if (objectType === 'panel') {
        const p = designStore.panels.find(x => x.id === objectId)
        return p ? new THREE.Vector3(p.dimensions.x, p.dimensions.y, p.dimensions.z) : null
      }
      if (objectType === 'component') {
        const c = designStore.components.find(x => x.id === objectId)
        return c ? new THREE.Vector3(c.dimensions.x, c.dimensions.y, c.dimensions.z) : null
      }
      return null
    }

    const dims1 = getDimensions(face1Pt.objectType, face1Pt.objectId)
    const dims2 = getDimensions(face2Pt.objectType, face2Pt.objectId)

    const wm1 = face1Pt.worldMatrix!
    const wm2 = face2Pt.worldMatrix!

    // 计算面中心
    const center1 = getFaceCenterWorld(face1Pt.faceIndex!, dims1!, wm1)
    const center2 = getFaceCenterWorld(face2Pt.faceIndex!, dims2!, wm2)
    const normal1 = getFaceNormalWorld(face1Pt.faceIndex!, wm1)
    const normal2 = getFaceNormalWorld(face2Pt.faceIndex!, wm2)

    // 判断是否平行（法线夹角 < 1°，getInvalidReason 已保证平行）
    const dotN = Math.abs(normal1.dot(normal2))
    const isParallel = dotN > FACE_PARALLEL_EPS

    if (!isParallel) {
      // 防御性兜底：正常情况下 getInvalidReason 已拦截相交面
      console.warn('[Measurement] 两面相交（不平行），无距离可标注，已忽略')
      this.resetState()
      this.measureObject.clearPreview()
      this.viewer.update()
      return
    }

    // 平行：面1中心到面2平面的垂直距离
    const p1World = center1.clone()
    const p2World = (() => {
      const toPoint = center1.clone().sub(center2)
      const signedDist = toPoint.dot(normal2)
      return center1.clone().addScaledVector(normal2, -signedDist)
    })()

    // 更新世界坐标点用于渲染
    const updatedPts = pts.map((p, i) => ({
      ...p,
      worldPos: i === 0 ? p1World : p2World,
    }))

    const measurePoints: MeasurePoint[] = [
      {
        objectType: face1Pt.objectType,
        objectId: face1Pt.objectId,
        localPosition: { x: face1Pt.localPos.x, y: face1Pt.localPos.y, z: face1Pt.localPos.z },
        snapTarget: 'face',
        faceIndex: face1Pt.faceIndex,
        faceNormal: face1Pt.faceNormal,
      },
      {
        objectType: face2Pt.objectType,
        objectId: face2Pt.objectId,
        localPosition: { x: face2Pt.localPos.x, y: face2Pt.localPos.y, z: face2Pt.localPos.z },
        snapTarget: 'face',
        faceIndex: face2Pt.faceIndex,
        faceNormal: face2Pt.faceNormal,
      },
    ]

    this.commitAnnotation(type, updatedPts, measurePoints)
  }

  /** 提交标注到 Store + 创建 3D 对象 */
  private commitAnnotation(
    type: MeasureType,
    pts: PlacedPoint[],
    measurePoints: MeasurePoint[],
  ): void {
    const annotation: MeasureAnnotation = this.measurementStore.createAnnotation(type, measurePoints)
    annotation._worldPoints = pts.map(p => ({
      x: p.worldPos.x, y: p.worldPos.y, z: p.worldPos.z,
      nx: p.normal.x, ny: p.normal.y, nz: p.normal.z,
      ...(p.direction ? { dx: p.direction.x, dy: p.direction.y, dz: p.direction.z } : {}),
    }))

    const placed = pts.map(p => ({ worldPos: p.worldPos, normal: p.normal, direction: p.direction, snapTarget: p.snapTarget }))
    const { annotationSubGroup } = this.measureObject.createConfirmedAnnotation(type, placed)
    annotationSubGroup.userData.measureId = annotation.id

    const designStore = useDesignStore()
    designStore.saveHistory()
    this.measurementStore.addAnnotation(annotation)
    designStore.addMeasurement(annotation)

    this.resetState()
    this.clearCurrentHighlight()
    this.measureObject.clearPreview()

    if (import.meta.env.DEV) console.log(`[Measurement] 已确认 ${type} 标注: ${annotation.id}`)
  }

  // ==================== 子模式切换 ====================

  private switchSubTool(type: MeasureType): void {
    this.measurementStore.setSubTool(type)
    this.resetState()
    this.clearCurrentHighlight()
    this.measureObject.clearPreview()
    this.viewer.update()
  }

  // ==================== 退出测量模式 ====================

  private exitMeasureMode(): void {
    this.resetState()
    this.clearCurrentHighlight()
    this.measureObject.clearPreview()
    this.measurementStore.deactivate()
    this.editorStore.setTool('select')
    this.viewer.update()
  }

  // ==================== 状态重置 ====================

  private resetState(): void {
    this.state = { step: 0, points: [] }
    this.currentMouseWorld = null
    this.currentMouseNormal = null
    this.currentHitInfo = null
    this.clearCurrentHighlight()
    this.clearConfirmedHighlights()
  }
}
