// 几何工具函数
// 提供长方体边/面计算、射线到线段最短距离等测量所需的基础几何运算

import * as THREE from 'three'

// ===================== 长方体边/顶点定义 =====================

/** 长方体的 8 个局部顶点坐标（半尺寸） */
export function getBoxVerticesLocal(dimensions: THREE.Vector3): THREE.Vector3[] {
  const hw = dimensions.x / 2
  const hh = dimensions.y / 2
  const hd = dimensions.z / 2

  return [
    new THREE.Vector3(-hw, -hh, -hd), // V0
    new THREE.Vector3( hw, -hh, -hd), // V1
    new THREE.Vector3( hw,  hh, -hd), // V2
    new THREE.Vector3(-hw,  hh, -hd), // V3
    new THREE.Vector3(-hw, -hh,  hd), // V4
    new THREE.Vector3( hw, -hh,  hd), // V5
    new THREE.Vector3( hw,  hh,  hd), // V6
    new THREE.Vector3(-hw,  hh,  hd), // V7
  ]
}

/** 12 条边的顶点对索引 */
export const BOX_EDGE_VERTEX_PAIRS: Array<[number, number]> = [
  [0, 1], // 边 0: 底前 X向
  [1, 2], // 边 1: 右前 Y向
  [2, 3], // 边 2: 顶前 X向
  [3, 0], // 边 3: 左前 Y向
  [0, 4], // 边 4: 底左 Z向
  [1, 5], // 边 5: 底右 Z向
  [2, 6], // 边 6: 顶右 Z向
  [3, 7], // 边 7: 顶左 Z向
  [4, 5], // 边 8: 底后 X向
  [5, 6], // 边 9: 右后 Y向
  [6, 7], // 边 10: 顶后 X向
  [7, 4], // 边 11: 左后 Y向
]

/** 6 个面的法线（局部坐标系），索引 0-5: +X, -X, +Y, -Y, +Z, -Z */
export const BOX_FACE_NORMALS_LOCAL: THREE.Vector3[] = [
  new THREE.Vector3( 1,  0,  0), // 0: +X
  new THREE.Vector3(-1,  0,  0), // 1: -X
  new THREE.Vector3( 0,  1,  0), // 2: +Y
  new THREE.Vector3( 0, -1,  0), // 3: -Y
  new THREE.Vector3( 0,  0,  1), // 4: +Z
  new THREE.Vector3( 0,  0, -1), // 5: -Z
]

/** 6 个面的中心点（局部坐标系，半尺寸） */
export function getBoxFaceCentersLocal(dimensions: THREE.Vector3): THREE.Vector3[] {
  const hw = dimensions.x / 2
  const hh = dimensions.y / 2
  const hd = dimensions.z / 2

  return [
    new THREE.Vector3( hw,   0,   0), // +X 面中心
    new THREE.Vector3(-hw,   0,   0), // -X 面中心
    new THREE.Vector3(  0,  hh,   0), // +Y 面中心
    new THREE.Vector3(  0, -hh,   0), // -Y 面中心
    new THREE.Vector3(  0,   0,  hd), // +Z 面中心
    new THREE.Vector3(  0,   0, -hd), // -Z 面中心
  ]
}

// ===================== 世界空间转换 =====================

/**
 * 从物体根 Group 的 worldMatrix 计算所有 12 条边的世界坐标
 *
 * @param dimensions  物体尺寸（来自 CabinPanel.dimensions 或 SatelliteComponent.dimensions）
 * @param worldMatrix 物体根 Group 的 worldMatrix
 * @returns 12 条边，每条包含 index、start、end、direction
 */
export function getBoxEdgesWorld(
  dimensions: THREE.Vector3,
  worldMatrix: THREE.Matrix4,
): Array<{ index: number; start: THREE.Vector3; end: THREE.Vector3; direction: THREE.Vector3 }> {
  const localVerts = getBoxVerticesLocal(dimensions)
  // 将局部顶点转到世界空间
  const worldVerts = localVerts.map(v => v.clone().applyMatrix4(worldMatrix))

  return BOX_EDGE_VERTEX_PAIRS.map(([a, b], index) => {
    const start = worldVerts[a]
    const end = worldVerts[b]
    const direction = new THREE.Vector3().copy(end).sub(start).normalize()
    return { index, start, end, direction }
  })
}

/**
 * 将长方体的 8 个局部顶点转换到世界空间
 *
 * @param dimensions  物体尺寸
 * @param worldMatrix 物体根 Group 的 worldMatrix
 * @returns 8 个顶点的世界坐标（顺序与 getBoxVerticesLocal 一致，索引 0-7）
 */
