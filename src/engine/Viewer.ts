// 精简 3D 引擎 —— 场景 / 相机 / 渲染器 / 轨道控制 / 事件转发
//
// 主项目的 Viewer 还要管 OCC、模型加载、后处理、多视图等；Demo 只保留
// 测量模块真正依赖的那部分，并用同样的类名与方法签名，使复制的
// MeasurementObject / MeasurementEventHandler 无需改动即可运行。
//
// 被复制的代码实际只用到 6 个方法：
//   getCamera() · getRenderer() · getScene() · update() · setForceRender()
//   （另有 handler 侧自行调用的事件方法，由本类统一转发）

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { IEventHandler } from '@/core/measure/IEventHandler'

export class Viewer {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls

  private container: HTMLElement
  private handler: IEventHandler | null = null
  private rafId = 0
  private disposed = false

  /** 脏标记：仅在需要时重绘（测量模式外不做无谓渲染） */
  private dirty = true
  /** 强制逐帧渲染（测量模式开启，交互预览需要连续刷新） */
  private forceRender = false

  private resizeObserver: ResizeObserver | null = null

  // 事件监听器引用，dispose 时精确解绑
  private onPointerDown = (e: PointerEvent) => this.handler?.pointerDown?.(this, e)
  private onPointerMove = (e: PointerEvent) => this.handler?.pointerMove?.(this, e)
  private onPointerUp = (e: PointerEvent) => this.handler?.pointerUp?.(this, e)
  private onPointerOut = (e: PointerEvent) => this.handler?.pointerOut?.(this, e)
  private onWheel = (e: WheelEvent) => this.handler?.wheel?.(this, e)
  // dblclick 是 MouseEvent，而 IEventHandler.doubleClick 声明的是 PointerEvent。
  // 两者在这条路径上可用的字段完全一致（clientX/clientY/button/…），此处显式转换。
  private onDoubleClick = (e: MouseEvent) =>
    this.handler?.doubleClick?.(this, e as unknown as PointerEvent)
  private onKeyDown = (e: KeyboardEvent) => this.handler?.keyDown?.(this, e)
  private onKeyUp = (e: KeyboardEvent) => this.handler?.keyUp?.(this, e)

  constructor(container: HTMLElement) {
    this.container = container

    // ========== 渲染器 ==========
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
    this.renderer.setClearColor(0x0e1116, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    // ========== 场景 ==========
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0e1116)

    // ========== 相机（场景尺度单位 mm，约 2.2m 跨度） ==========
    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1)
    this.camera = new THREE.PerspectiveCamera(45, aspect, 1, 100000)
    this.camera.up.set(0, 1, 0)
    this.camera.position.set(-2600, 2200, 3200)
    this.camera.lookAt(0, 400, 0)

