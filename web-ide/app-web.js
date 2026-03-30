// MELP Web Editörü — app-web.js
// Electron bağımlılıkları kaldırıldı; tarayıcı File API + fetch kullanır
'use strict';

// ── Worker tabanlı WASM Backend ────────────────────────────────────────────
// Derleme ve çalıştırma ana thread'i bloke etmez.
// compiler-worker.js ayrı bir thread'de çalışır.
let _worker     = null;
let _workerReady = false;

function _getWorker() {
  if (_worker) return _worker;
  _worker = new Worker('compiler-worker.js');
  _worker.onmessage = (e) => {
    if (e.data.type === 'worker-ready') { _workerReady = true; }
  };
  return _worker;
}

// Worker'ı önceden başlat
_getWorker();

// ── Backend adaptörü ───────────────────────────────────────────────────────
const backend = {
  _pendingResolve: null,

  compile(code, run) {
    return new Promise((resolve) => {
      const worker = _getWorker();
      this._pendingResolve = resolve;
      let stdout = '';
      let stderr = '';
      let compileSize = 0;

      worker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
          case 'worker-ready':
            _workerReady = true;
            break;
          case 'compile-start':
            break;
          case 'compile-error':
            resolve({ stdout: '', stderr: msg.stderr, exitCode: 1 });
            break;
          case 'compile-success':
            compileSize = msg.size;
            if (!run) {
              resolve({ stdout: `✅ Derleme başarılı (${compileSize} byte WASM)\n`, stderr: '', exitCode: 0 });
            }
            break;
          case 'run-start':
            break;
          case 'run-stdout':
            stdout += msg.stdout;
            break;
          case 'run-stderr':
            stderr += msg.stderr;
            break;
          case 'run-exit':
            resolve({ stdout, stderr, exitCode: msg.exitCode });
            break;
          case 'run-cancel':
            resolve({ stdout, stderr: stderr || '⛔ İptal edildi', exitCode: -1 });
            break;
        }
      };

      worker.postMessage({ type: 'compile', code, run });
    });
  },

  cancel() {
    if (_worker) {
      _worker.postMessage({ type: 'cancel' });
    }
  }
};

// ── Yardımcı ───────────────────────────────────────────────────────────────
function basename(p) {
  return p ? (p.split('/').pop() || p.split('\\').pop() || p) : 'untitled.mlp';
}

// ── Durum ──────────────────────────────────────────────────────────────────
// localStorage'da 'pmpl' kalmışsa 'mlp' olarak düzelt
(function migrateLegacyStorage() {
  if (localStorage.getItem('melp-syntax') === 'pmpl') {
    localStorage.setItem('melp-syntax', 'mlp');
  }
})();

const state = {
  editor:     null,
  modified:   false,
  tabs:       [],
  activeTab:  null,  lang:       localStorage.getItem('melp-lang')   || 'english',
  syntax:     localStorage.getItem('melp-syntax') || 'mlp',};

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const editorEl        = $('editor-container');
const tabsEl          = $('tabs');
const statusText      = $('status-text');
const cursorInfo      = $('cursor-info');
const outputEl        = $('output-panel');
const validationEl    = $('validation-status');

// ── Editör başlat ──────────────────────────────────────────────────────────
const DEFAULT_CONTENT =
`#lang english
#syntax mlp

-- Merhaba, MELP!
function main()
    print("Merhaba, Dünya!")
end function
`;

// ── #lang / #syntax direktif yardımcıları ─────────────────────────────────────
function parseAndStripDirectives(code) {
  const lines = code.split('\n');
  let lang = null, syntax = null;
  const kept = [];
  let scanning = true;
  for (let i = 0; i < lines.length; i++) {
    const tr = lines[i].trim();
    if (scanning) {
      if (tr === '' || tr.startsWith('--')) { kept.push(lines[i]); continue; }
      if (tr.startsWith('#lang '))   { lang   = tr.slice(6).trim();  continue; }
      if (tr.startsWith('#syntax ')) { syntax = tr.slice(8).trim();  continue; }
      scanning = false;
    }
    kept.push(lines[i]);
  }
  return { lang, syntax, clean: kept.join('\n') };
}

