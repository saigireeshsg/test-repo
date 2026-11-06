#!/usr/bin/env python3
"""Generates scene.rml for the NEXUS ONE console dashboard.

The scene is regular and repetitive (eight game cards with hover states, four
tracks, three screens), so it is written by this script rather than by hand.
Run `python3 gen.py` after editing, then `rive . --verify`.

Draw order in RML is front-to-back (the first child paints on top). The
helpers below collect children back-to-front, the way a painter thinks, and
`group()` reverses them on output.
"""

import random
from xml.sax.saxutils import quoteattr

W, H = 1280, 720

# ----------------------------------------------------------------- palette
BG0 = "FF07060F"
BG1 = "FF120C2A"
PANEL = "CC151129"
PANEL_EDGE = "33FFFFFF"
TEXT = "FFF4F2FF"
MUTED = "FF9A93B8"
DIM = "FF5E5880"
CYAN = "FF33D9FF"
MAGENTA = "FFD94DFF"
GREEN = "FF4DFFA0"
GOLD = "FFFFC24D"

# ----------------------------------------------------------------- ids
_next = [100]


def nid():
    _next[0] += 1
    return f"0:{_next[0]}"


def a(**kw):
    """Attributes, dropping None. Trailing underscores are stripped."""
    out = []
    for k, v in kw.items():
        if v is None:
            continue
        k = k.rstrip("_")
        if isinstance(v, bool):
            v = "true" if v else "false"
        elif isinstance(v, float):
            v = f"{v:.4f}".rstrip("0").rstrip(".")
        out.append(f"{k}={quoteattr(str(v))}")
    return " ".join(out)


def el(_tag, children=(), **kw):
    attrs = a(**kw)
    head = f"<{_tag} {attrs}" if attrs else f"<{_tag}"
    kids = [c for c in children if c]
    if not kids:
        return head + "/>"
    return head + ">" + "".join(kids) + f"</{_tag}>"


def group(_tag, back_to_front, **kw):
    """A container whose children were listed back-to-front."""
    return el(_tag, list(reversed([c for c in back_to_front if c])), **kw)


# ----------------------------------------------------------------- fixed ids
FONT = "0:2"
VM = "0:3"
VMI = "0:4"
ART = "0:5"
ART_STYLE = "0:6"
SM = "0:7"
TO_BAR = "0:8"       # progress 0..1 -> music bar width
P3D = "0:10"         # 3D script asset
PPLAYER = "0:11"     # player script asset
TO_MINI_BAR = "0:12"

# ----------------------------------------------------------------- view model
VM_PROPS = []  # (name, kind, id, default)


def prop(name, kind, default=None):
    pid = nid()
    VM_PROPS.append((name, kind, pid, default))
    return pid


P_SCREEN = prop("screen", "Number", 0)
P_UP = prop("moveUp", "Trigger")
P_DOWN = prop("moveDown", "Trigger")
P_PLAYING = prop("playing", "Boolean", True)
P_TOGGLE = prop("togglePlay", "Trigger")
P_NEXT = prop("next", "Trigger")
P_PREV = prop("prev", "Trigger")
P_TRACK = prop("track", "Number", 0)
P_TITLE = prop("title", "String", "Neon Horizon")
P_ARTIST = prop("artist", "String", "Synthwave Collective")
P_PROGRESS = prop("progress", "Number", 0.18)
P_ELAPSED = prop("elapsed", "String", "0:37")
P_TOTAL = prop("total", "String", "3:24")
P_DISC = prop("disc", "Number", 0)
P_CLOCK = prop("clock", "String", "9:41 PM")
P_SELECTED = prop("selected", "String", "Starfall Odyssey")
P_GENRE = prop("selectedGenre", "String", "Adventure")

GAMES = [
    # title, genre, hours, color a, color b, icon
    ("Starfall Odyssey", "Adventure", "42h", "FF5B2BFF", "FF00C2FF", "star"),
    ("Neon Drift", "Racing", "18h", "FFFF2E88", "FFFF9E3D", "chevron"),
    ("Ember Knights", "RPG", "67h", "FFFF5E3A", "FF8A1538", "shield"),
    ("Kurukshetra Tactics", "Strategy", "31h", "FFFFB000", "FFB7410E", "chakra"),
    ("Yaksha's Lake", "Puzzle", "9h", "FF00D1B2", "FF1B4DFF", "drop"),
    ("Abyssal Echo", "Horror", "12h", "FF3B1F5C", "FF0A0A1F", "eye"),
    ("Pixel Garden", "Casual", "25h", "FF3DDC84", "FF0F7A5B", "leaf"),
    ("Iron Tempest", "Action", "54h", "FF8E9AAF", "FF2B2D42", "bolt"),
]
P_HOVER = [prop(f"cardHover{i}", "Boolean", False) for i in range(len(GAMES))]
P_TILE_HOVER = [prop(f"tileHover{i}", "Boolean", False) for i in range(3)]
P_MENU_HOVER = [prop(f"menuHover{i}", "Boolean", False) for i in range(3)]

TRACKS = [
    ("Neon Horizon", "Synthwave Collective", "3:24", "FF7B2FF7", "FF00D4FF"),
    ("Pixel Hearts", "8-Bit Dreamers", "2:58", "FFFF4D8D", "FFFFB86B"),
    ("Kurukshetra Dawn", "Raga Machines", "4:12", "FFFF9F1C", "FFE71D36"),
    ("Deep Space Lo-Fi", "Orbit Cafe", "3:46", "FF2EC4B6", "FF3A86FF"),
]


def path(pid):
    return f"{VM}-{pid}"


# ----------------------------------------------------------------- binds
def bind(pid, key, converter=None):
    return el("DataBindContext", sourcePathIds=path(pid), propertyKey=key,
              converterId=converter)


def write_num(pid, value):
    return el("ListenerViewModelChange", [el("BindablePropertyNumber", [
        el("DataBindContext", sourcePathIds=path(pid), propertyKey=636, direction=True)],
        propertyValue=value)])


def write_str(pid, value):
    return el("ListenerViewModelChange", [el("BindablePropertyString", [
        el("DataBindContext", sourcePathIds=path(pid), propertyKey=635, direction=True)],
        propertyValue=value)])


def write_bool(pid, value):
    return el("ListenerViewModelChange", [el("BindablePropertyBoolean", [
        el("DataBindContext", sourcePathIds=path(pid), propertyKey=634, direction=True)],
        propertyValue=value)])


def fire(pid):
    # propertyValue="1" keeps older runtimes firing on a write
    return el("ListenerViewModelChange", [el("BindablePropertyTrigger", [
        el("DataBindContext", sourcePathIds=path(pid), propertyKey=686, direction=True)],
        propertyValue=1)])


def cond_num(pid, value):
    return el("TransitionViewModelCondition", [
        el("TransitionPropertyViewModelComparator", [el("BindablePropertyNumber", [
            el("DataBindContext", sourcePathIds=path(pid), propertyKey=636)])]),
        el("TransitionValueNumberComparator", value=value)], opValue="equal")


def cond_bool(pid, value):
    return el("TransitionViewModelCondition", [
        el("TransitionPropertyViewModelComparator", [el("BindablePropertyBoolean", [
            el("DataBindContext", sourcePathIds=path(pid), propertyKey=634)])]),
        el("TransitionValueBooleanComparator", value=value)])


def cond_trigger(pid):
    return el("TransitionViewModelCondition", [
        el("TransitionPropertyViewModelComparator", [el("BindablePropertyTrigger", [
            el("DataBindContext", sourcePathIds=path(pid), propertyKey=686)])]),
        el("TransitionValueTriggerComparator")])


# ----------------------------------------------------------------- paint
def solid(color, id_=None):
    return el("SolidColor", colorValue=color, name="Color", id=id_)


