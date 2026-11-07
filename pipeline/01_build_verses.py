"""
Step 1 - Build the 700-shloka verse table from public-domain sources.

Inputs (data/sources/):
  sanskrit_iast_krishnagita.json   Sanskrit text, IAST, standard 700-verse numbering
  ganguli_bhishma_parva_25_42.json K. M. Ganguli's English (1883-96), one prose block per chapter

Ganguli did not number verses; his translation is continuous prose. This script
splits his prose into clause-level units and aligns them to the Sanskrit verses with a
monotonic dynamic programme. It uses only public-domain signals:

  * speaker markers   Sanskrit "X uvaca"  <->  English "X said"
  * a cue lexicon     Sanskrit vocatives / names / key terms  <->  Ganguli's English renderings
  * a length prior    English words per verse ~ Sanskrit syllables per verse

Output: data/verses.json (chapter, verse, speaker, sanskrit_iast, sanskrit_devanagari, english)

Run:  python pipeline/01_build_verses.py
"""
import json
import math
import re
from pathlib import Path

from indic_transliteration import sanscript

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "sources"
OUT = ROOT / "data" / "verses.json"

# --------------------------------------------------------------------------- sources
skt = json.load(open(SRC / "sanskrit_iast_krishnagita.json", encoding="utf-8"))
gan = json.load(open(SRC / "ganguli_bhishma_parva_25_42.json", encoding="utf-8"))["chapters"]

SPEAKERS = {
    "dhṛtarāṣṭra uvāca": "Dhritarashtra",
    "saṃjaya uvāca": "Sanjaya",
    "sañjaya uvāca": "Sanjaya",
    "arjuna uvāca": "Arjuna",
    "śrībhagavān uvāca": "Krishna",
}
EN_SPEAKER = re.compile(
    r"^\W*(Dhritarashtra said|Sanjaya (?:said|continued)|Arjuna said|The Holy One said)", re.I
)

# Sanskrit substring -> regex over Ganguli's English.  Vocatives and proper names are the
# strongest anchors; a handful of doctrinal terms add signal inside long monologues.
CUES = [
    ("kaunteya", r"Kunti"), ("pārtha", r"Pritha|Partha"), ("bhārata", r"Bharata"),
    ("bharatarṣabha", r"Bharata"), ("mahābāho", r"mighty.armed"), ("paraṃtapa", r"chastiser|scorcher|foes"),
    ("dhanaṃjaya", r"Dhananjaya"), ("dhanañjaya", r"Dhananjaya"), ("arjuna", r"Arjuna"),
    ("kṛṣṇa", r"Krishna"), ("keśava", r"Kesava"), ("madhusūdana", r"Madhu"), ("janārdana", r"Janardana"),
    ("govinda", r"Govinda"), ("mādhava", r"Madhava"), ("hṛṣīkeśa", r"Hrishikesa"), ("acyuta", r"Achyuta"),
    ("vārṣṇeya", r"Vrishni"), ("yādava", r"Yadava"), ("kurunandana", r"Kuru"), ("kurusattama", r"Kuru"),
    ("puruṣarṣabha", r"bull among men"), ("guḍākeśa", r"Gudakesa"), ("anagha", r"sinless"),
    ("bhīṣma", r"Bhishma"), ("droṇa", r"Drona"), ("karṇa", r"Karna"), ("duryodhana", r"Duryodhana"),
    ("pāṇḍava", r"Pandu|Pandava"), ("pāṇḍu", r"Pandu"), ("saṃjaya", r"Sanjaya"), ("dhṛtarāṣṭra", r"Dhritarashtra"),
    ("prajāpati", r"Prajapati|Creator"), ("vivasvat", r"Vivaswat"), ("manu", r"Manu"),
    ("yajña", r"sacrific"), ("tapas", r"austerit|penance"), ("dāna", r"gift"), ("śraddh", r"faith"),
    ("sāttvik", r"goodness"), ("sattva", r"goodness"), ("rājas", r"passion"), ("rajas", r"passion"),
    ("tāmas", r"darkness"), ("tamas", r"darkness"), ("guṇa", r"qualit"), ("prakṛti", r"Prakriti|nature"),
    ("kṣetrajña", r"Kshetrajna"), ("kṣetra", r"Kshetra"), ("aśvattha", r"Aswattha"), ("brahma", r"Brahma"),
    ("veda", r"Veda"), ("oṃ", r"\bOm\b"), ("krodh", r"wrath|anger"), ("kām", r"desire|lust"),
    ("phala", r"fruit"), ("indriy", r"sense"), ("mṛtyu", r"death"), ("yogin", r"devotee|Yogin"),
    ("saṃnyās", r"renunci|renounc"), ("tyāg", r"abandon|relinqu"), ("svadharm", r"own duty|own duties"),
    ("ahiṃs", r"injur"), ("āsur", r"demon|Asura"), ("daiv", r"godlike|divine"), ("ātmā", r"self|soul"),
    ("deha", r"body|bodies|Embodied"), ("śarīr", r"body|bodies"), ("jñān", r"knowledge"),
    ("karma", r"action|work"), ("buddh", r"understanding|intelligence|mind"), ("man", r"mind"),
    ("sukh", r"happiness|pleasure|felicity"), ("duḥkh", r"pain|misery|sorrow"), ("pāp", r"sin"),
    ("rudr", r"Rudra"), ("āditya", r"Aditya"), ("vasu", r"Vasu"), ("marut", r"Marut"), ("gandharv", r"Gandharva"),
    ("satya", r"truth|truly|true"), ("priy", r"dear"), ("udapān", r"well|water"), ("amṛt", r"immortal|nectar"),
    ("śānti", r"tranquil|peace"), ("bhakt", r"devot|adore"), ("namas", r"bow|reverence"), ("sarvabhūt", r"all (?:creatures|beings|entities)"),
    ("ākāś", r"space|ether|sky"), ("sūry", r"sun"), ("candr", r"moon"), ("agni", r"fire"), ("jala|ap ", r"water"),
    ("kāla", r"Time|time"), ("viśva", r"universe|universal"), ("rūpa", r"form"), ("hari", r"Hari"),
]

