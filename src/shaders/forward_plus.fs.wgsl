// Forward+ fragment shader: uses clustered light lists to compute lighting per fragment.

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(0) @binding(1) var<storage, read> lightData : Lights;
@group(0) @binding(2) var<uniform> clustering : ClusteringUniforms;
@group(0) @binding(3) var<storage, read> clusterCounts : ClusterCounts;
@group(0) @binding(4) var<storage, read> clusterIndices : ClusterIndices;

// Per-vertex output from vertex shader (must match naive.vs.wgsl structure)
struct FragmentInput {
    @location(0) worldPos: vec4<f32>;   // world-space position of fragment
    @location(1) worldNormal: vec4<f32>; // world-space normal of fragment (w unused)
    @location(2) uv: vec2<f32>;        // texture coordinates
    @builtin(position) fragCoord: vec4<f32>; // position of fragment in screen (pixel coords in .xy, depth in .z)
};

// Output of fragment shader: the final color of the fragment
struct FragmentOutput {
    @location(0) color: vec4<f32>;
};

@fragment
fn main(input: FragmentInput) -> FragmentOutput {
    // Unpack the incoming data
    let fragPos = input.worldPos.xyz;      // fragment world position (xyz)
    let normal = normalize(input.worldNormal.xyz);  // normalized world-space normal
    // Sample the material's albedo color from the diffuse texture (bound in group2)
    // (We assume a texture and sampler are bound at group2, binding0 and 1)
    var albedo: vec3<f32>;
    if (true) {
        // Using material texture (if present)
        albedo = textureSample(material.diffuseTexture, material.diffuseSampler, input.uv).rgb;
    } else {
        // If no texture, use a default white albedo
        albedo = vec3<f32>(1.0, 1.0, 1.0);
    }

    // Determine which cluster this fragment belongs to (Forward+ uses clustering to limit lights)
    // Compute cluster indices (X, Y, Z) from fragment's screen position and depth.
    let screenW = clustering.screenWidth;
    let screenH = clustering.screenHeight;
    // Compute cluster index in X by dividing fragment's pixel x coordinate by screen width fraction per cluster.
    let clusterXIndex = u32(clamp(floor(input.fragCoord.x / (screenW / f32(clustering.clustersX))), 0.0, f32(clustering.clustersX) - 1.0));
    // Compute cluster index in Y (note: origin is top-left, y increases downward).
    let clusterYIndex = u32(clamp(floor(input.fragCoord.y / (screenH / f32(clustering.clustersY))), 0.0, f32(clustering.clustersY) - 1.0));
    // Compute cluster index in Z (depth) by linearizing depth and mapping to clustersZ.
    // We have fragment's device-space depth in fragCoord.z (0 to 1). Convert to view-space z.
    // Use the inverse projection matrix to get the view-space position.
    let ndcPos = vec4<f32>(
        (input.fragCoord.x / screenW) * 2.0 - 1.0,
        (input.fragCoord.y / screenH) * 2.0 - 1.0,
        input.fragCoord.z * 2.0 - 1.0,
        1.0);
    let viewPos4 = clustering.invProjMat * ndcPos;
    let viewPos = viewPos4.xyz / viewPos4.w;  // perspective divide to get view-space position
    let viewDepth = -viewPos.z;  // positive distance from camera
    // Map viewDepth to a cluster slice index (linear distribution between near and far planes).
    let clusterZIndex = u32(clamp(floor((viewDepth - clustering.near) / (clustering.far - clustering.near) * f32(clustering.clustersZ)), 0.0, f32(clustering.clustersZ) - 1.0));
    // Compute the 1D cluster index from the 3D indices.
    let clusterIndex = clusterXIndex + clusterYIndex * clustering.clustersX + clusterZIndex * clustering.clustersX * clustering.clustersY;

    // Retrieve the number of lights affecting this cluster
    let numLightsInCluster = clusterCounts.data[clusterIndex];
    // Accumulate lighting contributions
    var lighting: vec3<f32> = vec3<f32>(0.0);
    for (var i: u32 = 0u; i < numLightsInCluster; i++) {
        // Get the global light index from the cluster's list
        let lightIndex = clusterIndices.data[clusterIndex * clustering.maxLightsPerCluster + i];
        // Fetch the light data from the light buffer
        let light = lightData.lights[lightIndex];
        let lightPos = light.position;
        let lightColor = light.color;
        // Compute vector from fragment to light
        let toLight = lightPos - fragPos;
        let dist = length(toLight);
        if (dist <= lightRadius) {
            // Compute attenuation (simple linear attenuation within lightRadius)
            let atten = 1.0 - dist / lightRadius;
            // Compute diffuse lambertian term
            let L = toLight / dist;  // normalize light direction
            let NdotL = max(dot(normal, L), 0.0);
            // Accumulate diffuse contribution: light color * NdotL * attenuation
            lighting += lightColor * NdotL * atten;
        }
    }
    // Modulate lighting by the surface albedo (diffuse color)
    let finalColor = vec4<f32>(albedo * lighting, 1.0);
    return FragmentOutput(finalColor);
}
