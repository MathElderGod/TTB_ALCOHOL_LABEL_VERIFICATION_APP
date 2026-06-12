// =============================================================================
// TTB COLA Label Verification — app.js  (v4 — optimized)
// 100% local: Tesseract.js OCR + canvas image preprocessing
// No API calls, no server, no cost.
//
// Changes vs v3:
//   • Slot-based DRY handling for the two label images (no duplicated branches)
//   • US state lists defined ONCE and compiled into shared regexes
//   • One Tesseract worker reused across all OCR passes per verification run
//     (was: create + terminate a worker per pass — 4× worker startup cost)
//   • Contrast percentiles computed from a histogram, O(n), instead of
//     copying + sorting millions of pixels, O(n log n)
//   • Binarized output written back into the existing ImageData buffer
//   • show/hide via the `hidden` property (HTML attribute) instead of
//     juggling inline style.display strings
//   • Dead code removed: parseBrandName / extractBrandFromBottler were never
//     called after the v3 "containment" architecture change
// =============================================================================

'use strict';

const REQUIRED_WARNING_PREFIX = 'GOVERNMENT WARNING:';
const REQUIRED_WARNING_BODY =
  ' (1) According to the Surgeon General, women should not drink alcoholic beverages ' +
  'during pregnancy because of the risk of birth defects. ' +
  '(2) Consumption of alcoholic beverages impairs your ability to drive a car or ' +
  'operate machinery, and may cause health problems.';
const FULL_REQUIRED_WARNING = REQUIRED_WARNING_PREFIX + REQUIRED_WARNING_BODY;

// =============================================================================
// US STATE DATA — single source of truth.
// v3 repeated these alternation lists verbatim in EIGHT different regexes;
// now every state regex is built from these two strings.
// =============================================================================
const STATE_ABBRS =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|' +
  'MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';

const STATE_NAMES =
  'ALABAMA|ALASKA|ARIZONA|ARKANSAS|CALIFORNIA|COLORADO|CONNECTICUT|DELAWARE|' +
  'FLORIDA|GEORGIA|HAWAII|IDAHO|ILLINOIS|INDIANA|IOWA|KANSAS|KENTUCKY|LOUISIANA|' +
  'MAINE|MARYLAND|MASSACHUSETTS|MICHIGAN|MINNESOTA|MISSISSIPPI|MISSOURI|MONTANA|' +
  'NEBRASKA|NEVADA|NEW\\s+HAMPSHIRE|NEW\\s+JERSEY|NEW\\s+MEXICO|NEW\\s+YORK|' +
  'NORTH\\s+CAROLINA|NORTH\\s+DAKOTA|OHIO|OKLAHOMA|OREGON|PENNSYLVANIA|' +
  'RHODE\\s+ISLAND|SOUTH\\s+CAROLINA|SOUTH\\s+DAKOTA|TENNESSEE|TEXAS|UTAH|' +
  'VERMONT|VIRGINIA|WASHINGTON|WEST\\s+VIRGINIA|WISCONSIN|WYOMING';

// Full state name anywhere in text (case-insensitive).
const FULL_STATE_RE = new RegExp(`\\b(?:${STATE_NAMES})\\b`, 'i');

// Trailing ", City, ST [12345]" address suffix — used to strip the address
// off an application value before token matching.
const ADDRESS_SUFFIX_RE = new RegExp(
  `,?\\s*[\\w\\s]+,\\s*(?:${STATE_ABBRS})(?:\\s*\\d{5})?$`, 'i');

// Value ENDS in a state abbreviation (", MD" / " MD 21201").
const STATE_ABBR_END_RE = new RegExp(
  `(?:,\\s*|\\s+)(?:${STATE_ABBRS})(?:\\s*\\d{5})?\\s*$`, 'i');

// State abbreviation followed by a ZIP code, anywhere.
const STATE_ZIP_RE = new RegExp(`\\b(?:${STATE_ABBRS})\\s*\\d{5}`, 'i');

// Full names, DC, or abbreviations — deliberately CASE-SENSITIVE so the
// uppercase abbreviations don't match common lowercase words ("in", "or", "me").
const ANY_STATE_LINE_RE = new RegExp(`\\b(?:${STATE_NAMES}|DC|${STATE_ABBRS})\\b`);

// Producer verbs shared by the bottler parser and OCR line rejoiner.
const PRODUCER_VERBS =
  'bottled|brewed|distilled|produced|manufactured|crafted|made|imported|distributed';
const PRODUCED_BY_RE = new RegExp(
  `(?:brewed\\s+and\\s+bottled|${PRODUCER_VERBS})\\s+by\\s*:?\\s*(.+)`, 'i');

// =============================================================================
// DOM refs — slot objects keep the front/back image plumbing DRY.
// =============================================================================
const $ = id => document.getElementById(id);

const slots = [
  {
    file: null,
    input:     $('labelFile'),
    drop:      $('labelDrop'),
    preview:   $('labelPreview'),
    wrap:      $('labelPreviewWrap'),
    filename:  $('labelFilename'),
    ppPreview: $('preprocessPreview1'),
    ppWrap:    null,
  },
  {
    file: null,
    input:     $('labelFile2'),
    drop:      $('labelDrop2'),
    preview:   $('labelPreview2'),
    wrap:      $('labelPreviewWrap2'),
    filename:  $('labelFilename2'),
    ppPreview: $('preprocessPreview2'),
    ppWrap:    $('preprocessPreview2Wrap'),
  },
];

const secondImageToggle  = $('secondImageToggle');
const secondImagePanel   = $('secondImagePanel');
const formText           = $('formText');
const verifyBtn          = $('verifyBtn');
const clearBtn           = $('clearBtn');
const statusEl           = $('status');
const statusText         = $('statusText');
const errorBox           = $('errorBox');
const resultsEl          = $('results');
const ocrDebugWrap       = $('ocrDebugWrap');
const ocrDebugText       = $('ocrDebugText');
const preprocessDebugEl  = $('preprocessDebugWrap');

// =============================================================================
// Second image toggle
// =============================================================================
secondImageToggle.addEventListener('change', () => {
  secondImagePanel.hidden = !secondImageToggle.checked;
  if (!secondImageToggle.checked) resetSlot(slots[1]);
});

