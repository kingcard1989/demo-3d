// Core types for the Satellite Layout Optimization Platform
// Migrated from V0View/lib/types.ts

export interface Vector3 {
  x: number
  y: number
  z: number
}
export interface Vector2 {
  x:number,
  y:number
}
export type ComponentType = 'electronic' | 'propulsion' | 'structural' | 'wiring' | 'geometry' | 'imported'

export type WireType = 'power' | 'data' | 'signal' | 'ground'

export type PanelFace = 'front' | 'back'

export type EditorTool = 'select' | 'move' | 'rotate' | 'scale' | 'wire' | 'delete' | 'measure' | 'keepout'

/** 测量子类型 */
export type MeasureType =
  | 'distance-point-to-point'
  | 'distance-point-to-line'
  | 'distance-line-to-line'
  | 'distance-line-to-face'
  | 'distance-face-to-face'
  | 'radius'
  | 'angle-three-point'
  | 'angle-line-to-line'
  | 'angle-line-to-face'
  | 'angle-face-to-face'

/** 测量点吸附目标类型 */
export type SnapTarget = 'point' | 'edge' | 'face'

/** 测量点 —— 关联被测物体 + 局部坐标 + 吸附类型 */
export interface MeasurePoint {
  objectType: 'component' | 'panel' | 'wire'
  objectId: string
  /** 物体局部坐标系下的位置 */
  localPosition: Vector3
  /** 吸附目标类型（默认 'point'） */
  snapTarget?: SnapTarget
  /** 命中边时：边的顶点对索引 (0-11) */
  edgeIndex?: number
  /** 命中面时：面的法线方向索引 (0-5: ±X, ±Y, ±Z) */
  faceIndex?: number
  /** 命中面时：局部坐标系下的单位法线 */
  faceNormal?: { x: number; y: number; z: number }
}

/** 一条完整的测量标注 */
export interface MeasureAnnotation {
  id: string
  type: MeasureType
  points: MeasurePoint[]
  confirmed: boolean
  createdAt: number
  /** 内部：世界坐标 + 法线 + 方向（用于 undo 后重建 3D 标注） */
  _worldPoints?: Array<{ x: number; y: number; z: number; nx: number; ny: number; nz: number; dx?: number; dy?: number; dz?: number }>
}

export type ViewMode = 'perspective' | 'top' | 'front' | 'side'

export type PanelShape = 'rect' | 'hexagon' | 'octagon' | 'outline' | 'cylinder'

/** UV 原点位置（Demo 版内联定义，主项目位于 utils/panelUV） */
export type UVOrigin = 'center' | 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right'

/** 圆筒型舱板渲染参数（shape='cylinder' 时有效；底面中心已并入 CabinPanel.position 作为几何中心） */
export interface CylinderPanelData {
  /** 圆筒轴向 */
  axis: 'x' | 'y' | 'z'
  /** 圆筒高度（沿轴向） */
  height: number
  /** 外半径（底面） */
  outerRadius: number
  /** 内半径（底面；0=实心，>0=空心薄壁） */
  innerRadius: number
  /** 顶面外半径（圆台筒；与 outerRadius 相等时为直筒） */
  topOuterRadius: number
  /** 顶面内半径（圆台筒空心时；与 innerRadius 相等时为直筒） */
  topInnerRadius: number
}

/** 孔类型 */
export type HoleType = 'circle' | 'rect' | 'polygon'

/** 孔所在面 */
export type HoleFace = 'front' | 'back' | 'through'

/** 面板上的孔（内部类型） */
export interface PanelHole {
  id: string
  type: HoleType
  /** 孔中心在面板面平面上的局部坐标 (u, v → 对应非厚度轴的两个方向) */
  u: number
  v: number
  /** 圆形孔半径 */
  radius?: number
  /** 矩形孔宽 */
  width?: number
  /** 矩形孔高 */
  height?: number
  /** 矩形孔旋转角度（弧度） */
  rotation?: number
  /** 多边形孔轮廓点 [[u,v], ...] */
  points?: number[][]
  /** 孔所在面 */
  face: HoleFace
}

export interface PanelFaceProperties {
  canLayout: boolean
  heatDissipationLevel: number
  loadBearingLevel: number
  contourPoints: Vector3[]
}