def fill(paint, feather=None, name="Fill", id_=None):
    kids = [paint]
    if feather:
        kids.append(el("Feather", strength=feather, name="Feather"))
    return el("Fill", kids, name=name, id=id_,
              fillRule="clockwise" if feather else None)


def stroke(paint, thickness=1.0, feather=None, name="Stroke", id_=None):
    kids = [paint]
    if feather:
        kids.append(el("Feather", strength=feather, name="Feather"))
    return el("Stroke", kids, thickness=thickness, name=name, id=id_)


def lin(sx, sy, ex, ey, stops, ids=None):
    ids = ids or [None] * len(stops)
    return el("LinearGradient", [
        el("GradientStop", colorValue=c, position=float(p), id=i)
        for (c, p), i in zip(stops, ids)],
        startX=sx, startY=sy, endX=ex, endY=ey, name="Gradient")


def rad(cx, cy, r, stops, ids=None):
    ids = ids or [None] * len(stops)
    return el("RadialGradient", [
        el("GradientStop", colorValue=c, position=float(p), id=i)
        for (c, p), i in zip(stops, ids)],
        startX=cx, startY=cy, endX=cx + r, endY=cy, name="Gradient")


# ----------------------------------------------------------------- shapes
def rect(x, y, w, h, paints, r=0, ox=0.0, oy=0.0, name="Rect", id_=None,
         rect_id=None, rect_bind=None, opacity=None, extra=()):
    return el("Shape", [
        el("Rectangle", [rect_bind] if rect_bind else [], width=w, height=h,
           cornerRadiusTL=r if r else None, originX=ox, originY=oy, name="Path",
           id=rect_id),
        *paints, *extra], x=x, y=y, name=name, id=id_, opacity=opacity)


def ellipse(x, y, w, h, paints, name="Ellipse", id_=None, opacity=None):
    return el("Shape", [el("Ellipse", width=w, height=h, originX=0.5, originY=0.5,
                           name="Path"), *paints],
              x=x, y=y, name=name, id=id_, opacity=opacity)


def poly(x, y, points, paints, name="Poly", id_=None, closed=True, rotation=None,
         opacity=None):
    verts = [el("StraightVertex", x=float(px), y=float(py)) for px, py in points]
    return el("Shape", [el("PointsPath", verts, isClosed=closed, name="Path"), *paints],
              x=x, y=y, name=name, id=id_, rotation=rotation, opacity=opacity)


def node(children_btf, x=0, y=0, name="Group", id_=None, opacity=None, scale=None,
         rotation=None, bind_=None):
    kids = list(reversed([c for c in children_btf if c]))
    if bind_:
        kids = [bind_] + kids
    return el("Node", kids, x=x, y=y, name=name, id=id_, opacity=opacity,
              scaleX=scale, scaleY=scale, rotation=rotation)


WEIGHT_TAG = 2003265652  # 'wght'


def text(x, y, s, size, color=TEXT, weight=400, ox=0.0, oy=0.0, name="Text",
         id_=None, color_id=None, run_bind=None, width=None, align=None,
         spacing=None, ellipsis=False):
    style = nid()
    sizing = "fixed" if width else "autoWidth"
    return el("Text", [
        el("TextStylePaint", [
            el("Fill", [solid(color, color_id)], name="Fill"),
            el("TextStyleAxis", tag=WEIGHT_TAG, axisValue=weight, name="Weight"),
        ], fontSize=size, fontAssetId=FONT, letterSpacing=spacing, name="Style", id=style),
        el("TextValueRun", [run_bind] if run_bind else [], styleId=style, text=s, name="Run"),
    ], x=x, y=y, originX=ox, originY=oy, sizingValue=sizing, width=width,
        height=size * 1.4 if width else None, alignValue=align,
        overflowValue="ellipsis" if ellipsis else None,
        wrapValue="noWrap" if (width and ellipsis) else None, name=name, id=id_)


# ----------------------------------------------------------------- animation
ANIMS = []


def kf(kind, frame, value, interp="linear", ease=None):
    kids = []
    if interp == "cubic":
        x1, y1, x2, y2 = ease or (0.22, 1.0, 0.36, 1.0)
        kids.append(el("CubicEaseInterpolator", x1=x1, y1=y1, x2=x2, y2=y2))
    attrs = dict(value=value, frame=frame)
    if kind in ("Double", "Color"):
        attrs["interpolationType"] = interp
    return el(f"KeyFrame{kind}", kids, **attrs)


def keyed(obj, prop_name, kind, frames):
    """frames: list of (frame, value) or (frame, value, interp)."""
    kfs = []
    for f in frames:
        frame, value = f[0], f[1]
        interp = f[2] if len(f) > 2 else ("hold" if kind == "Id" else "linear")
        kfs.append(kf(kind, frame, value, interp))
    return (obj, el("KeyedProperty", kfs, property=prop_name))


def anim(name, duration, keys, loop=False):
    aid = nid()
    by_obj = {}
    order = []
    for obj, kp in keys:
        if obj not in by_obj:
            by_obj[obj] = []
            order.append(obj)
        by_obj[obj].append(kp)
    ANIMS.append(el("LinearAnimation", [
        el("KeyedObject", by_obj[o], objectId=o) for o in order],
        loopValue="loop" if loop else None, duration=duration, name=name, id=aid))
    return aid


# ----------------------------------------------------------------- icons
def icon_home(x, y, color_id, color):
    return poly(x, y, [(0, -9), (9, -1), (6, -1), (6, 8), (2, 8), (2, 3), (-2, 3),
                       (-2, 8), (-6, 8), (-6, -1), (-9, -1)],
                [fill(solid(color, color_id))], name="HomeIcon")


def icon_grid(x, y, color_id, color):
    paint = fill(solid(color, color_id))
    # one path, four squares wound the same way
    verts = []
    shapes = []
    for dx in (-5, 5):
        for dy in (-5, 5):
            shapes.append(el("Rectangle", width=8, height=8, cornerRadiusTL=2,
                             originX=0.5, originY=0.5, x=dx, y=dy, name="Cell"))
    return el("Shape", shapes + [paint], x=x, y=y, name="GridIcon")


def icon_note(x, y, color_id, color):
    paint = fill(solid(color, color_id))
    return el("Shape", [
        el("Ellipse", width=8, height=7, originX=0.5, originY=0.5, x=-4, y=6, name="Head"),
        el("Ellipse", width=8, height=7, originX=0.5, originY=0.5, x=6, y=4, name="Head2"),
        el("Rectangle", width=2.2, height=15, originX=0, originY=1, x=-1.2, y=6, name="Stem"),
        el("Rectangle", width=2.2, height=15, originX=0, originY=1, x=8.8, y=4, name="Stem2"),
        el("Rectangle", width=12.2, height=3, originX=0, originY=0, x=-1.2, y=-10,
           name="Beam"),
        paint], x=x, y=y, name="NoteIcon")


def game_icon(kind, color="E6FFFFFF"):
    p = [fill(solid(color))]
    if kind == "star":
        return el("Shape", [el("Star", width=46, height=46, points=5, innerRadius=0.45,
                                originX=0.5, originY=0.5, name="Path"), *p], name="Icon")
    if kind == "chevron":
        return poly(0, 0, [(-22, -16), (2, -16), (22, 0), (2, 16), (-22, 16), (-2, 0)], p,
                    name="Icon")
    if kind == "shield":
        return poly(0, 0, [(0, -24), (20, -16), (18, 6), (0, 24), (-18, 6), (-20, -16)], p,
                    name="Icon")
    if kind == "chakra":
        return el("Shape", [el("Star", width=50, height=50, points=12, innerRadius=0.72,
                                originX=0.5, originY=0.5, name="Path"),
                            el("Ellipse", width=16, height=16, originX=0.5, originY=0.5,
                               name="Hub"), *p], name="Icon")
    if kind == "drop":
        return poly(0, 0, [(0, -24), (12, -6), (16, 6), (10, 18), (0, 22), (-10, 18),
                           (-16, 6), (-12, -6)], p, name="Icon")
    if kind == "eye":
        return el("Shape", [el("Ellipse", width=52, height=26, originX=0.5, originY=0.5,
                                name="Path"), *p,
                            ], name="Icon")
    if kind == "leaf":
        return poly(0, 0, [(-18, 18), (-16, -4), (-4, -18), (20, -20), (16, 4), (2, 16)], p,
                    name="Icon", rotation=0.0)
    if kind == "bolt":
        return poly(0, 0, [(4, -26), (-14, 4), (-2, 4), (-6, 26), (14, -6), (2, -6)], p,
                    name="Icon")
    raise ValueError(kind)