export function getBoxVerticesWorld(
  dimensions: THREE.Vector3,
  worldMatrix: THREE.Matrix4,
): THREE.Vector3[] {
  return getBoxVerticesLocal(dimensions).map(v => v.clone().applyMatrix4(worldMatrix))
}

/**
 * 将局部面法线转换到世界空间
 *
 * @param faceIndex  面索引 (0-5)
 * @param worldMatrix 物体根 Group 的 worldMatrix
 * @returns 世界空间的面法线（单位向量）
 */
export function getFaceNormalWorld(faceIndex: number, worldMatrix: THREE.Matrix4): THREE.Vector3 {
  const localNormal = BOX_FACE_NORMALS_LOCAL[faceIndex].clone()
  // 仅旋转，不平移 —— 提取旋转部分
  localNormal.transformDirection(worldMatrix)
  return localNormal.normalize()
}

/**
 * 从世界法线反向匹配面索引
 *
 * @param worldNormal  世界空间的面法线（来自 hit.face.normal）
 * @param worldMatrix  物体根 Group 的 worldMatrix
 * @returns 最匹配的面索引 (0-5)
 */
export function matchFaceIndex(worldNormal: THREE.Vector3, worldMatrix: THREE.Matrix4): number {
  let bestIndex = 0
  let bestDot = -Infinity

  for (let i = 0; i < 6; i++) {
    const faceNormal = getFaceNormalWorld(i, worldMatrix)
    const dot = faceNormal.dot(worldNormal)
    if (dot > bestDot) {
      bestDot = dot
      bestIndex = i
    }
  }

  return bestIndex
}

/**
 * 获取指定面在世界空间中的 4 个角点
 *
 * @param faceIndex   面索引 (0-5)
 * @param dimensions  物体尺寸
 * @param worldMatrix 物体根 Group 的 worldMatrix
 * @returns 面的 4 个角点（世界坐标，按环形顺序排列）
 */
export function getFaceCornersWorld(
  faceIndex: number,
  dimensions: THREE.Vector3,
  worldMatrix: THREE.Matrix4,
): THREE.Vector3[] {
  const localVerts = getBoxVerticesLocal(dimensions)
  const worldVerts = localVerts.map(v => v.clone().applyMatrix4(worldMatrix))

  // 每个面的顶点索引
  const faceVertexIndices: number[][] = [
    [1, 2, 6, 5], // +X 面
    [0, 4, 7, 3], // -X 面
    [3, 2, 6, 7], // +Y 面
    [0, 1, 5, 4], // -Y 面
    [4, 5, 6, 7], // +Z 面
    [0, 1, 2, 3], // -Z 面
  ]

  return faceVertexIndices[faceIndex].map(i => worldVerts[i].clone())
}

/**
 * 获取指定面在世界空间中的中心点
 */
export function getFaceCenterWorld(
  faceIndex: number,
  dimensions: THREE.Vector3,
  worldMatrix: THREE.Matrix4,
): THREE.Vector3 {
  const localCenters = getBoxFaceCentersLocal(dimensions)
  return localCenters[faceIndex].clone().applyMatrix4(worldMatrix)
}

// ===================== 射线 → 线段最短距离 =====================

/**
 * 计算 3D 射线到 3D 线段的最短距离
 *
 * 求解 clostestPointOnRay - closestPointOnSegment 的最短距离
 *
 * @param rayOrigin    射线原点
 * @param rayDirection 射线方向（单位向量）
 * @param segStart     线段起点
 * @param segEnd       线段终点
 * @returns 最近距离、线段上的最近点、射线上的参数 t
 */