function buildDirectiveHeader(lang, syntax) {
  return `#lang ${lang || 'english'}\n#syntax ${syntax || 'mlp'}\n`;
}

// Editördeki direktiflerden dropdown + state.lang/syntax güncelle (setValue yok)
function syncDropdownsFromEditorContent() {
  if (!state.editor) return;
  const { lang, syntax } = parseAndStripDirectives(state.editor.getValue());
  if (lang && lang !== state.lang) {
    state.lang = lang;
    localStorage.setItem('melp-lang', lang);
    const ls = $('sel-lang'); if (ls) ls.value = lang;
  }
  if (syntax && syntax !== state.syntax) {
    state.syntax = syntax;
    localStorage.setItem('melp-syntax', syntax);
    const ss = $('sel-syntax'); if (ss) ss.value = syntax;
  }
}

// Dropdown değişince editorün en üstündeki direktifleri güncelle
function updateDirectivesInEditor() {
  if (!state.editor || state.activeTab === null) return;
  const { clean } = parseAndStripDirectives(state.editor.getValue());
  const newCode = buildDirectiveHeader(state.lang, state.syntax) + clean;
  state.editor.setValue(newCode);
  state.tabs[state.activeTab].content = newCode;
}

// ── Özel keyword haritası ─────────────────────────────────────────────────
// Display format: "canonical = alias"  (örn. print = yaz)
// Storage format: "canonical = alias" (aynı — textarea içeriği doğrudan kaydedilir)
// Normalizer format: {alias: canonical} — apply sırasında çevrilir

function _textToNormalizerMap(text) {
  // "canonical = alias" satırlarını parse edip {alias: canonical} döndürür
  const map = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const canonical = t.slice(0, eq).trim();
    const alias     = t.slice(eq + 1).trim();
    if (canonical && alias) map[alias] = canonical;
  }
  return map;
}

function buildDisplayText(lang) {
  // Tüm varsayılan eşleşmeleri "canonical = alias" formatında döndürür.
  // Kaydedilmiş özelleştirmeler varsa ilgili canonical satırını override eder.
  // English için: kanonik dil, çeviriye gerek yok.
  try {
    const defaults = MelpEditor.getDefaultKeywords ? MelpEditor.getDefaultKeywords(lang) : {};
    if (!defaults || Object.keys(defaults).length === 0) {
      return '-- Bu dil kanonik dildir (English).\n-- Keyword dönüşümü gerekmez.\n-- Farklı bir dil seçip tekrar açın.';
    }
    // defaults: {canonical → alias}  örn. {"if": "koşul"}
    const byCanonical = {};
    for (const [canonical, alias] of Object.entries(defaults)) {
      if (!byCanonical[canonical]) byCanonical[canonical] = alias;
    }
    // Kaydedilmiş özelleştirme varsa override et
    const saved = localStorage.getItem('melp-custom-map-' + lang) || '';
    for (const line of saved.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('--')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const canonical = t.slice(0, eq).trim();
      const alias     = t.slice(eq + 1).trim();
      if (canonical && alias && Object.prototype.hasOwnProperty.call(byCanonical, canonical))
        byCanonical[canonical] = alias;
    }
    return Object.entries(byCanonical).map(([c, a]) => `${c} = ${a}`).join('\n');
  } catch(e) { return ''; }
}

function applyCustomKeywords(lang) {
  const text = localStorage.getItem('melp-custom-map-' + lang) || '';
  try { MelpEditor.setCustomLanguageMap(lang, _textToNormalizerMap(text)); } catch(e) {}
}

function applyAllSavedCustomMaps() {
  ['turkish','russian','arabic','chinese'].forEach(applyCustomKeywords);
}

// ── Doğrulama (Validation Pipeline Adım 1-3) ────────────────────────────────
let _validationTimer = null;

