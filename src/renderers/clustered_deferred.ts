import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

export class ClusteredDeferredRenderer extends renderer.Renderer {
    // GPU resources for clustered deferred rendering
    sceneBindGroupLayout: GPUBindGroupLayout;
    sceneBindGroup: GPUBindGroup;

    // G-buffer textures (position, normal, albedo) and views
    gPositionTex: GPUTexture;
    gNormalTex: GPUTexture;
    gAlbedoTex: GPUTexture;
    gPositionView: GPUTextureView;
    gNormalView: GPUTextureView;
    gAlbedoView: GPUTextureView;
    depthTexture: GPUTexture;
    depthTextureView: GPUTextureView;

    // Pipeline for the geometry (G-buffer) pass
    gbufferPipeline: GPURenderPipeline;

    // Bind group and layout for reading G-buffer textures in the lighting pass
    gbufferReadBindGroupLayout: GPUBindGroupLayout;
    gbufferReadBindGroup: GPUBindGroup;
    gbufferSampler: GPUSampler;
    // Pipeline for the fullscreen lighting pass
    fullscreenPipeline: GPURenderPipeline;

    // A fullscreen model matrix (identity) and bind group for it
    fullscreenModelMatBuffer: GPUBuffer;
    fullscreenModelBindGroup: GPUBindGroup;

