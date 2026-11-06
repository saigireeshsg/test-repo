--!strict
-- Music player engine. The state machine owns which track is selected and
-- whether it is playing; this script owns time. While `playing` is true it
-- advances `progress`, spins the vinyl (`disc`), formats the elapsed/total
-- labels and moves to the next track when one ends. It draws nothing.

-- Track lengths in seconds, in the same order as the Track layer's states.
local LENGTHS = { 204, 178, 252, 226 }

type Player = {
    progress: Property<number>?,
    disc: Property<number>?,
    track: Property<number>?,
    playing: Property<boolean>?,
    elapsed: Property<string>?,
    total: Property<string>?,
    clock: Property<string>?,
    position: number,
    lastTrack: number,
    clockTime: number,
    lastElapsed: string,
}

local function mmss(seconds: number): string
    local s = math.floor(seconds)
    return string.format('%d:%02d', s // 60, s % 60)
end

local function init(self: Player, context: Context): boolean
    -- init runs twice; the view model only exists on the second call
    local vm = context:viewModel()
    if vm == nil then return true end
    self.progress = vm:getNumber('progress')
    self.disc = vm:getNumber('disc')
    self.track = vm:getNumber('track')
    self.playing = vm:getBoolean('playing')
    self.elapsed = vm:getString('elapsed')
    self.total = vm:getString('total')
    self.clock = vm:getString('clock')
    return true
end

local function trackIndex(self: Player): number
    local t = self.track
    if t == nil then return 0 end
    return math.clamp(math.floor(t.value + 0.5), 0, #LENGTHS - 1)
end

local function advance(self: Player, seconds: number): boolean
    local index = trackIndex(self)
    local length = LENGTHS[index + 1]

    -- a new track (picked by the state machine or by us) starts from zero
    if index ~= self.lastTrack then
        -- the very first track keeps the demo start position
        if self.lastTrack >= 0 then self.position = 0 end
        self.lastTrack = index
        local total = self.total
        if total ~= nil then total.value = mmss(length) end
    end

    local playing = self.playing
    if playing ~= nil and playing.value then
        self.position += seconds
        local disc = self.disc
        if disc ~= nil then disc.value = (disc.value + seconds * 1.4) % (math.pi * 2) end
        if self.position >= length then
            -- auto-advance; the Track layer follows the number
            local track = self.track
            if track ~= nil then track.value = (index + 1) % #LENGTHS end
        end
    end

    local progress = self.progress
    if progress ~= nil then progress.value = math.clamp(self.position / length, 0, 1) end
    local label = mmss(self.position)
    if label ~= self.lastElapsed then
        self.lastElapsed = label
        local elapsed = self.elapsed
        if elapsed ~= nil then elapsed.value = label end
    end

    -- a console-style clock that starts at 9:41 PM and keeps time
    self.clockTime += seconds
    local clock = self.clock
    if clock ~= nil then
        local minutes = (21 * 60 + 41 + math.floor(self.clockTime / 60)) % (24 * 60)
        local h = minutes // 60
        local suffix = if h >= 12 then 'PM' else 'AM'
        local h12 = if h % 12 == 0 then 12 else h % 12
        clock.value = string.format('%d:%02d %s', h12, minutes % 60, suffix)
    end
    return true
end

local function draw(self: Player, renderer: Renderer) end

return function(context: Context): Layout<Player>
    return {
        progress = nil, disc = nil, track = nil, playing = nil,
        elapsed = nil, total = nil, clock = nil,
        position = 37, lastTrack = -1, clockTime = 0, lastElapsed = '',
        init = init, advance = advance, draw = draw,
    }
end