function runValidation() {
  if (!state.editor || typeof MelpEditor.validate !== 'function') return;
  const diags = MelpEditor.validate(state.editor.getValue());
  state.editor.setDiagnostics(diags);

  if (!validationEl) return;
  const errCount  = diags.filter(d => d.severity === 'error').length;
  const warnCount = diags.filter(d => d.severity === 'warning').length;

  if (!errCount && !warnCount) {
    validationEl.textContent = '✓';
    validationEl.className   = 'val-ok';
    validationEl.title       = 'Doğrulama başarılı';
    validationEl.style.cursor = 'default';
    validationEl.onclick     = null;
    return;
  }

  const hasMissingDir = diags.some(
    d => d.message.startsWith('[E001]') || d.message.startsWith('[E002]')
  );
  const parts = [];
  if (errCount)  parts.push(`⚠ ${errCount} hata`);
  if (warnCount) parts.push(`${warnCount} uyarı`);
  if (hasMissingDir) parts.push('⚡ Direktif ekle');

  validationEl.textContent  = parts.join(' · ');
  validationEl.className    = errCount ? 'val-error' : 'val-warn';
  if (hasMissingDir) validationEl.className += ' val-fix';
  validationEl.style.cursor = hasMissingDir ? 'pointer' : 'default';

  const tipLines = diags.slice(0, 4).map(d => d.message);
  if (diags.length > 4) tipLines.push(`... +${diags.length - 4} daha`);
  validationEl.title   = tipLines.join('\n');
  validationEl.onclick = hasMissingDir
    ? () => { updateDirectivesInEditor(); scheduleValidation(); }
    : null;
}

function scheduleValidation() {
  clearTimeout(_validationTimer);
  _validationTimer = setTimeout(runValidation, 400);
}

function initEditor() {
  state.editor = MelpEditor.createEditor(editorEl, DEFAULT_CONTENT);

  window.onEditorChange = () => {
    markModified();
    updateCursorInfo();
    scheduleValidation();
  };

  _createUntitledTab(DEFAULT_CONTENT);
}

let untitledCounter = 1;

function _createUntitledTab(content = '') {
  const label = `untitled-${untitledCounter++}.mlp`;
  state.tabs.push({ path: null, label, content, modified: false });
  state.activeTab = state.tabs.length - 1;
  renderTabs();
  setStatus(label);
}

// ── Tab yönetimi ────────────────────────────────────────────────────────────
function openTab(filePath, content) {
  if (filePath) {
    const existing = state.tabs.findIndex(t => t.path === filePath);
    if (existing >= 0) { activateTab(existing); return; }
  }
  const label = filePath ? basename(filePath) : `untitled-${untitledCounter++}.mlp`;
  state.tabs.push({ path: filePath, label, content, modified: false });
  activateTab(state.tabs.length - 1);
  renderTabs();
}

function activateTab(idx) {
  if (state.activeTab !== null && state.editor) {
    state.tabs[state.activeTab].content = state.editor.getValue();
  }
  state.activeTab = idx;
  const tab = state.tabs[idx];
  state.editor.setValue(tab.content);
  syncDropdownsFromEditorContent();
  state.editor.focus();
  renderTabs();
  setStatus(tab.label);
  scheduleValidation();
}

function closeTab(idx) {
  // splice'dan önce mevcut içeriği kaydet
  if (state.activeTab !== null && state.editor) {
    state.tabs[state.activeTab].content = state.editor.getValue();
  }
  state.tabs.splice(idx, 1);
  if (state.tabs.length === 0) {
    state.activeTab = null;
    state.editor.setValue('');
    renderTabs();
  } else {
    // activeTab index'ini ayarla: kapatılan sekme öncesindeyse kaydır
    let newActive = state.activeTab;
    if (idx < state.activeTab) {
      newActive = state.activeTab - 1;
    } else if (idx === state.activeTab) {
      newActive = Math.min(idx, state.tabs.length - 1);
    }
    state.activeTab = null; // activateTab içinde çift kayıt olmasın
    activateTab(newActive);
  }
}

function markModified() {
  if (state.activeTab === null) return;
  state.tabs[state.activeTab].modified = true;
  renderTabs();
}