# ============================================================ the scene
layers = []      # StateMachineLayer xml
listeners = []   # listener xml
STATE_X = [0]


def state_pos():
    STATE_X[0] += 1
    return STATE_X[0]


# ----------------------------------------------------------------- background
BG_SHAPE = nid()
BG_FOCUS = nid()
GLOW_A = nid()
GLOW_B = nid()
background = [
    el("Shape", [
        el("FocusData", id=BG_FOCUS),
        el("SemanticData", role="group", label="NEXUS ONE dashboard"),
        el("Rectangle", width=W, height=H, originX=0, originY=0, name="Path"),
        fill(lin(0, 0, W, H, [(BG1, 0), (BG0, 0.6), ("FF0A0718", 1)])),
    ], name="Background", id=BG_SHAPE),
    ellipse(380, 120, 620, 620, [fill(rad(0, 0, 310, [("40D94DFF", 0), ("00D94DFF", 1)]))],
            name="GlowMagenta", id_=GLOW_A),
    ellipse(1080, 640, 760, 760, [fill(rad(0, 0, 380, [("3833D9FF", 0), ("0033D9FF", 1)]))],
            name="GlowCyan", id_=GLOW_B),
]
ambient = anim("Ambient Drift", 600, [
    keyed(GLOW_A, "x", "Double", [(0, 380, "cubic"), (300, 520, "cubic"), (600, 380)]),
    keyed(GLOW_A, "y", "Double", [(0, 120, "cubic"), (300, 220, "cubic"), (600, 120)]),
    keyed(GLOW_B, "x", "Double", [(0, 1080, "cubic"), (300, 940, "cubic"), (600, 1080)]),
    keyed(GLOW_B, "scaleX", "Double", [(0, 1, "cubic"), (300, 1.2, "cubic"), (600, 1)]),
    keyed(GLOW_B, "scaleY", "Double", [(0, 1, "cubic"), (300, 1.2, "cubic"), (600, 1)]),
], loop=True)

# ----------------------------------------------------------------- 3D hero (home only)
HERO_X, HERO_Y, HERO_W, HERO_H = 268, 96, 988, 372
# The script's GPU canvas composites above markup, so the 3D viewport sits to
# the right of the hero copy instead of underneath it.
VIEW_X = HERO_X + 400
VIEW_W = HERO_X + HERO_W - VIEW_X
HERO_BG = nid()
HERO_3D = nid()
HERO_CLIP = nid()
HERO_CARD = nid()
hero_bg = node([
    rect(0, 0, HERO_W, HERO_H, [
        fill(rad(HERO_W * 0.68, HERO_H * 0.55, 560,
                 [("FF2A1A5E", 0), ("FF140F33", 0.55), ("FF0C0A1E", 1)])),
        stroke(lin(0, 0, HERO_W, HERO_H, [("66D94DFF", 0), ("1AFFFFFF", 0.5), ("6633D9FF", 1)]),
               1.5),
    ], r=24, name="HeroCard", id_=HERO_CARD),
], x=HERO_X, y=HERO_Y, name="HeroBackdrop", id_=HERO_BG)

hero_clip_shape = rect(HERO_X, HERO_Y, HERO_W, HERO_H, [], r=24, name="HeroClip",
                       id_=HERO_CLIP)

hero_3d = el("LayoutComponent", [
    el("LayoutComponentStyle", positionTypeValue="absolute",
       positionLeft=VIEW_X, positionLeftUnitsValue="points",
       positionTop=HERO_Y, positionTopUnitsValue="points",
       widthUnitsValue="points", heightUnitsValue="points",
       name="Hero3D Style", id="0:20"),
    el("ScriptedLayout", [el("ScriptInputNumber", propertyValue=1, name="speed")],
       scriptAssetId=P3D, name="Console3D"),
    el("ClippingShape", sourceId=HERO_CLIP, name="Clip"),
], width=VIEW_W, height=HERO_H, styleId="0:20", name="Hero3D", id=HERO_3D)

player_engine = el("LayoutComponent", [
    el("LayoutComponentStyle", positionTypeValue="absolute",
       positionLeft=0, positionLeftUnitsValue="points",
       positionTop=0, positionTopUnitsValue="points",
       widthUnitsValue="points", heightUnitsValue="points",
       name="Engine Style", id="0:21"),
    el("ScriptedLayout", scriptAssetId=PPLAYER, name="PlayerEngine"),
], width=1, height=1, styleId="0:21", name="PlayerEngine")

# ----------------------------------------------------------------- sidebar
SIDEBAR_W = 240
MENU = [("Home", icon_home), ("Library", icon_grid), ("Music", icon_note)]
MENU_Y0, MENU_DY = 168, 58
PILL = nid()
menu_label_colors = []
menu_icon_colors = []
menu_hit = []
menu_hover_bg = []
sidebar_items = []
for i, (label, icon) in enumerate(MENU):
    y = MENU_Y0 + i * MENU_DY
    lc, ic, hit, hov = nid(), nid(), nid(), nid()
    menu_label_colors.append(lc)
    menu_icon_colors.append(ic)
    menu_hit.append(hit)
    menu_hover_bg.append(hov)
    sidebar_items += [
        rect(20, y, 200, 46, [fill(solid("00FFFFFF"))], r=14, oy=0.5, name=f"{label}Hit",
             id_=hit),
        rect(20, y, 200, 46, [fill(solid("14FFFFFF"))], r=14, oy=0.5, name=f"{label}Hover",
             id_=hov, opacity=0.0),
        icon(48, y, ic, MUTED),
        text(74, y, label, 16, MUTED, 600, oy=0.5, name=f"{label}Label", color_id=lc),
    ]

