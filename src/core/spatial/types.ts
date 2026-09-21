/** 3D 轴对齐矩形包围盒 */
export interface BBox3D {
  x: number
  y: number
  z: number
  width: number
  height: number
  depth: number
}

/** 八叉树中存储的数据项 */
export interface OctreeItem<T = unknown> {
  /** 该项在三维空间中的包围盒 */
  bbox: BBox3D
  /** 附加的自定义数据 */
  data: T
}