function renderTabs() {
  tabsEl.innerHTML = '';
  state.tabs.forEach((tab, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === state.activeTab ? ' active' : '') + (tab.modified ? ' modified' : '');
    el.innerHTML = `<span class="tab-label">${escHtml(tab.label)}</span>`
                 + `<span class="tab-close" data-i="${i}">×</span>`;
    el.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.tab-close');
      if (closeBtn) {
        e.stopPropagation();
        closeTab(parseInt(closeBtn.dataset.i, 10));
      } else {
        activateTab(i);
      }
    });
    tabsEl.appendChild(el);
  });
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Dosya işlemleri (File API) ─────────────────────────────────────────────
function newFile() {
  openTab(null, buildDirectiveHeader(state.lang, state.syntax));
  setStatus('Yeni dosya');
}

function openFileFromDisk() {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.mlp,.mlpgui,.ll,.txt';
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      openTab(file.name, ev.target.result);
      setStatus('📄 ' + file.name);
    };
    reader.readAsText(file, 'utf-8');
  });
  input.click();
}

// Blob indirme — Ctrl+S
function saveFile() {
  const content = state.editor.getValue();
  const label   = state.tabs[state.activeTab]?.label ?? 'untitled.mlp';
  const blob    = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href = url; a.download = label;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  if (state.activeTab !== null) {
    state.tabs[state.activeTab].modified = false;
    state.tabs[state.activeTab].content  = content;
  }
  renderTabs();
  setStatus('✅ İndirildi: ' + label);
}

// ── Örnekler paneli ───────────────────────────────────────────────────────
// Her örnekte `labels` (dil → görünen ad) ve `codes` (dil/sözdizimi → kod) bulunur.
// Eşleşme önceliği: lang → syntax → 'default'
const EXAMPLES = [
  {
    labels: {
      english: 'Fibonacci', turkish: 'Fibonacci',
      russian: 'Фибоначчи', arabic: 'فيبوناتشي', chinese: '斐波那契',
    },
    codes: {
      default: `numeric function fibonacci(numeric n)\n    if n <= 1 then\n        return n\n    end if\n    return fibonacci(n - 1) + fibonacci(n - 2)\nend function\n\nfunction main()\n    loop i = 0 to 9\n        print(fibonacci(i))\n    end loop\nend function\n`,
      turkish: `sayısal fonksiyon fibonacci(sayısal n)\n    koşul n <= 1 ise\n        döndür n\n    koşul sonu\n    döndür fibonacci(n - 1) + fibonacci(n - 2)\nfonksiyon sonu\n\nfonksiyon giriş()\n    döngü i = 0 kadar 9\n        yaz(fibonacci(i))\n    döngü sonu\nfonksiyon sonu\n`,
    },
  },
  {
    labels: {
      english: 'Hello World', turkish: 'Merhaba Dünya',
      russian: 'Привет мир', arabic: 'مرحبا بالعالم', chinese: '你好世界',
    },
    codes: {
      default:      `function main()\n    print("Hello, World!")\nend function\n`,
      turkish:      `fonksiyon giriş()\n    yaz("Merhaba, Dünya!")\nfonksiyon sonu\n`,
      vbnet:        `Sub Main()\n    Print("Hello, World!")\nEnd Sub\n`,
      python_style: `def main():\n    print("Hello, World!")\n`,
    },
  },
  {
    labels: {
      english: 'Loops', turkish: 'Döngüler',
      russian: 'Циклы', arabic: 'حلقات', chinese: '循环',
    },
    codes: {
      default: `function main()\n    -- loop with condition\n    numeric i = 0\n    loop i < 5\n        print(i)\n        i = i + 1\n    end loop\n\n    -- range loop\n    loop j = 1 to 5\n        print(j * j)\n    end loop\nend function\n`,
      turkish: `fonksiyon giriş()\n    -- koşullu döngü\n    sayısal i = 0\n    döngü i < 5\n        yaz(i)\n        i = i + 1\n    döngü sonu\n\n    -- aralık döngüsü\n    döngü j = 1 kadar 5\n        yaz(j * j)\n    döngü sonu\nfonksiyon sonu\n`,
    },
  },
  {
    labels: {
      english: 'Struct', turkish: 'Yapı',
      russian: 'Структура', arabic: 'هيكل', chinese: '结构体',
    },
    codes: {
      default: `struct Point\n    numeric x\n    numeric y\nend struct\n\nnumeric function Point.sum()\n    return this.x + this.y\nend function\n\nfunction main()\n    Point p\n    p.x = 3\n    p.y = 4\n    print(p.sum())\nend function\n`,
      turkish: `yapı Nokta\n    sayısal x\n    sayısal y\nyapı sonu\n\nsayısal fonksiyon Nokta.toplam()\n    döndür bu.x + bu.y\nfonksiyon sonu\n\nfonksiyon giriş()\n    Nokta p\n    p.x = 3\n    p.y = 4\n    yaz(p.toplam())\nfonksiyon sonu\n`,
    },
  },
  {
    labels: {
      english: 'Enum + Match', turkish: 'Sıralama + Eşleştir',
      russian: 'Перечисление + Совпадение', arabic: 'تعداد + مطابقة', chinese: '枚举 + 匹配',
    },
    codes: {
      default: `enum Color\n    RED\n    GREEN\n    BLUE\nend enum\n\nfunction main()\n    numeric c = Color.GREEN\n    match c\n        case Color.RED   then print("red")\n        case Color.GREEN then print("green")\n        case Color.BLUE  then print("blue")\n    end match\nend function\n`,
      turkish: `sıralama Renk\n    KIRMIZI\n    YEŞİL\n    MAVİ\nsıralama sonu\n\nfonksiyon giriş()\n    sayısal r = Renk.YEŞİL\n    seç r\n        durum Renk.KIRMIZI ise yaz("kırmızı")\n        durum Renk.YEŞİL   ise yaz("yeşil")\n        durum Renk.MAVİ    ise yaz("mavi")\n    seç sonu\nfonksiyon sonu\n`,
    },
  },
  {
    labels: {
      english: 'Try / Error', turkish: 'Dene / Hata',
      russian: 'Попытка / Ошибка', arabic: 'حاول / خطأ', chinese: '尝试 / 错误',
    },
    codes: {
      default: `numeric function divide(numeric a; numeric b)\n    if b == 0 then\n        throw "division by zero"\n    end if\n    return a / b\nend function\n\nfunction main()\n    try\n        numeric r = divide(10; 0)\n        print(r)\n    catch e\n        print("error: " + e)\n    end try\nend function\n`,
      turkish: `sayısal fonksiyon böl(sayısal a; sayısal b)\n    koşul b == 0 ise\n        fırlat "sıfıra bölme"\n    koşul sonu\n    döndür a / b\nfonksiyon sonu\n\nfonksiyon giriş()\n    dene\n        sayısal r = böl(10; 0)\n        yaz(r)\n    yakala e\n        yaz("hata: " + e)\n    dene sonu\nfonksiyon sonu\n`,
    },
  },
];

