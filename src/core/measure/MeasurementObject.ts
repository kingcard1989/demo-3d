// 测量标注 3D 对象工厂
// 负责构建测量线条、弧线、十字标记、标签 Sprite
// 使用 Line2 渲染可变宽度线条，Sprite + CanvasTexture 渲染描边文字标签
//
// 设计决策参考：memory/3d-measurement-feature-design.md

import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import type { MeasureType, SnapTarget } from './satelliteTypes'
import {
  getBoxEdgesWorld,
  getFaceCornersWorld,
  getFaceNormalWorld,
  getFaceCenterWorld,
  closestPointsBetweenLines,
  intersectLinePlane,
  distancePointToPlane,
} from './geometryUtils'
import { useMeasurementStore } from './measurementStore'
import { useDesignStore } from '@/stores/demoStores'

// ===================== 常量 =====================

/** 线条宽度（像素） */
const LINE_WIDTH = 2.5
/** 引线宽度（像素） */
const LEADER_LINE_WIDTH = 1.5
/** 预览态透明度 */
const PREVIEW_OPACITY = 0.6
/** 确认态透明度 */
const CONFIRMED_OPACITY = 0.95
/** 弧线采样段数 */
const ARC_SEGMENTS = 64

/** 按测量类型获取主题色：距离=绿 / 半径=蓝 / 角度=橙 */
function getTypeColor(type: MeasureType): number {
  if (type === 'radius') return 0x448aff
  if (type.startsWith('angle-')) return 0xff6d00
  return 0x00e676
}

/** 计算标签引线偏移量，避免标签与测量线重叠 */
function computeLabelOffset(midPoint: THREE.Vector3, direction: THREE.Vector3, offsetDistance: number): THREE.Vector3 {
  const absY = Math.abs(direction.y)
  if (direction.length() > 0.001 && absY / direction.length() > 0.85) {
    return new THREE.Vector3(offsetDistance, 0, 0)
  }
  return new THREE.Vector3(0, offsetDistance, 0)
}

/** 绘制圆角矩形路径（Canvas 2D 辅助） */
function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/** 屏幕分辨率（由 setResolution 更新） */
const resolution = new THREE.Vector2(1920, 1080)

// ===================== Line2 工具函数 =====================

/** 创建 LineMaterial */
function makeMaterial(opts: {
  color: number
  lineWidth: number
  dashed?: boolean
  dashScale?: number
  dashSize?: number
  gapSize?: number
  opacity?: number
  /** 关闭深度测试：线总是绘制在物体前面（悬停/确认高亮用，防止被面板遮挡） */
  depthTest?: boolean
  /** 渲染顺序：数值越大越晚绘制，用于高亮覆盖在物体表面之上 */
  renderOrder?: number
}): LineMaterial {
  const mat = new LineMaterial({
    color: opts.color,
    linewidth: opts.lineWidth,
    dashed: opts.dashed ?? false,
    dashScale: opts.dashScale ?? 1,
    dashSize: opts.dashSize ?? 1,
    gapSize: opts.gapSize ?? 1,
    transparent: (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
    resolution,
    worldUnits: false,
  })
  if (opts.depthTest !== undefined) mat.depthTest = opts.depthTest
  // 注：three.js 的 renderOrder 挂在 Object3D 上，不在 Material 上，
  //     故此处不对 mat 赋值（原实现对 Material 赋值不产生任何渲染效果）。
  //     高亮的可见性实际由上面的 depthTest:false 保证。
  return mat
}

/** 从两个端点创建 Line2 线段 */
function createLineSegment(
  from: THREE.Vector3,
  to: THREE.Vector3,
  material: LineMaterial,
  userData?: Record<string, unknown>,
): Line2 {
  const geometry = new LineGeometry()
  geometry.setPositions([from.x, from.y, from.z, to.x, to.y, to.z])
  const line = new Line2(geometry, material)
  line.computeLineDistances()
  line.frustumCulled = false
  if (userData) line.userData = userData
  return line
}

/** 从点数组创建 Line2（用于弧线等多段线） */
function createPolyline(
  points: THREE.Vector3[],
  material: LineMaterial,
  userData?: Record<string, unknown>,
): Line2 {
  const positions: number[] = []
  for (const p of points) positions.push(p.x, p.y, p.z)
  const geometry = new LineGeometry()
  geometry.setPositions(positions)
  const line = new Line2(geometry, material)
  line.computeLineDistances()
  line.frustumCulled = false
  if (userData) line.userData = userData
  return line
}

// ===================== 标签 Sprite =====================

/** 构建标签 Sprite 纹理（深色圆角底板 + 左侧色条 + 白色文字） */
function buildLabelTexture(text: string, accentColor: number, opacity: number = 1.0): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  canvas.width = 1024
  canvas.height = 256

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const accentHex = `#${accentColor.toString(16).padStart(6, '0')}`
  const pad = 14
  const radius = 22
  const barWidth = 16
  const barGap = 14

  // 深色半透明底板
  ctx.fillStyle = `rgba(18, 18, 20, ${(0.92 * opacity).toFixed(3)})`
  drawRoundRect(ctx, pad, pad, canvas.width - pad * 2, canvas.height - pad * 2, radius)
  ctx.fill()

  // 底板细边框
  ctx.strokeStyle = `rgba(255, 255, 255, ${(0.15 * opacity).toFixed(3)})`
  ctx.lineWidth = 2
  drawRoundRect(ctx, pad, pad, canvas.width - pad * 2, canvas.height - pad * 2, radius)
  ctx.stroke()

  // 左侧色条
  const barX = pad + 10
  const barY = pad + 14
  const barH = canvas.height - pad * 2 - 28
  ctx.fillStyle = accentHex
  drawRoundRect(ctx, barX, barY, barWidth, barH, 8)
  ctx.fill()

  // 白色文字（色条右侧居中）
  const textAreaLeft = barX + barWidth + barGap
  const textAreaRight = canvas.width - pad
  const textCenterX = (textAreaLeft + textAreaRight) / 2

  ctx.font = 'bold 68px "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 文字阴影增加立体感
  ctx.shadowColor = `rgba(0, 0, 0, ${(0.7 * opacity).toFixed(3)})`
  ctx.shadowBlur = 8
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, textCenterX, canvas.height / 2)
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0

  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

/** 创建标签 Sprite（带底板样式） */
function createLabelSprite(
  text: string,
  accentColor: number,
  worldSize: number,
  opacity: number = 1.0,
): THREE.Sprite {
  const texture = buildLabelTexture(text, accentColor, opacity)
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(worldSize * 4, worldSize, 1) // 宽高比 4:1
  sprite.userData = { type: 'measurement-label' }
  return sprite
}

// ===================== 十字标记 =====================

/** 创建几何十字标记（两条正交 Line2 线段） */
function createCrossMarker(
  position: THREE.Vector3,
  halfSize: number,
  color: number,
  opacity: number,
): THREE.Group {
  const group = new THREE.Group()
  group.position.copy(position)
  group.userData = { type: 'measurement-cross' }

  const material = makeMaterial({ color, lineWidth: 2, opacity })

  // X 方向臂
  const hLine = createLineSegment(
    new THREE.Vector3(-halfSize, 0, 0),
    new THREE.Vector3(halfSize, 0, 0),
    material,
  )
  // Y 方向臂
  const vLine = createLineSegment(
    new THREE.Vector3(0, -halfSize, 0),
    new THREE.Vector3(0, halfSize, 0),
    material,
  )

  group.add(hLine)
  group.add(vLine)
  return group
}

// ===================== 短横标记（边上的点） =====================

/** 创建边上的短横标记：垂直于边方向的短线段 */
function createDashMarker(
  position: THREE.Vector3,
  edgeDirection: THREE.Vector3,
  halfSize: number,
  color: number,
  opacity: number,
): THREE.Group {
  const group = new THREE.Group()
  group.position.copy(position)
  group.userData = { type: 'measurement-dash' }

  const material = makeMaterial({ color, lineWidth: 2, opacity })

  // 短横垂直于边方向，取任意与边正交的方向
  const perpDir = new THREE.Vector3()
  if (Math.abs(edgeDirection.x) < 0.9) {
    perpDir.crossVectors(edgeDirection, new THREE.Vector3(1, 0, 0)).normalize()
  } else {
    perpDir.crossVectors(edgeDirection, new THREE.Vector3(0, 1, 0)).normalize()
  }

  const a = perpDir.clone().multiplyScalar(halfSize)
  const b = perpDir.clone().multiplyScalar(-halfSize)
  const line = createLineSegment(a, b, material, { type: 'measurement-dash-line' })
  group.add(line)
  return group
}

// ===================== 方形标记（面上的点） =====================

/** 创建面上的方形标记：在面平面上画 4 条 Line2 组成正方形 */
function createSquareMarker(
  position: THREE.Vector3,
  faceNormal: THREE.Vector3,
  halfSize: number,
  color: number,
  opacity: number,
): THREE.Group {
  const group = new THREE.Group()
  group.position.copy(position)
  group.userData = { type: 'measurement-square' }

  const material = makeMaterial({ color, lineWidth: 2, opacity })

  // 在面平面上找到两个正交方向
  const uDir = new THREE.Vector3()
  if (Math.abs(faceNormal.x) < 0.9) {
    uDir.crossVectors(faceNormal, new THREE.Vector3(1, 0, 0)).normalize()
  } else {
    uDir.crossVectors(faceNormal, new THREE.Vector3(0, 1, 0)).normalize()
  }
  const vDir = new THREE.Vector3().crossVectors(faceNormal, uDir).normalize()

  const hs = halfSize
  // 4 个角点
  const corners = [
    uDir.clone().multiplyScalar(-hs).add(vDir.clone().multiplyScalar(-hs)),
    uDir.clone().multiplyScalar( hs).add(vDir.clone().multiplyScalar(-hs)),
    uDir.clone().multiplyScalar( hs).add(vDir.clone().multiplyScalar( hs)),
    uDir.clone().multiplyScalar(-hs).add(vDir.clone().multiplyScalar( hs)),
  ]

  for (let i = 0; i < 4; i++) {
    const from = corners[i]
    const to = corners[(i + 1) % 4]
    const line = createLineSegment(from, to, material)
    group.add(line)
  }

  return group
}