export interface CabinPanel {
  id: string
  projectId: string
  name: string
  position: Vector3
  rotation: Vector3
  scale: Vector3
  dimensions: Vector3
  shape: PanelShape
  color: string
  frontFaceColor: string
  backFaceColor: string
  frontFaceProperties: PanelFaceProperties
  backFaceProperties: PanelFaceProperties
  /** 不规则轮廓点位（仅在 shape='outline' 时有效） */
  outlinePoints?: Vector3[]
  /** 舱板编号（来自导入数据的原始编号） */
  boardId?: number
  /** 厚度方向轴（正面/背面的法线方向） */
  thicknessAxis?: 'x' | 'y' | 'z'
  /** 面板原点偏移（面内局部坐标 mm，a=横轴方向, b=纵轴方向） */
  originPointOffset?: { a: number; b: number }
  /** 坐标轴方向配置 */
  direction?: {
    primaryAxis: 'x' | 'y' | 'z'
    primaryDir: 1 | -1
    secondaryAxis: 'x' | 'y' | 'z'
    secondaryDir: 1 | -1
  }
  /**
   * outline 舱板单向外侧挤出方向符号（仅 shape='outline' 有效）：
   * 由转换器按旧项目「有符号 size 向量」语义计算 = sign(size · N)。
   *   +1：沿局部 +N(=世界法向) 挤出全厚，B 面落在轮廓平面
   *   −1：沿局部 −N 挤出全厚（N 朝内时，−N 即外向），B 面仍落在轮廓平面
   * 两种情况都使 B 面(负面)贴合轮廓平面、板厚沿「+size 方向」生长，与旧项目
   * prism(底面轮廓, signedSize) 一致。矩形/圆筒不使用此字段。
   * 缺省 +1（向后兼容未走转换器的 outline 面板）。
   */
  extrudeSign?: number
  /** UV 原点位置（默认 center=面板几何中心） */
  uvOrigin?: UVOrigin
  /** 孔列表（可选，无孔的舱板省略） */
  holes?: PanelHole[]
  /** 圆筒参数（仅在 shape='cylinder' 时有效） */
  cylinder?: CylinderPanelData
  /** 最大承载能力 (kg)，-1 表示不启用 */
  maximumLoadCapacity: number
  /** 当前承重 (kg)，优化后由结果填充 */
  currentLoadCapacity?: number
  createdAt?: string
  updatedAt?: string
}

export interface ComponentSubtype {
  id: string
  name: string
  nameCn: string
  type: ComponentType
  defaultDimensions: Vector3
  defaultColor: string
  defaultMass: number
  defaultHeatDissipation: number
  icon: string
  properties?: Record<string, unknown>
}

export interface CadMeshData {
  /** 顶点位置数组，长度 = 顶点数 * 3（运行时优先 TypedArray 省 1/2 内存；序列化转 number[]，存档兼容） */
  positions: number[] | Float32Array
  /** 法线数组，长度 = 顶点数 * 3（运行时优先 TypedArray；空时长度 0，消费侧 computeVertexNormals 兜底） */
  normals: number[] | Float32Array
  /** 三角面索引数组（运行时优先 Uint32Array 省 1/2 内存；序列化转 number[]，存档兼容） */
  index: number[] | Uint32Array
  /**
   * 拓扑边线段对数组（"Shaded with Edges / 带边着色"用）。
   * 来源：OCC BRep 拓扑 EDGE 经 GCPnts_TangentialDeflection 离散 + EdgeMeshDataBuilder
   * 折线点序列转线段对（[p0,p1, p1,p2, ...]）——可直接喂 THREE.LineSegments（每 2 顶点 1 线段）。
   * 仅画面的边界/孔轮廓/特征棱（非三角形内部边），对齐 board3D threeGeometry.ts initEdges。
   * 与 positions 同 center 居中对齐。可选：STEP 才有；通用格式(STL/glTF)/旧档无 → undefined（real 模式退化纯着色）。
   * ★运行时优先 Float32Array（4B/元素，number[] 为 8B——26 个真实模型的边线合计可观）；
   *   序列化 replacer/Float32BufferAttribute 对两种形态均兼容，消费侧无感。
   */
  edges?: number[] | Float32Array
}

/** 包络（来自 CAD 模型的包围盒信息） */
export interface ComponentEnvelope {
  /** 包络尺寸（长宽高） */
  size: Vector3
  /** 包络中心（局部） */
  center?: Vector3
}

/** 真实模型实例级姿态微调（仅作用于真实网格 mesh 本体，与组件 group 的挂载/位置/选中正交） */
export interface ComponentCadTransform {
  /** 三轴旋转（弧度） */
  rotation?: Vector3
  /** 均匀缩放（默认 1） */
  uniformScale?: number
}

/** 组件显示模式：simple=简化包络，real=真实网格实体，wireframe=真实网格线框 */
export type ComponentDisplayMode = 'simple' | 'real' | 'wireframe'