// =============================================================================
// File handling
// =============================================================================
function handleLabelFile(file, slot) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    slot.file = file;
    slot.preview.src = e.target.result;
    slot.wrap.hidden = false;
    slot.filename.textContent = file.name;
    checkReady();
  };
  reader.readAsDataURL(file);
}

function resetSlot(slot) {
  slot.file = null;
  slot.input.value = '';
  slot.preview.removeAttribute('src');
  slot.wrap.hidden = true;
  slot.filename.textContent = '';
}

for (const slot of slots) {
  slot.input.addEventListener('change', e => handleLabelFile(e.target.files[0], slot));
  slot.drop.addEventListener('dragover', e => {
    e.preventDefault();
    slot.drop.classList.add('drag-over');
  });
  slot.drop.addEventListener('dragleave', () => slot.drop.classList.remove('drag-over'));
  slot.drop.addEventListener('drop', e => {
    e.preventDefault();
    slot.drop.classList.remove('drag-over');
    handleLabelFile(e.dataTransfer.files[0], slot);
  });
}

formText.addEventListener('input', checkReady);

function checkReady() {
  verifyBtn.disabled = !(slots[0].file && formText.value.trim().length > 10);
}

clearBtn.addEventListener('click', () => {
  slots.forEach(resetSlot);
  formText.value = '';
  resultsEl.hidden = true;
  ocrDebugWrap.hidden = true;
  errorBox.hidden = true;
  preprocessDebugEl.hidden = true;
  if (slots[1].ppWrap) slots[1].ppWrap.hidden = true;
  secondImageToggle.checked = false;
  secondImagePanel.hidden = true;
  checkReady();
});

// =============================================================================
// IMAGE PREPROCESSING — canvas pipeline
// 1. Scale up small images
// 2. Grayscale (luminance weights)
// 3. Contrast normalization (1%/99% percentile stretch via histogram — O(n))
// 4. Unsharp mask sharpening
// 5. Otsu binarization → clean black-on-white for Tesseract
// =============================================================================
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image failed to load')); };
    img.src = url;
  });
}

function buildHistogram(grayData) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < grayData.length; i++) hist[grayData[i]]++;
  return hist;
}

// 1% / 99% percentile values straight from a histogram — replaces the v3
// approach of copying the full pixel array and sorting it (huge win on
// 2400px-wide images: millions of elements).
function percentileBounds(hist, total, loFrac, hiFrac) {
  const loTarget = total * loFrac;
  const hiTarget = total * hiFrac;
  let acc = 0, lo = -1, hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (lo < 0 && acc >= loTarget) lo = v;
    if (acc >= hiTarget) { hi = v; break; }
  }
  return [Math.max(lo, 0), hi];
}

function otsuThreshold(grayData) {
  const hist  = buildHistogram(grayData);
  const total = grayData.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) ** 2;
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

async function preprocessImage(file, targetWidth = 2400) {
  const img = await loadImage(file);
  const scale = img.width < targetWidth ? targetWidth / img.width : 1;
  const W = Math.round(img.width  * scale);
  const H = Math.round(img.height * scale);
  const N = W * H;

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);

  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;

  // Grayscale (Rec. 709 luminance weights)
  const gray = new Uint8Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    gray[i] = Math.round(0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]);
  }

  // Contrast stretch (1–99 percentile)
  const [lo, hi] = percentileBounds(buildHistogram(gray), N, 0.01, 0.99);
  const range = Math.max(hi - lo, 1);
  const normalized = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    normalized[i] = Math.min(255, Math.max(0, Math.round((gray[i] - lo) / range * 255)));
  }

  // Sharpen (Laplacian unsharp mask)
  const sharpened = new Uint8Array(N);
  const strength = 0.5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const v  = normalized[idx];
      const n  = y > 0     ? normalized[idx - W] : v;
      const s  = y < H - 1 ? normalized[idx + W] : v;
      const w  = x > 0     ? normalized[idx - 1] : v;
      const e  = x < W - 1 ? normalized[idx + 1] : v;
      const lap = 4 * v - n - s - w - e;
      sharpened[idx] = Math.min(255, Math.max(0, Math.round(v + strength * lap)));
    }
  }

  // Otsu binarize — write straight back into the existing ImageData buffer
  const thresh = otsuThreshold(sharpened);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const val = sharpened[i] > thresh ? 255 : 0;
    data[j] = data[j + 1] = data[j + 2] = val;
    data[j + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// =============================================================================
// OCR — two PSM passes per image, ONE worker for the whole run.
// PSM 11 = sparse text  → scattered label fields
// PSM 6  = uniform block → government warning paragraph
// =============================================================================
let ocrStatusLabel = ''; // read by the worker's progress logger

function createOcrWorker() {
  return Tesseract.createWorker('eng', 1, {
    logger: m => {
      if (m.status === 'recognizing text') {
        setStatus(`${ocrStatusLabel} ${Math.round((m.progress || 0) * 100)}%`);
      }
    },
  });
}

async function runOCR(worker, slot, imageNum) {
  setStatus(`Preprocessing image ${imageNum}…`);
  const processedBlob = await preprocessImage(slot.file);

  // Debug preview of the binarized image (revoke any previous blob URL first)
  if (slot.ppPreview.src.startsWith('blob:')) URL.revokeObjectURL(slot.ppPreview.src);
  slot.ppPreview.src = URL.createObjectURL(processedBlob);
  preprocessDebugEl.hidden = false;
  if (slot.ppWrap) slot.ppWrap.hidden = false;

  const texts = [];
  const passes = [[11, 'pass 1/2'], [6, 'pass 2/2']];
  for (const [psm, passLabel] of passes) {
    ocrStatusLabel = `Reading image ${imageNum} (${passLabel})…`;
    setStatus(ocrStatusLabel);
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm),
      tessedit_char_whitelist: '',
      preserve_interword_spaces: '1',
    });
    const { data: { text } } = await worker.recognize(processedBlob);
    texts.push(text.trim());
  }
  return texts.filter(Boolean).join('\n\n--- PSM6 PASS ---\n\n');
}

