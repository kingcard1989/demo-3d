/**
 * 通用八叉树空间索引（3D AABB）
 *
 * 参照 QuadTree.ts 的设计，从 2D 扩展到 3D：
 * - 每个节点最多容纳 `capacity` 个元素，超出后分裂为 8 个子节点
 * - 通过 `maxDepth` 限制递归深度
 * - 元素跨子节点边界时保留在父节点
 * - 泛型 T 支持任意附加数据类型
 *
 * @template T - 存储数据的类型
 */

import type { BBox3D, OctreeItem } from './types'

/** AABB 相交检测 */
export function bbox3DIntersect(a: BBox3D, b: BBox3D): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y ||
    a.z + a.depth < b.z ||
    b.z + b.depth < a.z
  )
}

/** 判断 parent 包围盒是否完全包含 child */
function bbox3DContains(parent: BBox3D, child: BBox3D): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.z >= parent.z &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height &&
    child.z + child.depth <= parent.z + parent.depth
  )
}

/** 八叉树内部节点 */
interface OctreeNode<T> {
  bounds: BBox3D
  items: OctreeItem<T>[]
  children: OctreeNode<T>[] | null
}

export class Octree<T = unknown> {
  private root: OctreeNode<T>
  private readonly capacity: number
  private readonly maxDepth: number

  /**
   * @param bounds   索引覆盖的空间范围
   * @param capacity 节点分裂阈值，默认 8
   * @param maxDepth 最大深度，默认 6
   */
  constructor(bounds: BBox3D, capacity = 8, maxDepth = 6) {
    this.root = { bounds, items: [], children: null }
    this.capacity = capacity
    this.maxDepth = maxDepth
  }

  /** 向八叉树中插入一个元素 */
  insert(item: OctreeItem<T>): boolean {
    return this.insertInto(this.root, item, 0)
  }

  private insertInto(node: OctreeNode<T>, item: OctreeItem<T>, depth: number): boolean {
    if (!bbox3DContains(node.bounds, item.bbox)) return false

    if (node.children === null) {
      node.items.push(item)
      if (node.items.length > this.capacity && depth < this.maxDepth) {
        this.subdivide(node)
      }
      return true
    }

    for (const child of node.children) {
      if (bbox3DContains(child.bounds, item.bbox)) {
        return this.insertInto(child, item, depth + 1)
      }
    }

    node.items.push(item)
    return true
  }

  /** 将区间分裂为八个卦限子节点 */
  private subdivide(node: OctreeNode<T>): void {
    const { x, y, z, width, height, depth } = node.bounds
    const hw = width / 2
    const hh = height / 2
    const hd = depth / 2

    // 八个子节点（按 xyz 排列）
    node.children = [
      { bounds: { x, y, z, width: hw, height: hh, depth: hd }, items: [], children: null },                         // 0: ---
      { bounds: { x: x + hw, y, z, width: hw, height: hh, depth: hd }, items: [], children: null },                // 1: +--
      { bounds: { x, y: y + hh, z, width: hw, height: hh, depth: hd }, items: [], children: null },                // 2: -+-
      { bounds: { x: x + hw, y: y + hh, z, width: hw, height: hh, depth: hd }, items: [], children: null },       // 3: ++-
      { bounds: { x, y, z: z + hd, width: hw, height: hh, depth: hd }, items: [], children: null },                // 4: --+
      { bounds: { x: x + hw, y, z: z + hd, width: hw, height: hh, depth: hd }, items: [], children: null },       // 5: +-+
      { bounds: { x, y: y + hh, z: z + hd, width: hw, height: hh, depth: hd }, items: [], children: null },       // 6: -++
      { bounds: { x: x + hw, y: y + hh, z: z + hd, width: hw, height: hh, depth: hd }, items: [], children: null }, // 7: +++
    ]

    const currentItems = node.items
    node.items = []
    for (const item of currentItems) {
      this.insertInto(node, item, 0)
    }
  }

  /**
   * 查询与给定包围盒相交的所有元素
   * @param bbox 查询区域
   * @returns 匹配的元素数组
   */
  query(bbox: BBox3D): OctreeItem<T>[] {
    const results: OctreeItem<T>[] = []
    this.queryNode(this.root, bbox, results)
    return results
  }

  private queryNode(node: OctreeNode<T>, bbox: BBox3D, results: OctreeItem<T>[]): void {
    if (!bbox3DIntersect(node.bounds, bbox)) return

    for (const item of node.items) {
      if (bbox3DIntersect(item.bbox, bbox)) {
        results.push(item)
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this.queryNode(child, bbox, results)
      }
    }
  }

  /** 清空所有数据，保留根节点范围不变 */
  clear(): void {
    this.root = { bounds: this.root.bounds, items: [], children: null }
  }

  // ==================== 以下为 Demo 新增（仅用于可视化，不属于原算法实现） ====================

  /**
   * 只读遍历：按前序返回所有节点的包围盒、深度与直属元素数。
   * 原实现不暴露内部节点，Demo 需要把树结构画出来，故补一个只读访问器。
   */
  collectNodes(): Array<{ bounds: BBox3D; depth: number; itemCount: number }> {
    const out: Array<{ bounds: BBox3D; depth: number; itemCount: number }> = []
    const walk = (node: OctreeNode<T>, depth: number): void => {
      out.push({ bounds: node.bounds, depth, itemCount: node.items.length })
      if (node.children) {
        for (const child of node.children) walk(child, depth + 1)
      }
    }
    walk(this.root, 0)
    return out
  }

  /** 获取树中元素总数（遍历统计） */
  get size(): number {
    return this.countNode(this.root)
  }

  private countNode(node: OctreeNode<T>): number {
    let count = node.items.length
    if (node.children) {
      for (const child of node.children) {
        count += this.countNode(child)
      }
    }
    return count
  }
}