const LANG_DISPLAY = { english:'English', turkish:'Türkçe', russian:'Русский', arabic:'العربية', chinese:'中文' };
const SYN_DISPLAY  = { mlp:'MLP', pmpl:'MLP', vbnet:'VB.NET', python_style:'Python' };

function getExampleLabel(ex) {
  return ex.labels[state.lang] || ex.labels.english;
}

function getExampleCode(ex) {
  // Dile özgü kod varsa doğrudan kullan
  if (ex.codes[state.lang]) return ex.codes[state.lang];
  // Sözdizimi özgü kod varsa kullan (vbnet, python_style)
  if (ex.codes[state.syntax]) return ex.codes[state.syntax];
  // İngilizce kodunu hedef dile ters çevir
  const base = ex.codes.default;
  if (state.lang !== 'english') {
    try { return MelpEditor.denormalize(base, state.lang); } catch(e) {}
  }
  return base;
}

function loadExamplesPanel() {
  const container = $('examples-list');
  if (!container) return;
  container.innerHTML = '';

  // Başlık: mevcut dil + sözdizimi
  const header = document.createElement('div');
  header.id = 'examples-lang-header';
  const langName = LANG_DISPLAY[state.lang]   || state.lang;
  const synName  = SYN_DISPLAY[state.syntax]  || state.syntax.toUpperCase();
  header.textContent = langName + ' · ' + synName;
  container.appendChild(header);

  EXAMPLES.forEach(ex => {
    const el = document.createElement('div');
    el.className = 'tree-file';
    const label = getExampleLabel(ex);
    el.title = label + '.mlp';
    el.textContent = label;

    el.addEventListener('click', () => {
      const code    = getExampleCode(ex);
      const hdr     = buildDirectiveHeader(state.lang, state.syntax);
      const tabPath = label + '.mlp';
      const fullCode = hdr + code;
      const existingIdx = state.tabs.findIndex(t => t.path === tabPath);
      if (existingIdx >= 0) {
        // Hedef sekme zaten aktifse activateTab önce editörden eski içeriği geri
        // yazar — doğrudan editöre set et, sonra sekmeler senkronize kalsın diye
        // tab içeriğini de güncelle.
        if (existingIdx === state.activeTab) {
          state.tabs[existingIdx].content = fullCode;
          state.editor.setValue(fullCode);
        } else {
          state.tabs[existingIdx].content = fullCode;
          activateTab(existingIdx);
        }
      } else {
        openTab(tabPath, fullCode);
      }
    });
    container.appendChild(el);
  });
}

