// =============================================================================
// TTB COLA Label Verification — app.js  (v3 — hardened parsing)
// 100% local: Tesseract.js OCR + canvas image preprocessing
// No API calls, no server, no cost.
// =============================================================================

const REQUIRED_WARNING_PREFIX = 'GOVERNMENT WARNING:';
const REQUIRED_WARNING_BODY =
  ' (1) According to the Surgeon General, women should not drink alcoholic beverages ' +
  'during pregnancy because of the risk of birth defects. ' +
  '(2) Consumption of alcoholic beverages impairs your ability to drive a car or ' +
  'operate machinery, and may cause health problems.';
const FULL_REQUIRED_WARNING = REQUIRED_WARNING_PREFIX + REQUIRED_WARNING_BODY;

// =============================================================================
// DOM refs
// =============================================================================
const labelFile         = document.getElementById('labelFile');
const labelFile2        = document.getElementById('labelFile2');
const labelDrop         = document.getElementById('labelDrop');
const labelDrop2        = document.getElementById('labelDrop2');
const labelPreview      = document.getElementById('labelPreview');
const labelPreview2     = document.getElementById('labelPreview2');
const labelPreviewWrap  = document.getElementById('labelPreviewWrap');
const labelPreviewWrap2 = document.getElementById('labelPreviewWrap2');
const labelFilename     = document.getElementById('labelFilename');
const labelFilename2    = document.getElementById('labelFilename2');
const secondImageToggle = document.getElementById('secondImageToggle');
const secondImagePanel  = document.getElementById('secondImagePanel');
const formText          = document.getElementById('formText');
const verifyBtn         = document.getElementById('verifyBtn');
const clearBtn          = document.getElementById('clearBtn');
const statusEl          = document.getElementById('status');
const statusText        = document.getElementById('statusText');
const errorBox          = document.getElementById('errorBox');
const resultsEl         = document.getElementById('results');
const ocrDebugWrap      = document.getElementById('ocrDebugWrap');
const ocrDebugText      = document.getElementById('ocrDebugText');

let labelImageFile  = null;
let labelImageFile2 = null;

// =============================================================================
// Second image toggle
// =============================================================================
secondImageToggle.addEventListener('change', () => {
  secondImagePanel.style.display = secondImageToggle.checked ? 'block' : 'none';
  if (!secondImageToggle.checked) {
    labelImageFile2 = null;
    labelFile2.value = '';
    labelPreview2.src = '';
    labelPreviewWrap2.style.display = 'none';
    labelFilename2.textContent = '';
  }
});

// =============================================================================
// File handling
// =============================================================================
function handleLabelFile(file, slot) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    if (slot === 1) {
      labelImageFile = file;
      labelPreview.src = e.target.result;
      labelPreviewWrap.style.display = 'block';
      labelFilename.textContent = file.name;
    } else {
      labelImageFile2 = file;
      labelPreview2.src = e.target.result;
      labelPreviewWrap2.style.display = 'block';
      labelFilename2.textContent = file.name;
    }
    checkReady();
  };
  reader.readAsDataURL(file);
}

labelFile.addEventListener('change',  e => handleLabelFile(e.target.files[0], 1));
labelFile2.addEventListener('change', e => handleLabelFile(e.target.files[0], 2));
formText.addEventListener('input', checkReady);

function setupDrop(dropEl, slot) {
  dropEl.addEventListener('dragover',  e => { e.preventDefault(); dropEl.classList.add('drag-over'); });
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag-over'));
  dropEl.addEventListener('drop', e => {
    e.preventDefault();
    dropEl.classList.remove('drag-over');
    handleLabelFile(e.dataTransfer.files[0], slot);
  });
}
setupDrop(labelDrop,  1);
setupDrop(labelDrop2, 2);

function checkReady() {
  verifyBtn.disabled = !(labelImageFile && formText.value.trim().length > 10);
}

