// This file loads all WGSL shader code and injects shared constants.
import { Camera } from '../stage/camera';

// Import raw WGSL shader source code (with ?raw to get text content).
import commonRaw from './common.wgsl?raw';
import naiveVertRaw from './naive.vs.wgsl?raw';
import naiveFragRaw from './naive.fs.wgsl?raw';
import forwardPlusFragRaw from './forward_plus.fs.wgsl?raw';
import clusteredDeferredFragRaw from './clustered_deferred.fs.wgsl?raw';
import clusteredDeferredFullscreenVertRaw from './clustered_deferred_fullscreen.vs.wgsl?raw';
import clusteredDeferredFullscreenFragRaw from './clustered_deferred_fullscreen.fs.wgsl?raw';
import moveLightsComputeRaw from './move_lights.cs.wgsl?raw';
import clusteringComputeRaw from './clustering.cs.wgsl?raw';

// Define constants to substitute into shader code. 
// These constants will be embedded into WGSL via template strings.
export const constants = {
    bindGroup_scene: 0,     // index for scene-level bind group (camera, lights, etc.)
    bindGroup_model: 1,     // index for model-level bind group (object transform)
    bindGroup_material: 2,  // index for material-level bind group (textures)

    moveLightsWorkgroupSize: 128,   // workgroup size for move_lights compute shader

    lightRadius: 2,               // radius of influence for point lights (in world units)
    clusterTileSize: 16,          // (Legacy constant, not used in final clustering)
    clusterZSlices: Camera.clustersZ,            // number of cluster slices in Z (depth) direction
    clusterMaxLights: Camera.maxLightsPerCluster, // max lights per cluster
    nearPlane: Camera.nearPlane,  // camera near plane distance
    farPlane: Camera.farPlane,    // camera far plane distance
    tanHalfFovY: Math.tan((Camera ? Camera : {nearPlane:1, farPlane:1}) 
                   ? (45 * Math.PI / 180) / 2 
                   : 0)  // tangent of half vertical FOV (45 deg FOV as example, unused in final code)
};

// Helper to inject constants into raw shader source via template strings.
function evalShaderRaw(raw: string) {
    // Replace any `${...}` expressions in shader with values from constants
    return eval('`' + raw.replaceAll('${', '${constants.') + '`');
}

// Preprocess common shader code (this defines shared structs and functions).
const commonSrc: string = evalShaderRaw(commonRaw);

// Preprocess each shader by concatenating common code and injecting constants.
function processShaderRaw(raw: string) {
    return commonSrc + evalShaderRaw(raw);
}

// Export processed shader source strings for each shader module.
export const naiveVertSrc: string = processShaderRaw(naiveVertRaw);
export const naiveFragSrc: string = processShaderRaw(naiveFragRaw);
export const forwardPlusFragSrc: string = processShaderRaw(forwardPlusFragRaw);
export const clusteredDeferredFragSrc: string = processShaderRaw(clusteredDeferredFragRaw);
export const clusteredDeferredFullscreenVertSrc: string = processShaderRaw(clusteredDeferredFullscreenVertRaw);
export const clusteredDeferredFullscreenFragSrc: string = processShaderRaw(clusteredDeferredFullscreenFragRaw);
export const moveLightsComputeSrc: string = processShaderRaw(moveLightsComputeRaw);
export const clusteringComputeSrc: string = processShaderRaw(clusteringComputeRaw);
