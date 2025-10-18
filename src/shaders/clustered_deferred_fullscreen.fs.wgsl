// Clustered Deferred fullscreen fragment shader: applies lighting using cluster data and G-buffer.

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(0) @binding(1) var<storage, read> lightData : Lights;
@group(0) @binding(2) var<uniform> clustering : ClusteringUniforms;
@group(0) @binding(3) var<storage, read> clusterCounts : ClusterCounts;
@group(0) @binding(4) var<storage, read> clusterIndices : ClusterIndices;

@group(2) @binding(0) var gPositionTex : texture_2d<f32>;
@group(2) @binding(1) var gNormalTex : texture_2d<f32>;
@group(2) @binding(2) var gAlbedoTex : texture_2d<f32>;
@group(2) @binding(3) var gSampler : sampler;

// Fragment input carrying UV coordinates (from fullscreen tri vertex shader)
struct FragmentInput {
    @location(0) uv: vec2<f32>;
    @builtin(position) fragCoord: vec4<f32>;
};
struct FragmentOutput { @location(0) color: vec4<f32>; };

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    // Fetch G-buffer values for this fragment (using integer pixel coords for exact texel fetch)
    let pixelCoord = vec2<i32>(i32(input.fragCoord.x), i32(input.fragCoord.y));
    // Read the stored world position (rgba16float texture) at this pixel
    let storedPos = textureLoad(gPositionTex, pixelCoord, 0);
    let fragPos = storedPos.xyz;
    // Read the stored world normal (rgba16float texture)
    let storedNorm = textureLoad(gNormalTex, pixelCoord, 0);
    let normal = normalize(storedNorm.xyz);
    // Read the stored albedo color (rgba8 texture)
    let albedoColor = textureLoad(gAlbedoTex, pixelCoord, 0).rgb;

    // Determine this fragment's cluster indices (same method as Forward+ shader)
    let screenW = clustering.screenWidth;
    let screenH = clustering.screenHeight;
    let clusterX = u32(clamp(floor(input.fragCoord.x / (screenW / f32(clustering.clustersX))), 0.0, f32(clustering.clustersX) - 1.0));
    let clusterY = u32(clamp(floor(input.fragCoord.y / (screenH / f32(clustering.clustersY))), 0.0, f32(clustering.clustersY) - 1.0));
    // Use view depth from stored position to find clusterZ
    // Compute view-space depth of fragment by transforming world position with view matrix.
    let viewPos = (clustering.viewMat * vec4<f32>(fragPos, 1.0)).xyz;
    let viewDepth = -viewPos.z;
    let clusterZ = u32(clamp(floor((viewDepth - clustering.near) / (clustering.far - clustering.near) * f32(clustering.clustersZ)), 0.0, f32(clustering.clustersZ) - 1.0));
    let clusterIndex = clusterX + clusterY * clustering.clustersX + clusterZ * clustering.clustersX * clustering.clustersY;

    // Fetch number of lights in this cluster
    let lightCount = clusterCounts.data[clusterIndex];

    var lightingAccum: vec3<f32> = vec3<f32>(0.0);
    // Loop through each light index in this cluster and accumulate lighting
    for (var i: u32 = 0u; i < lightCount; i++) {
        let lightIndex = clusterIndices.data[clusterIndex * clustering.maxLightsPerCluster + i];
        let light = lightData.lights[lightIndex];
        let lightPos = light.position;
        let lightColor = light.color;
        // Calculate vector to light
        let toLight = lightPos - fragPos;
        let dist = length(toLight);
        if (dist <= lightRadius) {
            let L = toLight / dist;
            let NdotL = max(dot(normal, L), 0.0);
            let atten = 1.0 - dist / lightRadius;
            lightingAccum += lightColor * NdotL * atten;
        }
    }
    // Multiply accumulated lighting by surface albedo
    let finalColor = vec4<f32>(albedoColor * lightingAccum, 1.0);
    return FragmentOutput(finalColor);
}
