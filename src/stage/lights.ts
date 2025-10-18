import { vec3 } from "wgpu-matrix";
//import { device, canvas } from "../renderer";
import { device } from "../renderer";
import * as shaders from "../shaders/shaders";
import { Camera } from "./camera";

/** Helper to get a nice color from a hue value for light coloring. */
function hueToRgb(h: number) {
    // Generates an RGB color from a hue [0,1] with pastel-like colors
    let f = (n: number, k = (n + h * 6) % 6) => 1 - Math.max(Math.min(k, 4 - k, 1), 0);
    // Interpolate between white and the color on the hue circle to lighten it
    return vec3.lerp(vec3.create(1, 1, 1), vec3.create(f(5), f(3), f(1)), 0.8);
}

export class Lights {
    private camera: Camera;

    // Current number of active point lights in the scene
    numLights = 200;
    static readonly maxNumLights = 5000;
    // Number of floats per light entry (8 floats: pos(3)+pad, color(3)+pad)
    static readonly numFloatsPerLight = 8;
    // Base light intensity for all lights (used to scale colors)
    static readonly lightIntensity = 0.1;

    // Typed array for initializing light data (positions are initially set by compute shader)
    lightsArray = new Float32Array(Lights.maxNumLights * Lights.numFloatsPerLight);
    // GPU storage buffer containing all light data (including count)
    lightSetStorageBuffer: GPUBuffer;

    // GPU uniform buffer for time (passed to compute shader to animate lights)
    timeUniformBuffer: GPUBuffer;
    // Bind group and pipeline for the compute shader that moves lights
    moveLightsComputeBindGroupLayout: GPUBindGroupLayout;
    moveLightsComputeBindGroup: GPUBindGroup;
    moveLightsComputePipeline: GPUComputePipeline;

    // GPU buffers for clustering results
    clusterCountsBuffer: GPUBuffer;
    clusterIndicesBuffer: GPUBuffer;
    // Bind group and pipeline for the clustering compute shader
    clusteringComputeBindGroupLayout: GPUBindGroupLayout;
    clusteringComputeBindGroup: GPUBindGroup;
    clusteringComputePipeline: GPUComputePipeline;

    constructor(camera: Camera) {
        this.camera = camera;
        // Create the storage buffer for lights. We allocate enough space for:
        // - a 16-byte header (to store numLights and padding),
        // - plus space for maxNumLights * 8 floats (32 bytes each light).
        this.lightSetStorageBuffer = device.createBuffer({
            label: "lights",
            size: 16 + this.lightsArray.byteLength,  // include 16 bytes for count and alignment
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        // Initialize the light buffer with random colors and initial positions.
        this.populateLightsBuffer();
        // Upload the initial number of lights to the buffer (at offset 0)
        this.updateLightSetUniformNumLights();

        // Create a small uniform buffer for time, to control light movement in the compute shader.
        this.timeUniformBuffer = device.createBuffer({
            label: "time uniform",
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Set up the compute pipeline to animate (move) lights over time.
        this.moveLightsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "move lights compute bind group layout",
            entries: [
                { // Binding 0: lights buffer (storage for read/write by compute)
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                { // Binding 1: time uniform (read-only uniform for compute)
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" }
                }
            ]
        });
        this.moveLightsComputeBindGroup = device.createBindGroup({
            label: "move lights compute bind group",
            layout: this.moveLightsComputeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.lightSetStorageBuffer } },
                { binding: 1, resource: { buffer: this.timeUniformBuffer } }
            ]
        });
        this.moveLightsComputePipeline = device.createComputePipeline({
            label: "move lights compute pipeline",
            layout: device.createPipelineLayout({
                label: "move lights compute pipeline layout",
                bindGroupLayouts: [ this.moveLightsComputeBindGroupLayout ]
            }),
            compute: {
                module: device.createShaderModule({
                    label: "move lights compute shader",
                    code: shaders.moveLightsComputeSrc  // WGSL shader that animates light positions
                }),
                entryPoint: "main"
            }
        });

        // ** Initialize resources for light clustering **

        // Create storage buffers for cluster data:
        const clustersX = Camera.clustersX;
        const clustersY = Camera.clustersY;
        const clustersZ = Camera.clustersZ;
        const maxLightsPerCluster = Camera.maxLightsPerCluster;
        const numClusters = clustersX * clustersY * clustersZ;
        // Buffer for light counts per cluster (one u32 per cluster)
        this.clusterCountsBuffer = device.createBuffer({
            label: "cluster light counts",
            size: numClusters * 4,  // one 4-byte uint per cluster
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        // Buffer for light indices per cluster. Each cluster can hold up to maxLightsPerCluster indices.
        this.clusterIndicesBuffer = device.createBuffer({
            label: "cluster light indices",
            size: numClusters * maxLightsPerCluster * 4,  // each index is a 4-byte uint
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });

        // Create the bind group layout for the clustering compute shader.
        this.clusteringComputeBindGroupLayout = device.createBindGroupLayout({
            label: "clustering compute bind group layout",
            entries: [
                { // Binding 0: clustering uniforms (view/proj matrices, screen size, etc.)
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" }
                },
                { // Binding 1: lightSet buffer (read-only lights data)
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" }
                },
                { // Binding 2: clusterCounts buffer (writeable storage for counts)
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                { // Binding 3: clusterIndices buffer (writeable storage for indices)
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                }
            ]
        });
        this.clusteringComputeBindGroup = device.createBindGroup({
            label: "clustering compute bind group",
            layout: this.clusteringComputeBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.clusteringUniformsBuffer } },
                { binding: 1, resource: { buffer: this.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.clusterCountsBuffer } },
                { binding: 3, resource: { buffer: this.clusterIndicesBuffer } }
            ]
        });
        this.clusteringComputePipeline = device.createComputePipeline({
            label: "clustering compute pipeline",
            layout: device.createPipelineLayout({
                label: "clustering compute pipeline layout",
                bindGroupLayouts: [ this.clusteringComputeBindGroupLayout ]
            }),
            compute: {
                module: device.createShaderModule({
                    label: "clustering compute shader",
                    code: shaders.clusteringComputeSrc  // WGSL shader for clustering lights into clusters
                }),
                entryPoint: "main"
            }
        });
    }