// ── Derleme & çalıştırma ──────────────────────────────────────────────
async function compile(andRun = false) {
  const raw = state.editor.getValue();
  // Dosya başındaki #lang / #syntax direktiflerini oku ve soy (WASM bunları anlamaz)
  const { lang: fileLang, syntax: fileSyntax, clean } = parseAndStripDirectives(raw);
  const effectiveLang   = fileLang   || state.lang;
  const effectiveSyntax = fileSyntax || state.syntax;

  let code = clean;
  let normInfo = '';
  // Normalleştirme: Türkçe/VBNet vb. → MELP standart sözdizimi
  if (effectiveLang !== 'english' || (effectiveSyntax !== 'mlp' && effectiveSyntax !== 'pmpl')) {
    try {
      code = MelpEditor.normalize(code, effectiveLang, effectiveSyntax);
      normInfo = `🔄 Normalleştirme: dil=${effectiveLang} | sözdizimi=${effectiveSyntax}\n`;
    } catch (e) {
      // Normalizer bulunamazsa devam et
    }
  }

  // Stage 0 WASM derleyici `end_X` (alt çizgili) formunu bekler.
  // Editörde ve örneklerde kullanılan boşluklu form (`end if`, `end function` vb.)
  // buraya gelene kadar alt çizgiye dönüştürülür.
  code = code
    .replace(/\bend\s+if\b/g,        'end_if')
    .replace(/\bend\s+function\b/g,  'end_function')
    .replace(/\bend\s+loop\b/g,      'end_loop')
    .replace(/\bend\s+for\b/g,       'end_for')
    .replace(/\bend\s+struct\b/g,    'end_struct')
    .replace(/\bend\s+enum\b/g,      'end_enum')
    .replace(/\bend\s+match\b/g,     'end_match')
    .replace(/\bend\s+try\b/g,       'end_try')
    .replace(/\bend\s+module\b/g,    'end_module')
    .replace(/\bend\s+lambda\b/g,    'end_lambda')
    .replace(/\bend\s+event\b/g,     'end_event')
    .replace(/\bend\s+while\b/g,     'end_while')
    .replace(/\belse\s+if\b/g,       'else_if');

  showOutput('⏳ ' + (andRun ? 'Derleniyor ve çalıştırılıyor...' : 'Derleniyor...') + '\n');
  if (normInfo) appendOutput(normInfo);
  setStatus('⏳ Çalışıyor...');

  let json;
  try {
    json = await backend.compile(code, andRun);
  } catch (err) {
    appendOutput('❌ Derleme hatası: ' + err.message + '\n');
    setStatus('❌ Hata');
    return;
  }

  if (json.stderr) appendOutput(json.stderr + '\n');
  if (json.stdout) appendOutput(json.stdout);
  if (!json.stderr && !json.stdout) appendOutput('(çıktı yok)\n');

  const ok = json.exitCode === 0;
  setStatus(ok ? '✅ Başarılı' : '❌ Derleme hatası');
}