    constructor(stage: Stage) {
        super(stage);

        // Create a bind group layout for scene data (camera, lights, cluster buffers) similar to Forward+
        this.sceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "clustered-deferred scene bind group layout",
            entries: [
                { // Binding 0: camera uniform
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                { // Binding 1: light set buffer
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                },
                { // Binding 2: clustering uniform buffer
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                { // Binding 3: cluster light counts buffer
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                },
                { // Binding 4: cluster light indices buffer
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" }
                }
            ]
        });

        // Create the scene bind group with actual buffers
        this.sceneBindGroup = renderer.device.createBindGroup({
            label: "clustered-deferred scene bind group",
            layout: this.sceneBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },               // camera (viewProj)
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },       // lights data
                { binding: 2, resource: { buffer: this.camera.clusteringUniformsBuffer } },    // clustering info
                { binding: 3, resource: { buffer: this.lights.clusterCountsBuffer } },         // cluster counts
                { binding: 4, resource: { buffer: this.lights.clusterIndicesBuffer } }         // cluster indices
            ]
        });

        // Create G-buffer textures for position, normal, and albedo (color).
        const size: GPUExtent3D = [renderer.canvas.width, renderer.canvas.height];
        this.gPositionTex = renderer.device.createTexture({
            label: "gPosition",
            size,
            format: 'rgba16float',  // use 16-bit float to store high-range positions
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.gNormalTex = renderer.device.createTexture({
            label: "gNormal",
            size,
            format: 'rgba16float',  // normals (XYZ) can also use 16-bit floats
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        this.gAlbedoTex = renderer.device.createTexture({
            label: "gAlbedo",
            size,
            format: 'rgba8unorm',   // albedo color (8-bit normalized)
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        });
        // Create texture views for these textures (to render to and to sample from)
        this.gPositionView = this.gPositionTex.createView();
        this.gNormalView = this.gNormalTex.createView();
        this.gAlbedoView = this.gAlbedoTex.createView();

        // Depth texture for the G-buffer pass (we reuse depth for the scene geometry pass)
        this.depthTexture = renderer.device.createTexture({
            label: "deferred depth",
            size,
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.depthTextureView = this.depthTexture.createView();

        // Create the pipeline for the G-buffer geometry pass.
        this.gbufferPipeline = renderer.device.createRenderPipeline({
            label: "deferred gbuffer pipeline",
            layout: renderer.device.createPipelineLayout({
                label: "deferred gbuffer pipeline layout",
                bindGroupLayouts: [
                    this.sceneBindGroupLayout,        // group0: scene (camera, lights, clusters)
                    renderer.modelBindGroupLayout,    // group1: model transform
                    renderer.materialBindGroupLayout  // group2: material (texture/sampler)
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
                    code: shaders.naiveVertSrc  // reuse naive vertex shader to output pos, normal, uv
                }),
                entryPoint: "main",
                buffers: [ renderer.vertexBufferLayout ]
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "deferred gbuffer fragment",
                    code: shaders.clusteredDeferredFragSrc  // fragment shader to output position/normal/albedo
                }),
                entryPoint: "main",
                targets: [
                    { format: 'rgba16float' }, // RT0: position
                    { format: 'rgba16float' }, // RT1: normal
                    { format: 'rgba8unorm' }   // RT2: albedo
                ]
            }
        });

        // Create a sampler for sampling the G-buffer textures in the lighting pass.
        this.gbufferSampler = renderer.device.createSampler({
            label: "gbuffer sampler",
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            magFilter: 'nearest',
            minFilter: 'nearest',
            mipmapFilter: 'nearest'
        });

        // Create a bind group layout for reading the G-buffer in the lighting (fullscreen) pass.
        this.gbufferReadBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "gbuffer read bind group layout",
            entries: [
                { // Binding 0: gPosition texture
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'unfilterable-float' }
                },
                { // Binding 1: gNormal texture
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'unfilterable-float' }
                },
                { // Binding 2: gAlbedo texture
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' }
                },
                { // Binding 3: sampler
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'non-filtering' }
                }
            ]
        });

        // Create a bind group for the G-buffer textures and sampler.
        this.gbufferReadBindGroup = renderer.device.createBindGroup({
            label: "gbuffer read bind group",
            layout: this.gbufferReadBindGroupLayout,
            entries: [
                { binding: 0, resource: this.gPositionView },
                { binding: 1, resource: this.gNormalView },
                { binding: 2, resource: this.gAlbedoView },
                { binding: 3, resource: this.gbufferSampler }
            ]
        });

        // Create a small uniform buffer and bind group for a fullscreen model matrix (identity matrix).
        // This is used to satisfy the model matrix binding in the fullscreen triangle draw (essentially a dummy transform).
        this.fullscreenModelMatBuffer = renderer.device.createBuffer({
            label: "fullscreen model mat",
            size: 16 * 4,  // 4x4 matrix (16 floats)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        // Write an identity matrix into the model matrix buffer.
        renderer.device.queue.writeBuffer(
            this.fullscreenModelMatBuffer,
            0,
            new Float32Array([
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ])
        );
        this.fullscreenModelBindGroup = renderer.device.createBindGroup({
            label: "fullscreen model bind group",
            layout: renderer.modelBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.fullscreenModelMatBuffer } }
            ]
        });

        // Create the pipeline for the fullscreen lighting pass.
        this.fullscreenPipeline = renderer.device.createRenderPipeline({
            label: "deferred fullscreen pipeline",
            layout: renderer.device.createPipelineLayout({
                label: "deferred fullscreen pipeline layout",
                bindGroupLayouts: [
                    this.sceneBindGroupLayout,         // group0: scene (camera, lights, cluster data)
                    renderer.modelBindGroupLayout,     // group1: model (using identity matrix for fullscreen tri)
                    this.gbufferReadBindGroupLayout    // group2: G-buffer textures + sampler
                ]
            }),
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "deferred fullscreen vertex",
                    code: shaders.clusteredDeferredFullscreenVertSrc  // vertex shader to generate fullscreen triangle
                }),
                entryPoint: "main",
                buffers: []  // fullscreen triangle uses no vertex buffer (generated in shader)
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "deferred fullscreen fragment",
                    code: shaders.clusteredDeferredFullscreenFragSrc  // fragment shader for lighting using clusters
                }),
                entryPoint: "main",
                targets: [
                    { format: renderer.canvasFormat }  // output to the canvas
                ]
            }
        });
    }

    override draw() {
        const encoder = renderer.device.createCommandEncoder();

        // 1. Run the clustering compute shader to update cluster light lists for this frame.
        this.lights.doLightClustering(encoder);

        // 2. Geometry pass: render scene geometry to G-buffer (position, normal, albedo textures).
        const gbufferPass = encoder.beginRenderPass({
            label: "deferred gbuffer pass",
            colorAttachments: [
                {
                    view: this.gPositionView,
                    clearValue: [0, 0, 0, 0],  // clear position buffer (unused areas to 0)
                    loadOp: "clear",
                    storeOp: "store"
                },
                {
                    view: this.gNormalView,
                    clearValue: [0, 0, 0, 0],  // clear normal buffer 
                    loadOp: "clear",
                    storeOp: "store"
                },
                {
                    view: this.gAlbedoView,
                    clearValue: [0, 0, 0, 0],  // clear albedo buffer 
                    loadOp: "clear",
                    storeOp: "store"
                }
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,      // clear depth
                depthLoadOp: "clear",
                depthStoreOp: "store"
            }
        });
        // Use G-buffer pipeline to fill position/normal/albedo targets
        gbufferPass.setPipeline(this.gbufferPipeline);
        // Bind scene data (camera, lights, cluster buffers) to group0
        gbufferPass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneBindGroup);
        // Draw all scene objects to populate the G-buffer
        this.scene.iterate(
            (node) => {
                gbufferPass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
            },
            (material) => {
                gbufferPass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
            },
            (primitive) => {
                gbufferPass.setVertexBuffer(0, primitive.vertexBuffer);
                gbufferPass.setIndexBuffer(primitive.indexBuffer, 'uint32');
                gbufferPass.drawIndexed(primitive.numIndices);
            }
        );
        gbufferPass.end();

        // 3. Fullscreen lighting pass: apply lighting using the G-buffer and clustered lights.
        const canvasView = renderer.context.getCurrentTexture().createView();
        const lightPass = encoder.beginRenderPass({
            label: "clustered-deferred fullscreen pass",
            colorAttachments: [
                {
                    view: canvasView,
                    clearValue: [0, 0, 0, 0],  // clear to black
                    loadOp: "clear",
                    storeOp: "store"
                }
            ]
            // Note: no depth attachment needed for fullscreen pass (it writes directly to color)
        });
        lightPass.setPipeline(this.fullscreenPipeline);
        // Bind scene data (camera, lights, cluster info) as group0
        lightPass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneBindGroup);
        // Bind the fullscreen model transform (identity) as group1
        lightPass.setBindGroup(shaders.constants.bindGroup_model, this.fullscreenModelBindGroup);
        // Bind the G-buffer textures and sampler as group2 for reading
        lightPass.setBindGroup(shaders.constants.bindGroup_material, this.gbufferReadBindGroup);
        // Draw a fullscreen triangle (vertex shader will generate the triangle covering the screen)
        lightPass.draw(3);
        lightPass.end();

        renderer.device.queue.submit([encoder.finish()]);
    }
}
