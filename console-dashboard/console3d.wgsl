// 3D hero scene for the console dashboard: a lit console, a floating gamepad
// and a neon grid floor. One shader serves all three; params.y picks the floor.

struct Uniforms {
    viewProj: mat4x4<f32>,
    model: mat4x4<f32>,
    // x: time in seconds, y: 1 for the grid floor, z: accent pulse 0..1,
    // w: canvas width in pixels
    params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VIn {
    @location(0) pos: vec3<f32>,
    @location(1) nrm: vec3<f32>,
    // rgb albedo, a = emissive strength
    @location(2) col: vec4<f32>,
};

struct VOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) n: vec3<f32>,
    @location(1) col: vec4<f32>,
    @location(2) wp: vec3<f32>,
};

@vertex fn vs(v: VIn) -> VOut {
    var o: VOut;
    let world = u.model * vec4<f32>(v.pos, 1.0);
    o.clip = u.viewProj * world;
    o.n = (u.model * vec4<f32>(v.nrm, 0.0)).xyz;
    o.col = v.col;
    o.wp = world.xyz;
    return o;
}

// 1 on the grid line through every integer coord, fading to 0 within
// `width` pixels, so lines stay crisp at any distance.
fn gridLine(coord: f32, width: f32) -> f32 {
    let d = abs(fract(coord + 0.5) - 0.5);
    let w = max(fwidth(coord) * width, 1e-4);
    return 1.0 - smoothstep(0.0, w, d);
}

@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
    let cyan = vec3<f32>(0.20, 0.85, 1.00);
    let magenta = vec3<f32>(0.85, 0.30, 1.00);

    if (u.params.y > 0.5) {
        // Neon grid floor: lines every 0.5 units, scrolling toward the camera,
        // fading out with distance so it melts into the dashboard background.
        let p = i.wp.xz * 2.0 + vec2<f32>(0.0, u.params.x * 0.6);
        let g = max(gridLine(p.x, 1.2), gridLine(p.y, 1.2));
        let d = length(i.wp.xz);
        let fade = clamp(1.0 - d / 5.5, 0.0, 1.0);
        let glow = clamp(1.0 - d / 1.6, 0.0, 1.0);
        let lineCol = mix(magenta, cyan, clamp(0.5 + i.wp.x * 0.2, 0.0, 1.0));
        // soften the canvas's left edge, where it meets the hero copy
        let edge = smoothstep(0.0, 0.28 * u.params.w, i.clip.x);
        let a = (g * 0.85 + glow * 0.35) * fade * edge;
        let rgb = (lineCol * g + cyan * glow * glow * 0.45) * fade * edge;
        // premultiplied output
        return vec4<f32>(rgb, a);
    }

    let n = normalize(i.n);
    let key = normalize(vec3<f32>(-0.4, 0.8, 0.6));
    let diff = max(dot(n, key), 0.0);
    // rim lights in the dashboard's two accent colours
    let rimL = pow(clamp(dot(n, normalize(vec3<f32>(-1.0, 0.1, -0.3))), 0.0, 1.0), 2.0);
    let rimR = pow(clamp(dot(n, normalize(vec3<f32>(1.0, 0.2, -0.2))), 0.0, 1.0), 2.0);
    let up = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
    let ambient = mix(vec3<f32>(0.10, 0.08, 0.18), vec3<f32>(0.28, 0.30, 0.42), up);

    var rgb = i.col.rgb * (ambient + diff * vec3<f32>(1.0, 0.97, 0.92) * 0.95);
    rgb += magenta * rimL * 0.55 + cyan * rimR * 0.55;

    // emissive parts pulse gently with the accent beat
    let pulse = 0.75 + 0.25 * u.params.z;
    rgb = mix(rgb, i.col.rgb * (1.4 * pulse), clamp(i.col.a, 0.0, 1.0));
    return vec4<f32>(rgb, 1.0);
}
