import * as THREE from 'three';
import { Viewer } from '@/engine/Viewer';

/**
 * 事件处理器接口
 * 定义了所有事件处理器必须实现的方法
 */
export interface IEventHandler {
    /**
     * 初始化处理器（可选）
     */
    init?(): void;

    /**
     * 指针按下事件
     */
    pointerDown(viewer: Viewer, event: PointerEvent): void;

    /**
     * 指针移动事件
     */
    pointerMove(viewer: Viewer, event: PointerEvent): void;

    /**
     * 指针抬起事件
     */
    pointerUp(viewer: Viewer, event: PointerEvent): void;

    /**
     * 指针离开事件（可选）
     */
    pointerOut?(viewer: Viewer, event: PointerEvent): void;

    /**
     * 滚轮事件（可选）
     */
    wheel?(viewer: Viewer, event: WheelEvent): void;

    /**
     * 键盘按下事件（可选）
     */
    keyDown?(viewer: Viewer, event: KeyboardEvent): void;

    /**
     * 键盘抬起事件（可选）
     */
    keyUp?(viewer: Viewer, event: KeyboardEvent): void;

    /**
     * 双击事件（可选）
     */
    doubleClick?(viewer: Viewer, event: PointerEvent): void;

    /**
     * 清理资源（可选）
     */
    dispose?(): void;

    /**
     * 获取处理器名称
     */
    getName(): string;

    /**
     * 获取处理器描述
     */
    getDescription(): string;

    /**
     * 激活框选模式（可选）
     */
    activateMarquee?(): void;
}

/**
 * 基础事件处理器抽象类
 * 提供了通用的功能实现
 */
export abstract class BaseEventHandler implements IEventHandler {
    protected viewer: Viewer;
    protected raycaster: THREE.Raycaster;
    protected mouse: THREE.Vector2;

    constructor(viewer: Viewer) {
        this.viewer = viewer;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
    }
    init?(): void {
        console.log(`[${this.getName()}] 初始化事件处理器`);
    }

    activateMarquee(): void {

    }
    pointerDown(viewer: Viewer, event: PointerEvent): void {
        // console.log(`[${this.getName()}] 指针按下事件:`, {
        //     clientX: event.clientX,
        //     clientY: event.clientY,
        //     pointerId: event.pointerId,
        //     button: event.button,
        //     target: event.target
        // });
    }
    pointerMove(viewer: Viewer, event: PointerEvent): void {
        // console.log(`[${this.getName()}] 指针移动事件:`, {
        //     clientX: event.clientX,
        //     clientY: event.clientY,
        //     pointerId: event.pointerId,
        //     movementX: event.movementX,
        //     movementY: event.movementY
        // });
    }
    pointerUp(viewer: Viewer, event: PointerEvent): void {
        // console.log(`[${this.getName()}] 指针抬起事件:`, {
        //     clientX: event.clientX,
        //     clientY: event.clientY,
        //     pointerId: event.pointerId,
        //     button: event.button
        // });
    }
    pointerOut?(viewer: Viewer, event: PointerEvent): void {
        // console.log(`[${this.getName()}] 指针离开事件:`, {
        //     clientX: event.clientX,
        //     clientY: event.clientY,
        //     pointerId: event.pointerId,
        //     relatedTarget: event.relatedTarget
        // });
    }
    wheel?(viewer: Viewer, event: WheelEvent): void {
        // console.log(`[${this.getName()}] 滚轮事件:`, {
        //     clientX: event.clientX,
        //     clientY: event.clientY,
        //     deltaX: event.deltaX,
        //     deltaY: event.deltaY,
        //     deltaZ: event.deltaZ,
        //     deltaMode: event.deltaMode
        // });
    }
    keyDown?(viewer: Viewer, event: KeyboardEvent): void {
        // console.log(`[${this.getName()}] 键盘按下事件:`, {
        //     key: event.key,
        //     code: event.code,
        //     ctrlKey: event.ctrlKey,
        //     shiftKey: event.shiftKey,
        //     altKey: event.altKey,
        //     metaKey: event.metaKey,
        //     repeat: event.repeat,
        //     location: event.location
        // });
    }
    keyUp?(viewer: Viewer, event: KeyboardEvent): void {
        // console.log(`[${this.getName()}] 键盘抬起事件:`, {
        //     key: event.key,
        //     code: event.code,
        //     ctrlKey: event.ctrlKey,
        //     shiftKey: event.shiftKey,
        //     altKey: event.altKey,
        //     metaKey: event.metaKey,
        //     repeat: event.repeat,
        //     location: event.location
        // });
    }
    doubleClick?(viewer: Viewer, event: PointerEvent): void {
        // console.log(`[${this.getName()}] 双击事件:`, {
        //     clientX: event.clientX,
        //     clientY: event.clientY,
        //     button: event.button,
        //     pointerId: event.pointerId
        // });
    }
    dispose?(): void {
        console.log(`[${this.getName()}] 清理事件处理器资源`);
    }


    /**
     * 将鼠标位置转换为标准化设备坐标
     */
    protected screenToNDC(event: PointerEvent): THREE.Vector2 {
        const rect = this.viewer.getRenderer().domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        return this.mouse;
    }

    /**
     * 射线检测
     *
     * 防御性 try/catch：当目标对象中存在损坏的几何体（如材质分组越界导致
     * material[materialIndex] 为 undefined，Three.js raycaster 会抛
     * "Cannot read properties of undefined (reading 'side')"）时，
     * 整个 intersectObjects 会中断，进而让 hover/点击拾取全面瘫痪。
     * 捕获后降级为"本轮无命中"，避免单个坏对象拖垮整画布交互。
     */
    protected raycast(event: PointerEvent, objects?: THREE.Object3D[]): THREE.Intersection[] {
        const ndc = this.screenToNDC(event);
        this.raycaster.setFromCamera(ndc, this.viewer.getCamera());

        const targetObjects = objects || this.viewer.getScene().children;
        try {
            return this.raycaster.intersectObjects(targetObjects, true);
        } catch (err) {
            console.warn('[raycast] 拾取异常，本轮已跳过:', err);
            return [];
        }
    }

    /**
     * 获取第一个相交的对象
     */
    protected getFirstIntersection(event: PointerEvent, objects?: THREE.Object3D[]): THREE.Object3D | null {
        const intersections = this.raycast(event, objects);
        if (intersections.length > 0) {
            return intersections[0].object;
        }
        return null;
    }

    /**
     * 获取相交的对象列表
     */
    protected getIntersections(event: PointerEvent, objects?: THREE.Object3D[]): THREE.Object3D[] {
        const intersections = this.raycast(event, objects);
        return intersections.map(intersection => intersection.object);
    }

    /**
     * 更新渲染
     */
    protected updateViewer(): void {
        this.viewer.update();
    }

    abstract getName(): string;
    abstract getDescription(): string;
}