VOWEL = re.compile(r"ai|au|[aāiīuūṛṝḷeo]")


def syllables(iast: str) -> int:
    return len(VOWEL.findall(iast))


def to_devanagari(iast: str) -> str:
    text = iast.replace(";", "|")
    lines = [l.strip() for l in text.split("|") if l.strip()]
    dev = []
    for line in lines:
        d = sanscript.transliterate(line, sanscript.IAST, sanscript.DEVANAGARI)
        d = d.replace("् ", "्")  # rejoin consonant-final words split by sandhi spacing
        dev.append(d)
    return " । ".join(dev) + " ॥"


def parse_sanskrit(ch: int):
    c = skt[str(ch)]
    n = int(c["numShloka"])
    verses = []
    for v in range(1, n + 1):
        raw = c[str(v)].strip()
        parts = [p.strip() for p in re.split(r"[|;]", raw) if p.strip()]
        speaker = None
        if parts and parts[0] in SPEAKERS:
            speaker = SPEAKERS[parts[0]]
            parts = parts[1:]
        body = " | ".join(parts)
        verses.append({"verse": v, "speaker_marker": speaker, "iast": body})
    return c["title"], verses


# --------------------------------------------------------------------------- Ganguli
def clean_ganguli(t: str) -> str:
    t = re.sub(r"\[\(Bhagavad Gita,? Chapter [IVXL]+\)\]", " ", t)
    t = re.sub(r"\(\[This where.*?Hare\]\)", " ", t, flags=re.S)
    t = re.sub(r"\[Here ends.*?verses\.\]", " ", t, flags=re.S)
    t = re.sub(r"\[End of the Bhagavad Gita\]", " ", t)
    t = re.sub(r"\[\d+\]", "", t)  # footnote call-outs (footnote bodies are not in the source)
    t = re.sub(r"\[([^\]]{1,30})\]", r"\1", t)  # editorial [soul], [universe] -> keep word
    t = t.replace("--", " -- ")
    return re.sub(r"\s+", " ", t).strip()


def units_of(text: str):
    """Split into clause units: sentence ends, semicolons, and speaker hand-offs."""
    text = EN_SPEAKER.sub(lambda m: "\n" + m.group(0), text)
    text = re.sub(r'((?:Sanjaya|Arjuna|Dhritarashtra) said|The Holy One said|Sanjaya continued)', r"\n\1", text)
    pieces = []
    for block in text.split("\n"):
        for s in re.split(r"(?<=[.?!;:])['\"]*\s+(?=['\"(]*[A-Z(])", block):
            s = s.strip()
            if s:
                pieces.append(s)
    # long sentences often carry two verses: split them at commas into >=7-word pieces
    fine = []
    for p in pieces:
        if len(p.split()) <= 22 or EN_SPEAKER.match(p) and len(p.split()) < 30:
            fine.append(p)
            continue
        cur = ""
        for seg in re.split(r"(?<=,)\s+", p):
            cur = (cur + " " + seg).strip()
            if len(cur.split()) >= 7:
                fine.append(cur)
                cur = ""
        if cur:
            fine[-1] += " " + cur
    pieces = fine
    # merge tiny fragments into neighbours
    units = []
    for p in pieces:
        if units and len(p.split()) < 4 and not EN_SPEAKER.match(p):
            units[-1] += " " + p
        else:
            units.append(p)
    return units


