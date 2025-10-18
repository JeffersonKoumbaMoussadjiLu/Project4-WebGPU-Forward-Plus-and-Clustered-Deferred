import { Mat4, mat4, Vec3, vec3 } from "wgpu-matrix";
import { toRadians } from "../math_util";
import { device, canvas, fovYDegrees, aspectRatio } from "../renderer";

/** CPU-side representation of camera uniforms (view-projection matrix, etc.) */
class CameraUniforms {
    // Allocate 16 floats (64 bytes) for the view-projection matrix.
    readonly buffer = new ArrayBuffer(52 * 4);
    private readonly floatView = new Float32Array(this.buffer);

    // Set the view-projection matrix (called each frame after computing matrices).
    set viewProjMat(mat: Float32Array) {
        // Copy 16 elements of the matrix into the uniform float array
        this.floatView.set(mat, 0);
    }

    // (Optional) Additional setters for other camera data could be added here,
    // e.g., screen size or camera position if needed for certain shaders.
}

/** CPU-side clustering uniform data: holds matrices and clustering parameters for GPU use. */
class ClusteringUniformsHost {
    // Allocate space for 3 matrices (16 floats each) + 4 floats + 4 uints.
    // That's (16*3 + 4 + 4) = 56 floats total (224 bytes).
    readonly buffer = new ArrayBuffer((16 * 3 + 4 + 4) * 4);
    private floatView = new Float32Array(this.buffer);
    private uintView  = new Uint32Array(this.buffer);

    // Offsets (in floats) for each section in the floatView
    private readonly viewMatOff = 0;    // offset for 16 floats (view matrix)
    private readonly projMatOff = 16;   // offset for 16 floats (proj matrix)
    private readonly invProjOff = 32;   // offset for 16 floats (inverse proj matrix)
    private readonly params0Off = 48;   // offset for 4 floats (screenW, screenH, near, far)
    private readonly params1Off = 52;   // offset for 4 uints  (clustersX, clustersY, clustersZ, maxLightsPerCluster)

    /** Set the view, projection, and inverse projection matrices. */
    setMatrices(viewMat: Float32Array, projMat: Float32Array, invProjMat: Float32Array) {
        // Copy each matrix (16 floats) into the appropriate section of the buffer.
        this.floatView.set(viewMat, this.viewMatOff);
        this.floatView.set(projMat, this.projMatOff);
        this.floatView.set(invProjMat, this.invProjOff);
    }

    /** Set screen size, depth range, and cluster dimensions parameters. */
    setParams(screenW: number, screenH: number, near: number, far: number,
              clustersX: number, clustersY: number, clustersZ: number, maxLightsPerCluster: number) {
        // Write screen width, height, near plane, far plane as floats.
        this.floatView[this.params0Off + 0] = screenW;
        this.floatView[this.params0Off + 1] = screenH;
        this.floatView[this.params0Off + 2] = near;
        this.floatView[this.params0Off + 3] = far;
        // Write cluster counts (X, Y, Z) and max lights per cluster as unsigned ints.
        this.uintView[this.params1Off + 0] = clustersX;
        this.uintView[this.params1Off + 1] = clustersY;
        this.uintView[this.params1Off + 2] = clustersZ;
        this.uintView[this.params1Off + 3] = maxLightsPerCluster;
    }
}

export class Camera {
    // Host-side camera uniform data (view-projection matrix).
    uniforms: CameraUniforms = new CameraUniforms();
    // GPU buffer for camera uniforms (bound to shaders).
    uniformsBuffer: GPUBuffer;
    // Host-side clustering uniform data.
    clusteringUniforms: ClusteringUniformsHost = new ClusteringUniformsHost();
    // GPU buffer for clustering uniforms.
    clusteringUniformsBuffer: GPUBuffer;

    // Camera transformation state
    projMat: Mat4 = mat4.create();
    cameraPos: Vec3 = vec3.create(-7, 2, 0);
    cameraFront: Vec3 = vec3.create(0, 0, -1);
    cameraUp: Vec3 = vec3.create(0, 1, 0);
    cameraRight: Vec3 = vec3.create(1, 0, 0);
    yaw: number = 0;
    pitch: number = 0;
    moveSpeed: number = 0.004;
    sensitivity: number = 0.15;

    // Define camera frustum and clustering parameters
    static readonly nearPlane = 0.1;
    static readonly farPlane = 1000;
    static readonly clustersX = 10;
    static readonly clustersY = 10;
    static readonly clustersZ = 32;
    static readonly maxLightsPerCluster = 512;

    // Keyboard input tracking
    keys: { [key: string]: boolean } = {};

