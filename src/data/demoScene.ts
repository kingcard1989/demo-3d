// Demo 场景数据 —— 一个简化的卫星设备布局（世界坐标单位：mm）
//
// 数据形状刻意与主项目的 CabinPanel / SatelliteComponent 对齐：
// 测量模块读取的 `dimensions`（包络盒尺寸）与 `position`（几何中心）
// 语义完全一致，因此复制的测量代码无需任何改动即可工作。

import type {
  CabinPanel,
  SatelliteComponent,
  PanelFaceProperties,
} from '@/core/measure/satelliteTypes'

const PROJECT_ID = 'demo-project'

/** 载荷面属性占位（Demo 不涉及布局优化，字段留默认值） */
function faceProps(): PanelFaceProperties {
  return {
    canLayout: true,
    heatDissipationLevel: 1,
    loadBearingLevel: 1,
    contourPoints: [],
  }
}

function panel(
  id: string,
  name: string,
  dimensions: { x: number; y: number; z: number },
  position: { x: number; y: number; z: number },
  color: string,
): CabinPanel {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    position,
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    dimensions,
    shape: 'rect',
    color,
    frontFaceColor: color,
    backFaceColor: color,
    frontFaceProperties: faceProps(),
    backFaceProperties: faceProps(),
    maximumLoadCapacity: -1,
  }
}

function component(
  id: string,
  name: string,
  dimensions: { x: number; y: number; z: number },
  position: { x: number; y: number; z: number },
  color: string,
  mass: number,
): SatelliteComponent {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    type: 'electronic',
    subtype: 'box',
    position,
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    dimensions,
    properties: {},
    color,
    mass,
    heatDissipation: 0,
  }
}

// 舱板：底板（顶面落在 y=0）+ 南北两块立板，构成一个开口朝上的舱体
const PANEL_COLOR = '#3a4657'

const PANELS: CabinPanel[] = [
  // 底板：厚 30，中心 y=-15 → 顶面恰在 y=0
  panel('panel-floor', 'C-底板', { x: 2200, y: 30, z: 1600 }, { x: 0, y: -15, z: 0 }, PANEL_COLOR),
  // 南板 / 北板：厚 30，中心 x=∓1085 → 内表面在 x=∓1070
  panel('panel-south', 'S-南舱板', { x: 30, y: 900, z: 1600 }, { x: -1085, y: 450, z: 0 }, PANEL_COLOR),
  panel('panel-north', 'N-北舱板', { x: 30, y: 900, z: 1600 }, { x: 1085, y: 450, z: 0 }, PANEL_COLOR),
]

/** 设备盒：底面贴合底板（y 从 0 起），各盒互不干涉 */
const COMPONENTS: SatelliteComponent[] = [
  component('comp-01', '电源控制器', { x: 300, y: 180, z: 240 }, { x: -700, y: 90, z: -400 }, '#4a7fb5', 12.5),
  component('comp-02', '配电器',     { x: 260, y: 160, z: 200 }, { x: -700, y: 80, z: 100 }, '#5b8fc7', 8.2),
  component('comp-03', '星载计算机', { x: 240, y: 200, z: 220 }, { x: 0,    y: 100, z: -500 }, '#c78b4a', 9.6),
  component('comp-04', '数据存储器', { x: 220, y: 140, z: 200 }, { x: 0,    y: 70, z: -100 }, '#d19a5c', 6.4),
  component('comp-05', '陀螺组件',   { x: 180, y: 180, z: 180 }, { x: 0,    y: 90, z: 300 },  '#6fae7a', 5.1),
  component('comp-06', '磁力矩器',   { x: 360, y: 120, z: 180 }, { x: 700,  y: 60, z: -450 }, '#54a06b', 4.8),
  component('comp-07', '蓄电池组',   { x: 420, y: 200, z: 260 }, { x: 700,  y: 100, z: 50 },  '#b5544f', 28.0),
  component('comp-08', '测控应答机', { x: 280, y: 150, z: 200 }, { x: 700,  y: 75, z: 420 },  '#c2645e', 7.3),
  component('comp-09', '载荷电子箱', { x: 320, y: 220, z: 260 }, { x: -350, y: 110, z: 500 }, '#8a6fbf', 14.1),
  component('comp-10', '电缆网盒',   { x: 200, y: 100, z: 160 }, { x: 350,  y: 50, z: 500 },  '#9a7fc9', 3.2),
]

/** 返回一份全新的场景数据（避免调用方之间共享可变对象） */
export function createDemoScene(): {
  panels: CabinPanel[]
  components: SatelliteComponent[]
} {
  return {
    panels: JSON.parse(JSON.stringify(PANELS)),
    components: JSON.parse(JSON.stringify(COMPONENTS)),
  }
}