MINI_ART_A, MINI_ART_B = nid(), nid()
MINI_EQ = [nid() for _ in range(3)]
sidebar = node([
    rect(0, 0, SIDEBAR_W, H, [fill(solid("B30B0919")), ], name="SidebarBg"),
    rect(SIDEBAR_W - 1, 0, 1, H, [fill(solid(PANEL_EDGE))], name="SidebarEdge"),
    # logo
    poly(46, 62, [(0, -18), (16, -9), (16, 9), (0, 18), (-16, 9), (-16, -9)],
         [fill(lin(-16, -18, 16, 18, [(MAGENTA, 0), (CYAN, 1)]))], name="LogoHex"),
    poly(46, 62, [(-5, -7), (7, 0), (-5, 7)], [fill(solid("FF0B0919"))], name="LogoPlay"),
    text(74, 50, "NEXUS", 20, TEXT, 800, spacing=3, name="LogoText"),
    text(75, 74, "ONE  ·  CONSOLE OS", 9, MUTED, 600, spacing=2, name="LogoSub"),
    text(28, 120, "MENU", 10, DIM, 700, spacing=2, name="MenuCaption"),
    # active pill, slides between rows
    node([
        rect(0, 0, 200, 46, [
            fill(lin(0, 0, 200, 0, [("59D94DFF", 0), ("1A33D9FF", 1)])),
            stroke(lin(0, 0, 200, 0, [("99D94DFF", 0), ("3333D9FF", 1)]), 1),
        ], r=14, oy=0.5, name="Pill"),
        rect(0, 0, 4, 22, [fill(lin(0, -11, 0, 11, [(MAGENTA, 0), (CYAN, 1)]))], r=2,
             oy=0.5, name="PillMark"),
    ], x=20, y=MENU_Y0, name="ActivePill", id_=PILL),
    *sidebar_items,
    text(28, 352, "KEYS", 10, DIM, 700, spacing=2, name="KeysCaption"),
    text(28, 372, "↑ ↓  switch screen", 11, MUTED, 400, name="KeyHint1"),
    text(28, 390, "Space  play / pause", 11, MUTED, 400, name="KeyHint2"),
    text(28, 408, "← →  previous / next track", 11, MUTED, 400, name="KeyHint3"),
    # mini player
    rect(16, 556, 208, 76, [fill(solid("1AFFFFFF")), stroke(solid(PANEL_EDGE), 1)], r=16,
         name="MiniCard"),
    rect(28, 568, 52, 52, [fill(lin(0, 0, 52, 52, [(TRACKS[0][3], 0), (TRACKS[0][4], 1)],
                                    ids=[MINI_ART_A, MINI_ART_B]))], r=12, name="MiniArt"),
    text(90, 572, "Neon Horizon", 13, TEXT, 700, width=100, ellipsis=True, name="MiniTitle",
         run_bind=bind(P_TITLE, 268)),
    text(90, 591, "Synthwave Collective", 11, MUTED, 400, width=122, ellipsis=True,
         name="MiniArtist", run_bind=bind(P_ARTIST, 268)),
    rect(90, 614, 120, 3, [fill(solid("26FFFFFF"))], r=1.5, name="MiniTrack"),
    rect(90, 614, 22, 3, [fill(lin(0, 0, 120, 0, [(MAGENTA, 0), (CYAN, 1)]))], r=1.5,
         name="MiniFill", rect_bind=bind(P_PROGRESS, 20, TO_MINI_BAR)),
    *[rect(198 + k * 6, 580, 3, 10, [fill(solid(CYAN))], r=1.5, oy=1, name=f"MiniEq{k}",
           rect_id=MINI_EQ[k]) for k in range(3)],
    # profile
    ellipse(44, 676, 36, 36, [fill(lin(-18, -18, 18, 18, [(GOLD, 0), (MAGENTA, 1)]))],
            name="Avatar"),
    text(44, 676, "P1", 12, "FF0B0919", 800, ox=0.5, oy=0.5, name="AvatarText"),
    text(72, 662, "Player One", 14, TEXT, 700, name="ProfileName"),
    ellipse(76, 688, 7, 7, [fill(solid(GREEN))], name="OnlineDot"),
    text(85, 681, "Online · Lv 42", 11, MUTED, 400, name="ProfileStatus"),
], name="Sidebar")

# ----------------------------------------------------------------- top bar
topbar = node([
    text(1180, 36, "9:41 PM", 15, TEXT, 600, ox=1, oy=0.5, name="Clock",
         run_bind=bind(P_CLOCK, 268)),
    # wifi bars
    *[rect(1196 + k * 6, 42, 4, 6 + k * 4, [fill(solid(TEXT if k < 3 else DIM))], r=1,
           oy=1, name=f"Wifi{k}") for k in range(4)],
    # battery
    rect(1226, 36, 26, 13, [stroke(solid(MUTED), 1.5)], r=3.5, oy=0.5, name="BatteryBody"),
    rect(1229, 36, 16, 7, [fill(solid(GREEN))], r=1.5, oy=0.5, name="BatteryFill"),
    rect(1253, 36, 2.5, 5, [fill(solid(MUTED))], r=1, oy=0.5, name="BatteryCap"),
], name="TopBar")

# ----------------------------------------------------------------- home panel
HOME_CONTENT = nid()
hero_bar_w = 260
tiles = [
    ("Game Library", "8 games installed", "Browse", 1, MAGENTA),
    ("Music", "Now playing", "Open player", 2, CYAN),
    ("Trophies", "248 earned · 12 friends online", "", None, GOLD),
]
tile_glows = []
tile_hits = []  # (hit shape, group node, screen to open)
TILE_W, TILE_H, TILE_Y = 314, 196, 490
for i, (title, sub, cta, target, accent) in enumerate(tiles):
    glow, hit, grp = nid(), nid(), nid()
    tile_glows.append(glow)
    tile_hits.append((hit, grp, target))


def centred(kids, cx, cy, w, h, name, id_):
    """A node at the item's centre (so it scales from there) whose children are
    authored from the item's top-left."""
    inner = node(kids, x=-w / 2, y=-h / 2, name=name + "Content")
    return node([inner], x=cx, y=cy, name=name, id_=id_)


TILE_KIDS = []
for i, (title, sub, cta, target, accent) in enumerate(tiles):
    glow = tile_glows[i]
    hit, grp, _ = tile_hits[i]
    kids = [
        rect(0, 0, TILE_W, TILE_H, [fill(solid(PANEL)), stroke(solid(PANEL_EDGE), 1)], r=20,
             name="TileBg", id_=hit),
        rect(0, 0, TILE_W, TILE_H, [stroke(solid(accent), 2), ], r=20, name="TileGlow",
             id_=glow, opacity=0.0),
        ellipse(TILE_W - 56, 56, 160, 160,
                [fill(rad(0, 0, 80, [("44" + accent[2:], 0), ("00" + accent[2:], 1)]))],
                name="TileOrb"),
        rect(24, 24, 46, 46, [fill(lin(0, 0, 46, 46, [(accent, 0), ("FF1B1640", 1)]))], r=13,
             name="TileIconBg"),
        text(24, 90, title, 22, TEXT, 800, name="TileTitle"),
        text(24, 122, sub, 13, MUTED, 400, name="TileSub"),
    ]
    if i == 0:
        kids.append(icon_grid(47, 47, None, "FFFFFFFF"))
    elif i == 1:
        kids.append(icon_note(45, 48, None, "FFFFFFFF"))
        kids.append(text(106, 122, "Neon Horizon", 13, TEXT, 700, width=190, ellipsis=True,
                         name="TileNow", run_bind=bind(P_TITLE, 268)))
    else:
        kids.append(el("Shape", [el("Star", width=26, height=26, points=5, innerRadius=0.5,
                                     originX=0.5, originY=0.5, name="Path"),
                                  fill(solid("FFFFFFFF"))], x=47, y=48, name="TrophyIcon"))
        kids += [rect(24, 164, 230, 6, [fill(solid("1FFFFFFF"))], r=3, name="TrophyTrack"),
                 rect(24, 164, 166, 6, [fill(lin(0, 0, 230, 0, [(GOLD, 0), (MAGENTA, 1)]))],
                      r=3, name="TrophyFill"),
                 text(290, 158, "72%", 13, GOLD, 800, ox=1, name="TrophyPct")]
    if cta:
        kids.append(text(24, 160, cta + "  →", 13, accent, 700, name="TileCta"))
    tx = 268 + i * (TILE_W + 23)
    TILE_KIDS.append(centred(kids, tx + TILE_W / 2, TILE_Y + TILE_H / 2, TILE_W, TILE_H,
                             f"Tile{i}", grp))