    constructor() {
        // Create GPU buffers for camera and clustering uniforms
        this.uniformsBuffer = device.createBuffer({
            label: "Camera Uniforms",
            size: this.uniforms.buffer.byteLength + 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.clusteringUniformsBuffer = device.createBuffer({
            label: "Clustering Uniforms",
            size: this.clusteringUniforms.buffer.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Set up the projection matrix (perspective projection)
        this.projMat = mat4.perspective(
            toRadians(fovYDegrees), aspectRatio,
            Camera.nearPlane, Camera.farPlane
        );
        // Initialize camera orientation vectors based on yaw/pitch
        this.rotateCamera(0, 0);

        // Set up input event handlers for camera movement
        window.addEventListener('keydown', (event) => this.onKeyEvent(event, true));
        window.addEventListener('keyup', (event) => this.onKeyEvent(event, false));
        window.onblur = () => { this.keys = {}; }; // Clear keys if focus lost
        canvas.addEventListener('mousedown', () => canvas.requestPointerLock());
        canvas.addEventListener('mouseup', () => document.exitPointerLock());
        canvas.addEventListener('mousemove', (event) => this.onMouseMove(event));
    }

    /** Handle keyboard press/release events. */
    private onKeyEvent(event: KeyboardEvent, down: boolean) {
        this.keys[event.key.toLowerCase()] = down;
        if (this.keys['alt']) {
            // Prevent default browser shortcuts when Alt is pressed
            event.preventDefault();
        }
    }

    /** Update camera orientation (yaw and pitch) given mouse movement. */
    private rotateCamera(dx: number, dy: number) {
        this.yaw += dx;
        this.pitch -= dy;
        // Clamp pitch to avoid flipping
        if (this.pitch > 89) this.pitch = 89;
        if (this.pitch < -89) this.pitch = -89;

        // Calculate new front vector from yaw and pitch
        const front = vec3.create(
            Math.cos(toRadians(this.yaw)) * Math.cos(toRadians(this.pitch)),
            Math.sin(toRadians(this.pitch)),
            Math.sin(toRadians(this.yaw)) * Math.cos(toRadians(this.pitch))
        );
        this.cameraFront = vec3.normalize(front);
        // Recompute right and up vectors
        this.cameraRight = vec3.normalize(vec3.cross(this.cameraFront, [0, 1, 0]));
        this.cameraUp = vec3.normalize(vec3.cross(this.cameraRight, this.cameraFront));
    }

    /** Handle mouse movement events for camera orientation. */
    private onMouseMove(event: MouseEvent) {
        if (document.pointerLockElement === canvas) {
            // Apply sensitivity scaling to raw mouse movement
            this.rotateCamera(event.movementX * this.sensitivity, event.movementY * this.sensitivity);
        }
    }

    /** Process keyboard input for camera movement each frame. */
    private processInput(deltaTime: number) {
        let moveDir = vec3.create(0, 0, 0);
        if (this.keys['w']) {
            moveDir = vec3.add(moveDir, this.cameraFront);
        }
        if (this.keys['s']) {
            moveDir = vec3.sub(moveDir, this.cameraFront);
        }
        if (this.keys['a']) {
            moveDir = vec3.sub(moveDir, this.cameraRight);
        }
        if (this.keys['d']) {
            moveDir = vec3.add(moveDir, this.cameraRight);
        }
        if (this.keys['q']) {
            moveDir = vec3.sub(moveDir, [0, 1, 0]); // down
        }
        if (this.keys['e']) {
            moveDir = vec3.add(moveDir, [0, 1, 0]); // up
        }
        // Normalize move direction so diagonal movement isn't faster
        moveDir = vec3.normalize(moveDir);
        // Move camera position by the computed direction scaled by speed and deltaTime
        const velocity = this.moveSpeed * deltaTime;
        this.cameraPos = vec3.add(this.cameraPos, vec3.scale(moveDir, velocity));
    }

    /** Update camera matrices and upload uniforms each frame. Should be called every frame. */
    onFrame(deltaTime: number) {
        this.processInput(deltaTime);
        // Compute the view matrix from camera position and orientation
        const target = vec3.add(this.cameraPos, this.cameraFront);  // point camera is looking at
        const viewMat = mat4.lookAt(this.cameraPos, target, [0, 1, 0]);
        // Compute combined view-projection matrix
        const viewProjMat = mat4.mul(this.projMat, viewMat);
        // Set camera uniform data
        this.uniforms.viewProjMat = new Float32Array(viewProjMat);
        // Upload camera matrix to GPU
        device.queue.writeBuffer(this.uniformsBuffer, 0, this.uniforms.buffer);

        // Also update clustering uniforms:
        const invProjMat = mat4.invert(this.projMat);
        const screenW = canvas.width;
        const screenH = canvas.height;
        // Provide view, projection, and inverse projection matrices to clustering uniforms
        this.clusteringUniforms.setMatrices(
            new Float32Array(viewMat),
            new Float32Array(this.projMat),
            new Float32Array(invProjMat)
        );
        // Provide screen size, depth range, and clustering parameters
        this.clusteringUniforms.setParams(
            screenW, screenH,
            Camera.nearPlane, Camera.farPlane,
            Camera.clustersX, Camera.clustersY, Camera.clustersZ,
            Camera.maxLightsPerCluster
        );
        // Upload updated clustering uniform data to GPU
        device.queue.writeBuffer(this.clusteringUniformsBuffer, 0, this.clusteringUniforms.buffer);
    }
}