export function closestPointRayToSegment(
  rayOrigin: THREE.Vector3,
  rayDirection: THREE.Vector3,
  segStart: THREE.Vector3,
  segEnd: THREE.Vector3,
): { distance: number; pointOnSegment: THREE.Vector3; tRay: number; tSeg: number } {
  const segDir = new THREE.Vector3().copy(segEnd).sub(segStart)
  const segLength = segDir.length()

  if (segLength < 0.0001) {
    // 线段退化为点
    const toPoint = new THREE.Vector3().copy(segStart).sub(rayOrigin)
    const t = toPoint.dot(rayDirection)
    const closestOnRay = rayOrigin.clone().addScaledVector(rayDirection, Math.max(0, t))
    const dist = closestOnRay.distanceTo(segStart)
    return { distance: dist, pointOnSegment: segStart.clone(), tRay: Math.max(0, t), tSeg: 0 }
  }

  segDir.normalize()

  const w0 = new THREE.Vector3().copy(rayOrigin).sub(segStart)
  const a = rayDirection.dot(rayDirection)   // = 1（单位向量）
  const b = rayDirection.dot(segDir)
  const c = segDir.dot(segDir)               // = 1（单位向量）
  const d = rayDirection.dot(w0)
  const e = segDir.dot(w0)

  // 用参数方程求解最近点
  const denom = a * c - b * b

  let tRay: number
  let tSeg: number

  if (Math.abs(denom) < 0.0001) {
    // 射线与线段方向平行
    tRay = 0
    tSeg = -e / c
  } else {
    tRay = (b * e - c * d) / denom
    tSeg = (a * e - b * d) / denom
  }

  // 钳制 tRay ≥ 0（射线不倒退）
  tRay = Math.max(0, tRay)

  // 钳制 tSeg 到 [0, segLength]
  tSeg = Math.max(0, Math.min(segLength, tSeg))

  const closestOnRay = rayOrigin.clone().addScaledVector(rayDirection, tRay)
  const pointOnSegment = segStart.clone().addScaledVector(segDir, tSeg)
  const distance = closestOnRay.distanceTo(pointOnSegment)

  return { distance, pointOnSegment, tRay, tSeg: tSeg / Math.max(segLength, 0.0001) }
}

/**
 * 计算 3D 射线到 3D 点的最短距离（用于顶点吸附）
 *
 * 点在射线后方（投影参数 t < 0）时返回 Infinity，避免吸附到相机背后的顶点
 *
 * @param rayOrigin    射线原点
 * @param rayDirection 射线方向（单位向量）
 * @param point        目标点
 * @returns 最近距离、射线上的投影参数 t
 */
export function closestPointRayToPoint(
  rayOrigin: THREE.Vector3,
  rayDirection: THREE.Vector3,
  point: THREE.Vector3,
): { distance: number; tRay: number } {
  const toPoint = new THREE.Vector3().copy(point).sub(rayOrigin)
  const tRay = toPoint.dot(rayDirection)
  if (tRay < 0) return { distance: Infinity, tRay: -1 }

  const closestOnRay = rayOrigin.clone().addScaledVector(rayDirection, tRay)
  return { distance: closestOnRay.distanceTo(point), tRay }
}

// ===================== 点到线段最近点 =====================

/**
 * 计算 3D 点到 3D 线段的最短距离和最近点
 *
 * @param point     3D 点
 * @param segStart  线段起点
 * @param segEnd    线段终点
 * @returns 最近距离、线段上的最近点、线段参数 t ∈ [0,1]
 */
export function closestPointOnSegment(
  point: THREE.Vector3,
  segStart: THREE.Vector3,
  segEnd: THREE.Vector3,
): { distance: number; pointOnSegment: THREE.Vector3; t: number } {
  const segDir = new THREE.Vector3().copy(segEnd).sub(segStart)
  const segLengthSq = segDir.lengthSq()

  if (segLengthSq < 0.0001) {
    const dist = point.distanceTo(segStart)
    return { distance: dist, pointOnSegment: segStart.clone(), t: 0 }
  }

  const t = Math.max(0, Math.min(1, new THREE.Vector3().copy(point).sub(segStart).dot(segDir) / segLengthSq))
  const pointOnSegment = segStart.clone().addScaledVector(segDir, t)
  const distance = point.distanceTo(pointOnSegment)

  return { distance, pointOnSegment, t }
}

// ===================== 点到平面距离 =====================

/**
 * 计算 3D 点到平面的垂直距离
 *
 * @param point        3D 点
 * @param planePoint   平面上任意一点
 * @param planeNormal  平面法线（单位向量）
 * @returns 有符号距离（正=法线方向），以及垂足点
 */
export function distancePointToPlane(
  point: THREE.Vector3,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3,
): { signedDistance: number; footPoint: THREE.Vector3 } {
  const toPoint = new THREE.Vector3().copy(point).sub(planePoint)
  const signedDistance = toPoint.dot(planeNormal)
  const footPoint = point.clone().addScaledVector(planeNormal, -signedDistance)
  return { signedDistance, footPoint }
}

// ===================== 两线段最短距离 =====================

/**
 * 计算两条 3D 线段之间的最短距离
 *
 * @returns 最近距离、线段1上的最近点、线段2上的最近点
 */