home = node([
    text(270, 30, "WELCOME BACK", 11, MUTED, 700, spacing=2, name="HomeKicker"),
    text(270, 46, "Player One", 28, TEXT, 800, name="HomeTitle"),
    # hero overlay copy (the 3D scene renders behind this, on the right)
    rect(300, 140, 92, 26, [fill(solid("33D94DFF")), stroke(solid("80D94DFF"), 1)], r=13,
         name="FeaturedChip"),
    text(346, 153, "CONTINUE", 10, "FFF0B8FF", 800, ox=0.5, oy=0.5, spacing=2,
         name="FeaturedText"),
    text(300, 182, "Starfall Odyssey", 38, TEXT, 800, name="HeroGame"),
    text(302, 232, "Chapter 7 · The Shattered Moon", 15, MUTED, 400, name="HeroChapter"),
    rect(302, 274, hero_bar_w, 6, [fill(solid("1FFFFFFF"))], r=3, name="HeroTrack"),
    rect(302, 274, hero_bar_w * 0.62, 6, [fill(lin(0, 0, hero_bar_w, 0,
                                                   [(MAGENTA, 0), (CYAN, 1)]))], r=3,
         name="HeroFill"),
    text(302 + hero_bar_w + 12, 270, "62%", 12, TEXT, 700, name="HeroPct"),
    rect(302, 310, 148, 50, [fill(lin(0, 0, 148, 0, [(MAGENTA, 0), ("FF7A5CFF", 1)])),
                             fill(solid("80D94DFF"), feather=18, name="Glow")], r=25,
         name="ResumeBtn"),
    poly(334, 335, [(-6, -8), (8, 0), (-6, 8)], [fill(solid("FFFFFFFF"))], name="ResumeIcon"),
    text(350, 335, "Resume", 16, "FFFFFFFF", 700, oy=0.5, name="ResumeText"),
    rect(462, 310, 120, 50, [fill(solid("14FFFFFF")), stroke(solid("40FFFFFF"), 1)], r=25,
         name="DetailsBtn"),
    text(522, 335, "Details", 15, TEXT, 600, ox=0.5, oy=0.5, name="DetailsText"),
    text(302, 400, "12 FRIENDS ONLINE", 10, MUTED, 700, spacing=2, name="FriendsCaption"),
    *[ellipse(314 + k * 22, 432, 30, 30,
              [fill(lin(-15, -15, 15, 15, [(c1, 0), (c2, 1)])), stroke(solid("FF140F33"), 2.5)],
              name=f"Friend{k}")
      for k, (c1, c2) in enumerate([(CYAN, "FF1B4DFF"), (GOLD, "FFFF5E3A"),
                                    (GREEN, "FF0F7A5B"), (MAGENTA, "FF5B2BFF")])],
    text(412, 432, "+8", 13, TEXT, 700, oy=0.5, name="FriendsMore"),
    *TILE_KIDS,
], name="HomeContent", id_=HOME_CONTENT)

# ----------------------------------------------------------------- library panel
LIB_CONTENT = nid()
CARD_W, CARD_H, GAP = 230, 236, 18
GRID_X, GRID_Y = 268, 150
cards = []
card_parts = []  # (node id, glow id, pill id, hit id)
for i, (title, genre, hours, c1, c2, ic) in enumerate(GAMES):
    col, row = i % 4, i // 4
    cx = GRID_X + col * (CARD_W + GAP) + CARD_W / 2
    cy = GRID_Y + row * (CARD_H + GAP) + CARD_H / 2
    grp, glow, pill, hit = nid(), nid(), nid(), nid()
    card_parts.append((grp, glow, pill, hit))
    kids = [
        rect(0, 0, CARD_W, CARD_H, [fill(solid("FF000000"), feather=26, name="Shadow")],
             r=20, name="Shadow", opacity=0.5),
        rect(0, 0, CARD_W, CARD_H, [fill(solid(PANEL)), stroke(solid(PANEL_EDGE), 1)], r=20,
             name="CardBg", id_=hit),
        rect(10, 10, CARD_W - 20, 144, [fill(lin(0, 0, CARD_W - 20, 144, [(c1, 0), (c2, 1)]))],
             r=14, name="Art"),
        ellipse(CARD_W - 50, 40, 120, 120,
                [fill(rad(0, 0, 60, [("40FFFFFF", 0), ("00FFFFFF", 1)]))], name="ArtShine"),
        node([game_icon(ic)], x=CARD_W / 2, y=82, name="IconHolder"),
        text(22, 166, title, 15, TEXT, 700, width=CARD_W - 44, ellipsis=True,
             name="CardTitle"),
        text(22, 192, genre, 12, MUTED, 400, name="CardGenre"),
        text(CARD_W - 22, 192, hours, 12, MUTED, 600, ox=1, name="CardHours"),
        rect(22, 218, CARD_W - 44, 3, [fill(solid("14FFFFFF"))], r=1.5, name="CardTrack"),
        rect(22, 218, (CARD_W - 44) * (0.25 + (i * 37 % 70) / 100), 3,
             [fill(solid(c1 if c1 != "FF3B1F5C" else MAGENTA))], r=1.5, name="CardFill"),
        # hover-only pieces
        rect(0, 0, CARD_W, CARD_H, [stroke(lin(0, 0, CARD_W, CARD_H, [(MAGENTA, 0),
                                                                     (CYAN, 1)]), 2.5),
                                    stroke(solid("99D94DFF"), 6, feather=14, name="Halo")],
             r=20, name="HoverGlow", id_=glow, opacity=0.0),
        node([
            ellipse(0, 0, 58, 58, [fill(solid("E6FFFFFF")),
                                   fill(solid("66000000"), feather=16, name="Shadow")],
                    name="PlayDisc"),
            poly(3, 0, [(-9, -12), (13, 0), (-9, 12)], [fill(solid("FF140F33"))],
                 name="PlayGlyph"),
        ], x=CARD_W / 2, y=82, name="PlayBadge", id_=pill, opacity=0.0),
    ]
    cards.append(centred(kids, cx, cy, CARD_W, CARD_H, f"Card{i}", grp))

CHIPS = ["All games", "Action", "RPG", "Racing", "Indie"]
chip_nodes = []
chx = 268
for k, c in enumerate(CHIPS):
    w = 24 + len(c) * 8
    active = k == 0
    chip_nodes += [
        rect(chx, 100, w, 32, [fill(solid("33D94DFF" if active else "12FFFFFF")),
                               stroke(solid("99D94DFF" if active else PANEL_EDGE), 1)],
             r=16, name=f"Chip{k}"),
        text(chx + w / 2, 116, c, 12, TEXT if active else MUTED, 700 if active else 500,
             ox=0.5, oy=0.5, name=f"ChipText{k}"),
    ]
    chx += w + 10

library = node([
    text(270, 30, "YOUR COLLECTION", 11, MUTED, 700, spacing=2, name="LibKicker"),
    text(270, 46, "Game Library", 28, TEXT, 800, name="LibTitle"),
    *chip_nodes,
    text(1252, 116, "Sort: Recently played", 12, MUTED, 500, ox=1, oy=0.5, name="Sort"),
    *cards,
    rect(268, 664, 988, 44, [fill(solid("14FFFFFF")), stroke(solid(PANEL_EDGE), 1)], r=14,
         name="SelectBar"),
    ellipse(290, 686, 8, 8, [fill(solid(GREEN))], name="SelectDot"),
    text(304, 686, "Selected:", 13, MUTED, 500, oy=0.5, name="SelectLabel"),
    text(370, 686, "Starfall Odyssey", 13, TEXT, 800, oy=0.5, name="SelectValue",
         run_bind=bind(P_SELECTED, 268)),
    text(1240, 686, "Hover a game to preview · click to select", 12, MUTED, 400, ox=1,
         oy=0.5, name="SelectHint"),
], name="LibraryContent", id_=LIB_CONTENT)

# ----------------------------------------------------------------- music panel
MUSIC_CONTENT = nid()
SLEEVE_A, SLEEVE_B = nid(), nid()
LABEL_A, LABEL_B = nid(), nid()
DISC = nid()
ROW_PILL = nid()
PLAY_SOLO, PLAY_ICON, PAUSE_ICON = nid(), nid(), nid()
PLAY_BTN, PREV_BTN, NEXT_BTN = nid(), nid(), nid()
EQ_N = 22
EQ_IDS = [nid() for _ in range(EQ_N)]
row_hits = []
BAR_X, BAR_Y, BAR_W = 770, 296, 470
ROW_Y0 = 534
grooves = [ellipse(0, 0, d, d, [stroke(solid("14FFFFFF"), 1)], name=f"Groove{k}")
           for k, d in enumerate(range(150, 300, 18))]
