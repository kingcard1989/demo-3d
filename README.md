# 技术展示 · 3D 可视化与空间索引

两个可在线访问的演示页，分别展示**八叉树碰撞检测优化**与**交互式三维测量**两项能力。
页面代码从工程项目中抽取，不是为演示而写的简化版——三维内核与算法实现均为原样复用。

**在线演示**：https://kingcard1989.github.io/demo-3d/

---

## 一、两个演示

### 1. 八叉树碰撞检测（`/#/octree`）

用真实的八叉树实现跑「大量 AABB 包围盒两两求交」，并与暴力双重循环实时对比。

| 对比项 | 暴力 O(n²) | 八叉树 |
| --- | --- | --- |
| 检测次数 | n(n-1)/2，全部两两检测 | 仅查询局部区域内的候选元素 |
| 耗时 | 纯计算 | 建树 + 查询（分开计时） |

- 规模可选 50 / 200 / 1000 / 5000，**空间尺度随规模自动放大**，把填充率固定在 6%——
  否则 N 越大场景越拥挤，加速比会被密度变化掩盖，失去可比性。
- 每轮跑 3 次取**中位数**抗抖动；随机数用固定种子的 mulberry32，同一组参数每次生成同一批数据，结果可复现。
- **结果一致性自动校验**：八叉树只做剪枝，不改变碰撞对集合。页面每次都会比对两种算法产出的
  碰撞对是否完全一致，并显示校验结果——这是「优化没有改变语义」的直接证据。
- 树结构线框按深度着色（浅青 → 洋红），`capacity` 与 `maxDepth` 可实时调整并观察空间划分变化。

> 计时口径说明：八叉树耗时 = 建树 + 查询。暴力算法无需预处理，这样对比才是公平的。

### 2. 3D 测量（`/#/measure`）

完整的 CAD 式交互测量：左键点选几何元素，自动判定吸附层级并生成标注。

- **10 种测量类型**：点对点 / 点对线 / 线对线 / 线对面 / 面对面的距离与夹角，以及半径。
- **三级吸附**：优先吸附到包络盒顶点（14px 阈值）→ 其次最近棱边（10px）→ 最后落到表面交点并记录面法线。
  阈值以**屏幕像素**给定，再按深度换算成世界距离，因此镜头拉远拉近时吸附手感一致。
- **渲染**：标注线用 `Line2` / `LineMaterial` 绘制可变宽度粗线，数值标签用 `Sprite` + CanvasTexture，
  随视角缩放保持像素级可读（不是把文字烘进场景几何）。
- **角度类**额外绘制圆弧与射线，面面夹角按两平面法线求二面角，并做平行性判定。
- 标注绑定被测物体的**局部坐标**，物体移动后可重新求解世界位置；支持撤销与单条删除。

场景为 3 块舱板 + 10 台设备，单位为毫米，未做任何等比缩放，因此测量数值即实际尺寸。

---

## 二、代码构成

### 原样复用（4647 行，仅修改 import 路径）

| 路径 | 行数 | 说明 |
| --- | ---: | --- |
| `src/core/measure/MeasurementObject.ts` | 1977 | 标注 3D 对象工厂：粗线、弧线、十字标记、标签 Sprite |
| `src/core/measure/MeasurementEventHandler.ts` | 1278 | 拾取状态机：射线检测、三级吸附、各类测量的求解与校验 |
| `src/core/measure/geometryUtils.ts` | 463 | 纯几何工具：包围盒顶点/棱边/面心/面法线、射线与线段最近点、屏幕像素→世界距离换算 |
| `src/core/measure/satelliteTypes.ts` | 379 | 领域类型定义 |
| `src/core/measure/IEventHandler.ts` | 236 | 事件处理器接口与抽象基类 |
| `src/core/spatial/Octree.ts` | 160 | 泛型八叉树（零依赖纯 TypeScript） |
| `src/core/measure/measurementStore.ts` | 137 | 测量状态与标注存储 |
| `src/core/spatial/types.ts` | 17 | `BBox3D` / `OctreeItem` |

`Octree.ts` 另有 18 行新增的 `collectNodes()` 只读遍历方法——原实现不暴露内部节点，
演示需要把树结构画出来才补的，已在源码中标注「Demo 新增」，与算法本身无关。

### 新写的适配层（2474 行）

| 路径 | 行数 | 说明 |
| --- | ---: | --- |
| `src/views/OctreeDemo.vue` | 782 | 八叉树演示页：数据生成、两种算法对比、实例化渲染、树线框 |
| `src/views/MeasureDemo.vue` | 582 | 测量演示页：场景搭建、事件接线、工具栏、标注列表 |
| `src/engine/Viewer.ts` | 265 | 精简引擎：场景/相机/渲染器/轨道控制/事件转发 |
| `src/views/HomeView.vue` | 202 | 首页 |
| `src/engine/SatelliteSceneManager.ts` | 180 | 精简场景管理器：按数据生成包络盒，提供拾取目标 |
| `src/stores/demoStores.ts` | 105 | DesignStore / EditorStore 的最小实现（+ 撤销栈） |
| `src/data/demoScene.ts` | 109 | 演示场景数据 |
| `src/utils/message.ts` | 78 | 轻量消息提示（替代 Element Plus 的 `ElMessage`） |
| 其余（路由、外壳、入口） | 171 | — |

**能低成本搬迁的关键，是原代码的依赖面极窄**——接入前逐处核对过：

