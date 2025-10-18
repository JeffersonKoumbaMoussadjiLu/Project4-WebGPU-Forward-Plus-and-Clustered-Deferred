// Clustering compute shader: assigns lights to all clusters they intersect.

@group(0) @binding(0) var<uniform> clustering : ClusteringUniforms;
@group(0) @binding(1) var<storage, read> lightData : Lights;
@group(0) @binding(2) var<storage, read_write> clusterCounts : ClusterCounts;
@group(0) @binding(3) var<storage, read_write> clusterIndices : ClusterIndices;

// Each workgroup will handle a set of clusters. We define a workgroup size of 64 threads.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
    let clusterIndex = global_id.x;
    // Calculate total number of clusters (X * Y * Z)
    let totalClusters = clustering.clustersX * clustering.clustersY * clustering.clustersZ;
    if (clusterIndex >= totalClusters) {
        return; // thread is out of range (if total clusters is not a multiple of workgroup size)
    }

    // Initialize the light count for this cluster to 0
    var count: u32 = 0;
    // Compute this cluster's 3D index (clusterX, clusterY, clusterZ) from the flat index.
    let clusterZ = clusterIndex / (clustering.clustersX * clustering.clustersY);
    let clusterXY = clusterIndex % (clustering.clustersX * clustering.clustersY);
    let clusterY = clusterXY / clustering.clustersX;
    let clusterX = clusterXY % clustering.clustersX;

    // Compute cluster's coverage in camera space for intersection tests:
    // Compute vertical and horizontal angular bounds for this cluster.
    // Horizontal (X) angular span:
    let fovY = 45.0 * 3.1415926 / 180.0; // using 45 degrees FOV Y (or derive from projection if needed)
    let aspect = clustering.screenWidth / clustering.screenHeight;
    let fovX = fovY * aspect;
    // Compute angles for cluster boundaries:
    let angleLeft = -fovX * 0.5 + fovX * f32(clusterX) / f32(clustering.clustersX);
    let angleRight = -fovX * 0.5 + fovX * f32(clusterX + 1u) / f32(clustering.clustersX);
    let angleDown = -fovY * 0.5 + fovY * f32(clusterY + 1u) / f32(clustering.clustersY);
    let angleUp = -fovY * 0.5 + fovY * f32(clusterY) / f32(clustering.clustersY);
    // Compute depth (Z) bounds for this cluster (linear depth range)
    let near = clustering.near;
    let far = clustering.far;
    let zSliceDepth = (far - near) / f32(clustering.clustersZ);
    let zNear = near + zSliceDepth * f32(clusterZ);
    let zFar = near + zSliceDepth * f32(clusterZ + 1u);

    // Loop over all lights to check if they intersect this cluster
    let numLights = lightData.numLights;
    for (var lightIndex: u32 = 0u; lightIndex < numLights; lightIndex++) {
        // Fetch light info
        let light = lightData.lights[lightIndex];
        let lightPos = light.position;
        // Transform light position to camera (view) space for testing cluster intersection
        let lightPosView = (clustering.viewMat * vec4<f32>(lightPos, 1.0)).xyz;
        let lx = lightPosView.x;
        let ly = lightPosView.y;
        let lz = -lightPosView.z; // forward distance (positive if in front of camera)
        if (lz < zNear - lightRadius || lz > zFar + lightRadius) {
            // Light is completely outside this cluster's depth range
            continue;
        }
        // Compute light's polar angles in view space
        let horizAngle = atan2(lx, lightPosView.z * -1.0); // horizontal angle from camera forward
        let vertAngle = atan2(ly, lightPosView.z * -1.0);  // vertical angle from camera forward
        // Check if the light's sphere intersects the cluster's angular bounds:
        // If the light's center is outside by more than its radius, skip.
        let halfAngleHoriz = asin(min(1.0, lightRadius / max(lz, 0.001)));
        let halfAngleVert = asin(min(1.0, lightRadius / max(lz, 0.001)));
        // Compute effective angular extents of the light
        let lightAngleLeft = horizAngle - halfAngleHoriz;
        let lightAngleRight = horizAngle + halfAngleHoriz;
        let lightAngleDown = vertAngle - halfAngleVert;
        let lightAngleUp = vertAngle + halfAngleVert;
        // Check overlap with cluster angular bounds
        if (lightAngleRight < angleLeft || lightAngleLeft > angleRight) {
            continue; // no horizontal overlap
        }
        if (lightAngleUp < angleDown || lightAngleDown > angleUp) {
            continue; // no vertical overlap
        }
        // If we reach here, the light intersects this cluster.
        if (count < clustering.maxLightsPerCluster) {
            clusterIndices.data[clusterIndex * clustering.maxLightsPerCluster + count] = lightIndex;
            count = count + 1;
        }
    }
    // Write the total count of lights intersecting this cluster
    clusterCounts.data[clusterIndex] = count;
}