disc = node([
    ellipse(0, 0, 316, 316, [fill(solid("FF050409")),
                             fill(solid("AA000000"), feather=30, name="Shadow")],
            name="Vinyl"),
    *grooves,
    ellipse(0, 0, 316, 316, [fill(lin(-158, -158, 158, 158,
                                      [("00FFFFFF", 0.3), ("1FFFFFFF", 0.5),
                                       ("00FFFFFF", 0.7)]))], name="Sheen"),
    ellipse(0, 0, 112, 112, [fill(lin(-56, -56, 56, 56,
                                      [(TRACKS[0][3], 0), (TRACKS[0][4], 1)],
                                      ids=[LABEL_A, LABEL_B]))], name="Label"),
    rect(0, -34, 6, 14, [fill(solid("66FFFFFF"))], r=3, ox=0.5, oy=0.5, name="LabelMark"),
    ellipse(0, 0, 12, 12, [fill(solid(BG0))], name="Spindle"),
], x=0, y=0, name="Disc", id_=DISC, bind_=bind(P_DISC, 15))

rows = []
for k, (t, art, dur, c1, c2) in enumerate(TRACKS):
    ry = ROW_Y0 + k * 46
    hit = nid()
    row_hits.append(hit)
    rows += [
        rect(BAR_X - 10, ry, BAR_W + 20, 40, [fill(solid("00FFFFFF"))], r=12, oy=0.5,
             name=f"Row{k}Hit", id_=hit),
        rect(BAR_X, ry, 28, 28, [fill(lin(0, 0, 28, 28, [(c1, 0), (c2, 1)]))], r=7, oy=0.5,
             name=f"Row{k}Art"),
        text(BAR_X + 40, ry - 9, t, 13, TEXT, 700, name=f"Row{k}Title"),
        text(BAR_X + 40, ry + 8, art, 11, MUTED, 400, name=f"Row{k}Artist"),
        text(BAR_X + BAR_W, ry, dur, 12, MUTED, 500, ox=1, oy=0.5, name=f"Row{k}Dur"),
    ]

music = node([
    text(270, 30, "NOW PLAYING", 11, MUTED, 700, spacing=2, name="MusicKicker"),
    text(270, 46, "Music", 28, TEXT, 800, name="MusicTitle"),
    rect(268, 96, 988, 372, [fill(solid("80110D24")), stroke(solid(PANEL_EDGE), 1)], r=24,
         name="PlayerCard"),
    # sleeve + vinyl
    rect(300, 128, 300, 300, [fill(lin(0, 0, 300, 300, [(TRACKS[0][3], 0),
                                                         (TRACKS[0][4], 1)],
                                       ids=[SLEEVE_A, SLEEVE_B])),
                              fill(solid("AA000000"), feather=28, name="Shadow")],
         r=18, name="Sleeve"),
    ellipse(380, 210, 220, 220, [fill(rad(0, 0, 110, [("55FFFFFF", 0), ("00FFFFFF", 1)]))],
            name="SleeveShine"),
    text(322, 396, "NEXUS RECORDS", 10, "CCFFFFFF", 800, spacing=3, name="SleeveText"),
    node([disc], x=560, y=278, name="DiscHolder"),
    # info
    text(BAR_X, 140, "Neon Horizon", 34, TEXT, 800, width=BAR_W, ellipsis=True,
         name="TrackTitle", run_bind=bind(P_TITLE, 268)),
    text(BAR_X, 190, "Synthwave Collective", 16, MUTED, 500, width=BAR_W, ellipsis=True,
         name="TrackArtist", run_bind=bind(P_ARTIST, 268)),
    rect(BAR_X, 236, 110, 26, [fill(solid("2633D9FF")), stroke(solid("6633D9FF"), 1)], r=13,
         name="HiResChip"),
    text(BAR_X + 55, 249, "HI-RES  ·  FLAC", 10, "FFB8F2FF", 800, ox=0.5, oy=0.5,
         name="HiResText"),
    # progress
    rect(BAR_X, BAR_Y, BAR_W, 6, [fill(solid("1FFFFFFF"))], r=3, name="ProgressTrack"),
    rect(BAR_X, BAR_Y, 84, 6, [fill(lin(0, 0, BAR_W, 0, [(MAGENTA, 0), (CYAN, 1)]))], r=3,
         name="ProgressFill", rect_bind=bind(P_PROGRESS, 20, TO_BAR)),
    text(BAR_X, BAR_Y + 18, "0:37", 12, MUTED, 600, name="Elapsed",
         run_bind=bind(P_ELAPSED, 268)),
    text(BAR_X + BAR_W, BAR_Y + 18, "3:24", 12, MUTED, 600, ox=1, name="Total",
         run_bind=bind(P_TOTAL, 268)),
    # controls
    ellipse(BAR_X + 140, 392, 48, 48, [fill(solid("14FFFFFF"))], name="PrevBtn",
            id_=PREV_BTN),
    poly(BAR_X + 140, 392, [(6, -8), (-6, 0), (6, 8)], [fill(solid(TEXT))], name="PrevGlyph"),
    rect(BAR_X + 132, 392, 3, 16, [fill(solid(TEXT))], r=1, ox=0.5, oy=0.5, name="PrevBar"),
    ellipse(BAR_X + 235, 392, 76, 76, [fill(lin(-38, -38, 38, 38, [(MAGENTA, 0),
                                                                  ("FF7A5CFF", 1)])),
                                       fill(solid("99D94DFF"), feather=22, name="Glow")],
            name="PlayBtn", id_=PLAY_BTN),
    el("Solo", [
        poly(3, 0, [(-9, -13), (13, 0), (-9, 13)], [fill(solid("FFFFFFFF"))], name="PlayIcon",
             id_=PLAY_ICON),
        el("Shape", [el("Rectangle", width=6, height=24, cornerRadiusTL=2, x=-6, originX=0.5,
                        originY=0.5, name="L"),
                     el("Rectangle", width=6, height=24, cornerRadiusTL=2, x=6, originX=0.5,
                        originY=0.5, name="R"),
                     fill(solid("FFFFFFFF"))], name="PauseIcon", id=PAUSE_ICON),
    ], activeComponentId=PAUSE_ICON, x=BAR_X + 235, y=392, name="PlayPause", id=PLAY_SOLO),
    ellipse(BAR_X + 330, 392, 48, 48, [fill(solid("14FFFFFF"))], name="NextBtn",
            id_=NEXT_BTN),
    poly(BAR_X + 330, 392, [(-6, -8), (6, 0), (-6, 8)], [fill(solid(TEXT))], name="NextGlyph"),
    rect(BAR_X + 338, 392, 3, 16, [fill(solid(TEXT))], r=1, ox=0.5, oy=0.5, name="NextBar"),
    # equalizer
    rect(268, 486, 472, 222, [fill(solid("80110D24")), stroke(solid(PANEL_EDGE), 1)], r=20,
         name="VisualizerCard"),
    rect(752, 486, 504, 222, [fill(solid("80110D24")), stroke(solid(PANEL_EDGE), 1)], r=20,
         name="QueueCard"),
    *[rect(298 + k * 19, 690, 11, 12, [fill(lin(0, 0, 0, -80, [(MAGENTA, 0), (CYAN, 1)]))],
           r=3, oy=1, name=f"Eq{k}", rect_id=EQ_IDS[k]) for k in range(EQ_N)],
    text(292, 502, "VISUALIZER", 10, DIM, 700, spacing=2, name="EqCaption"),
    text(BAR_X, 502, "UP NEXT", 10, DIM, 700, spacing=2, name="UpNext"),
    rect(BAR_X - 10, ROW_Y0, BAR_W + 20, 40, [fill(solid("1FFFFFFF")),
                                           stroke(solid("40D94DFF"), 1)], r=12, oy=0.5,
         name="RowPill", id_=ROW_PILL),
    *rows,
], name="MusicContent", id_=MUSIC_CONTENT)

