// Clustered Deferred G-buffer fragment shader: outputs world position, normal, and albedo for each fragment.

@group(0) @binding(0) var<uniform> camera : CameraUniforms;

struct FragmentInput {
    @location(0) worldPos: vec4<f32>;
    @location(1) worldNormal: vec4<f32>;
    @location(2) uv: vec2<f32>;
};

struct GBufferOutput {
    @location(0) position: vec4<f32>;
    @location(1) normal: vec4<f32>;
    @location(2) albedo: vec4<f32>;
};

@fragment
fn main(input: FragmentInput) -> GBufferOutput {
    // Extract world-space position and normal from vertex output
    let worldPos = input.worldPos;
    let normal = normalize(input.worldNormal.xyz);

    // Sample the material's diffuse texture for albedo color
    var albedoColor: vec3<f32>;
    if (true) {
        albedoColor = textureSample(material.diffuseTexture, material.diffuseSampler, input.uv).rgb;
    } else {
        albedoColor = vec3<f32>(1.0, 1.0, 1.0);
    }

    // Output world position (store xyz in high precision, w unused or set to 1)
    var outPos = vec4<f32>(worldPos.xyz, 1.0);
    // Output world normal (normalize and store in XYZ, and pack 0 into W as padding)
    var outNorm = vec4<f32>(normal, 0.0);
    // Output albedo color (RGB from texture, alpha = 1 for now)
    var outAlbedo = vec4<f32>(albedoColor, 1.0);

    return GBufferOutput(outPos, outNorm, outAlbedo);
}
