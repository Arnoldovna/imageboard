# Ruled Field

The design philosophy behind the repository graphics in this folder: `social-preview.png` (1280×640, the GitHub
social preview) and `cover.png` (1600×800, the same composition at a larger size).

## Philosophy

Ruled Field holds that a picture can be described with nothing but horizontal lines and one flat colour. The page is
paper, the marks are ink, and every structure is a 1px rule laid down with the patience of an engraver. There are no
boxes, no shadows, no rounded corners and no gradients. Tone comes only from how closely the rules are set: wide
spacing reads as light and air, tight spacing reads as weight and shadow. An image becomes a measured band of lines,
something that could be redrawn by hand with a ruler. Every interval has to look counted, never generated, as if
someone spent many hours setting each line.

Space works as a material, not as leftover room. The composition hangs from a single left edge and a single top rule,
and everything else is placed against those two lines. Large empty areas are deliberate. They let the few marks that
remain carry their full weight. Alignment is optical as well as arithmetic: the ascenders of the large type touch the
first row of fields, a lead line hangs from the second row, and the smallest label shares its baseline with the last
row of captions. Nothing is centred, and nothing floats.

Colour is a single event. One flat field of pale sky (#B8D3F3) sits among black and white, solid and without texture,
the newest thing on the page. Grey is used only for quiet structure (rules at #A8A8A8, a surface field at #F2F2F2,
secondary text at #606060). Black is used for meaning. The restraint matters: one accent, used once, at full
flatness, is louder than a palette.

Typography follows a strict two-scale order: one very large word set in a medium weight, and everything else small,
lowercase and lightly tracked, like the meta column of an index. The only typeface is Schibsted Grotesk (SIL Open
Font License 1.1), in two weights. Text is sparse, plain and literal. It labels rather than explains, and it would
still read correctly if the image were reduced to a thumbnail.

Rhythm comes from repetition with small, careful differences. A grid of equal fields, each with its own spacing and
its own horizon, reads like a contact sheet or a specimen board: a systematic record in which every entry is the same
kind of object and no two are identical. The work should look like the result of long, careful refinement, with every
interval chosen and every edge meeting its neighbour exactly.

## How the imageboard graphics express it

- **Nine fields, newest first.** The grid holds nine images, the page size of the original 2018 gallery. The ids
  count down from `#09` to `#01`, the order the feed returns them in.
- **The fields are the real seed.** Since the seed pictures were replaced by original artwork (ADR 0014), the nine
  fields show 16:10 crops of the nine newest seed pictures, exactly as the gallery tiles crop them; `#09`, the newest,
  keeps its `new` caption. The first version filled the fields with ruled lines and one flat sky accent; the type,
  rules and grid of that version are unchanged.
- **"more"** in the bottom-left corner quotes the original app's "MORE" button, which loaded the next nine images. It
  shares its baseline with the last row of captions.
- **"01 / 03"** marks Imageboard as the first of the three rebuilt projects (Imageboard, petition, social-network).
- **Safe area.** All content sits inside a frame with margins of about 70px or more on every side, so crops by
  social platforms do not cut into it.

## Production notes

- The nine fields were composited onto the first render with sharp (cover crop, newest seed pictures). Originally
  rendered with Playwright (Chromium, `deviceScaleFactor: 1`) from a generated HTML/SVG page, so every rule is a
  crisp 1px line on whole pixels. The cover is the same layout scaled by 1.25. Rules stay 1px and positions are
  rounded to whole pixels.
- Font: Schibsted Grotesk 400 and 500 from `@fontsource/schibsted-grotesk` 5.3.0 (latin subset), embedded in the
  page. All characters are in the font's latin subset, so no fallback font is rendered.
- Type and rules use maw tokens only: paper #FFFFFF, ink #000000, ink-muted #606060, rule #A8A8A8, surface #F2F2F2,
  sky #B8D3F3.