PANELS = nid()
P_HOME, P_LIB, P_MUSIC = nid(), nid(), nid()
panels = el("Solo", [
    node([home], name="HomePanel", id_=P_HOME),
    node([library], name="LibraryPanel", id_=P_LIB),
    node([music], name="MusicPanel", id_=P_MUSIC),
], activeComponentId=P_HOME, name="Screens", id=PANELS)

# ============================================================ state machine
def layer(name, entry_to, states):
    return el("StateMachineLayer", [
        el("AnyState", x=0, y=-150),
        el("ExitState", x=0, y=-250),
        el("EntryState", [el("StateTransition", stateToId=entry_to)], x=-250, y=0),
        *states,
    ], name=name)


def state(sid, anim_id, name, kids, x, y):
    return el("AnimationState", kids, animationId=anim_id, stateName=name, x=x, y=y, id=sid)


def trans(to, conds, duration=None, exit_time=False):
    kw = dict(stateToId=to, duration=duration)
    if duration:
        kw["enableEarlyExit"] = True
    return el("StateTransition", conds, **kw)


# ---- screens
SCREEN_STATES = [nid() for _ in range(3)]
content_ids = [HOME_CONTENT, LIB_CONTENT, MUSIC_CONTENT]
panel_ids = [P_HOME, P_LIB, P_MUSIC]
screen_anims = []
for s in range(3):
    keys = [
        keyed(PANELS, "activeComponentId", "Id", [(0, panel_ids[s])]),
        keyed(content_ids[s], "opacity", "Double", [(0, 0.0, "cubic"), (20, 1.0)]),
        keyed(content_ids[s], "y", "Double", [(0, 26, "cubic"), (24, 0)]),
        keyed(PILL, "y", "Double", [(0, MENU_Y0 + s * MENU_DY)]),
        keyed(HERO_BG, "opacity", "Double", [(0, 1.0 if s == 0 else 0.0)]),
        keyed(HERO_3D, "opacity", "Double",
              [(0, 0.0, "cubic"), (30, 1.0)] if s == 0 else [(0, 0.0)]),
    ]
    for k in range(3):
        keys.append(keyed(menu_label_colors[k], "colorValue", "Color",
                          [(0, TEXT if k == s else MUTED)]))
        keys.append(keyed(menu_icon_colors[k], "colorValue", "Color",
                          [(0, TEXT if k == s else MUTED)]))
    screen_anims.append(anim(f"Show {MENU[s][0]}", 30, keys))

screen_states = []
for s in range(3):
    kids = [write_num(P_SCREEN, s)]
    if s == 0:
        kids.insert(0, el("FocusActionTarget", targetId=BG_SHAPE))
    trs = []
    for t in range(3):
        if t != s:
            trs.append(trans(SCREEN_STATES[t], [cond_num(P_SCREEN, t)], duration=260))
    if s > 0:
        trs.append(trans(SCREEN_STATES[s - 1], [cond_trigger(P_UP)], duration=260))
    if s < 2:
        trs.append(trans(SCREEN_STATES[s + 1], [cond_trigger(P_DOWN)], duration=260))
    screen_states.append(state(SCREEN_STATES[s], screen_anims[s], MENU[s][0], kids + trs,
                               250, s * 120))
layers.append(layer("Screens", SCREEN_STATES[0], screen_states))

# ---- ambient
AMB_STATE = nid()
layers.append(layer("Ambient", AMB_STATE, [state(AMB_STATE, ambient, "Drift", [], 250, 0)]))

# ---- playback
PLAYING, PAUSED = nid(), nid()
rnd = random.Random(7)
eq_keys = []
for k, eid in enumerate(EQ_IDS):
    frames = []
    n = 8
    for j in range(n + 1):
        h = 10 + rnd.random() * (90 if 4 < k < 18 else 60)
        if j == n:
            h = float(frames[0][1])
        frames.append((j * 15, round(h, 1), "cubic"))
    frames[-1] = (frames[-1][0], frames[-1][1])
    eq_keys.append(keyed(eid, "height", "Double", frames))
mini_keys = []
for k, mid in enumerate(MINI_EQ):
    seq = [(0, 4), (10, 12), (20, 6), (30, 14), (40, 5), (50, 10), (60, 4)]
    shift = k * 3
    mini_keys.append(keyed(mid, "height", "Double",
                           [(f, 4 + ((v + shift * 2) % 11), "cubic") for f, v in seq[:-1]]
                           + [(60, 4 + ((4 + shift * 2) % 11))]))
playing_anim = anim("Playing", 120, [
    keyed(PLAY_SOLO, "activeComponentId", "Id", [(0, PAUSE_ICON)]),
    *eq_keys, *mini_keys,
], loop=True)
paused_anim = anim("Paused", 1, [
    keyed(PLAY_SOLO, "activeComponentId", "Id", [(0, PLAY_ICON)]),
    *[keyed(eid, "height", "Double", [(0, 6)]) for eid in EQ_IDS],
    *[keyed(mid, "height", "Double", [(0, 3)]) for mid in MINI_EQ],
])
layers.append(layer("Playback", PLAYING, [
    state(PLAYING, playing_anim, "Playing", [
        write_bool(P_PLAYING, True),
        trans(PAUSED, [cond_trigger(P_TOGGLE)], duration=200),
    ], 250, 0),
    state(PAUSED, paused_anim, "Paused", [
        write_bool(P_PLAYING, False),
        trans(PLAYING, [cond_trigger(P_TOGGLE)], duration=200),
    ], 250, 120),
]))

# ---- tracks
TRACK_STATES = [nid() for _ in TRACKS]
track_states = []
for k, (t, art, dur, c1, c2) in enumerate(TRACKS):
    an = anim(f"Track {k + 1}", 24, [
        keyed(SLEEVE_A, "colorValue", "Color", [(0, c1)]),
        keyed(SLEEVE_B, "colorValue", "Color", [(0, c2)]),
        keyed(LABEL_A, "colorValue", "Color", [(0, c1)]),
        keyed(LABEL_B, "colorValue", "Color", [(0, c2)]),
        keyed(MINI_ART_A, "colorValue", "Color", [(0, c1)]),
        keyed(MINI_ART_B, "colorValue", "Color", [(0, c2)]),
        keyed(ROW_PILL, "y", "Double", [(0, ROW_Y0 + k * 46)]),
        keyed(DISC, "scaleX", "Double", [(0, 0.9, "cubic"), (24, 1.0)]),
        keyed(DISC, "scaleY", "Double", [(0, 0.9, "cubic"), (24, 1.0)]),
    ])
    nxt, prv = (k + 1) % len(TRACKS), (k - 1) % len(TRACKS)
    kids = [write_num(P_TRACK, k), write_str(P_TITLE, t), write_str(P_ARTIST, art)]
    for j in range(len(TRACKS)):
        if j != k:
            kids.append(trans(TRACK_STATES[j], [cond_num(P_TRACK, j)], duration=300))
    kids.append(trans(TRACK_STATES[nxt], [cond_trigger(P_NEXT)], duration=300))
    kids.append(trans(TRACK_STATES[prv], [cond_trigger(P_PREV)], duration=300))
    track_states.append(state(TRACK_STATES[k], an, t, kids, 250, k * 120))
layers.append(layer("Tracks", TRACK_STATES[0], track_states))


# ---- hover layers (cards, tiles, menu)
def hover_layer(name, pid, idle_keys, hover_keys, x0=250):
    idle, hov = nid(), nid()
    ia = anim(f"{name} Idle", 1, idle_keys)
    ha = anim(f"{name} Hover", 1, hover_keys)
    return layer(name, idle, [
        state(idle, ia, "Idle", [trans(hov, [cond_bool(pid, True)], duration=180)], x0, 0),
        state(hov, ha, "Hover", [trans(idle, [cond_bool(pid, False)], duration=220)], x0, 120),
    ])


