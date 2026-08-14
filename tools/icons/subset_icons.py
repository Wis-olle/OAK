"""Rebuild ui/assets/fonts/font-material-subset.woff2 from the full Material Symbols font.

The pages render icons as ligatures (`<span class="material-symbols-outlined">search</span>`),
so the subset has to keep both the icon glyph and the a-z0-9_ glyphs the ligature is typed
from, plus the layout features that fire the substitution.

Usage (from anywhere):
    python tools/icons/subset_icons.py <source-material-symbols.woff2>

Get the source font from git history (the full 1.1MB file, deleted in 0c221aa):
    git show 0c221aa^:ui/assets/fonts/font-0bb58271a2.woff2 > material-symbols.woff2

Requires: fonttools, brotli.
"""

import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
NAMES = ROOT / 'tools/icons/icon-names.txt'
OUT = ROOT / 'ui/assets/fonts/font-material-subset.woff2'

# The characters an icon name is typed from; their glyphs must survive the subset.
INPUT_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_'


def ligature_map(font):
    """(first glyph, component glyphs) -> ligature glyph, from the GSUB 'rlig' lookups."""
    gsub = font['GSUB'].table
    indices = set()
    for record in gsub.FeatureList.FeatureRecord:
        if record.FeatureTag == 'rlig':
            indices.update(record.Feature.LookupListIndex)

    ligatures = {}
    for index in indices:
        for subtable in gsub.LookupList.Lookup[index].SubTable:
            # The real LigatureSubst tables sit behind extension lookups (type 7).
            subtable = getattr(subtable, 'ExtSubTable', subtable)
            for first, ligs in getattr(subtable, 'ligatures', {}).items():
                for lig in ligs:
                    ligatures[(first, tuple(lig.Component))] = lig.LigGlyph
    return ligatures


def main(source):
    font = TTFont(source)
    cmap = font.getBestCmap()
    glyph_of = {char: cmap[ord(char)] for char in INPUT_CHARS}
    ligatures = ligature_map(font)

    names = [line.strip() for line in NAMES.read_text(encoding='utf-8').splitlines() if line.strip()]
    keep = set(glyph_of.values())
    for name in names:
        try:
            typed = [glyph_of[char] for char in name]
        except KeyError:
            sys.exit(f'icon name "{name}" uses a character outside {INPUT_CHARS}')
        glyph = ligatures.get((typed[0], tuple(typed[1:])))
        if glyph is None:
            sys.exit(f'icon "{name}" has no ligature in {source}')
        keep.add(glyph)

    options = Options()
    options.layout_features = ['liga', 'rlig', 'rclt']
    options.layout_closure = False  # keep exactly the glyphs listed, nothing they substitute to
    options.flavor = 'woff2'
    subsetter = Subsetter(options=options)
    subsetter.populate(glyphs=sorted(keep))
    subsetter.subset(font)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUT)
    print(f'{len(names)} icons -> {OUT} ({OUT.stat().st_size} bytes)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