- `MeasurementObject` 只用到 DesignStore 的 `updateMeasurement(id, worldPoints)` 一个方法；
- `MeasurementEventHandler` 只用到 Viewer 的 3 个方法（`getCamera` / `update` / `setForceRender`）、
  SceneManager 的 4 个方法（`getSelectableObjects` / `getComponentMeshes` / `getPanelMeshes` / `identifyObject`），
  以及 EditorStore 的 `setTool`。

因此适配层只要用**同样的类名与方法签名**实现这些能力，复制的算法代码就无需任何逻辑改动。

---

## 三、本地运行

```bash
pnpm install
pnpm dev        # 开发服务器
pnpm build      # 产物输出到 dist/
pnpm preview    # 以静态服务预览构建产物（等价 GitHub Pages 的加载方式）
```

技术栈：Vue 3.4 · TypeScript 5.3 · Three.js r183 · Pinia 2.1 · Vite 5。
三维部分只依赖 Three.js；八叉树与几何工具为零依赖纯 TypeScript。全站静态，无后端。

---

## 四、部署到 GitHub Pages

1. 新建一个公开仓库，把本目录推上去（默认分支 `main`）：

   ```bash
   git init
   git add .
   git commit -m "技术展示：八叉树碰撞检测与 3D 测量"
   git branch -M main
   git remote add origin https://github.com/kingcard1989/demo-3d.git
   git push -u origin main
   ```

2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。

3. 推送到 `main` 即自动触发 `.github/workflows/deploy.yml`：构建 + 部署，产物地址在 Actions 的
   `deploy` 任务里可以看到。首次部署约 1~2 分钟。

> 已做两处适配，避免静态托管的常见坑：
> - `vite.config.ts` 设 `base: './'`——Pages 部署在 `用户名.github.io/仓库名/` 子路径下，绝对路径资源会 404；
> - 路由用 **hash 模式**——Pages 无法配置服务端 rewrite，history 模式下直接访问 `/octree` 会 404。

---

## 五、实现观察

把工程代码搬过来并开启完整类型检查后，有几处值得记录。**下面三条都不影响功能正确性**，
本次演示按「不改动被复用代码的行为」处理，仅此登记。

### 1. 八叉树的 `maxDepth` 不是绝对深度上限

`subdivide()` 把父节点元素重新插入子节点时，传入的深度是 `0`（`Octree.ts` 中
`this.insertInto(node, item, 0)`），而不是「当前节点深度 + 1」。因此 `maxDepth` 实际是
**每条插入路径上的分裂深度阈值**：重新分配的元素会在子节点里重新从 0 累计，树的实际最大深度
可能超过配置值。

不影响碰撞检测结果（页面的结果一致性校验始终通过），但演示页因此把「实际最大深度」单独列出作为观察项。

### 2. `renderOrder` 被设置在了 Material 上

`MeasurementObject.ts` 中有两处 `mat.renderOrder = …`，注释写的意图是「提升渲染序，
绘制在面板表面之上」。但 three.js 的 `renderOrder` 属于 `Object3D` 而非 `Material`，
对材质赋值不产生任何渲染效果。

高亮的可见性实际上是由同一处设置的 `depthTest: false` 保证的——所以功能一直正常，
只是「提高渲染序」这半句意图从未生效。

> 本次处理：**移除了这两次无效赋值并加注说明，渲染行为保持不变**。
> 若要让原注释的意图真正生效，应改为设置在创建出的 `Line2` / `Mesh` 对象上
> （即 `line.renderOrder = 900`）。这一步会改变渲染顺序，属于行为变更，本次未做。

### 3. 像素阈值换算依赖 `camera.viewport`

`geometryUtils.screenPxToWorldDistance` 用 `camera.viewport?.h` 把屏幕像素阈值换算成世界距离，
而工程代码中**没有任何地方给 `camera.viewport` 赋值**，因此该换算始终回退到硬编码的 `1080`——
只有当画布恰好 1080px 高时，`14px / 10px` 这两个阈值才严格准确。

Demo 在 `Viewer` 里显式写入了真实画布高度（画布尺寸变化时同步更新），使阈值在任意窗口尺寸下
都精确成立。这是适配层的行为，不涉及被复用的算法代码。

### 附带：工程当前的 type-check 未覆盖到这些语义错误

`node_modules` 里同时装有 `three@0.183.2` 与 `@types/three@0.182.0`（工程与 Demo 版本一致）。
用探针验证过：在工程所用的 `moduleResolution: "node"` 与 Demo 所用的 `"bundler"` 两种解析模式下，
`three` 都能正常拿到 `@types/three` 的类型，`new THREE.MeshBasicMaterial().renderOrder = 5`
这一行在两种模式下、在 `strict` 开与关两种设置下**都会报 TS2339**。

然而在工程项目里执行 `pnpm type-check`（`vue-tsc --noEmit`），输出只有 3 个配置级错误：

```
error TS6504: File '.../src/views/error/403.vue.js' is a JavaScript file.
  The file is in the program because: Root file specified for compilation
（404.vue.js、loading.vue.js 同）
```

**没有任何语义错误**，包括上面第 2 条那两个 `renderOrder`。也就是说，工程当前的 type-check
并没有真正跑到这部分的语义检查——最可能的原因是这 3 个 `.vue.js` 影子文件被当作根文件且无法加载，
配置级错误之后语义检查没有继续（此点在 Demo 中未能复现，故仅作为推断记录）。

Demo 使用 `moduleResolution: "bundler"` + `strict: true`，三维代码获得完整类型检查；
把第 2 条的无效赋值去掉后，`pnpm type-check` 零错误。