for i, (grp, glow, pill, hit) in enumerate(card_parts):
    layers.append(hover_layer(f"Card {i + 1}", P_HOVER[i], [
        keyed(grp, "scaleX", "Double", [(0, 1.0)]),
        keyed(grp, "scaleY", "Double", [(0, 1.0)]),
        keyed(glow, "opacity", "Double", [(0, 0.0)]),
        keyed(pill, "opacity", "Double", [(0, 0.0)]),
        keyed(pill, "scaleX", "Double", [(0, 0.6)]),
        keyed(pill, "scaleY", "Double", [(0, 0.6)]),
    ], [
        keyed(grp, "scaleX", "Double", [(0, 1.06)]),
        keyed(grp, "scaleY", "Double", [(0, 1.06)]),
        keyed(glow, "opacity", "Double", [(0, 1.0)]),
        keyed(pill, "opacity", "Double", [(0, 1.0)]),
        keyed(pill, "scaleX", "Double", [(0, 1.0)]),
        keyed(pill, "scaleY", "Double", [(0, 1.0)]),
    ]))
    title, genre = GAMES[i][0], GAMES[i][1]
    listeners.append(el("StateMachineListenerSingle", [write_bool(P_HOVER[i], True)],
                        targetId=hit, listenerTypeValue="enter", name=f"Card{i}In"))
    listeners.append(el("StateMachineListenerSingle", [write_bool(P_HOVER[i], False)],
                        targetId=hit, listenerTypeValue="exit", name=f"Card{i}Out"))
    listeners.append(el("StateMachineListenerSingle",
                        [write_str(P_SELECTED, title), write_str(P_GENRE, genre)],
                        targetId=hit, listenerTypeValue="click", name=f"Card{i}Pick"))

for i, (hit, grp, target) in enumerate(tile_hits):
    layers.append(hover_layer(f"Tile {i + 1}", P_TILE_HOVER[i], [
        keyed(grp, "scaleX", "Double", [(0, 1.0)]),
        keyed(grp, "scaleY", "Double", [(0, 1.0)]),
        keyed(tile_glows[i], "opacity", "Double", [(0, 0.0)]),
    ], [
        keyed(grp, "scaleX", "Double", [(0, 1.03)]),
        keyed(grp, "scaleY", "Double", [(0, 1.03)]),
        keyed(tile_glows[i], "opacity", "Double", [(0, 1.0)]),
    ]))
    listeners.append(el("StateMachineListenerSingle", [write_bool(P_TILE_HOVER[i], True)],
                        targetId=hit, listenerTypeValue="enter", name=f"Tile{i}In"))
    listeners.append(el("StateMachineListenerSingle", [write_bool(P_TILE_HOVER[i], False)],
                        targetId=hit, listenerTypeValue="exit", name=f"Tile{i}Out"))
    if target is not None:
        listeners.append(el("StateMachineListenerSingle",
                            [write_bool(P_TILE_HOVER[i], False), write_num(P_SCREEN, target)],
                            targetId=hit, listenerTypeValue="click", name=f"Tile{i}Open"))

for k in range(3):
    layers.append(hover_layer(f"Menu {MENU[k][0]}", P_MENU_HOVER[k],
                              [keyed(menu_hover_bg[k], "opacity", "Double", [(0, 0.0)])],
                              [keyed(menu_hover_bg[k], "opacity", "Double", [(0, 1.0)])]))
    listeners.append(el("StateMachineListenerSingle", [write_bool(P_MENU_HOVER[k], True)],
                        targetId=menu_hit[k], listenerTypeValue="enter", name=f"Menu{k}In"))
    listeners.append(el("StateMachineListenerSingle", [write_bool(P_MENU_HOVER[k], False)],
                        targetId=menu_hit[k], listenerTypeValue="exit", name=f"Menu{k}Out"))
    listeners.append(el("StateMachineListenerSingle", [write_num(P_SCREEN, k)],
                        targetId=menu_hit[k], listenerTypeValue="click", name=f"Menu{k}Go"))

# music controls
listeners += [
    el("StateMachineListenerSingle", [fire(P_TOGGLE)], targetId=PLAY_BTN,
       listenerTypeValue="click", name="PlayClick"),
    el("StateMachineListenerSingle", [fire(P_NEXT)], targetId=NEXT_BTN,
       listenerTypeValue="click", name="NextClick"),
    el("StateMachineListenerSingle", [fire(P_PREV)], targetId=PREV_BTN,
       listenerTypeValue="click", name="PrevClick"),
]
for k, hit in enumerate(row_hits):
    listeners.append(el("StateMachineListenerSingle", [write_num(P_TRACK, k)], targetId=hit,
                        listenerTypeValue="click", name=f"Row{k}Pick"))


def key_listener(name, keys, action):
    return el("StateMachineListener", [
        el("ListenerInputTypeKeyboard", [el("KeyboardInput", keyType=k, keyPhase=1)
                                         for k in keys], listenerTypeValue="keyboard"),
        action,
    ], targetId=BG_SHAPE, name=name)


listeners += [
    key_listener("KeyUp", ["up"], fire(P_UP)),
    key_listener("KeyDown", ["down"], fire(P_DOWN)),
    key_listener("KeySpace", ["space"], fire(P_TOGGLE)),
    key_listener("KeyNext", ["right"], fire(P_NEXT)),
    key_listener("KeyPrev", ["left"], fire(P_PREV)),
]

state_machine = el("StateMachine", listeners + layers, name="Dashboard", id=SM)

# ============================================================ assemble
artboard = group("Artboard", [
    el("LayoutComponentStyle", name="Artboard Style", id=ART_STYLE),
    *background,
    player_engine,
    hero_bg,
    hero_3d,
    hero_clip_shape,
    panels,
    sidebar,
    topbar,
], width=W, height=H, styleId=ART_STYLE, viewModelId=VM, viewModelInstanceId=VMI,
    defaultStateMachineId=SM, name="Dashboard", id=ART)
# state machine and animations go after the drawables (order does not matter for them)
artboard = artboard.replace("</Artboard>", state_machine + "".join(ANIMS) + "</Artboard>")


def vm_xml():
    props, vals = [], []
    for name, kind, pid, default in VM_PROPS:
        props.append(el(f"ViewModelProperty{kind}", name=name, id=pid))
        attrs = dict(viewModelPropertyId=pid)
        if default is not None:
            attrs["propertyValue"] = default
        vals.append(el(f"ViewModelInstance{kind}", **attrs))
    return el("ViewModel", props + [el("ViewModelInstance", vals, exports=True,
                                       name="Default", id=VMI)],
              defaultInstanceId=VMI, name="Dash", id=VM)


doc = el("Rive", [
    artboard,
    el("FontAsset", file="Inter.ttf", name="Inter", id=FONT),
    el("ScriptAsset", file="console3d.luau", name="console3d", id=P3D),
    el("ScriptAsset", file="player.luau", name="player", id=PPLAYER),
    el("DataConverterRangeMapper", minInput=0, maxInput=1, minOutput=0, maxOutput=BAR_W,
       clampLower=True, clampUpper=True, name="ProgressToBar", id=TO_BAR),
    el("DataConverterRangeMapper", minInput=0, maxInput=1, minOutput=0, maxOutput=120,
       clampLower=True, clampUpper=True, name="ProgressToMiniBar", id=TO_MINI_BAR),
    vm_xml(),
], version=1, kind="fragment")

with open("scene.rml", "w") as f:
    f.write("<!-- Generated by gen.py; edit that instead. -->\n")
    f.write(doc)
    f.write("\n")
print(f"wrote scene.rml ({len(doc)} bytes, last id 0:{_next[0]})")
