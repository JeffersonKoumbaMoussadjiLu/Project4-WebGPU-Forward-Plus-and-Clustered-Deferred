// Vertex shader for fullscreen pass: generates a fullscreen triangle covering the screen.
// We don't need any vertex buffer; we construct clip-space coordinates procedurally.

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>;
    @location(0) uv: vec2<f32>;
};

@vertex
fn main(@builtin(vertex_index) vertIndex: u32) -> VertexOutput {
    // We will create a triangle that covers the screen by outputting three vertices in clip space.
    // Use the vertex_index (0,1,2) to generate triangle corners.
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),  // bottom-left corner in NDC
        vec2<f32>(3.0, -1.0),   // beyond right to cover bottom-right
        vec2<f32>(-1.0, 3.0)    // beyond top to cover top-left
    );
    let clipXY = pos[vertIndex];
    var out: VertexOutput;
    out.clipPos = vec4<f32>(clipXY, 0.0, 1.0);
    // Derive UV from clip space coordinates (transform from [-1,1] to [0,1])
    out.uv = clipXY * 0.5 + vec2<f32>(0.5, 0.5);
    return out;
}