export interface SatelliteComponent {
  id: string
  projectId: string
  name: string
  type: ComponentType
  subtype: string
  position: Vector3
  rotation: Vector3
  /** 旋转矩阵 3×3（右手系，非正交优化返回；存在时 ComponentObject 优先于 rotation 欧拉角） */
  rotationMatrix?: number[][]
  scale: Vector3
  dimensions: Vector3
  properties: Record<string, unknown>
  color: string
  mass: number
  heatDissipation: number
  panelId?: string
  panelFace?: PanelFace
  /** 极性是否启用 */
  polarityEnabled?: boolean
  /** 极性法线方向 */
  polarityDirection?: Vector3
  /** 代号（与 name 分离） */
  codeName?: string
  /** 组件类别 key（引用类别注册表，支持用户自定义） */
  category?: string
  /** 震动特性勾选 */
  isVibration?: boolean
  /** 包络尺寸（CAD 导入时自动提取；导入真实模型时不覆盖，保留原有/简化包络） */
  envelope?: ComponentEnvelope
  /**
   * 真实模型包络尺寸（导入真实模型时由 CAD 提取，与 envelope 分离，供与原有/简化包络对比尺寸一致性）。
   * 仅当绑定真实模型时有值；解绑时清空。不参与布局/干涉计算（仍用 dimensions）。
   */
  realModelEnvelope?: ComponentEnvelope
  /** CAD 网格序列化数据（★已迁移至 ModelAsset.cadGeometry，此处仅向后兼容旧档） */
  cadGeometry?: CadMeshData
  /** 引用的真实模型资源 id（替代直接内嵌 cadGeometry；undefined=无真实模型，渲染简化包络） */
  modelAssetId?: string
  /** 实例级真实模型姿态微调（仅作用于真实网格 mesh 本体，与挂载/位置/选中正交） */
  cadTransform?: ComponentCadTransform
  /** 显示模式覆盖（'simple'|'real'|'wireframe'，优先于全局 componentDisplayMode；undefined=跟随全局） */
  displayModeOverride?: ComponentDisplayMode
  /** 创建对话框实时预览标记（预览组件以半透明渲染，不入库不算正式组件） */
  isPreview?: boolean
  /** 面内轮廓（uv 坐标，多边形组件精确形状渲染） */
  contour?: Vector2[]
  /** 轮廓厚度轴（挤出方向，多边形组件专用） */
  thicknessAxis?: 'x' | 'y' | 'z'
  createdAt?: string
  updatedAt?: string
}

export interface Wire {
  id: string
  projectId: string
  name?: string
  startComponentId?: string
  endComponentId?: string
  pathPoints?: Vector3[]
  wireType: WireType
  color: string
  thickness: number
  createdAt?: string
  updatedAt?: string
}

export interface SatelliteProject {
  id: string
  userId: string
  name: string
  description?: string
  satelliteDimensions: Vector3
  createdAt?: string
  updatedAt?: string
}

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface AIConversation {
  id: string
  projectId: string
  messages: AIMessage[]
  createdAt?: string
  updatedAt?: string
}

export interface PanelPreset {
  id: string
  name: string
  nameCn: string
  defaultDimensions: Vector3
  defaultColor: string
  defaultFrontFaceColor: string
  defaultBackFaceColor: string
  defaultFrontFaceProperties: PanelFaceProperties
  defaultBackFaceProperties: PanelFaceProperties
  shape: PanelShape
  icon: string
}

/**
 * 数据导入子系统（板件 / 孔位 / 元件 / 连接表 的导入文件格式）不在本 Demo 范围内 ——
 * 主项目中这四个类型来自同目录的独立模块，此处无法随测量模块一并搬迁，
 * 故以占位类型保留 ImportDataState 的结构，避免虚构并不存在的导入格式。
 */
type BoardImportFile = unknown
type HoleImportFile = unknown
type ComponentImportFile = unknown
type ConnectionTableFile = unknown

/** 导入原始数据状态（保留用户上传的原始 JSON，便于回溯和重新转换） */
export interface ImportDataState {
  boards: BoardImportFile | null
  holes: HoleImportFile | null
  components: ComponentImportFile | null
  connectionTable: ConnectionTableFile | null
  /** 最后导入时间戳 */
  importedAt: number | null
}

export interface ProjectState {
  projectId: string | null
  projectName: string
  components: SatelliteComponent[]
  wires: Wire[]
  panels: CabinPanel[]
  satelliteDimensions: Vector3
  satelliteCenter: Vector3
  importData: ImportDataState
}

export interface EditorState {
  selectedComponentId: string | null
  selectedWireId: string | null
  selectedPanelId: string | null
  tool: EditorTool
  viewMode: ViewMode
  showGrid: boolean
  showWires: boolean
  snapToGrid: boolean
  gridSize: number
}

/**
 * 编辑器视图状态快照（satelliteEditor.getViewSnapshot / applyViewSnapshot）
 * 仅视图相关字段；选中状态、撤销/重做历史等会话状态不纳入。
 * hiddenObjectIds 以数组形态序列化（Set 不能直接进 JSON）。
 */
export interface EditorViewSnapshot {
  viewMode: ViewMode
  showGrid: boolean
  showWires: boolean
  snapToGrid: boolean
  gridSize: number
  hiddenObjectIds: string[]
  /** 组件显示模式（simple/real/wireframe，缺失=默认 simple） */
  componentDisplayMode?: 'simple' | 'real' | 'wireframe'
  /** 天空盒开关（缺失=默认 true 启用；false=纯色背景省性能） */
  skyboxEnabled?: boolean
}