export function closestPointBetweenSegments(
  s1: THREE.Vector3,
  e1: THREE.Vector3,
  s2: THREE.Vector3,
  e2: THREE.Vector3,
): { distance: number; pointOnSeg1: THREE.Vector3; pointOnSeg2: THREE.Vector3 } {
  const d1 = new THREE.Vector3().copy(e1).sub(s1)
  const d2 = new THREE.Vector3().copy(e2).sub(s2)
  const r = new THREE.Vector3().copy(s1).sub(s2)

  const a = d1.dot(d1)  // 总是 ≥ 0
  const e = d2.dot(d2)  // 总是 ≥ 0
  const f = d2.dot(r)

  let t1 = 0
  let t2 = 0

  const c = d1.dot(r)
  const b = d1.dot(d2)
  const denom = a * e - b * b

  if (Math.abs(denom) > 0.0001) {
    // 非平行
    t1 = (b * f - c * e) / denom
    t2 = (a * f - b * c) / denom
  } else {
    // 平行
    t1 = 0
    t2 = f / e
  }

  // 钳制到 [0,1]
  t1 = Math.max(0, Math.min(1, t1))
  t2 = Math.max(0, Math.min(1, t2))

  // 如果钳制后还需要修正另一端
  const p1 = s1.clone().addScaledVector(d1, t1)
  const p2 = s2.clone().addScaledVector(d2, t2)

  return {
    distance: p1.distanceTo(p2),
    pointOnSeg1: p1,
    pointOnSeg2: p2,
  }
}

// ===================== 两条 3D 直线最近点 =====================

/**
 * 计算两条 3D 无限直线之间的最近点对
 * 线1: p1 + t*d1, 线2: p2 + s*d2
 */
export function closestPointsBetweenLines(
  p1: THREE.Vector3, d1: THREE.Vector3,
  p2: THREE.Vector3, d2: THREE.Vector3,
): { pointOnLine1: THREE.Vector3; pointOnLine2: THREE.Vector3; t: number; s: number } | null {
  const D1 = d1.clone().normalize()
  const D2 = d2.clone().normalize()
  const w = new THREE.Vector3().copy(p1).sub(p2)
  const a = D1.dot(D1)   // =1
  const b = D1.dot(D2)
  const c = D2.dot(D2)   // =1
  const d = D1.dot(w)
  const e = D2.dot(w)
  const denom = a * c - b * b

  if (Math.abs(denom) < 0.0001) {
    // 两线平行，取 p1 到线2 的垂足
    const t = 0
    const s = e / c
    return {
      pointOnLine1: p1.clone().add(D1.clone().multiplyScalar(t)),
      pointOnLine2: p2.clone().add(D2.clone().multiplyScalar(s)),
      t, s,
    }
  }

  const t = (b * e - c * d) / denom
  const s = (a * e - b * d) / denom
  return {
    pointOnLine1: p1.clone().add(D1.clone().multiplyScalar(t)),
    pointOnLine2: p2.clone().add(D2.clone().multiplyScalar(s)),
    t, s,
  }
}

// ===================== 线与平面交点 =====================

/**
 * 计算直线与平面的交点
 * 线: p + t*d, 面: (X - planePoint)·planeNormal = 0
 * @returns 交点，若线与面平行则返回 null
 */
export function intersectLinePlane(
  p: THREE.Vector3, d: THREE.Vector3,
  planePoint: THREE.Vector3, planeNormal: THREE.Vector3,
): THREE.Vector3 | null {
  const D = d.clone().normalize()
  const N = planeNormal.clone().normalize()
  const denom = D.dot(N)

  if (Math.abs(denom) < 0.0001) return null // 平行

  const t = new THREE.Vector3().copy(planePoint).sub(p).dot(N) / denom
  return p.clone().add(D.clone().multiplyScalar(t))
}

// ===================== 屏幕阈值 → 世界距离 =====================

/**
 * 将屏幕像素阈值转换为世界空间距离阈值
 *
 * @param screenPx    屏幕像素阈值（如 10px）
 * @param worldPoint  参考点的世界坐标（用于确定深度）
 * @param camera      Three.js 相机
 * @returns 对应深度的世界空间距离
 */
export function screenPxToWorldDistance(
  screenPx: number,
  worldPoint: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
): number {
  const distance = camera.position.distanceTo(worldPoint)
  const vFov = (camera as THREE.PerspectiveCamera).fov * (Math.PI / 180)
  const pixelHeightAtDistance = 2 * Math.tan(vFov / 2) * distance / (camera as any).viewport?.h || 1
  // fallback: use renderer size
  const viewportH = (camera as any).viewport?.h || 1080
  const pixelWorldSize = 2 * Math.tan(vFov / 2) * distance / viewportH
  return screenPx * pixelWorldSize
}