def strip_quotes(s: str) -> str:
    s = re.sub(r"^[\s'\"\-]+|[\s'\"\-]+$", "", s)
    return re.sub(r"\s+", " ", s.replace(" -- ", "—")).strip()


# --------------------------------------------------------------------------- alignment
def align(verses, units):
    n, m = len(verses), len(units)
    words = [len(u.split()) for u in units]
    starts_speaker = [bool(EN_SPEAKER.match(u)) for u in units]
    syl = [max(8, syllables(v["iast"])) for v in verses]
    ratio = sum(words) / sum(syl)
    cue_pats = [(s, re.compile(e, re.I)) for s, e in CUES]
    vcues = [[p for s, p in cue_pats if s in v["iast"].replace(" ", "")] for v in verses]
    L = 16

    def cost(j, i0, i1):  # verse j gets units[i0:i1]
        if i1 == i0:
            return 6.0  # verse shares text with a neighbour (Ganguli merged two verses)
        w = sum(words[i0:i1])
        exp = syl[j] * ratio
        c = 2.2 * (math.log((w + 3) / (exp + 3))) ** 2
        txt = " ".join(units[i0:i1])
        hits = sum(1 for p in vcues[j] if p.search(txt))
        c -= 0.9 * hits
        if verses[j]["speaker_marker"]:
            c += -2.5 if starts_speaker[i0] else 3.0
        # prefer verse boundaries at sentence ends rather than inside a comma-split sentence
        if not re.search(r"[.?!;:]['\")]*$", units[i1 - 1]):
            c += 1.6
        if any(starts_speaker[i0 + 1:i1]):
            c += 6.0  # a speaker change must start a new verse
        if starts_speaker[i0] and not verses[j]["speaker_marker"]:
            c += 1.5
        return c

    INF = float("inf")
    D = [[INF] * (m + 1) for _ in range(n + 1)]
    B = [[0] * (m + 1) for _ in range(n + 1)]
    D[0][0] = 0.0
    for j in range(1, n + 1):
        for i in range(0, m + 1):
            best, arg = INF, 0
            for k in range(0, min(L, i) + 1):
                prev = D[j - 1][i - k]
                if prev == INF:
                    continue
                val = prev + cost(j - 1, i - k, i)
                if val < best:
                    best, arg = val, k
            D[j][i], B[j][i] = best, arg
    groups, i = [None] * n, m
    for j in range(n, 0, -1):
        k = B[j][i]
        groups[j - 1] = (i - k, i)
        i -= k
    assert i == 0
    return groups


def main():
    out = []
    report = []
    for ch in range(1, 19):
        title, verses = parse_sanskrit(ch)
        units = units_of(clean_ganguli(gan[str(ch)]))
        groups = align(verses, units)
        last_speaker = None
        for v, (a, b) in zip(verses, groups):
            speaker = v["speaker_marker"] or last_speaker or "Krishna"
            last_speaker = speaker
            eng = strip_quotes(" ".join(units[a:b]))
            # drop the English speaker tag; it lives in its own field
            eng = re.sub(r"^(Dhritarashtra said|Sanjaya (?:said|continued)|Arjuna said|The Holy One said)[,.:]*\s*[—\-]*\s*['\"]*", "", eng).strip()
            out.append({
                "id": f"BG {ch}.{v['verse']}",
                "chapter": ch,
                "verse": v["verse"],
                "speaker": speaker,
                "sanskrit_iast": v["iast"],
                "sanskrit_devanagari": to_devanagari(v["iast"]),
                "english": eng or None,
                "english_shared_with_previous": b == a,
                # "sentence": verse text starts at a Ganguli sentence boundary;
                # "clause": Ganguli runs this verse and its neighbour into one sentence
                "alignment": "clause" if eng and eng[0].islower() else "sentence",
            })
        merged = sum(1 for a, b in groups if a == b)
        report.append((ch, len(verses), len(units), merged))
    for i, v in enumerate(out):  # verses Ganguli merged into a neighbour point at that rendering
        if v["english"] is None:
            prev = next((out[k] for k in range(i - 1, -1, -1) if out[k]["english"]), None)
            v["english_note"] = f"Ganguli renders this verse together with {prev['id']}." if prev else None
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("chapter verses units merged")
    for r in report:
        print(*r)
    print("total verses:", len(out))


if __name__ == "__main__":
    main()