// ===================== 直角标记（点→线垂足） =====================

/** 创建直角标记 ∟：在垂足处画两条短线形成直角拐角 */
function createRightAngleMark(
  footPos: THREE.Vector3,
  pointDirection: THREE.Vector3, // 从垂足指向被测点的方向
  edgeDirection: THREE.Vector3,   // 边的方向
  size: number,
  color: number,
  opacity: number,
): THREE.Group {
  const group = new THREE.Group()
  group.userData = { type: 'measurement-right-angle' }

  const material = makeMaterial({ color, lineWidth: 2, opacity })

  // 线段1：从垂足沿边方向
  const p1End = footPos.clone().add(edgeDirection.clone().normalize().multiplyScalar(size))
  const line1 = createLineSegment(footPos, p1End, material)

  // 线段2：从线段1末端指向点的方向
  const p2End = p1End.clone().add(pointDirection.clone().normalize().multiplyScalar(size))
  const line2 = createLineSegment(p1End, p2End, material)

  group.add(line1)
  group.add(line2)
  return group
}

// ===================== 标签前缀 =====================

/** 获取各测量类型的标签中文前缀 */
function getLabelPrefix(type: MeasureType): string {
  switch (type) {
    case 'distance-point-to-point': return '距离 '
    case 'distance-point-to-line': return '垂距 '
    case 'distance-line-to-line': return '线距 '
    case 'distance-line-to-face': return '线面距 '
    case 'distance-face-to-face': return '面距 '
    case 'radius': return 'R '
    case 'angle-three-point': return '夹角 '
    case 'angle-line-to-line': return '线线角 '
    case 'angle-line-to-face': return '线面角 '
    case 'angle-face-to-face': return '面面角 '
    default: return ''
  }
}

/** 是否为角度类型 */
function isAngleType(type: MeasureType): boolean {
  return type.startsWith('angle-')
}

/** 获取标签后缀（单位） */
function getLabelSuffix(type: MeasureType): string {
  if (isAngleType(type)) return '°'
  return ' mm'
}

// ===================== 弧线计算 =====================

/**
 * 在 3D 空间中计算圆弧采样点
 *
 * @param center    圆心世界坐标
 * @param radius    圆弧半径
 * @param normal    弧所在平面的法线（单位向量）
 * @param fromDir   弧起始方向（从圆心出发，单位向量）
 * @param toDir     弧结束方向（从圆心出发，单位向量）
 * @param segments  采样段数
 */
function computeArcPoints(
  center: THREE.Vector3,
  radius: number,
  normal: THREE.Vector3,
  fromDir: THREE.Vector3,
  toDir: THREE.Vector3,
  segments: number = ARC_SEGMENTS,
): THREE.Vector3[] {
  const u = fromDir.clone().normalize()
  const v = new THREE.Vector3().crossVectors(normal, u).normalize()

  // 计算从 fromDir 到 toDir 的有向角（弧度）
  const dot = u.dot(toDir.clone().normalize())
  const cross = new THREE.Vector3().crossVectors(u, toDir.clone().normalize()).dot(normal)
  let totalAngle = Math.atan2(cross, dot)
  if (totalAngle < 0) totalAngle += 2 * Math.PI

  const points: THREE.Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * totalAngle
    const pt = new THREE.Vector3()
      .copy(u).multiplyScalar(Math.cos(t) * radius)
      .add(new THREE.Vector3().copy(v).multiplyScalar(Math.sin(t) * radius))
      .add(center)
    points.push(pt)
  }
  return points
}

// ===================== 场景包围盒计算 =====================

/**
 * 从场景对象数组中计算包围盒对角线长度
 * 用于确定十字标记大小和 z-fighting 偏移的基准
 */
function computeSceneBBoxDiagonal(objects: THREE.Object3D[]): number {
  const box = new THREE.Box3()
  for (const obj of objects) {
    box.expandByObject(obj)
  }
  if (box.isEmpty()) return 100 // 默认 100mm
  return box.getSize(new THREE.Vector3()).length()
}

// ===================== 主类 =====================

export class MeasurementObject {
  /** 测量标注的根 Group */
  readonly group: THREE.Group

  /** 预览标注的临时 Group */
  readonly previewGroup: THREE.Group

  /** 场景包围盒对角线（每次重建标注时刷新） */
  private sceneDiagonal = 100

  /** 所有确认标注的子 Group 映射 (id → Group) */
  private annotationGroups = new Map<string, THREE.Group>()

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'measurement-root'
    this.group.userData = { type: 'measurement-root' }

    this.highlightGroup = new THREE.Group()
    this.highlightGroup.name = 'measurement-highlight'
    this.highlightGroup.userData = { type: 'measurement-highlight' }
    this.group.add(this.highlightGroup)