    /** Populate the light buffer with initial data (random light colors, initial positions default to 0). */
    private populateLightsBuffer() {
        for (let lightIdx = 0; lightIdx < Lights.maxNumLights; ++lightIdx) {
            // Note: light positions are set by the moveLights compute shader each frame, 
            // so we don't initialize positions here (they default to 0).
            // Initialize each light's color to a random hue scaled by intensity.
            const lightColor = vec3.scale(hueToRgb(Math.random()), Lights.lightIntensity);
            // Place the light color values into the lightsArray. 
            // The color is stored starting at offset 4 of each light (first 3 floats are pos, then 1 padding, then 3 floats color).
            this.lightsArray.set(lightColor, (lightIdx * Lights.numFloatsPerLight) + 4);
        }
        // Upload the initial light colors to the GPU (starting at byte offset 16 to skip the count).
        device.queue.writeBuffer(this.lightSetStorageBuffer, 16, this.lightsArray);
    }

    /** Update the number of active lights in the GPU buffer (writes to the buffer's first 4 bytes). */
    updateLightSetUniformNumLights() {
        device.queue.writeBuffer(
            this.lightSetStorageBuffer,
            0,
            new Uint32Array([this.numLights])
        );
    }

    /**
     * Perform light clustering by dispatching the clustering compute shader.
     * This will fill clusterCountsBuffer and clusterIndicesBuffer based on the current light positions.
     */
    doLightClustering(encoder: GPUCommandEncoder) {
        const pass = encoder.beginComputePass({ label: "clustering compute pass" });
        // Use the clustering compute pipeline
        pass.setPipeline(this.clusteringComputePipeline);
        // Bind the clustering uniforms and buffers (camera, lights, cluster output buffers)
        pass.setBindGroup(0, this.clusteringComputeBindGroup);
        // Dispatch enough workgroups to cover all clusters
        const numClusters = Camera.clustersX * Camera.clustersY * Camera.clustersZ;
        const workgroupSize = 64;  // must match the @workgroup_size in the shader
        // Calculate number of workgroups needed (ceil division of numClusters by workgroupSize)
        const numWorkgroups = Math.ceil(numClusters / workgroupSize);
        pass.dispatchWorkgroups(numWorkgroups);
        pass.end();
    }

    /** Advance the simulation for lights (to be called each frame before rendering). */
    onFrame(time: number) {
        // Update the time uniform (in milliseconds or any time unit desired)
        device.queue.writeBuffer(this.timeUniformBuffer, 0, new Float32Array([time]));
        // Dispatch the light movement compute shader to update light positions.
        const encoder = device.createCommandEncoder();
        const computePass = encoder.beginComputePass({ label: "move lights compute pass" });
        computePass.setPipeline(this.moveLightsComputePipeline);
        computePass.setBindGroup(0, this.moveLightsComputeBindGroup);
        // We dispatch enough workgroups such that all lights are processed.
        // The workgroup size is defined by moveLightsWorkgroupSize in shader constants (e.g., 128).
        const workgroupSize = shaders.constants.moveLightsWorkgroupSize;
        const numWorkgroups = Math.ceil(Lights.maxNumLights / workgroupSize);
        computePass.dispatchWorkgroups(numWorkgroups);
        computePass.end();
        device.queue.submit([encoder.finish()]);
    }
}