clearBtn.addEventListener('click', () => {
  labelImageFile = null;
  labelImageFile2 = null;
  labelFile.value = '';
  labelFile2.value = '';
  labelPreview.src = '';
  labelPreview2.src = '';
  labelPreviewWrap.style.display = 'none';
  labelPreviewWrap2.style.display = 'none';
  labelFilename.textContent = '';
  labelFilename2.textContent = '';
  formText.value = '';
  resultsEl.style.display = 'none';
  ocrDebugWrap.style.display = 'none';
  errorBox.style.display = 'none';
  const ppWrap = document.getElementById('preprocessDebugWrap');
  if (ppWrap) ppWrap.style.display = 'none';
  secondImageToggle.checked = false;
  secondImagePanel.style.display = 'none';
  checkReady();
});

// =============================================================================
// IMAGE PREPROCESSING — canvas pipeline
// 1. Scale up small images
// 2. Grayscale (luminance weights)
// 3. Contrast normalization (1%/99% percentile stretch)
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

function otsuThreshold(grayData) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < grayData.length; i++) hist[grayData[i]]++;
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

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);

  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;

  // Grayscale
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    gray[i] = Math.round(0.2126 * data[i*4] + 0.7152 * data[i*4+1] + 0.0722 * data[i*4+2]);
  }

  // Contrast stretch (1–99 percentile)
  const sorted = gray.slice().sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.01)];
  const hi = sorted[Math.floor(sorted.length * 0.99)];
  const range = Math.max(hi - lo, 1);
  const normalized = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) {
    normalized[i] = Math.min(255, Math.max(0, Math.round((gray[i] - lo) / range * 255)));
  }

  // Sharpen (Laplacian unsharp mask)
  const sharpened = new Uint8Array(W * H);
  const strength = 0.5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const v  = normalized[idx];
      const n  = y > 0     ? normalized[(y-1)*W+x] : v;
      const s  = y < H-1   ? normalized[(y+1)*W+x] : v;
      const ww = x > 0     ? normalized[y*W+(x-1)] : v;
      const e  = x < W-1   ? normalized[y*W+(x+1)] : v;
      const lap = 4*v - n - s - ww - e;
      sharpened[idx] = Math.min(255, Math.max(0, Math.round(v + strength * lap)));
    }
  }

  // Otsu binarize
  const thresh = otsuThreshold(sharpened);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const val = sharpened[i] > thresh ? 255 : 0;
    out[i*4] = out[i*4+1] = out[i*4+2] = val;
    out[i*4+3] = 255;
  }
  ctx.putImageData(new ImageData(out, W, H), 0, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// =============================================================================
// OCR — two PSM passes per image
// PSM 11 = sparse text  → scattered label fields
// PSM 6  = uniform block → government warning paragraph
// =============================================================================
async function runOCR(file, slot, showPreview) {
  setStatus(`Preprocessing image ${slot}…`);
  const processedBlob = await preprocessImage(file);

  if (showPreview) {
    const previewUrl = URL.createObjectURL(processedBlob);
    const previewImg = document.getElementById(`preprocessPreview${slot}`);
    const wrapEl     = document.getElementById('preprocessDebugWrap');
    if (previewImg) previewImg.src = previewUrl;
    if (wrapEl)     wrapEl.style.display = 'block';
    if (slot === 2) {
      const wrap2 = document.getElementById('preprocessPreview2Wrap');
      if (wrap2) wrap2.style.display = 'block';
    }
  }

  const runPass = async (psm, passLabel) => {
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          setStatus(`Reading image ${slot} (${passLabel})… ${Math.round((m.progress||0)*100)}%`);
        }
      }
    });
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm),
      tessedit_char_whitelist: '',
      preserve_interword_spaces: '1',
    });
    const { data: { text } } = await worker.recognize(processedBlob);
    await worker.terminate();
    return text.trim();
  };

  setStatus(`Reading image ${slot} (pass 1/2)…`);
  const text1 = await runPass(11, 'pass 1/2');
  setStatus(`Reading image ${slot} (pass 2/2)…`);
  const text2 = await runPass(6,  'pass 2/2');

  return [text1, text2].filter(Boolean).join('\n\n--- PSM6 PASS ---\n\n');
}

