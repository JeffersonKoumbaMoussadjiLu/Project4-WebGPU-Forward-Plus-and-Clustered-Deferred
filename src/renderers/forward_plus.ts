import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';
//import { Camera } from '../stage/camera';

export class ForwardPlusRenderer extends renderer.Renderer {
    // GPU resources for Forward+ rendering
    sceneBindGroupLayout: GPUBindGroupLayout;
    sceneBindGroup: GPUBindGroup;
    depthTexture: GPUTexture;
    depthTextureView: GPUTextureView;
    pipeline: GPURenderPipeline;

    constructor(stage: Stage) {
        super(stage);

        // Create a bind group layout for the scene data (camera, lights, clustering info)
        this.sceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "Forward+ scene bind group layout",
            entries: [
                { // Binding 0: Camera uniforms (viewProj matrix)
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                { // Binding 1: Light data buffer (read-only storage)
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                },
                { // Binding 2: Clustering uniform buffer (view, proj, screen info)
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                { // Binding 3: Cluster light counts buffer (read-only storage)
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                },
                { // Binding 4: Cluster light indices buffer (read-only storage)
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                }
            ]
        });

        // Create the scene bind group, binding actual GPU buffers to the layout.
        this.sceneBindGroup = renderer.device.createBindGroup({
            label: "forward+ scene bind group",
            layout: this.sceneBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },               // camera viewProj matrix
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },       // all lights data
                { binding: 2, resource: { buffer: this.camera.clusteringUniformsBuffer } },    // clustering parameters (view/proj matrices, etc.)
                { binding: 3, resource: { buffer: this.lights.clusterCountsBuffer } },         // per-cluster light counts
                { binding: 4, resource: { buffer: this.lights.clusterIndicesBuffer } }         // flattened list of light indices for clusters
            ]
        });

        // Create a depth texture for depth testing (Forward+ uses depth buffer for proper rendering order)
        this.depthTexture = renderer.device.createTexture({
            label: "forward+ depth",
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.depthTextureView = this.depthTexture.createView();

        // Create the render pipeline for Forward+ rendering.
        this.pipeline = renderer.device.createRenderPipeline({
            label: "Forward+ pipeline",
            layout: renderer.device.createPipelineLayout({
                label: "Forward+ pipeline layout",
                bindGroupLayouts: [
                    this.sceneBindGroupLayout,          // group0: scene (camera, lights, clusters)
                    renderer.modelBindGroupLayout,      // group1: model (per-object transform)
                    renderer.materialBindGroupLayout    // group2: material (textures/samplers)
                ]
            }),
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus"
            },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "naive vert shader",
                    code: shaders.naiveVertSrc  // reuse the naive vertex shader for simple vertex transform
                }),
                entryPoint: "main",
                buffers: [ renderer.vertexBufferLayout ]  // position, normal, uv
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "Forward+ fragment shader",
                    code: shaders.forwardPlusFragSrc    // Forward+ fragment shader with clustered lighting
                }),
                entryPoint: "main",
                targets: [
                    { format: renderer.canvasFormat }   // render to the canvas swapchain format
                ]
            }
        });
    }

    override draw() {
        // Encode rendering commands for this frame
        const encoder = renderer.device.createCommandEncoder();

        // 1. Update the cluster light lists by running the clustering compute shader.
        this.lights.doLightClustering(encoder);

        // 2. Begin the main render pass for Forward+.
        const canvasTextureView = renderer.context.getCurrentTexture().createView();
        const renderPass = encoder.beginRenderPass({
            label: "Forward+ render pass",
            colorAttachments: [
                {
                    view: canvasTextureView,
                    clearValue: [0, 0, 0, 0],      // clear to black
                    loadOp: "clear",
                    storeOp: "store"
                }
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,        // clear depth to far (1.0)
                depthLoadOp: "clear",
                depthStoreOp: "store"
            }
        });

        // Use the Forward+ pipeline (with clustered shading in fragment shader)
        renderPass.setPipeline(this.pipeline);
        // Bind the scene data (camera, lights, cluster buffers) to group 0
        renderPass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneBindGroup);

        // Draw all objects in the scene
        this.scene.iterate(
            (node) => {
                // For each model node: bind its transformation matrix (group1)
                renderPass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
            },
            (material) => {
                // For each material: bind its textures/samplers (group2)
                renderPass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
            },
            (primitive) => {
                // For each mesh primitive: set vertex and index buffers and draw
                renderPass.setVertexBuffer(0, primitive.vertexBuffer);
                renderPass.setIndexBuffer(primitive.indexBuffer, 'uint32');
                renderPass.drawIndexed(primitive.numIndices);
            }
        );

        renderPass.end();
        // Submit the command buffer to the GPU queue for execution
        renderer.device.queue.submit([encoder.finish()]);
    }
}
