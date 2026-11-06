--!strict
-- Real-time 3D hero for the dashboard's Home screen. Builds a low-poly
-- console and gamepad procedurally, then renders them with depth, 4x MSAA
-- and a neon grid floor into a GPU canvas that composites under the UI.

local FLOATS = 10 -- pos3, normal3, rgba (a = emissive)
local STRIDE = FLOATS * 4
local UBO_SIZE = 144 -- viewProj (64) + model (64) + params vec4 (16)
local SAMPLES = 4

type Mesh = { buffer: GPUBuffer, count: number }

type Obj = {
    mesh: Mesh,
    ubo: GPUBuffer,
    bind: GPUBindGroup,
    bytes: buffer,
}

type Hero = {
    context: Context,
    speed: Input<number>,
    canvas: GPUCanvas?,
    msaa: GPUTexture?,
    msaaView: GPUTextureView?,
    depth: GPUTexture?,
    depthView: GPUTextureView?,
    solid: GPUPipeline?,
    floorPipe: GPUPipeline?,
    console: Obj?,
    pad: Obj?,
    floor: Obj?,
    size: Vector,
    scale: number,
    pw: number,
    ph: number,
    time: number,
}

-- ---------------------------------------------------------------- geometry

type Builder = { data: { number } }

local function vert(b: Builder, x: number, y: number, z: number,
        nx: number, ny: number, nz: number, c: { number })
    local d = b.data
    d[#d + 1] = x; d[#d + 1] = y; d[#d + 1] = z
    d[#d + 1] = nx; d[#d + 1] = ny; d[#d + 1] = nz
    d[#d + 1] = c[1]; d[#d + 1] = c[2]; d[#d + 1] = c[3]; d[#d + 1] = c[4]
end

local function quad(b: Builder, p: { { number } }, n: { number }, c: { number })
    local order = { 1, 2, 3, 1, 3, 4 }
    for _, k in ipairs(order) do
        local v = p[k]
        vert(b, v[1], v[2], v[3], n[1], n[2], n[3], c)
    end
end

-- axis-aligned box from min to max corner
local function box(b: Builder, x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number, c: { number })
    quad(b, { { x0, y0, z1 }, { x1, y0, z1 }, { x1, y1, z1 }, { x0, y1, z1 } }, { 0, 0, 1 }, c)
    quad(b, { { x1, y0, z0 }, { x0, y0, z0 }, { x0, y1, z0 }, { x1, y1, z0 } }, { 0, 0, -1 }, c)
    quad(b, { { x1, y0, z1 }, { x1, y0, z0 }, { x1, y1, z0 }, { x1, y1, z1 } }, { 1, 0, 0 }, c)
    quad(b, { { x0, y0, z0 }, { x0, y0, z1 }, { x0, y1, z1 }, { x0, y1, z0 } }, { -1, 0, 0 }, c)
    quad(b, { { x0, y1, z1 }, { x1, y1, z1 }, { x1, y1, z0 }, { x0, y1, z0 } }, { 0, 1, 0 }, c)
    quad(b, { { x0, y0, z0 }, { x1, y0, z0 }, { x1, y0, z1 }, { x0, y0, z1 } }, { 0, -1, 0 }, c)
end

-- upright cylinder (y axis) centred at x,z from y0 to y1
local function cylinder(b: Builder, cx: number, cz: number, y0: number, y1: number,
        r: number, segs: number, c: { number })
    for i = 0, segs - 1 do
        local a0 = i / segs * math.pi * 2
        local a1 = (i + 1) / segs * math.pi * 2
        local x0, z0 = cx + math.cos(a0) * r, cz + math.sin(a0) * r
        local x1, z1 = cx + math.cos(a1) * r, cz + math.sin(a1) * r
        local am = (a0 + a1) / 2
        quad(b, { { x0, y0, z0 }, { x1, y0, z1 }, { x1, y1, z1 }, { x0, y1, z0 } },
            { math.cos(am), 0, math.sin(am) }, c)
        vert(b, cx, y1, cz, 0, 1, 0, c)
        vert(b, x1, y1, z1, 0, 1, 0, c)
        vert(b, x0, y1, z0, 0, 1, 0, c)
    end
end

local function upload(b: Builder): Mesh
    local n = #b.data
    local bytes = buffer.create(n * 4)
    for i = 1, n do
        buffer.writef32(bytes, (i - 1) * 4, b.data[i])
    end
    local gpu = GPUBuffer.new({ size = n * 4, usage = 'vertex', data = bytes, immutable = true })
    return { buffer = gpu, count = n // FLOATS }
end

local SHELL = { 0.70, 0.72, 0.84, 0 }
local CORE = { 0.10, 0.11, 0.16, 0 }
local BASE = { 0.07, 0.07, 0.10, 0 }
local CYAN = { 0.20, 0.85, 1.00, 1 }
local MAGENTA = { 0.90, 0.30, 1.00, 1 }

local function buildConsole(): Mesh
    local b: Builder = { data = {} }
    -- dark core with white side shells, standing on a plinth
    box(b, -0.30, 0.10, -0.52, 0.30, 1.76, 0.52, CORE)
    box(b, -0.38, 0.06, -0.58, -0.30, 1.84, 0.58, SHELL)
    box(b, 0.30, 0.06, -0.58, 0.38, 1.84, 0.58, SHELL)
    -- front light strip and power button
    box(b, -0.025, 0.22, 0.52, 0.025, 1.64, 0.545, CYAN)
    box(b, 0.12, 0.24, 0.52, 0.20, 0.29, 0.545, MAGENTA)
    -- disc slot
    box(b, -0.24, 1.40, 0.52, -0.08, 1.42, 0.535, { 0.02, 0.02, 0.03, 0 })
    -- top vents
    for i = 0, 5 do
        local z = -0.40 + i * 0.16
        box(b, -0.22, 1.76, z, 0.22, 1.775, z + 0.06, { 0.04, 0.04, 0.06, 0 })
    end
    -- plinth with a glowing edge
    box(b, -0.52, 0.0, -0.42, 0.52, 0.07, 0.42, BASE)
    box(b, -0.52, 0.025, 0.42, 0.52, 0.045, 0.43, MAGENTA)
    return upload(b)
end

local function buildPad(): Mesh
    local b: Builder = { data = {} }
    local body = { 0.17, 0.15, 0.27, 0 }
    local dark = { 0.07, 0.07, 0.10, 0 }
    local grey = { 0.55, 0.57, 0.66, 0 }
    box(b, -0.45, -0.07, -0.22, 0.45, 0.07, 0.16, body)
    box(b, -0.46, -0.08, 0.10, -0.20, 0.06, 0.42, body)
    box(b, 0.20, -0.08, 0.10, 0.46, 0.06, 0.42, body)
    -- shoulder buttons
    box(b, -0.42, -0.02, -0.27, -0.16, 0.05, -0.22, grey)
    box(b, 0.16, -0.02, -0.27, 0.42, 0.05, -0.22, grey)
    -- sticks
    cylinder(b, -0.16, 0.10, 0.07, 0.10, 0.075, 16, dark)
    cylinder(b, 0.16, 0.10, 0.07, 0.10, 0.075, 16, dark)
    cylinder(b, -0.16, 0.10, 0.10, 0.13, 0.055, 16, grey)
    cylinder(b, 0.16, 0.10, 0.10, 0.13, 0.055, 16, grey)
    -- d-pad
    box(b, -0.36, 0.07, -0.08, -0.24, 0.095, -0.04, grey)
    box(b, -0.32, 0.07, -0.12, -0.28, 0.095, 0.00, grey)
    -- face buttons, glowing
    local face = {
        { 0.30, -0.12, CYAN }, { 0.36, -0.06, MAGENTA },
        { 0.30, 0.00, { 1.0, 0.80, 0.25, 1 } }, { 0.24, -0.06, { 0.35, 1.0, 0.55, 1 } },
    }
    for _, f in ipairs(face) do
        cylinder(b, f[1] :: number, f[2] :: number, 0.07, 0.095, 0.026, 12, f[3] :: { number })
    end
    -- light bar
    box(b, -0.14, 0.07, -0.22, 0.14, 0.08, -0.17, CYAN)
    return upload(b)
end

local function buildFloor(): Mesh
    local b: Builder = { data = {} }
    local s = 6
    quad(b, { { -s, 0, s }, { s, 0, s }, { s, 0, -s }, { -s, 0, -s } }, { 0, 1, 0 }, { 0, 0, 0, 0 })
    return upload(b)
end

-- ---------------------------------------------------------------- GPU setup

local function makeObj(mesh: Mesh, pipe: GPUPipeline): Obj
    local ubo = GPUBuffer.new({ size = UBO_SIZE, usage = 'uniform' })
    local bind = GPUBindGroup.new({
        layout = pipe:getBindGroupLayout(0),
        ubos = { { slot = 0, buffer = ubo } },
    })
    return { mesh = mesh, ubo = ubo, bind = bind, bytes = buffer.create(UBO_SIZE) }
end

local function init(self: Hero, context: Context): boolean
    local shader = context:shader('console3d')
    if shader == nil then
        print('console3d: shader not found')
        return false
    end
    local layout: { VertexBufferLayout } = { {
        stride = STRIDE,
        attributes = {
            { format = 'float32x3', slot = 0, offset = 0 },
            { format = 'float32x3', slot = 1, offset = 12 },
            { format = 'float32x4', slot = 2, offset = 24 },
        },
    } }
    self.canvas = context:gpuCanvas()
    local solid = GPUPipeline.new({
        vertex = shader, fragment = shader, vertexLayout = layout,
        colorTargets = { { format = 'rgba8unorm' } },
        depthStencil = { format = 'depth32float', compare = 'less', write = true },
        cullMode = 'none', sampleCount = SAMPLES,
    })
    local floorPipe = GPUPipeline.new({
        vertex = shader, fragment = shader, vertexLayout = layout,
        colorTargets = { {
            format = 'rgba8unorm',
            blend = {
                srcColor = 'one', dstColor = 'one-minus-src-alpha',
                srcAlpha = 'one', dstAlpha = 'one-minus-src-alpha',
            },
        } },
        depthStencil = { format = 'depth32float', compare = 'less', write = false },
        cullMode = 'none', sampleCount = SAMPLES,
    })
    self.solid = solid
    self.floorPipe = floorPipe
    self.console = makeObj(buildConsole(), solid)
    self.pad = makeObj(buildPad(), solid)
    self.floor = makeObj(buildFloor(), floorPipe)
    return true
end

local function resize(self: Hero, size: Vector, scale: number)
    self.size = size
    self.scale = scale
end

local function ensureTargets(self: Hero): boolean
    local canvas = self.canvas
    if canvas == nil then return false end
    local w = math.max(1, math.floor(self.size.x * self.scale))
    local h = math.max(1, math.floor(self.size.y * self.scale))
    if self.size.x < 1 or self.size.y < 1 then return false end
    if w ~= self.pw or h ~= self.ph then
        canvas:resize(w, h)
        local msaa = GPUTexture.new({ width = w, height = h, format = 'rgba8unorm',
            renderTarget = true, sampleCount = SAMPLES })
        local depth = GPUTexture.new({ width = w, height = h, format = 'depth32float',
            renderTarget = true, sampleCount = SAMPLES })
        self.msaa = msaa
        self.msaaView = msaa:view()
        self.depth = depth
        self.depthView = depth:view()
        self.pw, self.ph = w, h
    end
    return true
end

local function advance(self: Hero, seconds: number): boolean
    self.time += seconds * math.max(0, self.speed)
    return true
end

local function writeObj(o: Obj, viewProj: Mat4, model: Mat4, isFloor: number, t: number, pulse: number,
        width: number)
    viewProj:writeToBuffer(o.bytes, 0)
    model:writeToBuffer(o.bytes, 64)
    buffer.writef32(o.bytes, 128, t)
    buffer.writef32(o.bytes, 132, isFloor)
    buffer.writef32(o.bytes, 136, pulse)
    buffer.writef32(o.bytes, 140, width)
    o.ubo:write(o.bytes)
end

local function drawObj(pass: GPURenderPass, o: Obj)
    pass:setBindGroup(0, o.bind)
    pass:setVertexBuffer(0, o.mesh.buffer)
    pass:draw(o.mesh.count)
end

local function draw(self: Hero, renderer: Renderer)
    if not ensureTargets(self) then return end
    local canvas, msaaView, depthView = self.canvas, self.msaaView, self.depthView
    local solid, floorPipe = self.solid, self.floorPipe
    local console, pad, floor = self.console, self.pad, self.floor
    if canvas == nil or msaaView == nil or depthView == nil or solid == nil
        or floorPipe == nil or console == nil or pad == nil or floor == nil then
        return
    end

    local t = self.time
    local aspect = self.pw / self.ph
    local proj = Mat4.perspective(math.rad(36), aspect, 0.1, 50)
    local view = Mat4.lookAt(Vector.xyz(0.1, 1.6, 4.4), Vector.xyz(0.15, 0.82, 0), Vector.xyz(0, 1, 0))
    local viewProj = proj * view
    local pulse = 0.5 + 0.5 * math.sin(t * 2.2)

    -- console: slow turntable
    local consoleModel = Mat4.fromTranslation(-0.55, 0, 0) * Mat4.fromRotationY(0.55 + math.sin(t * 0.35) * 0.6)
    -- gamepad: floats, bobs and tilts toward the camera
    local bob = math.sin(t * 1.6) * 0.06
    local padModel = Mat4.fromTranslation(0.85, 0.95 + bob, 0.35)
        * Mat4.fromRotationY(-0.5 + t * 0.6)
        * Mat4.fromRotationX(0.75 + math.sin(t * 1.1) * 0.12)
        * Mat4.fromScale(1.15)

    writeObj(console, viewProj, consoleModel, 0, t, pulse, self.pw)
    writeObj(pad, viewProj, padModel, 0, t, pulse, self.pw)
    writeObj(floor, viewProj, Mat4.identity(), 1, t, pulse, self.pw)

    local pass = canvas:beginRenderPass({
        color = { {
            view = msaaView, resolveTarget = canvas:colorView(),
            loadOp = 'clear', storeOp = 'discard', clearColor = { 0, 0, 0, 0 },
        } },
        depthStencil = { view = depthView, depthLoadOp = 'clear', depthStoreOp = 'discard', depthClearValue = 1 },
    })
    pass:setPipeline(solid)
    drawObj(pass, console)
    drawObj(pass, pad)
    pass:setPipeline(floorPipe)
    drawObj(pass, floor)
    pass:finish()

    renderer:save()
    local inv = 1 / self.scale
    renderer:transform(Mat2D.values(inv, 0, 0, inv, 0, 0))
    renderer:drawImage(canvas.image, ImageSampler('clamp', 'clamp', 'bilinear'), 'srcOver', 1)
    renderer:restore()
end

return function(context: Context): Layout<Hero>
    return {
        context = context,
        speed = 1,
        canvas = nil, msaa = nil, msaaView = nil, depth = nil, depthView = nil,
        solid = nil, floorPipe = nil, console = nil, pad = nil, floor = nil,
        size = Vector.xy(0, 0), scale = 1, pw = 0, ph = 0, time = 0,
        init = init, resize = resize, advance = advance, draw = draw,
    }
end