// =============================================================================
// Main verification flow
// =============================================================================
verifyBtn.addEventListener('click', async () => {
  verifyBtn.disabled = true;
  clearBtn.disabled  = true;
  statusEl.style.display = 'flex';
  errorBox.style.display = 'none';
  resultsEl.style.display = 'none';
  ocrDebugWrap.style.display = 'none';

  try {
    const ocrText1 = await runOCR(labelImageFile, 1, true);
    let ocrText2 = '';
    if (labelImageFile2) ocrText2 = await runOCR(labelImageFile2, 2, true);

    const combinedOCR = [ocrText1, ocrText2].filter(Boolean).join('\n\n=== LABEL IMAGE 2 ===\n\n');

    ocrDebugText.textContent = combinedOCR || '(no text detected)';
    ocrDebugWrap.style.display = 'block';

    setStatus('Comparing fields…');
    const formFields = parseFormFields(formText.value.trim());
    const labelOCR   = parseLabelOCR(combinedOCR);
    const results    = compareFields(formFields, labelOCR);
    renderResults(results);

  } catch (err) {
    showError('Verification failed: ' + err.message);
    console.error(err);
  } finally {
    statusEl.style.display = 'none';
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
// This inversion is the key architectural change: the application drives the
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
  const fields  = {};

  fields.brandName      = extractLabeled(cleaned, ['brand name', 'brand']);
  fields.classType      = extractLabeled(cleaned, ['class/type','class type','type','designation','style','flavor','variety','class'])
                       || parseClassType(cleaned);
  fields.alcoholContent = normalizeABV(
                         extractLabeled(cleaned, ['alcohol content','alcohol','alc./vol','alc/vol','abv','proof'])
                      || extractAlcohol(cleaned));
  fields.netContents    = extractLabeled(cleaned, ['net contents','net content','contents','net'])
                       || extractNetContents(cleaned);
  fields.bottler        = collapseLines(
                         extractLabeled(cleaned, ['bottler','producer','distiller','importer','distributed by','imported by'])
                      || parseBottler(cleaned));
  fields.govtWarning    = extractGovtWarning(cleaned);

  return fields;
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
// This is the key new step. OCR from barcodes, decorative borders, logos, and
// curved/arched text produces lines with very low "signal" — few actual letters
// relative to punctuation, symbols, and single characters. We score each line
// and drop the garbage before any field parser ever sees it.
//
// Signal score rules:
//   - A line is KEPT if it has ≥3 letters AND letter ratio ≥ 50% of non-space chars
//   - A line is KEPT if it matches a known TTB field pattern (ABV, volume, state, etc.)
//   - A line is DROPPED if it's mostly symbols, single-char tokens, or known noise
//
// We are intentionally conservative: a line is dropped only when confidence is
// high it is junk. Borderline lines are kept to avoid losing real data.
// =============================================================================
function scrubNoiseLines(text) {
  // Patterns that always force-KEEP a line regardless of signal score
  const forceKeep = [
    /GOVERNMENT\s+WARNING/i,
    /\d+(?:\.\d+)?\s*%\s*(?:alc|vol|abv)/i,           // ABV
    /\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|m\.?l|pint|liter)/i, // volume
    /\b(?:BOTTLED|BREWED|DISTILLED|PRODUCED|MANUFACTURED|IMPORTED|DISTRIBUTED)\s+(?:AND\s+)?BY\b/i,
    /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s*\d{5}/i,  // state + zip
    /\b(?:ALABAMA|ALASKA|ARIZONA|ARKANSAS|CALIFORNIA|COLORADO|CONNECTICUT|DELAWARE|FLORIDA|GEORGIA|HAWAII|IDAHO|ILLINOIS|INDIANA|IOWA|KANSAS|KENTUCKY|LOUISIANA|MAINE|MARYLAND|MASSACHUSETTS|MICHIGAN|MINNESOTA|MISSISSIPPI|MISSOURI|MONTANA|NEBRASKA|NEVADA|NEW\s+HAMPSHIRE|NEW\s+JERSEY|NEW\s+MEXICO|NEW\s+YORK|NORTH\s+CAROLINA|NORTH\s+DAKOTA|OHIO|OKLAHOMA|OREGON|PENNSYLVANIA|RHODE\s+ISLAND|SOUTH\s+CAROLINA|SOUTH\s+DAKOTA|TENNESSEE|TEXAS|UTAH|VERMONT|VIRGINIA|WASHINGTON|WEST\s+VIRGINIA|WISCONSIN|WYOMING)\b/i,
    TTB_BEVERAGE_REGEX,           // any recognized beverage type keyword
    /1\s*PINT|750\s*ML|355\s*ML|12\s*FL/i,  // common label volumes
  ];

  const lines = text.split('\n');
  const cleaned = lines.map(line => {
    const trimmed = line.trim();

    // Always keep blank lines (preserve paragraph structure)
    if (trimmed.length === 0) return line;

    // Always keep section dividers added by our OCR merger
    if (/^---\s*PSM|^===\s*LABEL/i.test(trimmed)) return line;

    // Force-keep lines matching known TTB field patterns
    if (forceKeep.some(re => re.test(trimmed))) return line;

    // Signal scoring
    const letters   = (trimmed.match(/[a-zA-Z]/g)  || []).length;
    const digits    = (trimmed.match(/\d/g)         || []).length;
    const nonSpace  = trimmed.replace(/\s/g, '').length;
    const useful    = letters + digits;

    // Drop if almost no real characters
    if (nonSpace < 3)                              return '';
    if (letters < 2)                               return '';
    // Drop if less than 40% of non-space chars are letters or digits
    if (useful / nonSpace < 0.40)                  return '';
    // Drop lines that are just single letters/symbols separated by spaces
    if (/^([A-Za-z\W]\s){3,}$/.test(trimmed))     return '';
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
// Ordered longest-match first so "STRAIGHT BOURBON WHISKY" beats "WHISKY".
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
  'flavored vodka','flavored gin','flavored rum','flavored whiskey','flavored whisky','flavored brandy',
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

// Build one big regex from the list — longest entries first (already ordered above)
// Use word boundary anchors so "ale" doesn't match inside "gale" etc.
const TTB_BEVERAGE_REGEX = new RegExp(
  '\\b(' +
  TTB_BEVERAGES
    .slice()
    .sort((a, b) => b.length - a.length)  // longest first for greedy match
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') +
  ')\\b',
  'i'
);

// =============================================================================
// BRAND NAME
// =============================================================================
function parseBrandName(text) {
  // 1. Explicit label field wins
  const labeled = extractLabeled(text, ['brand name', 'brand']);
  if (labeled) return labeled;

  // 2. Scan clean lines — skip noise, skip known-non-brand lines
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length >= 4);

  // Words that appear on logos/seals but are never the brand name itself
  const skipPattern = /^(class|type|alcohol|abv|net|contents|bottl|produc|distill|brew|manuf|govern|warning|founded|built|pride|variety|ingredient|cheers|www\.|http|for more|contains|distributed|imported|product of|drink responsibly|brewed|crafted|made|established|1\s*pint|\d+\s*fl|\d+\s*m[l]|\d+(?:\.\d+)?\s*%|\bESTD\.?\b|\bEST\.?\s*\d{4}\b|\bSINCE\s*\d{4}\b|\bESTABLISHED\s*\d{4}\b|^\d{4}$)/i;
  const locationPattern = /\b(?:ALABAMA|ALASKA|ARIZONA|ARKANSAS|CALIFORNIA|COLORADO|CONNECTICUT|DELAWARE|FLORIDA|GEORGIA|HAWAII|IDAHO|ILLINOIS|INDIANA|IOWA|KANSAS|KENTUCKY|LOUISIANA|MAINE|MARYLAND|MASSACHUSETTS|MICHIGAN|MINNESOTA|MISSISSIPPI|MISSOURI|MONTANA|NEBRASKA|NEVADA|NEW\s*HAMPSHIRE|NEW\s*JERSEY|NEW\s*MEXICO|NEW\s*YORK|NORTH\s*CAROLINA|NORTH\s*DAKOTA|OHIO|OKLAHOMA|OREGON|PENNSYLVANIA|RHODE\s*ISLAND|SOUTH\s*CAROLINA|SOUTH\s*DAKOTA|TENNESSEE|TEXAS|UTAH|VERMONT|VIRGINIA|WASHINGTON|WEST\s*VIRGINIA|WISCONSIN|WYOMING|DISTRICT\s*OF\s*COLUMBIA)\b/i;
  const isBodyCopy = l => (l.match(/[.,]/g) || []).length >= 3 || l.length > 70;

  const isNoise = l => {
    if (/[$@^*~`©®™]/.test(l)) return true;
    if (/[^A-Za-z0-9 '&.\-,]/.test(l)) return true;
    const letters  = (l.match(/[a-zA-Z]/g) || []).length;
    const nonSpace = l.replace(/\s/g, '').length;
    if (nonSpace === 0 || letters < 3) return true;
    if (letters / nonSpace < 0.50) return true;
    if (/([A-Z])\1{2,}/.test(l)) return true;
    // Single-token ALL-CAPS words with very few vowels are logo/seal artifacts
    // e.g. "ESTHORLND", "BRWRY", "WTRMRK" — real words have vowel ratios ≥ 30%
    if (/^[A-Z]{4,}[.\-]?$/.test(l)) {
      const vowels = (l.match(/[AEIOU]/g) || []).length;
      if (vowels / l.replace(/[^A-Za-z]/g,'').length < 0.30) return true;
    }
    return false;
  };

  // Beverage type lines are not brand names (unless explicitly labeled)
  const isBevType = l => TTB_BEVERAGE_REGEX.test(l) && l.trim().split(/\s+/).length <= 4;

  const passesFilters = l =>
    !isNoise(l) && !skipPattern.test(l) && !locationPattern.test(l) &&
    !isBodyCopy(l) && !isBevType(l);

  // Priority pass: lines containing a producer-entity word are the strongest
  // brand name signal and beat any logo-stamp line appearing earlier.
  const producerWord = /\b(brewing|brewery|brewer|winery|distillery|distilling|distillers?|spirits?|cidery|meadery|cellars?|vineyards?|estates?|company|co\.|corp\.?|llc\.?|ltd\.?)\b/i;
  const priorityLine = lines.find(l => passesFilters(l) && producerWord.test(l));
  if (priorityLine) return priorityLine;

  // Standard pass: first clean line that passes all filters
  for (const line of lines) {
    if (passesFilters(line)) return line;
  }
  return null;
}

// =============================================================================
// EXTRACT BRAND FROM BOTTLER STRING
// "EXAMPLE BREWING CO., BALTIMORE, MD" → "EXAMPLE BREWING CO."
// Called as fallback when parseBrandName finds nothing (curved text on label).
// =============================================================================
function extractBrandFromBottler(bottlerStr) {
  if (!bottlerStr) return null;
  // Remove the producer phrase prefix if present
  let s = bottlerStr.replace(/^(?:brewed\s+and\s+bottled|bottled|brewed|distilled|produced|manufactured|crafted|made|imported|distributed)\s+by\s*:?\s*/i, '').trim();
  // Strip the city/state portion — everything from the last comma before a state code
  // Pattern: "NAME, CITY, ST" or "NAME CITY, ST"
  const stateRe = /,?\s*[A-Za-z\s]+,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:\s*\d{5})?$/i;
  const nameOnly = s.replace(stateRe, '').trim();
  if (nameOnly.length >= 4) return nameOnly;
  return null;
}

// =============================================================================
// CLASS / TYPE — TTB Comprehensive List (27 CFR Parts 4, 5, 7)
//
// Four-tier search strategy to handle scattered label text:
//   1. Explicit labeled field ("Type: Wheat Beer")
//   2. Line-by-line scan — full TTB regex on each clean line
//   3. Sliding-window keyword scan — handles multi-word types split across
//      lines with noise between them (e.g. "WHEAT" / junk lines / "BEER")
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
          return (k + ' ' + follower).trim();
        }
      }
    }
  }

  // 3. Line-by-line scan — full TTB regex on each line (single-word types)
  for (const line of lines) {
    if (/GOVERNMENT\s+WARNING/i.test(line)) continue;
    if (TTB_BEVERAGE_REGEX.test(line) && line.length <= 80) {
      const m = line.match(TTB_BEVERAGE_REGEX);
      if (m) return m[0].trim();
    }
  }

  // 4. Collapsed full-text scan — last resort
  const collapsed = text.replace(/\s+/g, ' ');
  const fullMatch = collapsed.match(TTB_BEVERAGE_REGEX);
  if (fullMatch) return fullMatch[0].trim();

  return null;
}

// =============================================================================
// BOTTLER / PRODUCER
// =============================================================================
function parseBottler(text) {
  const labeled = extractLabeled(text, ['bottler','producer','distiller','importer',
                                         'distributed by','imported by']);
  if (labeled) return labeled;

  const byPattern = /(?:brewed\s+and\s+bottled|bottled|brewed|distilled|produced|manufactured|crafted|made|imported|distributed)\s+by\s*:?\s*(.+)/i;
  const m = text.match(byPattern);
  if (m) {
    let val = m[1].trim();
    const afterIdx  = text.indexOf(m[0]) + m[0].length;
    const remainder = text.slice(afterIdx).trim();
    const nextLine  = remainder.split('\n')[0].trim();
    const stateRe   = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;
    if (/^[A-Za-z][\w\s]+,\s*[A-Z]{2}/i.test(nextLine) || stateRe.test(nextLine)) {
      val = val + ', ' + nextLine;
    }
    return val.trim();
  }

  return extractProducerLocation(text);
}

function extractProducerLocation(text) {
  const stateRegex = /\b(?:ALABAMA|ALASKA|ARIZONA|ARKANSAS|CALIFORNIA|COLORADO|CONNECTICUT|DELAWARE|FLORIDA|GEORGIA|HAWAII|IDAHO|ILLINOIS|INDIANA|IOWA|KANSAS|KENTUCKY|LOUISIANA|MAINE|MARYLAND|MASSACHUSETTS|MICHIGAN|MINNESOTA|MISSISSIPPI|MISSOURI|MONTANA|NEBRASKA|NEVADA|NEW\s+HAMPSHIRE|NEW\s+JERSEY|NEW\s+MEXICO|NEW\s+YORK|NORTH\s+CAROLINA|NORTH\s+DAKOTA|OHIO|OKLAHOMA|OREGON|PENNSYLVANIA|RHODE\s+ISLAND|SOUTH\s+CAROLINA|SOUTH\s+DAKOTA|TENNESSEE|TEXAS|UTAH|VERMONT|VIRGINIA|WASHINGTON|WEST\s+VIRGINIA|WISCONSIN|WYOMING|DC|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (stateRegex.test(line)) {
      const prevLine = i > 0 ? lines[i - 1] : null;
      if (prevLine && /\b(?:bottled|brewed|distilled|produced|manufactured|crafted|made|imported|distributed|by)\b/i.test(prevLine)) {
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
    const re = new RegExp(escaped + '\\s*[:\\-]\\s*(.+)', 'i');
    const m  = text.match(re);
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
  // Regex captures: digits % [Alc.[/Vol.]] [( N proof )]  — nothing after.
  const re = /(\d+(?:\.\d+)?)\s*%\s*(?:alc\.?\s*(?:\/\s*vol\.?)?)?(?:\s*\(\s*\d+\s*proof\s*\))?/i;
  const m  = text.match(re);
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
  const startRe = /GOVERNMENT\s+WARNING\s*:/i;
  const startMatch = startRe.exec(text);
  if (!startMatch) return null;

  let body = text.slice(startMatch.index)
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
  { key: 'brandName',      label: 'Brand Name',        match: 'contains'      },
  { key: 'classType',      label: 'Class / Type',       match: 'contains'      },
  { key: 'alcoholContent', label: 'Alcohol Content',    match: 'abv'           },
  { key: 'netContents',    label: 'Net Contents',       match: 'volume'        },
  { key: 'bottler',        label: 'Bottler / Producer', match: 'bottler'       },
  { key: 'govtWarning',    label: 'Government Warning', match: 'exact'         },
];

/**
 * Main comparison entry point.
 * @param {object} formF  — parsed application fields (source of truth)
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
        const r  = compareGovtWarning(labelWarning, appVal);
        status       = r.status;
        note         = r.note;
        foundOnLabel = labelWarning;
      }
    } else {
      // All other fields: check whether the application value is present in the OCR text
      const r  = checkPresence(cfg.match, appVal, labelOCR);
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
 * Check whether an application value is present in the label OCR text.
 * Returns { status, note, found }.
 */
function checkPresence(type, appVal, labelOCR) {
  const { searchText } = labelOCR;

  if (type === 'abv') {
    const appNum = extractABVNumber(appVal);
    if (appNum === null) return { status: 'NOT_FOUND', note: 'Could not parse ABV from application.', found: null };
    // Match the ABV expression itself — number + % + optional alc./vol. label only.
    // Stop before any following text (brewed by, bottler, etc.).
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
    // Comma required before state abbrev to avoid matching 'Co.' as Colorado etc.
    const stateAbbrRe = /(?:,\s*|\s+)(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:\s*\d{5})?\s*$/i;
    const fullStateRe = /\b(?:ALABAMA|ALASKA|ARIZONA|ARKANSAS|CALIFORNIA|COLORADO|CONNECTICUT|DELAWARE|FLORIDA|GEORGIA|HAWAII|IDAHO|ILLINOIS|INDIANA|IOWA|KANSAS|KENTUCKY|LOUISIANA|MAINE|MARYLAND|MASSACHUSETTS|MICHIGAN|MINNESOTA|MISSISSIPPI|MISSOURI|MONTANA|NEBRASKA|NEVADA|NEW\s+HAMPSHIRE|NEW\s+JERSEY|NEW\s+MEXICO|NEW\s+YORK|NORTH\s+CAROLINA|NORTH\s+DAKOTA|OHIO|OKLAHOMA|OREGON|PENNSYLVANIA|RHODE\s+ISLAND|SOUTH\s+CAROLINA|SOUTH\s+DAKOTA|TENNESSEE|TEXAS|UTAH|VERMONT|VIRGINIA|WASHINGTON|WEST\s+VIRGINIA|WISCONSIN|WYOMING)\b/i;
    // Require 3+ tokens to avoid 'Distillery CO' (company abbrev) matching as a location
    const hasLocation = fullStateRe.test(appVal) ||
      (stateAbbrRe.test(appVal) && appVal.trim().split(/\s+/).length >= 3);

    // Run the normal containment check first
    const normApp   = fuzzyNormalize(appVal);
    const normLabel = fuzzyNormalize(searchText);
    const directHit = normLabel.includes(normApp);
    const appTokens = normApp.split(/\s+/).filter(t => t.length >= 3);
    const labelToks = new Set(normLabel.split(/\s+/));
    const matched   = appTokens.filter(t => labelToks.has(t));
    const ratio     = appTokens.length > 0 ? matched.length / appTokens.length : 0;
    const present   = directHit || ratio >= 0.75;

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

    // For bottler/producer values the application often includes a city+state address
    // (e.g. "Example Brewing Co., Baltimore, MD") but the label may print only the
    // company name, or vice-versa. Strip the trailing address before token-matching
    // so the company name alone is enough to confirm presence.
    const addressSuffix = /,?\s*[\w\s]+,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:\s*\d{5})?$/i;
    const normAppCore = fuzzyNormalize(appVal.replace(addressSuffix, '').trim());

    if (normAppCore.length >= 3 && normLabel.includes(normAppCore)) {
      return { status: 'MATCH', note: null, found: appVal };
    }

    // Token-overlap: significant words from the application value in the label.
    // Use the address-stripped core for token matching to avoid state abbrev tokens
    // (short 2-letter tokens like "md", "ca") inflating the miss count.
    const appTokens   = normAppCore.split(/\s+/).filter(t => t.length >= 3);
    const labelTokens = new Set(normLabel.split(/\s+/));
    const matchedTokens = appTokens.filter(t => labelTokens.has(t));
    const ratio = appTokens.length > 0 ? matchedTokens.length / appTokens.length : 0;

    if (ratio >= 0.75) {
      return { status: 'MATCH', note: null, found: appVal };
    }

    if (ratio >= 0.5) {
      return {
        status: 'MISMATCH',
        note: `Partial match: found ${matchedTokens.join(', ')} but not all words from application value "${appVal}".`,
        found: matchedTokens.length ? matchedTokens.join(' ') : null,
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

  const prefixRe = /^(GOVERNMENT\s+WARNING\s*:)/i;
  const labelPrefixMatch = labelVal.match(prefixRe);
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
  const afterPrefix = labelPrefix ? labelVal.slice(labelPrefix.length) : labelVal;
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
    labelSnippet:    a.slice(Math.max(0, pos-10), pos+20).replace(/\n/g, ' '),
    requiredSnippet: b.slice(Math.max(0, pos-10), pos+20).replace(/\n/g, ' '),
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
  if ((m = lower.match(/(\d+(?:\.\d+)?)l\b/)))         return parseFloat(m[1]) * 1000;
  if ((m = lower.match(/(\d+(?:\.\d+)?)fl\.?oz\.?/)))  return parseFloat(m[1]) * 29.5735;
  if ((m = lower.match(/(\d+(?:\.\d+)?)oz\.?/)))       return parseFloat(m[1]) * 29.5735;
  // Handle "1 PINT" = 16 fl oz = 473.18 mL
  if ((m = lower.match(/(\d+(?:\.\d+)?)\s*pint/)))     return parseFloat(m[1]) * 473.176;
  if ((m = lower.match(/(\d+(?:\.\d+)?)\s*gallon/)))   return parseFloat(m[1]) * 3785.41;
  return null;
}

// =============================================================================
// Render results
// =============================================================================
function renderResults({ overall, rows }) {
  const header  = document.getElementById('resultHeader');
  const icon    = document.getElementById('resultIcon');
  const verdict = document.getElementById('resultVerdict');
  const sub     = document.getElementById('resultSub');
  const body    = document.getElementById('fieldsBody');
  const summary = document.getElementById('summaryStrip');

  const approved = overall === 'APPROVED';
  header.className    = 'result-header ' + (approved ? 'approved' : 'rejected');
  icon.textContent    = approved ? '✔' : '✖';
  verdict.textContent = approved
    ? 'APPROVED — Label Matches Application'
    : 'REJECTED — Discrepancies Found';
  sub.textContent = approved
    ? 'All checked fields match the COLA application.'
    : 'One or more fields do not match. See details below.';

  body.innerHTML = '';
  rows.forEach(r => {
    const tr        = document.createElement('tr');
    const statusTag = makeTag(r.status, r.exactRequired);
    const noteHtml  = r.note
      ? `<div class="field-note ${r.status === 'MISMATCH' ? 'mismatch' : r.status === 'NOT_FOUND' ? 'missing' : 'info'}">${escHtml(r.note)}</div>`
      : '';
    tr.innerHTML = `
      <td class="field-name">${escHtml(r.field)}</td>
      <td class="field-label-val">${escHtml(r.labelValue || '—')}</td>
      <td class="field-form-val">${escHtml(r.formValue  || '—')}</td>
      <td class="field-status">${statusTag}${noteHtml}</td>
    `;
    body.appendChild(tr);
  });

  const matched    = rows.filter(r => r.status === 'MATCH').length;
  const mismatched = rows.filter(r => r.status === 'MISMATCH').length;
  const missing    = rows.filter(r => r.status === 'NOT_FOUND').length;

  summary.innerHTML = `
    <span><strong>${rows.length}</strong> fields checked</span>
    <span style="color:var(--green)"><strong>${matched}</strong> match</span>
    ${mismatched ? `<span style="color:var(--red)"><strong>${mismatched}</strong> mismatch</span>` : ''}
    ${missing    ? `<span style="color:var(--warn)"><strong>${missing}</strong> not found</span>`  : ''}
  `;

  resultsEl.style.display = 'block';
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
  errorBox.textContent   = '⚠ ' + msg;
  errorBox.style.display = 'block';
}
