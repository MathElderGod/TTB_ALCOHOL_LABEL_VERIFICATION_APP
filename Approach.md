# Technical Approach, Architecture, and Assumptions

## TTB COLA Label Verification — `docs/APPROACH.md`

---

## Problem Statement

TTB COLA reviewers must manually compare physical label images against the text submitted in a COLA application, checking that required fields match exactly. This is time-consuming, error-prone, and creates bottlenecks at scale. The goal of this prototype is to automate the field-by-field comparison using local OCR, with no external services, no data retention, and no cost per use.

---

## Architecture

### Core Principle: Application Text Is the Source of Truth

The most important architectural decision in this tool is the direction of comparison.

**Rejected approach (naive):** Extract a value from the label OCR → extract a value from the application → compare them.

This fails in practice because OCR is noisy. Curved brand name text on a label might produce garbage characters. Decorative borders and barcodes inject random symbols. Trying to "extract" the brand name from a noisy OCR string and then compare it to the application value means the comparison is only as good as the extraction — which frequently fails.

**Adopted approach (application-driven):** Parse the application text (clean, typed input) as the authoritative source of truth. Then ask a simpler question: *"Is this application value present anywhere in the label OCR text?"*

This is directly analogous to how a human reviewer works. They read the application, then look at the label and confirm each value. The label doesn't need to produce a perfectly extracted brand name — it just needs to contain the words "Example Brewing Co." somewhere readable.

---

## Image Preprocessing Pipeline

Raw label photos fed directly into Tesseract produce poor results due to:
- Variable lighting and low contrast
- Barcodes and decorative borders producing random character streams
- Small image resolution (phone photos at 600px wide)

The preprocessing pipeline (`preprocessImage()`) addresses each issue in sequence:

### 1. Upscaling
Images narrower than 2400px are scaled up using high-quality interpolation. Tesseract is trained on ~300 DPI equivalents. A 600px-wide photo is effectively ~72 DPI — scaling to 2400px brings it to ~288 DPI equivalent, which is within Tesseract's target range.

### 2. Grayscale Conversion
RGB → luminance-weighted grayscale using the Rec. 709 formula:  
`Y = 0.2126R + 0.7152G + 0.0722B`

This removes color noise from labels with dark backgrounds, colored text, or decorative elements.

### 3. Contrast Normalization
A 1st–99th percentile stretch is applied: the darkest 1% of pixels are mapped to 0, the lightest 1% to 255. This corrects for uneven lighting, slightly overexposed or underexposed photos, and labels with off-white backgrounds.

### 4. Unsharp Mask Sharpening
A Laplacian kernel is applied with strength 0.5:  
`sharpened[i] = v + 0.5 * (4v - N - S - E - W)`

This crisps soft or slightly blurry text without amplifying noise.

### 5. Otsu Binarization
The image is converted to pure black and white using Otsu's method, which finds the statistically optimal threshold by maximizing inter-class variance between foreground and background pixels. This is the single most impactful step:
- Barcodes become solid black zones (Tesseract ignores them)
- Logos become flat shapes (Tesseract reads through them)
- Text becomes clean black strokes on white

All preprocessing is done on an HTML `<canvas>` element using the Canvas 2D API — no server, no libraries.

---

## OCR Strategy: Two-Pass Per Image

A single Tesseract run is insufficient for label text because labels have two different text layouts:

| Layout | PSM Mode | Best For |
|--------|----------|---------|
| Scattered fields (brand, ABV, bottler) | PSM 11 — Sparse text | Text with no natural reading order |
| Government Warning paragraph | PSM 6 — Uniform block | Dense paragraph text |

Both passes run on the same preprocessed image and their outputs are concatenated with a divider marker (`--- PSM6 PASS ---`). The parsing layer uses this marker to separate the two passes when needed (notably for government warning extraction, which picks the best candidate by punctuation score).

---

## OCR Text Cleaning Pipeline

Even with binarization, OCR output contains noise. Three cleaning stages run before any field comparison:

### Stage 1: Structural Pre-processing (`preprocessOcrText`)
Fixes multi-line splits that OCR introduces on centered labels:
- `GOVERNMENT\nWARNING:` → `GOVERNMENT WARNING:`
- `BREWED AND BOTTLED\nBY` → `BREWED AND BOTTLED BY`
- Collapses the government warning paragraph onto a single line

### Stage 2: Line-level Noise Scrubbing (`scrubNoiseLines`)
Each line is scored by signal quality. Lines with fewer than 40% letter/digit characters are dropped. A `forceKeep` list protects lines matching known TTB patterns (ABV, volume, state names, bottler phrases, beverage keywords) so real data is never accidentally discarded.

Additional heuristics:
- Single ALL-CAPS tokens with fewer than 30% vowels are dropped (catches logo artifacts like `ESTHORLND`, `BRWRY`)
- `ESTD`, `EST. YYYY`, `SINCE YYYY` — common logo stamps — are explicitly blocked from brand name parsing