// ── Çıktı paneli ───────────────────────────────────────────────────────────
function showOutput(text) {
  outputEl.classList.remove('hidden');
  $('output-content').textContent = text;
}

function appendOutput(text) {
  outputEl.classList.remove('hidden');
  $('output-content').textContent += text;
}

// ── Status bar ─────────────────────────────────────────────────────────────
function setStatus(msg) {
  statusText.textContent = msg;
}

function updateCursorInfo() {
  if (!state.editor) return;
  const pos  = state.editor.view.state.selection.main.head;
  const line = state.editor.view.state.doc.lineAt(pos);
  cursorInfo.textContent = `Sat ${line.number}, Sut ${pos - line.from + 1}`;
}

// ── Renk paleti ──────────────────────────────────────────────────────────
const PALETTE_CLASSES = ['light', 'dracula', 'monokai', 'nord', 'solarized', 'pink', 'blue-kids', 'purple', 'magenta', 'fuchsia', 'cyan'];
function applyPalette(theme) {
  document.body.classList.remove(...PALETTE_CLASSES);
  if (theme) document.body.classList.add(theme);
  localStorage.setItem('melp-theme', theme);
  document.querySelectorAll('.palette-item').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === theme);
  });
  if (state.editor) MelpEditor.setEditorTheme(state.editor.view, theme);
}

const FONT_SIZE_MAP = { 'S': '12px', 'M': '14px', 'L': '17px', 'XL': '21px' };
function applyFontSize(sizeKey) {
  localStorage.setItem('melp-font-size', sizeKey);
  document.querySelectorAll('.font-size-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.size === sizeKey);
  });
  if (state.editor) MelpEditor.setEditorFontSize(state.editor.view, FONT_SIZE_MAP[sizeKey] || '14px');
}

