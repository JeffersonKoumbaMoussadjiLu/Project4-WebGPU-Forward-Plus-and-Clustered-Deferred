// Common WGSL definitions shared by multiple shaders (structures, constants).

// Constant for light radius (in world units), injected via host constants.
const lightRadius: f32 = ${lightRadius};

// Struct definitions for uniforms and buffers:
struct CameraUniforms {
    viewProj: mat4x4<f32>;
    // (If camera had additional data like pos, it could be added here.)
};

struct ClusteringUniforms {
    viewMat: mat4x4<f32>;
    projMat: mat4x4<f32>;
    invProjMat: mat4x4<f32>;
    screenWidth: f32;
    screenHeight: f32;
    near: f32;
    far: f32;
    clustersX: u32;
    clustersY: u32;
    clustersZ: u32;
    maxLightsPerCluster: u32;
};

struct Light {
    position: vec3<f32>;
    _pad0: f32;
    color: vec3<f32>;
    _pad1: f32;
};

struct Lights {
    numLights: u32;
    _padding: vec3<u32>;
    lights: array<Light>;
};

// Storage buffer for cluster counts (runtime array of u32)
struct ClusterCounts {
    data: array<u32>;
};
// Storage buffer for cluster indices (runtime array of u32)
struct ClusterIndices {
    data: array<u32>;
};

// (Material uniform structures, samplers, etc., would be declared in specific shaders as needed.)
