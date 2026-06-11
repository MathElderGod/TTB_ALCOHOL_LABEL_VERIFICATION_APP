# TTB COLA Label Verification Tool

A browser-based prototype for verifying alcoholic beverage labels against COLA (Certificate of Label Approval) application data, built for the Alcohol and Tobacco Tax and Trade Bureau (TTB).

> **Status:** Internal evaluation prototype — not for production deployment.

---

## Overview

This tool allows a TTB reviewer to upload a label image and paste the corresponding COLA application text. The tool reads the label via local OCR, then checks whether each required field on the application is present and correct on the label. 
Results are displayed in a structured table with per-field pass/fail status.

**All processing is entirely local.** 

No images, text, or results are transmitted to any server. No data is retained between sessions.

---

## Quick Start

No build step, no dependencies to install, no server required.

### Open directly in a browser

via [TTB Alcohol Verification App](https://matheldergod.github.io/TTB_ALCOHOL_LABEL_VERIFICATION_APP/)

---

## How to Use

[Watch Demo](Videos\demo.mp4)

### Step 1 — Upload the label image
- Click the **Label Image** drop zone or drag and drop a file
- Supported formats: JPG, PNG, WEBP
- For best results: clear, straight-on photo or scan at 300 DPI or higher
- If the label has a separate front and back panel, enable **"Label has a separate back image"** and upload both

### Step 2 — Paste the application text
In the **COLA Application Data** field, paste the application fields exactly as they appear in the submission. The tool recognizes labeled fields in this format:

```
Brand Name: Example Brewing Co.
Class/Type: Wheat Beer
Alcohol Content: 4% Alc./Vol.
Net Contents: 1 Pint
Bottler: Example Brewing Co. Baltimore, MD
GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. 
(2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.
```

### Step 3 — Run Verification
Click **Run Verification**. The tool will:
1. Preprocess the label image (grayscale, contrast normalization, binarization)
2. Run two OCR passes (sparse-text and block-text modes)
3. Parse the application text as the source of truth
4. Check whether each application field is present in the label OCR text
5. Display a per-field results table with MATCH / MISMATCH / NOT FOUND status

### Step 4 — Review results
| Status | Meaning |
|--------|---------|
| ✔ Match | Application value confirmed present on label |
| ✖ Mismatch | Application value not found on label, or field fails a rule |
| ? Not Found | Field missing from application or not detectable on label |

> ⚠ **Bold check always required:** OCR reads plain text only — it cannot detect font weight. Even if Government Warning shows ✔ Match, you must visually confirm that **"GOVERNMENT WARNING:"** is printed in **bold** on the physical label or source file.

---

## Fields Verified

| Field | Match Method |
|-------|-------------|
| Brand Name | Fuzzy containment — application value must be present in label text |
| Class / Type | Fuzzy containment — checked against a comprehensive TTB beverage type list |
| Alcohol Content | Numeric — ABV extracted from both sides and compared within ±0.15% |
| Net Contents | Numeric — volume converted to mL for unit-agnostic comparison |
| Bottler / Producer | Fuzzy containment — must include a valid city and state |
| Government Warning | Exact — must match the required TTB verbatim text character-for-character |

---

## Supported Beverage Types (Class/Type Detection)

The tool recognizes 150+ TTB-regulated beverage class/type designations from:
- **27 CFR Part 5** — Distilled Spirits (bourbon, whiskey, vodka, gin, rum, tequila, brandy, liqueurs, etc.)
- **27 CFR Part 7** — Malt Beverages (ales, lagers, stouts, IPAs, wheat beers, hard seltzers, etc.)
- **27 CFR Part 4** — Wine (table wine, sparkling wine, fortified wine, varietals, etc.)

---

## File Structure

```
ttb-cola-verification/
├── index.html          # Application shell and UI structure
├── styles.css          # All styles (design tokens, layout, result table)
├── app.js              # All application logic (OCR pipeline, parsing, comparison)
├── Docs/
│   └── APPROACH.md     # Technical approach, architecture decisions, assumptions
├── Images/   
│   └── various images  # label images for alcoholic beverages that the user can test on
├── Text-files/   
│   └── txt files       # consists of various text files for this application. ex: cola label examples prompts
└── README.md           # This very file
```

---

## Browser Compatibility

| Browser | Status |
|---------|--------|
| Chrome 90+ | ✅ Recommended |
| Firefox 88+ | ✅ Supported |
| Edge 90+ | ✅ Supported |
| Safari 14+ | ✅ Supported |
| IE 11 | ❌ Not supported |

Requires: Canvas API, File API, Blob API, async/await (ES2017+). All are standard in any browser released after 2018.

---

## Known Limitations

- **Curved / arched text** on ornate label designs produces poor OCR output. Binarization reduces but does not eliminate this noise. The application-driven comparison approach handles this gracefully — if the brand name appears anywhere legible in the OCR text, it will match.
- **Font weight is undetectable** via OCR. The bold requirement on "GOVERNMENT WARNING:" must always be verified manually.
- **Very low resolution images** (below ~150 DPI equivalent) will produce degraded OCR results. The preprocessing pipeline scales up small images, but a blurry or small source photo cannot be recovered.
- **Handwritten labels** are not supported.

---

## Dependencies

| Library | Version | Source | Purpose |
|---------|---------|--------|---------|
| Tesseract.js | 5.x | CDN (jsDelivr) | In-browser OCR engine |

No other runtime dependencies. No build tools, bundlers, or package manager required.

---