// ── Başlangıç ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initEditor();
  loadExamplesPanel();
  setStatus('MELP IDE — Hazır');
  updateCursorInfo();
  scheduleValidation();

  // Dosya çift tıklamayla açıldıysa: ?open=dosya.mlp
  const urlParams = new URLSearchParams(window.location.search);
  const openName  = urlParams.get('open');
  if (openName) {
    fetch('tmp_open.mlp?t=' + Date.now())
      .then(r => r.ok ? r.text() : Promise.reject(r.status))
      .then(content => {
        // Başlangıçta açılan boş untitled sekmeyi kapat
        if (state.tabs.length === 1 && !state.tabs[0].modified &&
            state.tabs[0].content.trim() === DEFAULT_CONTENT.trim()) {
          state.tabs = [];
          state.activeTab = null;
        }
        openTab(openName, content);
        history.replaceState(null, '', '/');
      })
      .catch(() => setStatus('Dosya açılamadı: ' + openName));
  }

  // Buton bağlamaları
  $('btn-new').addEventListener('click', newFile);
  $('btn-open').addEventListener('click', openFileFromDisk);
  $('btn-save').addEventListener('click', saveFile);
  $('btn-compile').addEventListener('click', () => compile(false));
  $('btn-run').addEventListener('click', () => compile(true));
  $('btn-close-output').addEventListener('click', () => $('output-panel').classList.add('hidden'));

  // Klavye kısayolları
  document.addEventListener('keydown', async (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 's')  { e.preventDefault(); saveFile(); }
    if (ctrl && e.key === 'n')  { e.preventDefault(); newFile(); }
    if (ctrl && e.key === 'o')  { e.preventDefault(); openFileFromDisk(); }
    if (e.key  === 'F5')        { e.preventDefault(); await compile(true); }
    if (ctrl && e.key === 'b')  { e.preventDefault(); await compile(false); }
    if (e.key  === 'Escape')    { $('output-panel').classList.add('hidden'); }
  });

  // Görünüm popup
  $('appearance-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('appearance-popup').classList.toggle('open');
  });
  document.addEventListener('click', () => $('appearance-popup').classList.remove('open'));
  document.querySelectorAll('.palette-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      applyPalette(el.dataset.theme);
    });
  });
  document.querySelectorAll('.font-size-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      applyFontSize(el.dataset.size);
    });
  });
  applyPalette(localStorage.getItem('melp-theme') || '');
  applyFontSize(localStorage.getItem('melp-font-size') || 'M');

  // Dil & Sözdizimi seçicileri
  const langSel   = $('sel-lang');
  const syntaxSel = $('sel-syntax');

  try {
    // Seçenekleri normalize modülünden doldur
    MelpEditor.getLanguageOptions().forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.id; opt.textContent = o.name;
      langSel.appendChild(opt);
    });
    MelpEditor.getSyntaxOptions().forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.id; opt.textContent = o.name;
      syntaxSel.appendChild(opt);
    });
  } catch(e) { /* normalizer yüklenmezse statik listeler kalacak */ }

  langSel.value   = state.lang;
  syntaxSel.value = state.syntax;

  langSel.addEventListener('change', () => {
    state.lang = langSel.value;
    localStorage.setItem('melp-lang', state.lang);
    updateDirectivesInEditor();
    loadExamplesPanel();
  });
  syntaxSel.addEventListener('change', () => {
    state.syntax = syntaxSel.value;
    localStorage.setItem('melp-syntax', state.syntax);
    updateDirectivesInEditor();
    loadExamplesPanel();
  });

  // Başlangıçta kaydedilmiş özel haritaları uygula
  applyAllSavedCustomMaps();

  // ── Dil Düzenle modali ───────────────────────────────────────────────
  const langEditBtn    = $('btn-lang-edit');
  const modalOverlay   = $('lang-modal-overlay');
  const modalClose     = $('btn-lang-modal-close');
  const modalSave      = $('btn-lang-modal-save');
  const modalCancel    = $('btn-lang-modal-cancel');
  const modalTitle     = $('lang-modal-title');
  const customTextarea = $('custom-map-textarea');

  function openLangModal() {
    const lang = state.lang;
    modalTitle.textContent = 'Dili Özelleştir — ' + (langSel.options[langSel.selectedIndex]?.text || lang);
    customTextarea.value = buildDisplayText(lang);
    // English için: textarea salt okunur, Kaydet gizli
    const isCanonical = (lang === 'english');
    customTextarea.readOnly = isCanonical;
    customTextarea.style.opacity = isCanonical ? '0.55' : '1';
    if (modalSave) modalSave.style.display = isCanonical ? 'none' : '';
    modalOverlay.classList.remove('hidden');
    customTextarea.focus();
  }

  function closeLangModal() { modalOverlay.classList.add('hidden'); }

  if (langEditBtn) langEditBtn.addEventListener('click', openLangModal);
  if (modalClose)  modalClose.addEventListener('click',  closeLangModal);
  if (modalCancel) modalCancel.addEventListener('click', closeLangModal);
  modalOverlay?.addEventListener('click', (e) => { if (e.target === modalOverlay) closeLangModal(); });

  if (modalSave) {
    modalSave.addEventListener('click', () => {
      const lang = state.lang;
      const text = customTextarea.value.trim();
      // Bilinmeyen canonical → o satırı atla, orijinal korunur
      const knownCanonicals = new Set();
      try {
        const defs = MelpEditor.getDefaultKeywords ? MelpEditor.getDefaultKeywords(lang) : {};
        Object.values(defs).forEach(v => knownCanonicals.add(v));
      } catch(e) {}
      // Geçerli satırları filtrele (her iki taraf dolu + canonical tanımlı)
      const validLines = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('--')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        const canonical = t.slice(0, eq).trim();
        const alias     = t.slice(eq + 1).trim();
        if (!canonical || !alias) continue;                          // print = (boş) → atla
        if (knownCanonicals.size && !knownCanonicals.has(canonical)) continue; // prin = yaz → atla
        validLines.push(`${canonical} = ${alias}`);
      }
      if (validLines.length) {
        localStorage.setItem('melp-custom-map-' + lang, validLines.join('\n'));
      } else {
        localStorage.removeItem('melp-custom-map-' + lang);
      }
      applyCustomKeywords(lang);
      closeLangModal();
      setStatus('✅ Keyword haritası kaydedildi: ' + lang);
    });
  }
});