    this.previewGroup = new THREE.Group()
    this.previewGroup.name = 'measurement-preview'
    this.previewGroup.visible = false
    this.group.add(this.previewGroup)
  }

  // ==================== 分辨率更新 ====================

  /** 更新 Line2 材质的分辨率（窗口大小变化时调用） */
  setResolution(width: number, height: number): void {
    resolution.set(width, height)
    // 遍历所有标注，更新其中的 Line2 材质
    this.group.traverse(child => {
      if (child instanceof Line2 && child.material instanceof LineMaterial) {
        child.material.resolution.set(width, height)
      }
    })
  }

  // ==================== 场景尺寸更新 ====================

  /** 更新场景包围盒基准（在每次创建标注前调用） */
  updateSceneScale(selectableObjects: THREE.Object3D[]): void {
    this.sceneDiagonal = computeSceneBBoxDiagonal(selectableObjects)
    if (this.sceneDiagonal < 1) this.sceneDiagonal = 100
  }

  // ==================== 公开工具方法 ====================

  /** 十字标记半臂长 = 场景对角线 × 0.05%（0.1%/2） */
  get crossHalfSize(): number {
    return this.sceneDiagonal * 0.0005
  }

  /** z-fighting 偏移量 = 场景对角线 × 0.05% */
  get zFightingOffset(): number {
    return this.sceneDiagonal * 0.0005
  }

  /** 标签世界尺寸 = 场景对角线 × 0.035 */
  get labelWorldSize(): number {
    return this.sceneDiagonal * 0.035
  }

  // ==================== 预览 ====================

  /**
   * 清除预览 Group
   */
  clearPreview(): void {
    while (this.previewGroup.children.length > 0) {
      const child = this.previewGroup.children[0]
      this.previewGroup.remove(child)
      this.disposeObject(child)
    }
    this.previewGroup.visible = false
  }

  /**
   * 更新预览（根据测量类型和已放置的点 + 当前鼠标位置）
   *
   * @param type          测量类型
   * @param placedPoints  已确认的放置点 { worldPos, normal, direction }
   * @param mousePoint    当前鼠标的世界坐标交点（可为 null）
   * @param mouseDirection 当前悬停目标的边方向/面法线（edge/face 命中时有效）
   */
  updatePreview(
    type: MeasureType,
    placedPoints: Array<{ worldPos: THREE.Vector3; normal: THREE.Vector3; snapTarget?: SnapTarget; direction?: THREE.Vector3 }>,
    mousePoint: THREE.Vector3 | null,
    mouseDirection: THREE.Vector3 | null = null,
    mouseSnapTarget: SnapTarget | null = null,
  ): void {
    this.clearPreview()

    const typeColor = getTypeColor(type)

    // 辅助函数：根据 snapTarget 创建对应标记
    const createMarker = (p: typeof placedPoints[0], isConfirmed: boolean) => {
      const pos = p.worldPos.clone().add(p.normal.clone().multiplyScalar(this.zFightingOffset))
      const color = typeColor
      const opacity = isConfirmed ? CONFIRMED_OPACITY : PREVIEW_OPACITY
      switch (p.snapTarget) {
        case 'edge':
          return createDashMarker(
            pos,
            p.direction?.clone().normalize() ?? new THREE.Vector3(1, 0, 0),
            this.crossHalfSize * 1.5,
            color, opacity,
          )
        case 'face':
          return createSquareMarker(pos, p.normal.clone().normalize(), this.crossHalfSize * 1.2, color, opacity)
        case 'point':
        default:
          // 点→点测量使用更大的十字标记，更醒目
          const half = type === 'distance-point-to-point' ? this.crossHalfSize * 2.2 : this.crossHalfSize
          return createCrossMarker(pos, half, color, opacity)
      }
    }

    if (!mousePoint) {
      this.previewGroup.visible = true
      for (const p of placedPoints) {
        this.previewGroup.add(createMarker(p, false))
      }
      return
    }

    this.previewGroup.visible = true
    const offsetMouse = mousePoint.clone()

    for (const p of placedPoints) {
      this.previewGroup.add(createMarker(p, false))
    }

    // ★ 鼠标悬停吸附标记：选点目标（点→点/点→线第一步/半径/三点角）悬停时，
    //    跟随鼠标显示吸附点十字标记（角点/边点/表面点统一为「点」），让「吸附」可见。
    //    mousePoint 已含 z-fighting 偏移，故标记直接落在 offsetMouse，不二次偏移。
    if (mouseSnapTarget) {
      const half = type === 'distance-point-to-point' ? this.crossHalfSize * 2.2 : this.crossHalfSize
      this.previewGroup.add(createCrossMarker(offsetMouse, half, typeColor, PREVIEW_OPACITY))
    }

    const previewMat = makeMaterial({
      color: typeColor,
      // 点→点测量预览线更粗，更醒目
      lineWidth: type === 'distance-point-to-point' ? LINE_WIDTH + 1.5 : LINE_WIDTH,
      dashed: true,
      dashSize: 3,
      gapSize: 2,
      opacity: PREVIEW_OPACITY,
    })

    const isDistanceType = type.startsWith('distance-')

    // 距离/半径：step 1 时显示预览线
    if ((isDistanceType || type === 'radius') && placedPoints.length === 1) {
      // 无意义组合不渲染预览线/标签（仅保留放置点标记）
      if (!this.isDistancePreviewValid(type, placedPoints[0], offsetMouse, mouseDirection)) {
        return
      }
      const from = placedPoints[0].worldPos.clone()
        .add(placedPoints[0].normal.clone().multiplyScalar(this.zFightingOffset))
      const to = offsetMouse
      const line = createLineSegment(from, to, previewMat)
      this.previewGroup.add(line)

      const dist = from.distanceTo(to)
      const prefix = getLabelPrefix(type)
      const suffix = getLabelSuffix(type)
      const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)
      const dir = new THREE.Vector3().copy(to).sub(from).normalize()
      const offset = computeLabelOffset(mid, dir, this.labelWorldSize * 2.5)
      const labelPos = mid.clone().add(offset)
      // 引线
      const leaderMat = makeMaterial({
        color: typeColor, lineWidth: LEADER_LINE_WIDTH, dashed: true,
        dashSize: 2, gapSize: 2, opacity: PREVIEW_OPACITY,
      })
      this.previewGroup.add(createLineSegment(mid, labelPos, leaderMat, { type: 'measurement-leader' }))
      const label = createLabelSprite(`${prefix}${dist.toFixed(1)}${suffix}`, typeColor, this.labelWorldSize, PREVIEW_OPACITY)
      label.position.copy(labelPos)
      this.previewGroup.add(label)
      return
    }

    // 半径和角度预览逻辑
    switch (type) {
      case 'radius': {
        if (placedPoints.length === 1) {
          const center = placedPoints[0].worldPos.clone()
            .add(placedPoints[0].normal.clone().multiplyScalar(this.zFightingOffset))
          const radius = center.distanceTo(offsetMouse)

          const line = createLineSegment(center, offsetMouse, previewMat)
          this.previewGroup.add(line)

          if (radius > 0.001) {
            const normal = placedPoints[0].normal.clone().normalize()
            const fromDir = new THREE.Vector3().copy(offsetMouse).sub(center).normalize()
            const toDir = fromDir.clone().multiplyScalar(-1)
            const arcPoints = computeArcPoints(center, radius, normal, fromDir, toDir)
            if (arcPoints.length >= 2) {
              const arcMat = makeMaterial({
                color: typeColor, lineWidth: LINE_WIDTH, dashed: true,
                dashSize: 3, gapSize: 2, opacity: PREVIEW_OPACITY,
              })
              this.previewGroup.add(createPolyline(arcPoints, arcMat))
            }
          }

          const mid = new THREE.Vector3().addVectors(center, offsetMouse).multiplyScalar(0.5)
          const dir = new THREE.Vector3().copy(offsetMouse).sub(center).normalize()
          const offset = computeLabelOffset(mid, dir, this.labelWorldSize * 2.5)
          const labelPos = mid.clone().add(offset)
          const leaderMat = makeMaterial({
            color: typeColor, lineWidth: LEADER_LINE_WIDTH, dashed: true,
            dashSize: 2, gapSize: 2, opacity: PREVIEW_OPACITY,
          })
          this.previewGroup.add(createLineSegment(mid, labelPos, leaderMat, { type: 'measurement-leader' }))
          const label = createLabelSprite(`R ${radius.toFixed(1)} mm`, typeColor, this.labelWorldSize, PREVIEW_OPACITY)
          label.position.copy(labelPos)
          this.previewGroup.add(label)
        }
        break
      }

      case 'angle-three-point': {
        if (placedPoints.length >= 1) {
          const vertex = placedPoints[0].worldPos.clone()
            .add(placedPoints[0].normal.clone().multiplyScalar(this.zFightingOffset))

          if (placedPoints.length === 1) {
            const line = createLineSegment(vertex, offsetMouse, previewMat)
            this.previewGroup.add(line)
          } else if (placedPoints.length === 2) {
            const pointA = placedPoints[1].worldPos.clone()
              .add(placedPoints[1].normal.clone().multiplyScalar(this.zFightingOffset))
            this.previewGroup.add(createLineSegment(vertex, pointA, previewMat))
            this.previewGroup.add(createLineSegment(vertex, offsetMouse, previewMat))

            const dirA = new THREE.Vector3().copy(pointA).sub(vertex).normalize()
            const dirB = new THREE.Vector3().copy(offsetMouse).sub(vertex).normalize()
            const distA = vertex.distanceTo(pointA)
            const distB = vertex.distanceTo(offsetMouse)
            const arcRadius = Math.min(distA, distB) * 0.2

            if (arcRadius > 0.001) {
              const planeNormal = new THREE.Vector3().crossVectors(dirA, dirB).normalize()
              if (planeNormal.length() > 0.001) {
                const arcPoints = computeArcPoints(vertex, arcRadius, planeNormal, dirA, dirB)
                if (arcPoints.length >= 2) {
                  const arcMat = makeMaterial({
                    color: typeColor, lineWidth: LINE_WIDTH, dashed: true,
                    dashSize: 3, gapSize: 2, opacity: PREVIEW_OPACITY,
                  })
                  this.previewGroup.add(createPolyline(arcPoints, arcMat))
                }

                const dot = dirA.dot(dirB)
                const clamped = Math.max(-1, Math.min(1, dot))
                const angleDeg = (Math.acos(clamped) * 180) / Math.PI

                const midArc = arcPoints[Math.floor(arcPoints.length / 2)]
                const toMid = new THREE.Vector3().copy(midArc).sub(vertex).normalize()
                const labelPos = midArc.clone().add(toMid.multiplyScalar(this.labelWorldSize * 2))
                const label = createLabelSprite(`${getLabelPrefix(type)}${angleDeg.toFixed(1)}°`, typeColor, this.labelWorldSize, PREVIEW_OPACITY)
                label.position.copy(labelPos)
                this.previewGroup.add(label)
              }
            }
          }
        }
        break
      }

      // ===== 角度：线→线 预览 =====
      case 'angle-line-to-line': {
        if (placedPoints.length === 1 && mousePoint) {
          const p1 = placedPoints[0]
          const from = p1.worldPos.clone()
            .add(p1.normal.clone().multiplyScalar(this.zFightingOffset))
          const d1 = p1.direction?.clone().normalize()
          if (!d1) break

          if (mouseDirection) {
            // 悬停在第二根线上：计算公垂线，实时显示线线角
            const d2 = mouseDirection.clone().normalize()
            const closest = closestPointsBetweenLines(from, d1, offsetMouse, d2)
            if (closest) {
              // 两线异面（不真实相交，公垂距离 ≥ 0.5mm）→ 无夹角，不渲染预览
              if (closest.pointOnLine1.distanceTo(closest.pointOnLine2) >= 0.5) break
              const anchor = new THREE.Vector3()
                .addVectors(closest.pointOnLine1, closest.pointOnLine2)
                .multiplyScalar(0.5)

              // 参考虚线：放置点 → 公垂线端点
              const refMat = makeMaterial({
                color: typeColor, lineWidth: 1.2, dashed: true,
                dashSize: 2, gapSize: 2, opacity: 0.45,
              })
              this.previewGroup.add(createLineSegment(from, closest.pointOnLine1, refMat, { type: 'ref-line' }))
              this.previewGroup.add(createLineSegment(offsetMouse, closest.pointOnLine2, refMat, { type: 'ref-line' }))

              const arcMat = makeMaterial({
                color: typeColor, lineWidth: LINE_WIDTH, dashed: true,
                dashSize: 3, gapSize: 2, opacity: PREVIEW_OPACITY,
              })
              this.addAngleArcToGroup(this.previewGroup, anchor, d1, d2, arcMat, false, typeColor, type, PREVIEW_OPACITY)
            }
          } else {
            // 未命中第二根线：画一条引导虚线
            this.previewGroup.add(createLineSegment(from, offsetMouse, previewMat))
          }
        }
        break
      }

      // ===== 角度：线→面 预览 =====
      case 'angle-line-to-face': {
        if (placedPoints.length === 1 && mousePoint) {
          const p1 = placedPoints[0]
          const from = p1.worldPos.clone()
            .add(p1.normal.clone().multiplyScalar(this.zFightingOffset))
          const edgeDir = p1.direction?.clone().normalize()
          if (!edgeDir) break

          if (mouseDirection) {
            // 悬停在面上：计算线与面平面的交点，实时显示线面角
            const faceN = mouseDirection.clone().normalize()
            const intersection = intersectLinePlane(from, edgeDir, offsetMouse, faceN)
            const anchor = intersection ?? from.clone()

            const refMat = makeMaterial({
              color: typeColor, lineWidth: 1.2, dashed: true,
              dashSize: 2, gapSize: 2, opacity: 0.45,
            })
            this.previewGroup.add(createLineSegment(from, anchor, refMat, { type: 'ref-line' }))
            this.previewGroup.add(createLineSegment(offsetMouse, anchor, refMat, { type: 'ref-line' }))

            const arcMat = makeMaterial({
              color: typeColor, lineWidth: LINE_WIDTH, dashed: true,
              dashSize: 3, gapSize: 2, opacity: PREVIEW_OPACITY,
            })
            this.addAngleArcToGroup(this.previewGroup, anchor, edgeDir, faceN, arcMat, true, typeColor, type, PREVIEW_OPACITY)
          } else {
            // 未命中面：画一条引导虚线
            this.previewGroup.add(createLineSegment(from, offsetMouse, previewMat))
          }
        }
        break
      }

      // ===== 角度：面→面（二面角）预览 =====
      case 'angle-face-to-face': {
        if (placedPoints.length === 1 && mousePoint && mouseDirection) {
          const p1 = placedPoints[0]
          const n1 = (p1.direction ?? p1.normal).clone().normalize()
          const n2 = mouseDirection.clone().normalize()
          const pos1 = p1.worldPos.clone()
            .add(p1.normal.clone().multiplyScalar(this.zFightingOffset))
          const pos2 = offsetMouse

          const arcMat = makeMaterial({
            color: typeColor, lineWidth: LINE_WIDTH, dashed: true,
            dashSize: 3, gapSize: 2, opacity: PREVIEW_OPACITY,
          })
          // 两面平行时函数内部不绘制（平行面无二面角）
          this.addDihedralAngle(this.previewGroup, pos1, n1, pos2, n2, arcMat, typeColor, PREVIEW_OPACITY)
        }
        break
      }
    }
  }

  /**
   * 距离预览有效性检查：无意义组合（线面不平行 / 两线相交）不渲染预览线
   * 与确认阶段的 getInvalidReason 规则保持一致
   */
  private isDistancePreviewValid(
    type: MeasureType,
    placed: { worldPos: THREE.Vector3; normal: THREE.Vector3; snapTarget?: SnapTarget; direction?: THREE.Vector3 },
    mousePoint: THREE.Vector3,
    mouseDirection: THREE.Vector3 | null,
  ): boolean {
    if (!mouseDirection || !placed.direction) return true

    switch (type) {
      case 'distance-line-to-face': {
        // 线不平行于面 → 距离无意义（sin(1°) ≈ 0.01745）
        const dot = Math.abs(placed.direction.dot(mouseDirection))
        return dot <= 0.01745
      }
      case 'distance-line-to-line': {
        // 两线相交（公垂距离 < 0.5mm）→ 距离无意义
        const closest = closestPointsBetweenLines(
          placed.worldPos, placed.direction, mousePoint, mouseDirection,
        )
        if (closest) {
          return closest.pointOnLine1.distanceTo(closest.pointOnLine2) >= 0.5
        }
        return true
      }
      default:
        return true
    }
  }

  // ==================== 确认标注 ====================

  /**
   * 创建已确认的测量标注
   *
   * @returns { group, annotationGroup } 主Group和标注子Group
   */
  createConfirmedAnnotation(
    type: MeasureType,
    placedPoints: Array<{ worldPos: THREE.Vector3; normal: THREE.Vector3; direction?: THREE.Vector3; snapTarget?: SnapTarget }>,
  ): { group: THREE.Group; annotationSubGroup: THREE.Group } {
    const annotationGroup = new THREE.Group()
    annotationGroup.userData = { type: 'measurement-annotation', measureType: type }

    const color = getTypeColor(type)

    const confirmedMat = makeMaterial({
      color,
      lineWidth: LINE_WIDTH,
      dashed: false,
      opacity: CONFIRMED_OPACITY,
    })

    const dashedArcMat = makeMaterial({
      color,
      lineWidth: LINE_WIDTH,
      dashed: true,
      dashSize: 3,
      gapSize: 2,
      opacity: CONFIRMED_OPACITY,
    })

    const leaderMat = makeMaterial({
      color,
      lineWidth: LEADER_LINE_WIDTH,
      dashed: false,
      opacity: CONFIRMED_OPACITY,
    })

    // z-fighting 偏移后的点
    const pts = placedPoints.map(p => ({
      pos: p.worldPos.clone().add(p.normal.clone().multiplyScalar(this.zFightingOffset)),
      normal: p.normal.clone().normalize(),
      direction: p.direction?.clone(),
      snapTarget: p.snapTarget,
    }))

    /** 在测量线段上方添加引线+标签 */
    const addLeaderLabel = (mid: THREE.Vector3, lineDir: THREE.Vector3, text: string) => {
      const offset = computeLabelOffset(mid, lineDir, this.labelWorldSize * 2.5)
      const labelPos = mid.clone().add(offset)
      annotationGroup.add(createLineSegment(mid, labelPos, leaderMat, { type: 'measurement-leader' }))
      const label = createLabelSprite(text, color, this.labelWorldSize, CONFIRMED_OPACITY)
      label.position.copy(labelPos)
      annotationGroup.add(label)
    }

    /** 为点测量端点添加十字标记（角点/边点/表面点统一为「点」，均用十字） */
    const addPointMarker = (p: { pos: THREE.Vector3 }) => {
      // 点→点测量使用更大的十字标记，更醒目
      const half = type === 'distance-point-to-point' ? this.crossHalfSize * 2.2 : this.crossHalfSize
      annotationGroup.add(createCrossMarker(p.pos, half, color, CONFIRMED_OPACITY))
    }

    switch (type) {
      // ===== 距离：点→点 =====
      case 'distance-point-to-point': {
        const [p1, p2] = pts
        // 点→点标注增强：更粗的线 + 更大的十字标记 + “距离”前缀，避免不明显
        const ppMat = makeMaterial({
          color,
          lineWidth: LINE_WIDTH + 2,
          dashed: false,
          opacity: CONFIRMED_OPACITY,
        })
        annotationGroup.add(createLineSegment(p1.pos, p2.pos, ppMat))
        addPointMarker(p1)
        addPointMarker(p2)
        const dist = p1.pos.distanceTo(p2.pos)
        const mid = new THREE.Vector3().addVectors(p1.pos, p2.pos).multiplyScalar(0.5)
        const lineDir = new THREE.Vector3().copy(p2.pos).sub(p1.pos).normalize()
        addLeaderLabel(mid, lineDir, `${getLabelPrefix(type)}${dist.toFixed(1)} mm`)
        break
      }

      // ===== 距离：点→线 =====
      case 'distance-point-to-line': {
        const [p1, p2] = pts
        annotationGroup.add(createLineSegment(p1.pos, p2.pos, confirmedMat))
        addPointMarker(p1)
        const lineDir = new THREE.Vector3().copy(p2.pos).sub(p1.pos).normalize()
        const edgeDirEst = new THREE.Vector3().crossVectors(lineDir, p2.normal).normalize()
        if (edgeDirEst.length() < 0.1) edgeDirEst.set(1, 0, 0)
        annotationGroup.add(createDashMarker(p2.pos, edgeDirEst, this.crossHalfSize * 1.5, color, CONFIRMED_OPACITY))
        const pointDir = new THREE.Vector3().copy(p1.pos).sub(p2.pos).normalize()
        annotationGroup.add(createRightAngleMark(p2.pos, pointDir, edgeDirEst, this.crossHalfSize * 3, color, CONFIRMED_OPACITY))
        const dist = p1.pos.distanceTo(p2.pos)
        const mid = new THREE.Vector3().addVectors(p1.pos, p2.pos).multiplyScalar(0.5)
        addLeaderLabel(mid, lineDir, `${getLabelPrefix(type)}${dist.toFixed(1)} mm`)
        break
      }

      // ===== 距离：线→线 =====
      case 'distance-line-to-line': {
        const [p1, p2] = pts
        annotationGroup.add(createLineSegment(p1.pos, p2.pos, confirmedMat))
        const lineDir = new THREE.Vector3().copy(p2.pos).sub(p1.pos).normalize()
        const e1 = new THREE.Vector3().crossVectors(lineDir, p1.normal).normalize()
        if (e1.length() < 0.1) e1.set(1, 0, 0)
        const e2 = new THREE.Vector3().crossVectors(lineDir, p2.normal).normalize()
        if (e2.length() < 0.1) e2.set(1, 0, 0)
        annotationGroup.add(createDashMarker(p1.pos, e1, this.crossHalfSize * 1.5, color, CONFIRMED_OPACITY))
        annotationGroup.add(createDashMarker(p2.pos, e2, this.crossHalfSize * 1.5, color, CONFIRMED_OPACITY))
        const dist = p1.pos.distanceTo(p2.pos)
        const mid = new THREE.Vector3().addVectors(p1.pos, p2.pos).multiplyScalar(0.5)
        addLeaderLabel(mid, lineDir, `${getLabelPrefix(type)}${dist.toFixed(1)} mm`)
        break
      }

      // ===== 距离：线→面 =====
      case 'distance-line-to-face': {
        const [p1, p2] = pts
        annotationGroup.add(createLineSegment(p1.pos, p2.pos, confirmedMat))
        const lineDir = new THREE.Vector3().copy(p2.pos).sub(p1.pos).normalize()
        const edgeDir = new THREE.Vector3().crossVectors(lineDir, p1.normal).normalize()
        if (edgeDir.length() < 0.1) edgeDir.set(1, 0, 0)
        annotationGroup.add(createDashMarker(p1.pos, edgeDir, this.crossHalfSize * 1.5, color, CONFIRMED_OPACITY))
        annotationGroup.add(createSquareMarker(p2.pos, p2.normal, this.crossHalfSize * 1.2, color, CONFIRMED_OPACITY))
        const dist = p1.pos.distanceTo(p2.pos)
        const mid = new THREE.Vector3().addVectors(p1.pos, p2.pos).multiplyScalar(0.5)
        addLeaderLabel(mid, lineDir, `${getLabelPrefix(type)}${dist.toFixed(1)} mm`)
        break
      }

      // ===== 距离：面→面 =====
      case 'distance-face-to-face': {
        const [p1, p2] = pts
        annotationGroup.add(createLineSegment(p1.pos, p2.pos, confirmedMat))
        annotationGroup.add(createSquareMarker(p1.pos, p1.normal, this.crossHalfSize * 1.2, color, CONFIRMED_OPACITY))
        annotationGroup.add(createSquareMarker(p2.pos, p2.normal, this.crossHalfSize * 1.2, color, CONFIRMED_OPACITY))
        const dist = p1.pos.distanceTo(p2.pos)
        const mid = new THREE.Vector3().addVectors(p1.pos, p2.pos).multiplyScalar(0.5)
        const lineDir = new THREE.Vector3().copy(p2.pos).sub(p1.pos).normalize()
        addLeaderLabel(mid, lineDir, `${getLabelPrefix(type)}${dist.toFixed(1)} mm`)
        break
      }

      case 'radius': {
        const [center, radiusPt] = pts
        const r = center.pos.distanceTo(radiusPt.pos)
        annotationGroup.add(createLineSegment(center.pos, radiusPt.pos, confirmedMat))
        addPointMarker(center)
        if (r > 0.001) {
          const fromDir = new THREE.Vector3().copy(radiusPt.pos).sub(center.pos).normalize()
          const toDir = fromDir.clone().multiplyScalar(-1)
          const arcPoints = computeArcPoints(center.pos, r, center.normal, fromDir, toDir)
          if (arcPoints.length >= 2) {
            annotationGroup.add(createPolyline(arcPoints, dashedArcMat))
          }
        }
        const mid = new THREE.Vector3().addVectors(center.pos, radiusPt.pos).multiplyScalar(0.5)
        const lineDir = new THREE.Vector3().copy(radiusPt.pos).sub(center.pos).normalize()
        addLeaderLabel(mid, lineDir, `R ${r.toFixed(1)} mm`)
        break
      }

      case 'angle-three-point': {
        const [vertex, pointA, pointB] = pts
        annotationGroup.add(createLineSegment(vertex.pos, pointA.pos, confirmedMat))
        annotationGroup.add(createLineSegment(vertex.pos, pointB.pos, confirmedMat))
        addPointMarker(vertex)

        const dirA = new THREE.Vector3().copy(pointA.pos).sub(vertex.pos).normalize()
        const dirB = new THREE.Vector3().copy(pointB.pos).sub(vertex.pos).normalize()
        const distA = vertex.pos.distanceTo(pointA.pos)
        const distB = vertex.pos.distanceTo(pointB.pos)
        const arcRadius = Math.min(distA, distB) * 0.2

        if (arcRadius > 0.001) {
          const planeNormal = new THREE.Vector3().crossVectors(dirA, dirB).normalize()
          if (planeNormal.length() > 0.001) {
            const arcPoints = computeArcPoints(vertex.pos, arcRadius, planeNormal, dirA, dirB)
            if (arcPoints.length >= 2) {
              annotationGroup.add(createPolyline(arcPoints, dashedArcMat))

              const midArc = arcPoints[Math.floor(arcPoints.length / 2)]
              const toMid = new THREE.Vector3().copy(midArc).sub(vertex.pos).normalize()
              const labelPos = midArc.clone().add(toMid.multiplyScalar(this.labelWorldSize * 1.2))
              const dot = Math.abs(dirA.dot(dirB))
              const clamped = Math.max(-1, Math.min(1, dot))
              const angleDeg = (Math.acos(clamped) * 180) / Math.PI
              const labelText = `${getLabelPrefix(type)}${angleDeg.toFixed(1)}°`
              const label = createLabelSprite(labelText, color, this.labelWorldSize, CONFIRMED_OPACITY)
              label.position.copy(labelPos)
              label.userData = { type: 'measurement-label', labelText }
              annotationGroup.add(label)
            }
          }
        }
        break
      }

      // ===== 角度：线→线 =====
      case 'angle-line-to-line': {
        const [p1, p2] = pts
        const d1 = (p1.direction ?? new THREE.Vector3(1,0,0)).clone().normalize()
        const d2 = (p2.direction ?? new THREE.Vector3(0,1,0)).clone().normalize()

        annotationGroup.add(createDashMarker(p1.pos, d1, this.crossHalfSize * 1.5, color, CONFIRMED_OPACITY))
        annotationGroup.add(createDashMarker(p2.pos, d2, this.crossHalfSize * 1.5, color, CONFIRMED_OPACITY))

        const closest = closestPointsBetweenLines(p1.pos, d1, p2.pos, d2)
        const vertex = closest
          ? new THREE.Vector3().addVectors(closest.pointOnLine1, closest.pointOnLine2).multiplyScalar(0.5)
          : p1.pos.clone()

        const refMat = makeMaterial({
          color, lineWidth: 1.2, dashed: true,
          dashSize: 2, gapSize: 2, opacity: 0.45,
        })
        annotationGroup.add(createLineSegment(p1.pos, vertex, refMat, { type: 'ref-line' }))
        annotationGroup.add(createLineSegment(p2.pos, vertex, refMat, { type: 'ref-line' }))

        this.addAngleArcToGroup(annotationGroup, vertex, d1, d2, dashedArcMat, false, color, type, CONFIRMED_OPACITY)
        break
      }

      // ===== 角度：线→面 =====
      case 'angle-line-to-face': {
        const [p1, p2] = pts
        const edgeDir = (p1.direction ?? new THREE.Vector3(1,0,0)).clone().normalize()
        const faceN = (p2.direction ?? p2.normal).clone().normalize()

        annotationGroup.add(createDashMarker(p1.pos, edgeDir, this.crossHalfSize * 1.5, color, CONFIRMED_OPACITY))
        annotationGroup.add(createSquareMarker(p2.pos, faceN, this.crossHalfSize * 1.2, color, CONFIRMED_OPACITY))

        const intersection = intersectLinePlane(p1.pos, edgeDir, p2.pos, faceN)
        const vertex = intersection ?? p1.pos.clone()

        const refMat = makeMaterial({
          color, lineWidth: 1.2, dashed: true,
          dashSize: 2, gapSize: 2, opacity: 0.45,
        })
        annotationGroup.add(createLineSegment(p1.pos, vertex, refMat, { type: 'ref-line' }))
        annotationGroup.add(createLineSegment(p2.pos, vertex, refMat, { type: 'ref-line' }))

        this.addAngleArcToGroup(annotationGroup, vertex, edgeDir, faceN, dashedArcMat, true, color, type, CONFIRMED_OPACITY)
        break
      }

      // ===== 角度：面→面（二面角） =====
      case 'angle-face-to-face': {
        const [p1, p2] = pts
        const n1 = (p1.direction ?? p1.normal).clone().normalize()
        const n2 = (p2.direction ?? p2.normal).clone().normalize()
        annotationGroup.add(createSquareMarker(p1.pos, p1.normal, this.crossHalfSize * 1.2, color, CONFIRMED_OPACITY))
        annotationGroup.add(createSquareMarker(p2.pos, p2.normal, this.crossHalfSize * 1.2, color, CONFIRMED_OPACITY))
        this.addDihedralAngle(annotationGroup, p1.pos, n1, p2.pos, n2, dashedArcMat, color, CONFIRMED_OPACITY)
        break
      }
    }

    // 将标注子 Group 加入根 Group
    this.group.add(annotationGroup)
    return { group: this.group, annotationSubGroup: annotationGroup }
  }

  // ==================== 移除标注 ====================

  /** 移除指定标注 */
  removeAnnotation(annotationGroup: THREE.Group): void {
    const measureId = annotationGroup.userData.measureId as string | undefined
    this.group.remove(annotationGroup)
    this.disposeObject(annotationGroup)
    if (measureId) this.annotationGroups.delete(measureId)
  }

  /** 通过 Store ID 查找标注子 Group（惰性填充 annotationGroups 缓存） */
  private findAnnotationGroupById(measureId: string): THREE.Group | null {
    // 先查缓存
    const cached = this.annotationGroups.get(measureId)
    if (cached) return cached

    // 线性扫描 + 填充缓存
    for (const child of this.group.children) {
      if (child === this.previewGroup || child === this.highlightGroup) continue
      if (child instanceof THREE.Group && child.userData?.measureId === measureId) {
        this.annotationGroups.set(measureId, child)
        return child
      }
    }
    return null
  }

  /** 从 Sprite 的纹理中提取文字（用于重生成高亮纹理） */
  private getSpriteLabelText(sprite: THREE.Sprite): string {
    // Sprite 的文字信息没有直接存储，我们根据标注类型反推
    // 遍历父 Group 找到 annotation 的 userData 确定类型
    let current: THREE.Object3D | null = sprite
    while (current) {
      if (current.userData?.type === 'measurement-annotation') {
        const measureType = current.userData.measureType as MeasureType
        // 根据类型和位置重新计算文字
        const annotationGroup = current as THREE.Group
        return this.recomputeLabelText(annotationGroup, measureType)
      }
      current = current.parent
    }
    return '--'
  }

  /** 根据标注类型和几何信息重新计算标签文字 */
  private recomputeLabelText(annotationGroup: THREE.Group, type: MeasureType): string {
    // 从 Group 的子对象中提取位置信息
    const lines = annotationGroup.children.filter(
      c => c instanceof Line2 && c.userData?.type !== 'measurement-cross',
    ) as Line2[]

    switch (type) {
      case 'distance-point-to-point':
      case 'distance-point-to-line':
      case 'distance-line-to-line':
      case 'distance-line-to-face':
      case 'distance-face-to-face': {
        if (lines.length >= 1) {
          const geom = lines[0].geometry
          const pos = geom.attributes.position?.array
          if (pos && pos.length >= 6) {
            const p1 = new THREE.Vector3(pos[0], pos[1], pos[2])
            const p2 = new THREE.Vector3(pos[3], pos[4], pos[5])
            const prefix = getLabelPrefix(type)
            const suffix = getLabelSuffix(type)
            return `${prefix}${p1.distanceTo(p2).toFixed(1)}${suffix}`
          }
        }
        break
      }
      case 'radius': {
        // 找实线（非虚线弧）计算半径
        const solidLine = lines.find(
          l => l.material instanceof LineMaterial && !l.material.dashed,
        )
        if (solidLine) {
          const geom = solidLine.geometry
          const pos = geom.attributes.position?.array
          if (pos && pos.length >= 6) {
            const c = new THREE.Vector3(pos[0], pos[1], pos[2])
            const r = new THREE.Vector3(pos[3], pos[4], pos[5])
            return `R ${c.distanceTo(r).toFixed(1)} mm`
          }
        }
        break
      }
      case 'angle-three-point': {
        // 两条射线 + 弧
        if (lines.length >= 2) {
          const geo1 = lines[0].geometry
          const geo2 = lines[1].geometry
          const p1 = geo1.attributes.position?.array
          const p2 = geo2.attributes.position?.array
          if (p1 && p2 && p1.length >= 6 && p2.length >= 6) {
            const v = new THREE.Vector3(p1[0], p1[1], p1[2])
            const a = new THREE.Vector3(p1[3], p1[4], p1[5])
            const b = new THREE.Vector3(p2[3], p2[4], p2[5])
            const dirA = new THREE.Vector3().copy(a).sub(v).normalize()
            const dirB = new THREE.Vector3().copy(b).sub(v).normalize()
            const dot = Math.abs(dirA.dot(dirB))
            const clamped = Math.max(-1, Math.min(1, dot))
            return `${getLabelPrefix(type)}${(Math.acos(clamped) * 180 / Math.PI).toFixed(1)}°`
          }
        }
        break
      }
      case 'angle-line-to-line':
      case 'angle-line-to-face':
      case 'angle-face-to-face': {
        // 从 Sprite userData 读取标签文本
        const sprite = annotationGroup.children.find(
          c => c instanceof THREE.Sprite && c.userData?.type === 'measurement-label',
        ) as THREE.Sprite | undefined
        if (sprite?.userData?.labelText) return sprite.userData.labelText as string
        // 回退：从连接线推算
        if (lines.length >= 1) {
          const geom = lines[0].geometry
          const pos = geom.attributes.position?.array
          if (pos && pos.length >= 6) {
            return `-- °`
          }
        }
        break
      }
    }
    return '--'
  }

  /** 通过 Store ID 移除标注 3D 对象 */
  removeAnnotationById(measureId: string): void {
    const found = this.findAnnotationGroupById(measureId)
    if (found) {
      this.group.remove(found)
      this.disposeObject(found)
      this.annotationGroups.delete(measureId)
    }
  }

  /**
   * 在 anchor 点处绘制角度弧和标签（弧锚定在anchor，不悬浮）
   *
   * @param opacity 透明度（预览态传 PREVIEW_OPACITY，确认态默认 CONFIRMED_OPACITY）
   */
  private addAngleArcToGroup(
    group: THREE.Group,
    anchor: THREE.Vector3,
    d1: THREE.Vector3,
    d2: THREE.Vector3,
    arcMat: LineMaterial,
    isLineToFace: boolean,
    color: number,
    type: MeasureType,
    opacity: number = CONFIRMED_OPACITY,
  ): void {
    const rayLen = this.crossHalfSize * 14
    const arcRadius = rayLen * 0.6

    const dirA = d1.clone().normalize()
    const dirB = d2.clone().normalize()

    // 弧平面法线
    const planeNormal = new THREE.Vector3().crossVectors(dirA, dirB).normalize()
    if (planeNormal.length() < 0.001) {
      if (isLineToFace) {
        // 线垂直于面：线面角 = 90°（有意义，显示）
        const label = createLabelSprite(`${getLabelPrefix(type)}90.0°`, color, this.labelWorldSize, opacity)
        label.position.copy(anchor).add(new THREE.Vector3(0, rayLen, 0))
        group.add(label)
      }
      // 线→线平行：角度为 0，无意义，不绘制
      return
    }

    // 将方向投影到弧平面
    const projA = dirA.clone().addScaledVector(planeNormal, -dirA.dot(planeNormal)).normalize()
    const projB = dirB.clone().addScaledVector(planeNormal, -dirB.dot(planeNormal)).normalize()

    // 计算角度
    const dotAB = Math.abs(projA.dot(projB))
    const clamped = Math.max(-1, Math.min(1, dotAB))
    let angleDeg = (Math.acos(clamped) * 180) / Math.PI
    if (isLineToFace) {
      angleDeg = 90 - angleDeg
    }
    if (angleDeg < 0.5) return

    // 顶点十字标记
    group.add(createCrossMarker(anchor, this.crossHalfSize * 1.2, color, opacity))

    // 两条方向射线（实线）
    const rayMat = makeMaterial({
      color,
      lineWidth: LINE_WIDTH + 0.5,
      dashed: false,
      opacity,
    })
    const rayEnd1 = anchor.clone().add(projA.clone().multiplyScalar(rayLen))
    const rayEnd2 = anchor.clone().add(projB.clone().multiplyScalar(rayLen))
    group.add(createLineSegment(anchor, rayEnd1, rayMat, { type: 'angle-ray' }))
    group.add(createLineSegment(anchor, rayEnd2, rayMat, { type: 'angle-ray' }))

    // 弧
    const arcPoints = computeArcPoints(anchor, arcRadius, planeNormal, projA, projB)
    if (arcPoints.length >= 2) {
      group.add(createPolyline(arcPoints, arcMat))
    }

    // 标签
    const midArc = arcPoints[Math.floor(arcPoints.length / 2)]
    const outward = new THREE.Vector3().copy(midArc).sub(anchor).normalize()
    const labelPos = midArc.clone().add(outward.multiplyScalar(this.labelWorldSize * 1.2))
    const labelText = `${getLabelPrefix(type)}${angleDeg.toFixed(1)}°`
    const label = createLabelSprite(labelText, color, this.labelWorldSize, opacity)
    label.position.copy(labelPos)
    label.userData = { type: 'measurement-label', labelText }
    group.add(label)
  }

  /**
   * 面→面二面角：在两面交线上标注
   * 从交线上最近点出发，在两个面内各画一条垂直于交线的射线
   *
   * @param opacity 透明度（预览态传 PREVIEW_OPACITY，确认态默认 CONFIRMED_OPACITY）
   */
  private addDihedralAngle(
    group: THREE.Group,
    p1: THREE.Vector3,
    n1: THREE.Vector3,
    p2: THREE.Vector3,
    n2: THREE.Vector3,
    arcMat: LineMaterial,
    color: number,
    opacity: number = CONFIRMED_OPACITY,
  ): void {
    const N1 = n1.clone().normalize()
    const N2 = n2.clone().normalize()

    // 交线方向 D = N1 × N2
    const D = new THREE.Vector3().crossVectors(N1, N2)
    if (D.length() < 0.001) {
      // 两面平行/共面：无二面角，不绘制任何内容
      return
    }
    D.normalize()

    // 在交线上找最靠近 (p1+p2)/2 的点
    const target = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5)
    const d1 = N1.dot(p1)
    const d2 = N2.dot(p2)
    const a = N1.dot(N2)
    const denom = 1 - a * a
    if (Math.abs(denom) < 0.0001) return

    const b1 = d1 - N1.dot(target)
    const b2 = d2 - N2.dot(target)
    const alpha = (b1 - b2 * a) / denom
    const beta  = (b2 - b1 * a) / denom
    const anchor = target.clone().add(N1.clone().multiplyScalar(alpha)).add(N2.clone().multiplyScalar(beta))

    // 两个面内垂直于交线的方向
    const perp1 = new THREE.Vector3().crossVectors(D, N1).normalize()
    const perp2 = new THREE.Vector3().crossVectors(N2, D).normalize()

    // 角度
    const dot = Math.abs(perp1.dot(perp2))
    const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI
    if (angleDeg < 0.5) return

    const rayLen = this.crossHalfSize * 15
    const arcRadius = rayLen * 0.6

    // 交线虚线
    const lineLen = rayLen * 1.4
    const halfD = D.clone().multiplyScalar(lineLen)
    const lineMat = makeMaterial({
      color,
      lineWidth: 1.5,
      dashed: true,
      dashSize: 2,
      gapSize: 2,
      opacity: 0.5,
    })
    group.add(createLineSegment(
      anchor.clone().add(halfD.clone().multiplyScalar(-1)),
      anchor.clone().add(halfD),
      lineMat,
      { type: 'intersection-line' },
    ))

    // 顶点十字标记
    group.add(createCrossMarker(anchor, this.crossHalfSize * 1.2, color, opacity))

    // 两条方向射线（实线，在各自平面内 ⊥ 交线）
    const rayMat = makeMaterial({
      color,
      lineWidth: LINE_WIDTH + 1,
      dashed: false,
      opacity,
    })
    group.add(createLineSegment(anchor, anchor.clone().add(perp1.clone().multiplyScalar(rayLen)), rayMat, { type: 'angle-ray' }))
    group.add(createLineSegment(anchor, anchor.clone().add(perp2.clone().multiplyScalar(rayLen)), rayMat, { type: 'angle-ray' }))

    // 弧
    const planeNormal = D.clone() // 弧所在平面以交线为法线
    const arcPoints = computeArcPoints(anchor, arcRadius, planeNormal, perp1, perp2)
    if (arcPoints.length >= 2) {
      group.add(createPolyline(arcPoints, arcMat))
    }

    // 标签
    const midArc = arcPoints[Math.floor(arcPoints.length / 2)]
    const outward = new THREE.Vector3().copy(midArc).sub(anchor).normalize()
    const labelPos = midArc.clone().add(outward.multiplyScalar(this.labelWorldSize * 1.5))
    const labelText = `${getLabelPrefix('angle-face-to-face')}${angleDeg.toFixed(1)}°`
    const label = createLabelSprite(labelText, color, this.labelWorldSize, opacity)
    label.position.copy(labelPos)
    label.userData = { type: 'measurement-label', labelText }
    group.add(label)
  }

  /** 高亮指定标注（白色），取消其它高亮 */
  highlightAnnotation(measureId: string | null): void {
    // 直接通过遍历所有标注子 Group 高亮/取消高亮
    for (const child of this.group.children) {
      if (child === this.previewGroup) continue
      if (!(child instanceof THREE.Group)) continue
      if (child.userData?.type !== 'measurement-annotation') continue

      const id = child.userData.measureId as string | undefined
      const measureType = child.userData.measureType as MeasureType | undefined
      const typeColor = measureType ? getTypeColor(measureType) : 0x00e676
      const isTarget = id === measureId

      child.traverse(obj => {
        if (obj === child) return
        if (obj instanceof Line2 && obj.material instanceof LineMaterial) {
          obj.material.dispose()
          // 引线保持细线宽度
          const isLeader = obj.userData?.type === 'measurement-leader'
          const restoreWidth = isLeader ? LEADER_LINE_WIDTH : LINE_WIDTH
          obj.material = makeMaterial({
            color: isTarget ? 0xffffff : typeColor,
            lineWidth: isTarget ? 3.5 : restoreWidth,
            dashed: false,
            opacity: isTarget ? 1.0 : CONFIRMED_OPACITY,
          })
        } else if (obj instanceof THREE.Sprite && obj.material instanceof THREE.SpriteMaterial) {
          if (obj.userData?.type === 'measurement-label') {
            const oldTexture = obj.material.map
            const labelColor = isTarget ? 0xffffff : typeColor
            const newTexture = buildLabelTexture(
              this.getSpriteLabelText(obj),
              labelColor,
              isTarget ? 1.0 : CONFIRMED_OPACITY,
            )
            obj.material.map = newTexture
            obj.material.opacity = isTarget ? 1.0 : CONFIRMED_OPACITY
            oldTexture?.dispose()
          }
        }
      })
    }
  }

  /** 从 Store 标注数据全量重建 3D 对象（用于 undo/redo 后恢复） */
  rebuildFromAnnotations(annotations: Array<{
    id: string
    type: MeasureType
    _worldPoints?: Array<{ x: number; y: number; z: number; nx: number; ny: number; nz: number; dx?: number; dy?: number; dz?: number }>
  }>): void {
    // 1. 移除所有现存的确认标注 3D 对象
    const toRemove: THREE.Group[] = []
    this.group.children.forEach(child => {
      if (child !== this.previewGroup && child instanceof THREE.Group) {
        toRemove.push(child)
      }
    })
    for (const g of toRemove) {
      this.group.remove(g)
      this.disposeObject(g)
    }
    this.annotationGroups.clear()

    // 2. 为每条带 _worldPoints 的标注重建 3D 对象
    for (const ann of annotations) {
      if (!ann._worldPoints || ann._worldPoints.length < 2) continue

      const placedPoints = ann._worldPoints.map(wp => ({
        worldPos: new THREE.Vector3(wp.x, wp.y, wp.z),
        normal: new THREE.Vector3(wp.nx, wp.ny, wp.nz),
        ...(wp.dx !== undefined ? { direction: new THREE.Vector3(wp.dx, wp.dy!, wp.dz!) } : {}),
      }))

      const { annotationSubGroup } = this.createConfirmedAnnotation(ann.type, placedPoints)
      annotationSubGroup.userData.measureId = ann.id
    }
  }

  /** 清除所有标注 */
  clearAll(): void {
    this.clearPreview()
    this.clearHighlights()
    // 收集所有标注子 Group
    const toRemove: THREE.Group[] = []
    this.group.children.forEach(child => {
      if (child !== this.previewGroup && child instanceof THREE.Group) {
        toRemove.push(child)
      }
    })
    for (const g of toRemove) {
      this.group.remove(g)
      this.disposeObject(g)
    }
    this.annotationGroups.clear()
  }

  /** 同步 3D 对象与 Store annotations（批量 diff） */
  syncWithStore(storeAnnotationIds: Set<string>): void {
    // 清理：移除 3D 中存在但 Store 中不存在的标注
    const toRemove: string[] = []
    for (const child of this.group.children) {
      if (child === this.previewGroup) continue
      const measureId = child.userData?.measureId as string | undefined
      if (measureId && !storeAnnotationIds.has(measureId)) {
        toRemove.push(measureId)
      }
    }
    for (const id of toRemove) {
      this.removeAnnotationById(id)
    }
  }

  // ==================== 获取可射线检测对象 ====================

  /** 返回确认标注中的所有可选中对象（用于 SatelliteEditorHandler 选中） */
  getRaycastTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = []
    this.group.traverse(child => {
      if (child === this.previewGroup) return // 跳过预览
      if (child.userData?.type === 'measurement-annotation') {
        targets.push(child)
      }
    })
    return targets
  }

  // ==================== 高亮（边/面预览反馈） ====================

  /** 高亮组（独立于 previewGroup，用于鼠标悬停时的边/面高亮） */
  readonly highlightGroup: THREE.Group

  /** 创建边高亮：在指定边上画一条加粗的黄色线段 */
  createEdgeHighlight(
    dimensions: THREE.Vector3,
    worldMatrix: THREE.Matrix4,
    edgeIndex: number,
    color?: number,
  ): THREE.Object3D {
    const edges = getBoxEdgesWorld(dimensions, worldMatrix)
    const edge = edges[edgeIndex]
    if (!edge) return new THREE.Group()

    const highlightColor = color ?? 0xffcc00
    const isConfirmed = color !== undefined
    // ★ 高亮线关闭深度测试 + 高渲染序，总是绘制在物体表面之上。
    //   旧实现用 (0,1,0)×边方向 做世界偏移：水平面板的边偏移向量落在面板平面内，
    //   线贴面渲染被面板遮挡（z-fighting），导致选边时看不到高亮。
    const mat = makeMaterial({
      color: highlightColor,
      lineWidth: isConfirmed ? LINE_WIDTH + 3.5 : LINE_WIDTH + 2.5,
      dashed: false,
      opacity: isConfirmed ? 0.95 : 0.9,
      depthTest: false,
      renderOrder: 900,
    })

    const line = createLineSegment(
      edge.start,
      edge.end,
      mat,
      { type: 'edge-highlight' },
    )
    this.highlightGroup.add(line)
    return line
  }

  /** 创建面高亮：在指定面上创建一个半透明黄色填充矩形 */
  createFaceHighlight(
    dimensions: THREE.Vector3,
    worldMatrix: THREE.Matrix4,
    faceIndex: number,
    color?: number,
    withBorder?: boolean,
  ): THREE.Object3D {
    const corners = getFaceCornersWorld(faceIndex, dimensions, worldMatrix)
    if (corners.length < 4) return new THREE.Group()

    const highlightColor = color ?? 0xffcc00
    const isConfirmed = color !== undefined
    const group = new THREE.Group()
    group.userData = { type: 'face-highlight' }

    // 计算法线和 z-fighting 偏移
    const normal = new THREE.Vector3()
      .crossVectors(
        new THREE.Vector3().copy(corners[1]).sub(corners[0]),
        new THREE.Vector3().copy(corners[3]).sub(corners[0]),
      ).normalize()
    // ★ 偏移加倍：大场景远端深度缓冲精度不足，单倍偏移填充面仍会与面板 z-fighting
    //   被遮挡而不可见（面面测量时看不到选中反馈）
    const offset = normal.clone().multiplyScalar(this.zFightingOffset * 2)

    // 偏移后的角点（填充面和边框共用的世界坐标）
    const offsetCorners = corners.map(c => c.clone().add(offset))

    // 创建半透明矩形平面
    const geo = new THREE.BufferGeometry()
    const verts = new Float32Array([
      offsetCorners[0].x, offsetCorners[0].y, offsetCorners[0].z,
      offsetCorners[1].x, offsetCorners[1].y, offsetCorners[1].z,
      offsetCorners[2].x, offsetCorners[2].y, offsetCorners[2].z,
      offsetCorners[0].x, offsetCorners[0].y, offsetCorners[0].z,
      offsetCorners[2].x, offsetCorners[2].y, offsetCorners[2].z,
      offsetCorners[3].x, offsetCorners[3].y, offsetCorners[3].z,
    ])
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geo.computeVertexNormals()

    const mat = new THREE.MeshBasicMaterial({
      color: highlightColor,
      transparent: true,
      opacity: isConfirmed ? 0.25 : 0.3,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    })
    // 注：原实现在此处给 Material 设 renderOrder，但该属性属于 Object3D，
    //     对材质赋值不生效；高亮面的可见性由上面的 depthTest:false 保证。

    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    group.add(mesh)

    // 边框默认开启（悬停态也绘制）：让"将要选中的面"轮廓清晰可见
    const showBorder = withBorder ?? true
    if (showBorder) {
      // 边框线关闭深度测试：保证任何视角下轮廓都可见
      const borderMat = makeMaterial({
        color: highlightColor,
        lineWidth: LINE_WIDTH + 1.5,
        dashed: false,
        opacity: 0.9,
        depthTest: false,
        renderOrder: 901,
      })
      for (let i = 0; i < 4; i++) {
        const from = offsetCorners[i]
        const to = offsetCorners[(i + 1) % 4]
        const line = createLineSegment(from, to, borderMat, { type: 'face-highlight-border' })
        group.add(line)
      }
    }

    this.highlightGroup.add(group)
    return group
  }

  /** 移除指定高亮对象 */
  removeHighlight(obj: THREE.Object3D): void {
    this.highlightGroup.remove(obj)
    this.disposeObject(obj)
  }

  /** 清除所有高亮 */
  clearHighlights(): void {
    while (this.highlightGroup.children.length > 0) {
      const child = this.highlightGroup.children[0]
      this.highlightGroup.remove(child)
      this.disposeObject(child)
    }
  }

  // ==================== 标线绑定 ====================

  /**
   * 拖动中轻量平移标注 Group（仅纯平移，排除跨对象标注）
   * 每帧调用，只改 Group.position，不做几何重建
   *
   * @param objectId 被拖动的元件 ID
   * @param delta    世界空间位移增量
   */
  translateAnnotationsForObject(objectId: string, delta: THREE.Vector3): void {
    const measurementStore = useMeasurementStore()
    const annotations = measurementStore.getAnnotationsForObject(objectId)

    for (const annotation of annotations) {
      // 跳过跨对象标注（无法简单平移）
      const uniqueIds = new Set(annotation.points.map(p => p.objectId))
      if (uniqueIds.size > 1) continue

      const grp = this.findAnnotationGroupById(annotation.id)
      if (grp) {
        grp.position.x += delta.x
        grp.position.y += delta.y
        grp.position.z += delta.z
      }
    }
  }

  /**
   * 元件移动/旋转/缩放后，全量重建其所有关联标注的 3D 对象和世界坐标
   *
   * @param objectId         被移动的元件 ID
   * @param objectType       'component' | 'panel'
   * @param mesh             元件的当前 mesh（提供 worldMatrix）
   * @param dimensions       元件尺寸
   * @param getOtherMesh     获取其他元件 mesh 的回调（处理跨对象标注）
   * @param getOtherDims     获取其他元件尺寸的回调
   */
  rebuildBindingsForObject(
    objectId: string,
    _objectType: 'component' | 'panel',
    _mesh: THREE.Mesh,
    _dimensions: THREE.Vector3,
    getOtherMesh: (objId: string) => THREE.Mesh | null,
    getOtherDims: (objType: string, objId: string) => THREE.Vector3 | null,
  ): void {
    const measurementStore = useMeasurementStore()
    const annotations = measurementStore.getAnnotationsForObject(objectId)

    for (const annotation of annotations) {
      this.rebuildSingleAnnotation(annotation, getOtherMesh, getOtherDims)
    }
  }

  // ==================== 单条标注重建（内部） ====================

  /**
   * 重建单条标注：局部坐标 → 世界坐标 → 几何精修 → 3D 对象重建 → _worldPoints 同步
   */
  private rebuildSingleAnnotation(
    annotation: import('./satelliteTypes').MeasureAnnotation,
    getMesh: (objId: string) => THREE.Mesh | null,
    getDims: (objType: string, objId: string) => THREE.Vector3 | null,
  ): void {
    const newWorldPts: Array<{
      pos: THREE.Vector3
      normal: THREE.Vector3
      direction?: THREE.Vector3
    }> = []

    // 第一步：从 localPosition 推算世界坐标
    for (const point of annotation.points) {
      const m = getMesh(point.objectId)
      const dims = getDims(point.objectType, point.objectId)
      if (!m || !dims) {
        // 物体已删除，跳过整个标注
        console.warn(`[MeasurementBinding] 标注 ${annotation.id}: 物体 ${point.objectId} 已不存在`)
        return
      }

      const wm = m.matrixWorld
      const worldPos = new THREE.Vector3(
        point.localPosition.x, point.localPosition.y, point.localPosition.z,
      ).applyMatrix4(wm)

      // 法线：优先用 faceNormal（面吸附），否则用默认 (0,1,0)
      let normal: THREE.Vector3
      if (point.faceNormal) {
        normal = new THREE.Vector3(point.faceNormal.x, point.faceNormal.y, point.faceNormal.z)
          .transformDirection(wm).normalize()
      } else if (point.snapTarget === 'face' && point.faceIndex !== undefined) {
        normal = getFaceNormalWorld(point.faceIndex, wm)
      } else {
        normal = new THREE.Vector3(0, 1, 0)
      }

      // 方向向量：边 → 边方向，面 → 面法线
      let direction: THREE.Vector3 | undefined
      if (point.snapTarget === 'edge' && point.edgeIndex !== undefined) {
        const edges = getBoxEdgesWorld(dims, wm)
        if (edges[point.edgeIndex]) {
          direction = edges[point.edgeIndex].direction.clone()
        }
      } else if (point.snapTarget === 'face' && point.faceIndex !== undefined) {
        direction = getFaceNormalWorld(point.faceIndex, wm)
      }

      newWorldPts.push({ pos: worldPos, normal, direction })
    }

    // 第二步：跨对象标注 → 几何精修
    const uniqueIds = new Set(annotation.points.map(p => p.objectId))
    if (uniqueIds.size > 1) {
      this.refineGeometry(annotation.type, newWorldPts, annotation, getMesh, getDims)
    }

    // 第三步：构建 _worldPoints + 重建 3D 对象
    this.commitRebuild(annotation, newWorldPts)
  }

  /**
   * 几何精修：跨对象标注需要重新计算垂足/公垂线/投影点
   */
  private refineGeometry(
    type: import('./satelliteTypes').MeasureType,
    pts: Array<{ pos: THREE.Vector3; normal: THREE.Vector3; direction?: THREE.Vector3 }>,
    annotation: import('./satelliteTypes').MeasureAnnotation,
    getMesh: (objId: string) => THREE.Mesh | null,
    getDims: (objType: string, objId: string) => THREE.Vector3 | null,
  ): void {
    switch (type) {
      case 'distance-point-to-line': {
        // P0: 表面点, P1: 边点 → P0 向 P1 的边作垂足
        if (pts.length >= 2 && pts[1].direction) {
          const pointPos = pts[0].pos
          const edgeDir = pts[1].direction.clone().normalize()
          const toPoint = pointPos.clone().sub(pts[1].pos)
          const t = toPoint.dot(edgeDir)
          pts[1].pos.copy(pts[1].pos.clone().add(edgeDir.clone().multiplyScalar(t)))
        }
        break
      }
      case 'distance-line-to-line': {
        if (pts.length >= 2 && pts[0].direction && pts[1].direction) {
          const closest = closestPointsBetweenLines(
            pts[0].pos, pts[0].direction.clone().normalize(),
            pts[1].pos, pts[1].direction.clone().normalize(),
          )
          if (closest) {
            pts[0].pos.copy(closest.pointOnLine1)
            pts[1].pos.copy(closest.pointOnLine2)
          }
        }
        break
      }
      case 'distance-line-to-face': {
        if (pts.length >= 2 && pts[1].direction) {
          const faceNormal = pts[1].direction.clone().normalize()
          const { footPoint } = distancePointToPlane(pts[0].pos, pts[1].pos, faceNormal)
          pts[1].pos.copy(footPoint)
        }
        break
      }
      case 'distance-face-to-face': {
        // 重新计算面中心，判断是否平行
        if (pts.length >= 2 && annotation.points.length >= 2) {
          const p0 = annotation.points[0]
          const p1 = annotation.points[1]
          const m0 = getMesh(p0.objectId)
          const m1 = getMesh(p1.objectId)
          const d0 = getDims(p0.objectType, p0.objectId)
          const d1 = getDims(p1.objectType, p1.objectId)
          if (m0 && m1 && d0 && d1 && p0.faceIndex !== undefined && p1.faceIndex !== undefined) {
            const c0 = getFaceCenterWorld(p0.faceIndex, d0, m0.matrixWorld)
            const c1 = getFaceCenterWorld(p1.faceIndex, d1, m1.matrixWorld)
            const n0 = getFaceNormalWorld(p0.faceIndex, m0.matrixWorld)
            const n1 = getFaceNormalWorld(p1.faceIndex, m1.matrixWorld)

            const dotN = Math.abs(n0.dot(n1))
            if (dotN > 0.9998) {
              // 平行：面0中心到面1平面的垂直距离
              const toPoint = c0.clone().sub(c1)
              const signedDist = toPoint.dot(n1)
              pts[0].pos.copy(c0)
              pts[1].pos.copy(c0.clone().addScaledVector(n1, -signedDist))
            } else {
              pts[0].pos.copy(c0)
              pts[1].pos.copy(c1)
            }
            pts[0].normal.copy(n0)
            pts[1].normal.copy(n1)
            pts[0].direction = n0.clone()
            pts[1].direction = n1.clone()
          }
        }
        break
      }
    }
  }

  /**
   * 提交重建：构建 _worldPoints → 销毁旧 3D Group → 创建新 3D Group → 同步 designStore
   */
  private commitRebuild(
    annotation: import('./satelliteTypes').MeasureAnnotation,
    pts: Array<{ pos: THREE.Vector3; normal: THREE.Vector3; direction?: THREE.Vector3 }>,
  ): void {
    // 构建 _worldPoints
    const wp: Array<{
      x: number; y: number; z: number
      nx: number; ny: number; nz: number
      dx?: number; dy?: number; dz?: number
    }> = pts.map(p => ({
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      nx: p.normal.x, ny: p.normal.y, nz: p.normal.z,
      ...(p.direction ? { dx: p.direction.x, dy: p.direction.y, dz: p.direction.z } : {}),
    }))

    // 销毁旧 3D 对象
    const oldGroup = this.findAnnotationGroupById(annotation.id)
    if (oldGroup) {
      this.group.remove(oldGroup)
      this.annotationGroups.delete(annotation.id)
      this.disposeObject(oldGroup)
    }

    // 创建新 3D 对象
    const placed = pts.map(p => ({
      worldPos: p.pos,
      normal: p.normal,
      direction: p.direction,
    }))
    const { annotationSubGroup } = this.createConfirmedAnnotation(annotation.type, placed)
    annotationSubGroup.userData.measureId = annotation.id
    this.annotationGroups.set(annotation.id, annotationSubGroup)

    // 更新 annotation 的 _worldPoints
    annotation._worldPoints = wp

    // 同步到 DesignStore（不触发 saveHistory）
    const designStore = useDesignStore()
    designStore.updateMeasurement(annotation.id, wp)
  }

  // ==================== 清理 ====================

  /** 递归 dispose 对象及其子对象 */
  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse(child => {
      if (child instanceof Line2) {
        child.geometry.dispose()
        if (child.material instanceof LineMaterial) {
          child.material.dispose()
        }
      } else if (child instanceof THREE.Sprite) {
        if (child.material instanceof THREE.SpriteMaterial) {
          child.material.map?.dispose()
          child.material.dispose()
        }
      } else if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose())
        } else if (child.material instanceof THREE.Material) {
          child.material.dispose()
        }
      }
    })
  }

  dispose(): void {
    this.clearAll()
  }
}