// =============================================================================
// Main verification flow
// =============================================================================
verifyBtn.addEventListener('click', async () => {
  verifyBtn.disabled = true;
  clearBtn.disabled  = true;
  statusEl.hidden    = false;
  errorBox.hidden    = true;
  resultsEl.hidden   = true;
  ocrDebugWrap.hidden = true;

  let worker = null;
  try {
    worker = await createOcrWorker();

    const texts = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].file) texts.push(await runOCR(worker, slots[i], i + 1));
    }
    const combinedOCR = texts.filter(Boolean).join('\n\n=== LABEL IMAGE 2 ===\n\n');

    ocrDebugText.textContent = combinedOCR || '(no text detected)';
    ocrDebugWrap.hidden = false;

    setStatus('Comparing fields…');
    const formFields = parseFormFields(formText.value.trim());
    const labelOCR   = parseLabelOCR(combinedOCR);
    renderResults(compareFields(formFields, labelOCR));

  } catch (err) {
    showError('Verification failed: ' + err.message);
    console.error(err);
  } finally {
    if (worker) await worker.terminate();
    statusEl.hidden = true;
    verifyBtn.disabled = false;
    clearBtn.disabled  = false;
    checkReady();
  }
});

function setStatus(msg) { statusText.textContent = msg; }

// =============================================================================
// FIELD PARSING PIPELINE
//
// Two modes:
//   parseFormFields(text)  — parses clean typed application text.
//                            This is the SOURCE OF TRUTH. No noise, no guessing.
//   parseLabelOCR(text)    — prepares the noisy OCR text for containment checks.
//                            We do NOT try to "extract" a canonical value from OCR.
//                            Instead we return the cleaned full text so compareFields
//                            can ask: "is the application value present in here?"
//
// This inversion is the key architectural choice: the application drives the
// comparison; the label just needs to confirm each application value is present.
// =============================================================================