    // ========== 灯光 ==========
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1))

    const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x2a2f38, 1.4)
    hemi.position.set(0, 1, 0)
    this.scene.add(hemi)

    const key = new THREE.DirectionalLight(0xffffff, 1.9)
    key.position.set(1800, 2600, 1600)
    this.scene.add(key)

    const fill = new THREE.DirectionalLight(0xa8c4ff, 0.7)
    fill.position.set(-2000, 900, -1800)
    this.scene.add(fill)

    // ========== 轨道控制 ==========
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 400, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.maxDistance = 20000
    this.controls.minDistance = 120
    this.controls.update()

    this.syncCameraViewport()
    this.bindEvents()
    this.startLoop()
  }

  /**
   * 把画布尺寸写进 camera.viewport。
   *
   * geometryUtils.screenPxToWorldDistance 通过 `camera.viewport?.h` 把屏幕像素阈值
   * 换算成世界距离；主项目未设置该字段，因此始终回退到硬编码的 1080 —— 换算结果只在
   * 画布恰好 1080px 高时才严格准确。Demo 显式写入真实高度，使「顶点 14px / 棱边 10px」
   * 这两个阈值在任意窗口尺寸下都精确成立。
   */
  private syncCameraViewport(): void {
    const size = this.getSize()
    ;(this.camera as unknown as { viewport?: { w: number; h: number } }).viewport = {
      w: size.width,
      h: size.height,
    }
  }

  // ==================== 被复制代码依赖的 API ====================

  getCamera(): THREE.PerspectiveCamera {
    return this.camera
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer
  }

  getScene(): THREE.Scene {
    return this.scene
  }

  /** 标记需要重绘（下一帧渲染一次） */
  update(): void {
    this.dirty = true
  }

  /**
   * 强制逐帧渲染。
   * 测量模式下的悬停预览依赖鼠标位置实时刷新，按需渲染会漏帧。
   */
  setForceRender(enabled: boolean): void {
    this.forceRender = enabled
    if (enabled) this.dirty = true
  }

  // ==================== 事件处理器接入 ====================

  /** 切换当前事件处理器（传入 null 表示不接管交互） */
  setEventHandler(handler: IEventHandler | null): void {
    this.handler?.dispose?.()
    this.handler = handler
    this.handler?.init?.()
    this.update()
  }

  getEventHandler(): IEventHandler | null {
    return this.handler
  }

  /**
   * 是否允许左键拖动旋转视角。
   * 测量模式需要左键点击取点，此时关掉左键旋转，保留右键旋转 / 中键平移 / 滚轮缩放。
   */
  setOrbitEnabled(enabled: boolean): void {
    this.controls.mouseButtons = {
      LEFT: enabled ? THREE.MOUSE.ROTATE : null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    }
    this.controls.enablePan = true
    this.controls.enableZoom = true
  }

  /** 相机取景到指定包围盒 */
  fitToBox(box: THREE.Box3): void {
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    const dist = maxDim / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 1.5

    this.controls.target.copy(center)
    this.camera.position.set(center.x - dist * 0.6, center.y + dist * 0.55, center.z + dist * 0.75)
    this.camera.near = Math.max(maxDim / 1000, 0.1)
    this.camera.far = dist * 12
    this.camera.updateProjectionMatrix()
    this.controls.update()
    this.update()
  }

  // ==================== 渲染循环 ====================

  private startLoop(): void {
    const tick = () => {
      if (this.disposed) return
      this.rafId = requestAnimationFrame(tick)

      // enableDamping 打开时，update() 返回本帧是否实际产生了变化
      const controlsChanged = this.controls.update()

      if (this.forceRender || this.dirty || controlsChanged) {
        this.dirty = false
        this.renderer.render(this.scene, this.camera)
      }
    }
    this.rafId = requestAnimationFrame(tick)
  }

  // ==================== 事件绑定 ====================

  private bindEvents(): void {
    const dom = this.renderer.domElement
    dom.addEventListener('pointerdown', this.onPointerDown)
    dom.addEventListener('pointermove', this.onPointerMove)
    dom.addEventListener('pointerup', this.onPointerUp)
    dom.addEventListener('pointerleave', this.onPointerOut)
    dom.addEventListener('wheel', this.onWheel, { passive: true })
    dom.addEventListener('dblclick', this.onDoubleClick)
    // 键盘事件挂 window：画布不一定持有焦点（Delete 删除标注等需要全局可用）
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)

    this.controls.addEventListener('change', () => { this.dirty = true })

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)
  }

  /** 尺寸变化时同步相机宽高比与渲染缓冲 */
  resize(): void {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.syncCameraViewport()
    this.update()
  }

  /** 当前画布分辨率（Line2 材质需要，见 MeasurementObject.setResolution） */
  getSize(): { width: number; height: number } {
    return {
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)

    const dom = this.renderer.domElement
    dom.removeEventListener('pointerdown', this.onPointerDown)
    dom.removeEventListener('pointermove', this.onPointerMove)
    dom.removeEventListener('pointerup', this.onPointerUp)
    dom.removeEventListener('pointerleave', this.onPointerOut)
    dom.removeEventListener('wheel', this.onWheel)
    dom.removeEventListener('dblclick', this.onDoubleClick)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)

    this.resizeObserver?.disconnect()
    this.handler?.dispose?.()
    this.controls.dispose()
    this.renderer.dispose()
    dom.remove()
  }
}