### Stage 3: Character-level Cleanup (`cleanOcrText`)
Corrects common Tesseract substitution errors:
- `I` before digits → `1`
- `O` before digits → `0`
- Strips barcode scan characters (`|`, `{`, `}`, `[`, `]`, `©`, `®`)

---

## Field Parsing

### Application Fields (`parseFormFields`)
Clean typed text. Simple labeled-field extraction using key:value regex patterns. The application text is treated as authoritative and undergoes minimal transformation.

### Label OCR (`parseLabelOCR`)
Returns two things:
1. `searchText` — the full cleaned OCR text collapsed to a single space-normalized string, used for containment checks
2. `govtWarning` — the best government warning candidate, selected by punctuation score across all OCR passes

---

## Comparison Logic (`checkPresence`)

### Fuzzy fields (Brand Name, Class/Type, Bottler)
Two strategies in priority order:
1. **Direct substring** — normalized application value is a substring of normalized OCR text
2. **Token overlap** — 75%+ of the application value's words (3+ chars) individually appear in the OCR text

Normalization: lowercase, `&` → `and`, non-alphanumeric → space, collapse whitespace.

### ABV (Alcohol Content)
- Parse the numeric ABV from the application value (e.g., `4% Alc./Vol.` → `4.0`)
- Scan the OCR text for all `N%` patterns
- Accept if any OCR value is within ±0.15% of the application value
- The application ABV is normalized via `normalizeABV()` to strip any trailing text that runs onto the same line (a common data entry pattern)

### Volume (Net Contents)
- Convert both application and OCR volume expressions to milliliters
- Accept if within ±1 mL
- Handles all common units: fl oz, mL, L, pint, gallon (with conversion factors)

### Bottler / Producer
Same fuzzy containment as above, with one additional requirement: the application value **must include a valid location** (city and state). The location check:
- Accepts both full state names (`Maryland`) and two-letter abbreviations (`MD`)
- Abbreviations must appear at the end of the string, preceded by a comma or space, with at least 3 total tokens in the value — this prevents `Example Brewing Co.` matching `CO` as Colorado

### Government Warning
Exact comparison against the required TTB verbatim text. The comparison:
1. Verifies `GOVERNMENT WARNING:` is present in ALL CAPS (required by TTB)
2. Normalizes whitespace and compares the body text case-insensitively
3. On mismatch, reports the character position of the first divergence

---

## Beverage Type Recognition

A master list of 150+ TTB-regulated beverage type designations covers 27 CFR Parts 4, 5, and 7. A multi-tier search strategy handles labels where the type is split across lines:

1. **Explicit labeled field** — `Type: Wheat Beer`
2. **Sliding-window keyword scanner** — extracts the dominant uppercase word from each line, then searches forward within a 7-line window for known two-word type combinations. Handles `WHEAT` on line 2 and `BEER` on line 5 with noise lines between them.
3. **Line-by-line TTB regex scan** — single-word types
4. **Collapsed full-text scan** — last resort

---

## Assumptions

1. **Application text is correct as entered.** The tool validates the label against the application. It does not validate whether the application itself complies with TTB regulations (e.g., whether the class/type designation is valid, whether the brand name is acceptable).

2. **Labels are photographed straight-on.** Perspective distortion significantly degrades OCR output. The preprocessing pipeline does not include perspective correction. Labels photographed at an angle will produce reduced accuracy.

3. **The government warning appears in its entirety on the label (or split across front and back panels uploaded via the two-image feature).** If the warning is split across more than two images, it will not be detected.

4. **One label per verification.** The tool is designed for single-label review sessions, consistent with the TTB COLA workflow where applications are reviewed one at a time.

5. **English-language labels.** Tesseract is initialized with the English language model only. Bilingual labels (e.g., English/Spanish) will have their English text read correctly; non-English portions may produce garbled output.

6. **"GOVERNMENT WARNING:" bold requirement cannot be automated.** OCR reads character data only — font weight is not part of the output. The tool flags this for every submission and requires manual visual confirmation regardless of text match status.

---

## Tools and Libraries

| Tool | Role |
|------|------|
| **Tesseract.js 5.x** | In-browser OCR engine (WebAssembly port of Tesseract 4) |
| **HTML Canvas 2D API** | Image preprocessing pipeline (grayscale, contrast, binarization) |
| **Vanilla JavaScript (ES2017+)** | All application logic — no framework |
| **CSS custom properties** | Design token system for the UI |

No build tools, bundlers, transpilers, or package managers are required. The only external resource loaded at runtime is the Tesseract.js bundle from jsDelivr CDN (`https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js`).

---

## Security and Privacy

- No network requests are made during verification (except the initial Tesseract.js library load from CDN)
- No label images are uploaded or stored anywhere
- No application text is transmitted
- No session data, cookies, or local storage are used
- All computation runs in the browser's JavaScript engine and WebAssembly runtime

This design was a hard requirement from the outset. A tool handling potentially sensitive pre-approval label data must not transmit that data to any external service.