// Collapse any embedded newlines/extra spaces in a parsed value to a single space.
// Prevents "Example Brewing Co.\nBaltimore, MD" splitting across table rows.
function collapseLines(s) {
  if (!s) return s;
  return s.replace(/[\r\n]+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

function parseFormFields(text) {
  // Application text is clean typed input — minimal preprocessing needed
  const cleaned = text.replace(/[ \t]{2,}/g, ' ').trim();

  return {
    brandName:      extractLabeled(cleaned, ['brand name', 'brand']),
    classType:      extractLabeled(cleaned, ['class/type','class type','type','designation','style','flavor','variety','class'])
                 || parseClassType(cleaned),
    alcoholContent: normalizeABV(
                    extractLabeled(cleaned, ['alcohol content','alcohol','alc./vol','alc/vol','abv','proof'])
                 || extractAlcohol(cleaned)),
    netContents:    extractLabeled(cleaned, ['net contents','net content','contents','net'])
                 || extractNetContents(cleaned),
    bottler:        collapseLines(
                    extractLabeled(cleaned, ['bottler','producer','distiller','importer','distributed by','imported by'])
                 || parseBottler(cleaned)),
    govtWarning:    extractGovtWarning(cleaned),
  };
}

function parseLabelOCR(text) {
  // Return the cleaned OCR text for containment checks, plus the best
  // government warning candidate (which still needs exact comparison).
  const preprocessed = preprocessOcrText(text);
  const scrubbed     = scrubNoiseLines(preprocessed);
  const cleaned      = cleanOcrText(scrubbed);

  return {
    fullText:    cleaned,
    // Keep a copy with more whitespace collapsed for looser containment search
    searchText:  cleaned.replace(/\s+/g, ' ').toLowerCase(),
    govtWarning: extractGovtWarning(preprocessed),
  };
}

// =============================================================================
// STEP 1 — STRUCTURAL PRE-PROCESSING
// Fixes multi-line splits that break field detection before parsing runs.
// =============================================================================
function preprocessOcrText(text) {
  let t = text;

  // Rejoin "GOVERNMENT\nWARNING:" (very common on centered labels)
  t = t.replace(/GOVERNMENT\s*\n\s*WARNING\s*:/gi, 'GOVERNMENT WARNING:');

  // Also handle "GOVERNMENT\nWARNING\n" without colon on same line
  t = t.replace(/GOVERNMENT\s*\n\s*WARNING(?!\s*:)/gi, 'GOVERNMENT WARNING:');

  // Rejoin multi-line producer phrases
  t = t.replace(/(BREWED(?:\s+AND\s+BOTTLED)?)\s*\n\s*(BY\b)/gi, '$1 $2');
  t = t.replace(/(BOTTLED|BREWED|DISTILLED|PRODUCED|MANUFACTURED)\s*\n\s*(AND\b)/gi, '$1 $2');
  t = t.replace(/(AND\s+BOTTLED)\s*\n\s*(BY\b)/gi, '$1 $2');

  // Collapse government warning onto one line for easier extraction
  t = t.replace(/(GOVERNMENT\s+WARNING\s*:)([\s\S]*?)(health\s+problems\.)/i, (match, prefix, body, end) => {
    const rejoined = body.replace(/\r?\n(?!\r?\n)/g, ' ').replace(/\s{2,}/g, ' ');
    return prefix + rejoined + end;
  });

  return t;
}

// =============================================================================
// STEP 2 — LINE-LEVEL NOISE SCRUBBING
//
// OCR from barcodes, decorative borders, logos, and curved/arched text produces
// lines with very low "signal" — few actual letters relative to punctuation,
// symbols, and single characters. We score each line and drop the garbage
// before any field parser ever sees it.
//
// Signal score rules:
//   - A line is KEPT if it has ≥3 letters AND letter ratio ≥ 50% of non-space chars
//   - A line is KEPT if it matches a known TTB field pattern (ABV, volume, state, etc.)
//   - A line is DROPPED if it's mostly symbols, single-char tokens, or known noise
//
// We are intentionally conservative: a line is dropped only when confidence is
// high it is junk. Borderline lines are kept to avoid losing real data.
//
// Note: FORCE_KEEP_PATTERNS is declared after TTB_BEVERAGE_REGEX (below) so it
// can include it; this function only runs at event time, long after all
// top-level constants are initialized.
// =============================================================================
function scrubNoiseLines(text) {
  const cleaned = text.split('\n').map(line => {
    const trimmed = line.trim();

    // Always keep blank lines (preserve paragraph structure)
    if (trimmed.length === 0) return line;

    // Always keep section dividers added by our OCR merger
    if (/^---\s*PSM|^===\s*LABEL/i.test(trimmed)) return line;

    // Force-keep lines matching known TTB field patterns
    if (FORCE_KEEP_PATTERNS.some(re => re.test(trimmed))) return line;

    // Signal scoring
    const letters  = (trimmed.match(/[a-zA-Z]/g) || []).length;
    const digits   = (trimmed.match(/\d/g)       || []).length;
    const nonSpace = trimmed.replace(/\s/g, '').length;
    const useful   = letters + digits;

    // Drop if almost no real characters
    if (nonSpace < 3)             return '';
    if (letters < 2)              return '';
    // Drop if less than 40% of non-space chars are letters or digits
    if (useful / nonSpace < 0.40) return '';
    // Drop lines that are just single letters/symbols separated by spaces
    if (/^([A-Za-z\W]\s){3,}$/.test(trimmed)) return '';
    // Drop lines that contain mostly backslashes, pipes, and angle chars (border/logo OCR)
    if ((trimmed.match(/[\\|/<>]/g) || []).length > trimmed.length * 0.25) return '';

    return line;
  });

  return cleaned.join('\n');
}

// =============================================================================
// STEP 3 — CHARACTER-LEVEL NOISE CLEANUP
// =============================================================================
function cleanOcrText(text) {
  return text
    .replace(/\bI\b(?=\d)/g, '1')         // "I5%" → "15%"
    .replace(/\bO\b(?=\d)/g, '0')         // "O.9" → "0.9"
    .replace(/(\d)\s*[oO]\s*z/g, '$1oz')  // "9 oz" variants
    .replace(/[|}{\\[\]©®™°]/g, ' ')      // symbol noise
    .replace(/\bfs\b/gi, 's')
    .replace(/\s*=\s*/g, ' ')
    .replace(/\s*#\s*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// =============================================================================
// TTB BEVERAGE TYPE MASTER LIST
// Source: 27 CFR Part 4 (wine), Part 5 (distilled spirits), Part 7 (malt beverages)
// This covers every class/type designation the TTB recognizes.
// Sorted longest-match first at compile time so "STRAIGHT BOURBON WHISKY"
// beats "WHISKY".
// =============================================================================
const TTB_BEVERAGES = [
  // ── Distilled Spirits (27 CFR Part 5) ────────────────────────────────────
  'neutral spirits','grain spirits','vodka',
  'whisky','whiskey',
  'straight bourbon whisky','straight bourbon whiskey','bourbon whisky','bourbon whiskey','bourbon',
  'straight rye whisky','straight rye whiskey','rye whisky','rye whiskey',
  'straight wheat whisky','straight wheat whiskey','wheat whisky','wheat whiskey',
  'straight malt whisky','straight malt whiskey','malt whisky','malt whiskey',
  'straight corn whisky','straight corn whiskey','corn whisky','corn whiskey',
  'straight american whisky','american whisky','american whiskey',
  'blended straight whisky','blended whisky','blended whiskey',
  'tennessee whisky','tennessee whiskey',
  'single malt scotch whisky','blended scotch whisky','scotch whisky','scotch',
  'irish whiskey','irish whisky',
  'canadian whisky','canadian whiskey',
  'japanese whisky',
  'gin','distilled gin','compounded gin','london dry gin','geneva','hollands',
  'rum','light rum','dark rum','añejo rum','anejo rum','spiced rum','flavored rum',
  'tequila','blanco tequila','reposado tequila','añejo tequila','extra añejo tequila',
  'mezcal',
  'brandy','grape brandy','fruit brandy','cognac','armagnac','pisco','grappa',
  'calvados','applejack','apple brandy',
  'absinthe','absinth',
  'aquavit','akvavit',
  'schnapps',
  'distilled spirits specialty',
  'liqueur','cordial','creme de','triple sec','curacao','amaretto','sambuca',
  'anisette','ouzo','chartreuse','benedictine','drambuie','baileys type',
  'flavored vodka','flavored gin','flavored whiskey','flavored whisky','flavored brandy',
  'amaro',
  // ── Malt Beverages (27 CFR Part 7) ───────────────────────────────────────
  'beer','ale','lager','stout','porter','pilsner','pilsener',
  'wheat beer','weizenbier','hefeweizen','dunkelweizen','weizen','weiss beer','weissbier',
  'pale ale','india pale ale','ipa','double ipa','imperial ipa','session ipa','west coast ipa','new england ipa','hazy ipa','neipa',
  'amber ale','red ale','brown ale','dark ale','blonde ale','golden ale','cream ale',
  'oatmeal stout','milk stout','imperial stout','dry stout','foreign extra stout',
  'robust porter','baltic porter',
  'saison','farmhouse ale','biere de garde',
  'belgian tripel','belgian dubbel','belgian quad','belgian strong ale','belgian golden strong',
  'barleywine','barley wine',
  'kolsch','kölsch','altbier',
  'schwarzbier','dunkel','doppelbock','bock','eisbock','weizenbock','maibock',
  'oktoberfest','märzen','marzen','vienna lager',
  'berliner weisse','berliner weiss','gose','lichtenhainer','roggenbier',
  'lambic','gueuze','kriek','framboise','faro',
  'sour ale','wild ale','brett ale','flanders red','flanders brown','oud bruin',
  'hard seltzer','hard sparkling water','spiked seltzer',
  'hard cider','cider','perry','hard perry',
  'malt liquor','malt beverage','flavored malt beverage','malternative',
  'shandy','radler',
  'gluten-free beer','gluten free beer',
  // ── Wine (27 CFR Part 4) ─────────────────────────────────────────────────
  'table wine','still wine',
  'sparkling wine','champagne','prosecco','cava','cremant','crémant','sekt','pétillant naturel','petillant naturel','pet-nat',
  'red wine','white wine','rosé wine','rose wine','rosé','rose','blush wine','orange wine',
  'dessert wine','late harvest wine','ice wine','eiswein',
  'fortified wine','port','porto','sherry','jerez','madeira','marsala','vermouth','mistelle',
  'fruit wine','berry wine','apple wine','cherry wine','elderflower wine','mead','honey wine',
  'sake','rice wine',
  'pinot noir','pinot gris','pinot grigio','pinot blanc',
  'cabernet sauvignon','cabernet franc','merlot','syrah','shiraz','grenache','mourvedre','tempranillo',
  'zinfandel','malbec','sangiovese','nebbiolo','barbera','dolcetto','montepulciano',
  'chardonnay','sauvignon blanc','riesling','gewurztraminer','viognier','chenin blanc',
  'semillon','muscat','moscato','pinot meunier','gamay','carignan','albarino','albariño',
  // ── Hard Kombucha / Cider / Adjacent ─────────────────────────────────────
  'hard kombucha','jun','water kefir',
  'hard lemonade','hard tea','hard coffee',
];

// Build one big regex from the list — longest entries first for greedy match.
// Word boundary anchors so "ale" doesn't match inside "gale" etc.
const TTB_BEVERAGE_REGEX = new RegExp(
  '\\b(' +
  TTB_BEVERAGES
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') +
  ')\\b',
  'i'
);

// Patterns that always force-KEEP a line during noise scrubbing,
// regardless of its signal score.
const FORCE_KEEP_PATTERNS = [
  /GOVERNMENT\s+WARNING/i,
  /\d+(?:\.\d+)?\s*%\s*(?:alc|vol|abv)/i,                // ABV
  /\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|m\.?l|pint|liter)/i,    // volume
  new RegExp(`\\b(?:${PRODUCER_VERBS})\\s+(?:AND\\s+)?BY\\b`, 'i'),
  STATE_ZIP_RE,                                          // state abbrev + zip
  new RegExp(`\\b(?:${STATE_NAMES})\\b`, 'i'),           // full state name
  TTB_BEVERAGE_REGEX,                                    // any recognized beverage type
  /1\s*PINT|750\s*ML|355\s*ML|12\s*FL/i,                 // common label volumes
];

// =============================================================================
// CLASS / TYPE — TTB Comprehensive List (27 CFR Parts 4, 5, 7)
//
// Four-tier search strategy to handle scattered label text:
//   1. Explicit labeled field ("Type: Wheat Beer")
//   2. Sliding-window keyword scan — handles multi-word types split across
//      lines with noise between them (e.g. "WHEAT" / junk lines / "BEER")
//   3. Line-by-line scan — full TTB regex on each clean line
//   4. Collapsed full-text scan as last resort
// =============================================================================

// Maps first-word of a two-word TTB type → expected second word(s)
// Used by the sliding-window scanner to reconstruct split types
const TTB_SPLIT_TYPES = {
  'WHEAT':    ['BEER','WHISKY','WHISKEY'],
  'PALE':     ['ALE'],
  'INDIA':    ['PALE'],  // "INDIA" + "PALE ALE" or just finding "PALE ALE" next
  'HARD':     ['CIDER','SELTZER','KOMBUCHA','LEMONADE','TEA'],
  'BROWN':    ['ALE'],
  'AMBER':    ['ALE'],
  'GOLDEN':   ['ALE'],
  'BLONDE':   ['ALE'],
  'CREAM':    ['ALE'],
  'DARK':     ['RUM','ALE'],
  'LIGHT':    ['RUM','ALE','BEER'],
  'SPICED':   ['RUM'],
  'WHITE':    ['RUM','WINE'],
  'RED':      ['WINE','ALE'],
  'ROSE':     ['WINE'],
  'TABLE':    ['WINE'],
  'MALT':     ['BEVERAGE','LIQUOR'],
  'SINGLE':   ['MALT'],
  'DOUBLE':   ['IPA'],
  'SESSION':  ['IPA'],
  'STRAIGHT': ['BOURBON','RYE','WHEAT'],
  'BLENDED':  ['WHISKY','WHISKEY','SCOTCH'],
  'SPARKLING':['WINE','WATER'],
  'DESSERT':  ['WINE'],
  'FORTIFIED':['WINE'],
  'FARM':     ['ALE'],    // farmhouse ale sometimes split
  'FARMHOUSE':['ALE'],
  'IMPERIAL': ['STOUT','IPA'],
  'OATMEAL':  ['STOUT'],
  'MILK':     ['STOUT'],
  'DRY':      ['STOUT','GIN'],
  'LONDON':   ['DRY'],
  'CANADIAN': ['WHISKY','WHISKEY'],
  'IRISH':    ['WHISKEY','WHISKY'],
  'SCOTCH':   ['WHISKY'],
  'CORN':     ['WHISKY','WHISKEY'],
};

/**
 * Extract the first 3+ consecutive uppercase letter run from a line.
 * Ignores leading symbols, numbers, and short fragments.
 * e.g. "© WHEAT '0" → "WHEAT", "devs BEER Us" → "BEER"
 */
function extractKeywordFromLine(line) {
  const m = line.trim().match(/\b([A-Z]{3,})\b/);
  return m ? m[1] : null;
}

function parseClassType(text) {
  // 1. Explicit labeled field always wins
  const labeled = extractLabeled(text, ['class/type','class type','type','designation','style','flavor','variety','class']);
  if (labeled) return labeled;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 2. Sliding-window keyword scan — runs FIRST so multi-word types
  //    like "WHEAT BEER" beat single-word matches like "BEER".
  //    Extracts the dominant uppercase word from each line, then looks for
  //    known two-word type combinations within a 7-line window.
  //    This handles "WHEAT" on line 2 and "BEER" on line 5 with noise between.
  const keywords = lines.map(extractKeywordFromLine);

  for (let i = 0; i < keywords.length; i++) {
    const k = keywords[i];
    if (!k || !TTB_SPLIT_TYPES[k]) continue;
    const expectedFollowers = TTB_SPLIT_TYPES[k];
    for (let j = i + 1; j < Math.min(i + 8, keywords.length); j++) {
      const next = keywords[j];
      if (!next) continue;
      for (const follower of expectedFollowers) {
        if (next === follower || follower.startsWith(next)) {
          return `${k} ${follower}`;
        }
      }
    }
  }

  // 3. Line-by-line scan — full TTB regex on each line (single-word types)
  for (const line of lines) {
    if (/GOVERNMENT\s+WARNING/i.test(line)) continue;
    if (line.length <= 80) {
      const m = line.match(TTB_BEVERAGE_REGEX);
      if (m) return m[0].trim();
    }
  }

  // 4. Collapsed full-text scan — last resort
  const fullMatch = text.replace(/\s+/g, ' ').match(TTB_BEVERAGE_REGEX);
  return fullMatch ? fullMatch[0].trim() : null;
}

// =============================================================================
// BOTTLER / PRODUCER
// =============================================================================
function parseBottler(text) {
  const labeled = extractLabeled(text, ['bottler','producer','distiller','importer',
                                        'distributed by','imported by']);
  if (labeled) return labeled;

  const m = text.match(PRODUCED_BY_RE);
  if (m) {
    let val = m[1].trim();
    const afterIdx  = text.indexOf(m[0]) + m[0].length;
    const nextLine  = text.slice(afterIdx).trim().split('\n')[0].trim();
    const stateRe   = new RegExp(`\\b(?:${STATE_ABBRS})\\b`);
    if (/^[A-Za-z][\w\s]+,\s*[A-Z]{2}/i.test(nextLine) || stateRe.test(nextLine)) {
      val = `${val}, ${nextLine}`;
    }
    return val.trim();
  }

  return extractProducerLocation(text);
}

function extractProducerLocation(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ANY_STATE_LINE_RE.test(line)) {
      const prevLine = i > 0 ? lines[i - 1] : null;
      if (prevLine && new RegExp(`\\b(?:${PRODUCER_VERBS}|by)\\b`, 'i').test(prevLine)) {
        return `${prevLine} ${line}`.trim();
      }
      return line;
    }
  }
  return null;
}

// =============================================================================
// LABELED FIELD EXTRACTION  (e.g. "Brand Name: Foo Bar")
// =============================================================================
function extractLabeled(text, keys) {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp(`${escaped}\\s*[:\\-]\\s*(.+)`, 'i'));
    if (m && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
}

// =============================================================================
// ALCOHOL CONTENT
// =============================================================================

/**
 * Trim an ABV string to just the number + unit — nothing after.
 * "4% Alc./Vol. Brewed and Bottled by..." → "4% Alc./Vol."
 * "5.0% ABV (10 proof) bottled by..."     → "5.0% ABV (10 proof)"
 */
function normalizeABV(s) {
  if (!s) return s;
  // Match from the start: digits % [unit] [( proof )] — capture only that
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%\s*(?:alc\.?\s*(?:\/\s*vol\.?)?)?\s*(?:\(\s*\d+\s*proof\s*\))?/i);
  return m ? m[0].trim().replace(/\s+/g, ' ') : s;
}

