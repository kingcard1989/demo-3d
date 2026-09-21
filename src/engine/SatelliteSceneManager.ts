// 精简场景管理器 —— 按 DesignStore 数据生成舱板与组件包络盒
//
// 主项目的 SceneManager 还要管真实网格、线缆、标签、选中态、层可见性等；
// Demo 只保留测量拾取需要的四件事：
//   getSelectableObjects() / getComponentMeshes() / getPanelMeshes() / identifyObject()
//
// ★ 关键约定：每个 mesh 的几何体是「以原点为中心的包络盒」，
//   其 position 即数据里的几何中心。这样 mesh 的局部坐标系与
//   geometryUtils.getBoxVerticesWorld(dims, matrixWorld) 的假设完全一致，
//   无需像主项目那样为 PanelObject 处理 dim/2 偏移。

import * as THREE from 'three'
import type { Viewer } from './Viewer'
import { useDesignStore } from '@/stores/demoStores'
import type { EditorTool } from '@/core/measure/satelliteTypes'

export type IdentifiedObject = {
  type: 'component' | 'panel' | 'wire'
  id: string
}

export class SatelliteSceneManager {
  private viewer: Viewer
  private panelMeshes: THREE.Mesh[] = []
  private componentMeshes: THREE.Mesh[] = []
  private root: THREE.Group

  constructor(viewer: Viewer) {
    this.viewer = viewer
    this.root = new THREE.Group()
    this.root.name = 'satellite-root'
    this.root.userData = { type: 'satellite-root' }
    this.viewer.getScene().add(this.root)
  }

  // ==================== 场景构建 ====================

  /** 依据当前 DesignStore 数据重建全部网格 */
  build(): void {
    this.clear()

    const store = useDesignStore()

    // 舱板：半透明，便于观察内部设备
    for (const panel of store.panels) {
      const mesh = this.createBoxMesh(
        panel.dimensions,
        panel.color,
        { opacity: 0.72, doubleSide: true },
      )
      mesh.name = panel.name
      mesh.position.set(panel.position.x, panel.position.y, panel.position.z)
      mesh.rotation.set(panel.rotation.x, panel.rotation.y, panel.rotation.z)
      mesh.userData = { type: 'panel', id: panel.id }
      this.root.add(mesh)
      this.panelMeshes.push(mesh)
    }

    // 组件：不透明设备盒
    for (const comp of store.components) {
      const mesh = this.createBoxMesh(comp.dimensions, comp.color, { opacity: 1 })
      mesh.name = comp.name
      mesh.position.set(comp.position.x, comp.position.y, comp.position.z)
      mesh.rotation.set(comp.rotation.x, comp.rotation.y, comp.rotation.z)
      mesh.userData = { type: 'component', id: comp.id }
      this.root.add(mesh)
      this.componentMeshes.push(mesh)
    }

    this.viewer.update()
  }

  private createBoxMesh(
    dims: { x: number; y: number; z: number },
    color: string,
    opts: { opacity: number; doubleSide?: boolean },
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(dims.x, dims.y, dims.z)
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      metalness: 0.18,
      roughness: 0.72,
      transparent: opts.opacity < 1,
      opacity: opts.opacity,
      side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    })
    const mesh = new THREE.Mesh(geometry, material)

    // 棱线：让包络盒边界清晰可见（拾取用 recursive=false，不会干扰命中）
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28 }),
    )
    edges.raycast = () => {}
    mesh.add(edges)

    return mesh
  }

  // ==================== 测量模块依赖的 API ====================

  /** 可被测量的对象集合（用于计算场景包围盒基准） */
  getSelectableObjects(): THREE.Object3D[] {
    return [...this.componentMeshes, ...this.panelMeshes]
  }

  getComponentMeshes(): THREE.Mesh[] {
    return this.componentMeshes
  }

  getPanelMeshes(): THREE.Mesh[] {
    return this.panelMeshes
  }

  /**
   * 由命中的 mesh 反查所属实体。
   * 沿父链回溯，取第一个带 { type, id } 标记的节点。
   */
  identifyObject(object: THREE.Object3D | null): IdentifiedObject | null {
    let node: THREE.Object3D | null = object
    while (node) {
      const data = node.userData as Partial<IdentifiedObject> | undefined
      if (data && (data.type === 'component' || data.type === 'panel' || data.type === 'wire') && data.id) {
        return { type: data.type, id: data.id }
      }
      node = node.parent
    }
    return null
  }

  // ==================== 工具 ====================

  /** 切换组件层可见性 */
  setComponentsVisible(visible: boolean): void {
    for (const mesh of this.componentMeshes) mesh.visible = visible
    this.viewer.update()
  }

  /** 切换舱板层可见性 */
  setPanelsVisible(visible: boolean): void {
    for (const mesh of this.panelMeshes) mesh.visible = visible
    this.viewer.update()
  }

  /** 清空全部网格并释放资源 */
  clear(): void {
    for (const mesh of [...this.panelMeshes, ...this.componentMeshes]) {
      this.root.remove(mesh)
      mesh.geometry.dispose()
      const mat = mesh.material
      if (Array.isArray(mat)) mat.forEach(m => m.dispose())
      else mat.dispose()
      mesh.children.forEach(child => {
        if (child instanceof THREE.LineSegments) {
          child.geometry.dispose()
          ;(child.material as THREE.Material).dispose()
        }
      })
    }
    this.panelMeshes = []
    this.componentMeshes = []
  }

  dispose(): void {
    this.clear()
    this.viewer.getScene().remove(this.root)
  }
}

/** 供 UI 显示：工具名 → 中文标签 */
export const TOOL_LABELS: Record<EditorTool, string> = {
  select: '选择',
  move: '移动',
  rotate: '旋转',
  scale: '缩放',
  wire: '布线',
  delete: '删除',
  measure: '测量',
  keepout: '禁布区',
}