function extractAlcohol(text) {
  // Match the number + % + optional unit label, then STOP.
  // "4% Alc./Vol. Brewed and Bottled by..." must not pull in the trailing text.
  const m = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:alc\.?\s*(?:\/\s*vol\.?)?)?(?:\s*\(\s*\d+\s*proof\s*\))?/i);
  if (m) return m[0].trim().replace(/\s+/g, ' ');
  // Proof-only labels (no % sign)
  const pm = text.match(/(\d+)\s*proof/i);
  return pm ? pm[0].trim() : null;
}

// =============================================================================
// NET CONTENTS
// =============================================================================
function extractNetContents(text) {
  const re = /(?:\d+(?:\.\d+)?)\s*(?:m\.?l\.?|milliliter|millilitre|fl\.?\s*oz\.?|fluid\s+ounce|litre|liter|pint|gallon|\bL\b)/gi;
  const matches = text.match(re);
  if (!matches || matches.length === 0) return null;
  if (matches.length === 1) return matches[0].trim();
  const preferred = matches.find(m => /fl\.?\s*oz|m\.?l/i.test(m));
  return (preferred || matches[0]).trim();
}

// =============================================================================
// GOVERNMENT WARNING EXTRACTION
// preprocessOcrText already collapsed the warning onto one line.
// We preserve the raw text so the exact-match comparison stays accurate.
// =============================================================================
function extractGovtWarning(text) {
  // The two OCR passes are concatenated with a "--- PSM6 PASS ---" divider.
  // When the warning is on image 2, both passes produce a copy — and after
  // preprocessOcrText collapses newlines, they may land on the same long line,
  // causing a naive regex to span both and return a double-warning string.
  //
  // Fix: split on pass/image dividers first, extract one candidate per segment,
  // then score by punctuation count and return the best (most complete) one.

  const segments = text.split(/---\s*PSM6?\s*PASS\s*---|===\s*LABEL\s*IMAGE\s*\d+\s*===/i);

  const cleanCandidate = raw =>
    raw.replace(/\r?\n(?!\r?\n)/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Score: periods + commas = better OCR punctuation = better candidate
  const score = s => (s.match(/[.,]/g) || []).length;

  const fullRe = /GOVERNMENT\s+WARNING\s*:[\s\S]*?health\s+problems\./i;
  const candidates = [];

  for (const seg of segments) {
    const m = seg.match(fullRe);
    if (m) candidates.push(cleanCandidate(m[0]));
  }

  if (candidates.length > 0) {
    return candidates.sort((a, b) => score(b) - score(a))[0];
  }

  // Fallback: grab from first "GOVERNMENT WARNING:" to first blank line
  const startMatch = /GOVERNMENT\s+WARNING\s*:/i.exec(text);
  if (!startMatch) return null;

  const body = text.slice(startMatch.index)
    .replace(/\r?\n(?!\r?\n)/g, ' ')
    .replace(/\r?\n\r?\n[\s\S]*/g, '')
    .replace(/\s+[A-Z]{8,}\s*$/g, '')
    .replace(/\s+[|I]{4,}\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return body.length > 20 ? body : null;
}

// =============================================================================
// FIELD COMPARISON
//
// The application form fields are the SOURCE OF TRUTH.
// For each field, we ask: "is the application value present in the label OCR?"
//
// For fuzzy fields (brand, class, bottler):
//   — normalize both sides and check containment in either direction
//   — also check token-level overlap for multi-word values
//
// For numeric fields (ABV, volume):
//   — parse the number from the application value, then scan OCR for the same number
//
// For the government warning:
//   — still an exact comparison (TTB requires verbatim text)
// =============================================================================
const FIELDS_CONFIG = [
  { key: 'brandName',      label: 'Brand Name',         match: 'contains' },
  { key: 'classType',      label: 'Class / Type',       match: 'contains' },
  { key: 'alcoholContent', label: 'Alcohol Content',    match: 'abv'      },
  { key: 'netContents',    label: 'Net Contents',       match: 'volume'   },
  { key: 'bottler',        label: 'Bottler / Producer', match: 'bottler'  },
  { key: 'govtWarning',    label: 'Government Warning', match: 'exact'    },
];

/**
 * Main comparison entry point.
 * @param {object} formF    — parsed application fields (source of truth)
 * @param {object} labelOCR — { fullText, searchText, govtWarning }
 */
function compareFields(formF, labelOCR) {
  const rows = [];

  for (const cfg of FIELDS_CONFIG) {
    const appVal = formF[cfg.key] || null;
    let status, note, foundOnLabel;

    if (!appVal) {
      // Field missing from the application — flag it
      status       = 'NOT_FOUND';
      note         = 'Field not present in application text. Cannot verify.';
      foundOnLabel = null;
    } else if (cfg.match === 'exact') {
      // Government warning: exact comparison against extracted OCR warning
      const labelWarning = labelOCR.govtWarning;
      if (!labelWarning) {
        status       = 'NOT_FOUND';
        note         = 'Government Warning not detected in label image. Check image quality.';
        foundOnLabel = null;
      } else {
        const r = compareGovtWarning(labelWarning, appVal);
        status       = r.status;
        note         = r.note;
        foundOnLabel = labelWarning;
      }
    } else {
      // All other fields: check whether the application value is present in the OCR text
      const r = checkPresence(cfg.match, appVal, labelOCR);
      status       = r.status;
      note         = r.note;
      foundOnLabel = r.found;
    }

    rows.push({
      field:      cfg.label,
      labelValue: foundOnLabel,   // what we found / confirmed on the label
      formValue:  appVal,         // what the application says it should be
      status,
      note,
      exactRequired: cfg.match === 'exact',
    });
  }

  const allMatch = rows.every(r => r.status === 'MATCH');
  return { overall: allMatch ? 'APPROVED' : 'REJECTED', rows };
}

/**
 * Token-level overlap between an application value and the label OCR text.
 * Shared by the 'contains' and 'bottler' checks (was duplicated in v3).
 * @returns {{ matched: string[], ratio: number }}
 */
function tokenOverlap(normApp, normLabel) {
  const appTokens   = normApp.split(/\s+/).filter(t => t.length >= 3);
  const labelTokens = new Set(normLabel.split(/\s+/));
  const matched     = appTokens.filter(t => labelTokens.has(t));
  return { matched, ratio: appTokens.length > 0 ? matched.length / appTokens.length : 0 };
}

/**
 * Check whether an application value is present in the label OCR text.
 * Returns { status, note, found }.
 */
function checkPresence(type, appVal, labelOCR) {
  const { searchText } = labelOCR;

  if (type === 'abv') {
    const appNum = extractABVNumber(appVal);
    if (appNum === null) return { status: 'NOT_FOUND', note: 'Could not parse ABV from application.', found: null };
    // Match the ABV expression itself — number + % + optional alc./vol. label only.
    const abvRe = /(\d+(?:\.\d+)?)\s*%\s*(?:alc\.?\s*(?:\/\s*vol\.?)?|alcohol|abv)?/gi;
    let m;
    while ((m = abvRe.exec(searchText)) !== null) {
      if (Math.abs(parseFloat(m[1]) - appNum) < 0.15) {
        return { status: 'MATCH', note: null, found: m[0].trim() };
      }
    }
    return { status: 'MISMATCH', note: `Application states ${appVal} — not found in label.`, found: null };
  }

  if (type === 'volume') {
    const appML = parseVolumeToML(appVal);
    if (appML === null) return { status: 'NOT_FOUND', note: 'Could not parse volume from application.', found: null };
    // Find all volume expressions in OCR and compare numerically
    const volRe = /(\d+(?:\.\d+)?)\s*(m\.?l\.?|fl\.?\s*oz\.?|litre|liter|pint|gallon)/gi;
    let m;
    while ((m = volRe.exec(searchText)) !== null) {
      const ocrML = parseVolumeToML(m[0]);
      if (ocrML !== null && Math.abs(ocrML - appML) < 1) {
        return { status: 'MATCH', note: null, found: m[0].trim() };
      }
    }
    return { status: 'MISMATCH', note: `Application states ${appVal} — not found in label.`, found: null };
  }

  if (type === 'bottler') {
    // Bottler MUST include a location (city/state) per TTB requirements.
    // First check that the application value itself has a location component,
    // then verify it is present in the label OCR text.
    // Comma/space required before the state abbrev (STATE_ABBR_END_RE) and 3+
    // tokens required, to avoid 'Distillery CO' (company abbrev) matching as a location.
    const hasLocation = FULL_STATE_RE.test(appVal) ||
      (STATE_ABBR_END_RE.test(appVal) && appVal.trim().split(/\s+/).length >= 3);

    // Run the normal containment check first
    const normApp   = fuzzyNormalize(appVal);
    const normLabel = fuzzyNormalize(searchText);
    const { ratio } = tokenOverlap(normApp, normLabel);
    const present   = normLabel.includes(normApp) || ratio >= 0.75;

    if (!hasLocation) {
      return {
        status: 'MISMATCH',
        note: 'Application bottler/producer value is missing a location (city and state). TTB requires bottler name AND address.',
        found: present ? appVal : null,
      };
    }
    if (present) return { status: 'MATCH', note: null, found: appVal };
    return {
      status: 'MISMATCH',
      note: `Application states "${appVal}" — not found in label OCR.`,
      found: null,
    };
  }

  if (type === 'contains') {
    // Normalize both sides and check if every significant word from the
    // application value appears somewhere in the label OCR text.
    const normApp   = fuzzyNormalize(appVal);
    const normLabel = fuzzyNormalize(searchText);

    // Direct substring containment
    if (normLabel.includes(normApp)) {
      return { status: 'MATCH', note: null, found: appVal };
    }

    // The application often includes a city+state address (e.g. "Example
    // Brewing Co., Baltimore, MD") but the label may print only the company
    // name, or vice-versa. Strip the trailing address before token-matching
    // so the company name alone is enough to confirm presence. This also
    // avoids short state-abbrev tokens ("md", "ca") inflating the miss count.
    const normAppCore = fuzzyNormalize(appVal.replace(ADDRESS_SUFFIX_RE, '').trim());

    if (normAppCore.length >= 3 && normLabel.includes(normAppCore)) {
      return { status: 'MATCH', note: null, found: appVal };
    }

    // Token-overlap: significant words from the application value in the label.
    const { matched, ratio } = tokenOverlap(normAppCore, normLabel);

    if (ratio >= 0.75) {
      return { status: 'MATCH', note: null, found: appVal };
    }

    if (ratio >= 0.5) {
      return {
        status: 'MISMATCH',
        note: `Partial match: found ${matched.join(', ')} but not all words from application value "${appVal}".`,
        found: matched.length ? matched.join(' ') : null,
      };
    }

    return {
      status: 'MISMATCH',
      note: `Application states "${appVal}" — not found in label OCR.`,
      found: null,
    };
  }

  return { status: 'NOT_FOUND', note: 'Unknown match type.', found: null };
}

// =============================================================================
// Government Warning comparison
// =============================================================================
function compareGovtWarning(labelVal, formVal) {
  const issues = [];

  const labelPrefixMatch = labelVal.match(/^(GOVERNMENT\s+WARNING\s*:)/i);
  const labelPrefix = labelPrefixMatch ? labelPrefixMatch[1] : null;

  if (!labelPrefix) {
    issues.push('Could not find "GOVERNMENT WARNING:" prefix on label.');
  } else if (labelPrefix !== REQUIRED_WARNING_PREFIX) {
    issues.push(
      `"GOVERNMENT WARNING:" must be in ALL CAPS. ` +
      `Found: "${labelPrefix}" — Expected: "${REQUIRED_WARNING_PREFIX}"`
    );
  }

  const norm = s => s.replace(/\s+/g, ' ').trim();
  const afterPrefix  = labelPrefix ? labelVal.slice(labelPrefix.length) : labelVal;
  const labelBody    = norm(afterPrefix).toLowerCase();
  const requiredBody = norm(REQUIRED_WARNING_BODY).toLowerCase();

  if (labelBody !== requiredBody) {
    const d = findDivergence(labelBody, requiredBody);
    issues.push(
      `Warning body does not match required TTB text. ` +
      `First difference at position ${d.pos}: ` +
      `label has "…${d.labelSnippet}…", required is "…${d.requiredSnippet}…"`
    );
  }

  if (issues.length === 0) {
    return {
      status: 'MATCH',
      note: '⚠ MANUAL CHECK REQUIRED: OCR cannot detect font weight. Confirm "GOVERNMENT WARNING:" is printed in bold on the physical label or source file. If it is not bold, this application must be rejected.'
    };
  }
  return {
    status: 'MISMATCH',
    note: issues.join(' | ') +
      ' | ⚠ Bold check: also confirm "GOVERNMENT WARNING:" appears bold on physical label.'
  };
}

function findDivergence(a, b) {
  let pos = 0;
  const limit = Math.min(a.length, b.length);
  while (pos < limit && a[pos] === b[pos]) pos++;
  return {
    pos,
    labelSnippet:    a.slice(Math.max(0, pos - 10), pos + 20).replace(/\n/g, ' '),
    requiredSnippet: b.slice(Math.max(0, pos - 10), pos + 20).replace(/\n/g, ' '),
  };
}

// =============================================================================
// Helpers
// =============================================================================
function fuzzyNormalize(s) {
  return s
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractABVNumber(s) {
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

function parseVolumeToML(s) {
  const lower = s.toLowerCase().replace(/\s/g, '');
  let m;
  if ((m = lower.match(/(\d+(?:\.\d+)?)m\.?l\.?/)))   return parseFloat(m[1]);
  if ((m = lower.match(/(\d+(?:\.\d+)?)l\b/)))        return parseFloat(m[1]) * 1000;
  if ((m = lower.match(/(\d+(?:\.\d+)?)fl\.?oz\.?/))) return parseFloat(m[1]) * 29.5735;
  if ((m = lower.match(/(\d+(?:\.\d+)?)oz\.?/)))      return parseFloat(m[1]) * 29.5735;
  if ((m = lower.match(/(\d+(?:\.\d+)?)pint/)))       return parseFloat(m[1]) * 473.176; // 1 PINT = 16 fl oz
  if ((m = lower.match(/(\d+(?:\.\d+)?)gallon/)))     return parseFloat(m[1]) * 3785.41;
  return null;
}

// =============================================================================
// Render results
// =============================================================================
function renderResults({ overall, rows }) {
  const header  = $('resultHeader');
  const icon    = $('resultIcon');
  const verdict = $('resultVerdict');
  const sub     = $('resultSub');
  const body    = $('fieldsBody');
  const summary = $('summaryStrip');

  const approved = overall === 'APPROVED';
  header.className    = 'result-header ' + (approved ? 'approved' : 'rejected');
  icon.textContent    = approved ? '✔' : '✖';
  verdict.textContent = approved
    ? 'APPROVED — Label Matches Application'
    : 'REJECTED — Discrepancies Found';
  sub.textContent = approved
    ? 'All checked fields match the COLA application.'
    : 'One or more fields do not match. See details below.';

  const noteClass = { MISMATCH: 'mismatch', NOT_FOUND: 'missing' };
  body.innerHTML = rows.map(r => `
    <tr>
      <td class="field-name">${escHtml(r.field)}</td>
      <td class="field-label-val">${escHtml(r.labelValue || '—')}</td>
      <td class="field-form-val">${escHtml(r.formValue  || '—')}</td>
      <td class="field-status">${makeTag(r.status, r.exactRequired)}${
        r.note ? `<div class="field-note ${noteClass[r.status] || 'info'}">${escHtml(r.note)}</div>` : ''
      }</td>
    </tr>`).join('');

  // Single pass over rows instead of three filter() sweeps
  const counts = { MATCH: 0, MISMATCH: 0, NOT_FOUND: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  summary.innerHTML = `
    <span><strong>${rows.length}</strong> fields checked</span>
    <span style="color:var(--green)"><strong>${counts.MATCH}</strong> match</span>
    ${counts.MISMATCH  ? `<span style="color:var(--red)"><strong>${counts.MISMATCH}</strong> mismatch</span>`   : ''}
    ${counts.NOT_FOUND ? `<span style="color:var(--warn)"><strong>${counts.NOT_FOUND}</strong> not found</span>` : ''}
  `;

  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function makeTag(status, exactRequired) {
  const map = {
    'MATCH':     ['match',    '✔ Match'],
    'MISMATCH':  ['mismatch', '✖ Mismatch'],
    'NOT_FOUND': ['missing',  '? Not Found'],
  };
  const [cls, label] = map[status] || ['missing', status];
  const exactBadge = (exactRequired && status === 'MISMATCH')
    ? ' <span class="tag exact">Exact Required</span>'
    : '';
  return `<span class="tag ${cls}">${label}</span>${exactBadge}`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showError(msg) {
  errorBox.textContent = '⚠ ' + msg;
  errorBox.hidden = false;
}
