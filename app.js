(() => {
  'use strict';

  const CONFIG = {
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    minTextChars: 40,          // abaixo disso, a página é tratada como escaneada e vai para OCR
    imageTokensPerPage: 1600,  // estimativa de tokens de uma página enviada como imagem
    charsPerToken: 3.5,        // estimativa para texto em português
    maxImageSide: 3500,        // fotos maiores são reduzidas antes do OCR
    ocrTargetWidth: 2200,      // largura em pixels ao renderizar página de PDF para OCR
    lowConfidence: 60,         // abaixo disso, a página é marcada para conferência
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const els = {
    drop: $('#drop'),
    file: $('#file'),
    lang: $('#lang'),
    pages: $('#pages'),
    force: $('#forceOcr'),
    alert: $('#alert'),
    queue: $('#queueSection'),
    list: $('#list'),
    totals: $('#totals'),
    stop: $('#stop'),
    joinAll: $('#joinAll'),
    zipAll: $('#zipAll'),
    clear: $('#clear'),
    tpl: $('#itemTpl'),
  };

  if (typeof pdfjsLib === 'undefined' || typeof Tesseract === 'undefined') {
    showAlert('As bibliotecas de leitura não carregaram. Verifique a conexão com a internet e recarregue a página.');
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = CONFIG.pdfWorker;

  class StopSignal extends Error {}

  const items = [];
  let nextId = 1;
  let running = false;
  let stopRequested = false;
  let worker = null;
  let workerLang = null;
  let onOcrLog = null;

  /* ---------- utilidades ---------- */

  const fmt = (n) => Math.round(n).toLocaleString('pt-BR');
  const textTokens = (t) => Math.ceil(t.length / CONFIG.charsPerToken);
  const baseName = (n) => n.replace(/\.[^.]+$/, '');
  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const isImage = (f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
  const plural = (n, one, many) => (n === 1 ? one : many);

  function sizeLabel(bytes) {
    if (bytes >= 1048576) {
      return `${(bytes / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function userError(message) {
    const err = new Error(message);
    err.userMessage = message;
    return err;
  }

  const RANGE_PART = /^(\d+)(?:-(\d*))?$/;

  function rangeIsValid(str) {
    return str.split(/[,;\s]+/).filter(Boolean).every((p) => RANGE_PART.test(p));
  }

  function parseRange(str, max) {
    if (!str.trim()) return null;
    const set = new Set();
    for (const part of str.split(/[,;\s]+/).filter(Boolean)) {
      const m = part.match(RANGE_PART);
      if (!m) throw userError(`Intervalo de páginas inválido: "${part}". Use algo como 1-5, 9.`);
      let a = Number(m[1]);
      let b = m[2] === undefined ? a : m[2] === '' ? max : Number(m[2]);
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(1, a); i <= Math.min(max, b); i++) set.add(i);
    }
    return [...set].sort((x, y) => x - y);
  }

  function cleanText(t) {
    return t
      .replace(/\r/g, '')
      .replace(/[ \t\u00A0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2') // junta palavras hifenizadas na quebra de linha
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function textFromContent(content) {
    let out = '';
    for (const it of content.items) {
      if (typeof it.str !== 'string') continue;
      out += it.str;
      if (it.hasEOL) out += '\n';
    }
    return out;
  }

  /* ---------- OCR ---------- */

  async function getWorker(lang) {
    if (worker && workerLang === lang) return worker;
    if (worker) {
      await worker.terminate();
      worker = null;
    }
    worker = await Tesseract.createWorker(lang, 1, {
      logger: (m) => { if (onOcrLog) onOcrLog(m); },
    });
    workerLang = lang;
    return worker;
  }

  async function ocr(source, onLog) {
    onOcrLog = onLog;
    try {
      const w = await getWorker(els.lang.value);
      const { data } = await w.recognize(source);
      return { text: cleanText(data.text || ''), conf: Math.round(data.confidence || 0) };
    } finally {
      onOcrLog = null;
    }
  }

  function ocrLogger(item, base, step, label) {
    return (m) => {
      const status = m.status || '';
      if (status === 'recognizing text') {
        setProgress(item, base + step * (m.progress || 0), `${label}: lendo a imagem (OCR)`);
      } else if (/load|initializ/i.test(status)) {
        setProgress(item, base, 'Preparando o OCR. O modelo de idioma é baixado só na primeira vez.');
      }
    };
  }

  /* ---------- conversão ---------- */

  async function renderPage(page) {
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.max(1.5, Math.min(3, CONFIG.ocrTargetWidth / v1.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  async function convertPdf(item) {
    setProgress(item, 0.01, 'Abrindo o PDF');
    const data = await item.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    try {
      const total = pdf.numPages;
      const wanted = parseRange(els.pages.value, total) || Array.from({ length: total }, (_, i) => i + 1);
      if (!wanted.length) throw userError(`Nenhuma das páginas pedidas existe neste PDF, que tem ${total} ${plural(total, 'página', 'páginas')}.`);

      const parts = [];
      const low = [];
      let ocrCount = 0;
      const step = 1 / wanted.length;

      for (let idx = 0; idx < wanted.length; idx++) {
        if (stopRequested) throw new StopSignal();
        const n = wanted[idx];
        const base = idx * step;
        const label = `Página ${n} de ${total}`;
        setProgress(item, base, label);

        const page = await pdf.getPage(n);
        let text = cleanText(textFromContent(await page.getTextContent()));
        let mode = 'texto';
        let conf = null;

        if (els.force.checked || text.replace(/\s/g, '').length < CONFIG.minTextChars) {
          const canvas = await renderPage(page);
          const r = await ocr(canvas, ocrLogger(item, base, step, label));
          canvas.width = 0;
          canvas.height = 0;
          text = r.text;
          mode = 'OCR';
          conf = r.conf;
          ocrCount++;
          if (conf < CONFIG.lowConfidence) low.push(n);
        }

        page.cleanup();
        parts.push({ n, mode, conf, text });
      }

      return { parts, totalPages: total, ocrCount, low, before: wanted.length * CONFIG.imageTokensPerPage };
    } finally {
      pdf.destroy();
    }
  }

  async function loadBitmap(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        throw userError('Não foi possível abrir esta imagem. Tente salvá-la de novo como JPG ou PNG.');
      }
    }
  }

  async function convertImage(item) {
    if (stopRequested) throw new StopSignal();
    setProgress(item, 0.02, 'Abrindo a imagem');
    const bmp = await loadBitmap(item.file);
    const before = Math.min(CONFIG.imageTokensPerPage, Math.ceil((bmp.width * bmp.height) / 750));
    const scale = Math.min(1, CONFIG.maxImageSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();

    const r = await ocr(canvas, ocrLogger(item, 0, 1, 'Imagem'));
    canvas.width = 0;
    canvas.height = 0;
    return {
      parts: [{ n: 1, mode: 'OCR', conf: r.conf, text: r.text }],
      totalPages: 1,
      ocrCount: 1,
      low: r.conf < CONFIG.lowConfidence ? [1] : [],
      before,
    };
  }

  function buildOutput(name, res, pdf) {
    const lines = [`Arquivo: ${name}`];
    if (pdf) {
      let pagesLine = `Páginas convertidas: ${res.parts.length} de ${res.totalPages}`;
      if (res.ocrCount) pagesLine += ` (${res.ocrCount} por OCR)`;
      lines.push(pagesLine);
    }
    if (res.low.length) {
      lines.push(pdf
        ? `Conferir (OCR com baixa confiança): ${plural(res.low.length, 'página', 'páginas')} ${res.low.join(', ')}`
        : 'Conferir: OCR com baixa confiança');
    }
    lines.push('');
    for (const p of res.parts) {
      let mark = pdf ? `--- Página ${p.n}` : '--- Imagem';
      if (p.mode === 'OCR') mark += ` (OCR, confiança ${p.conf}%)`;
      lines.push(`${mark} ---`, p.text || '[nenhum texto reconhecido]', '');
    }
    return `${lines.join('\n').trim()}\n`;
  }

  function errorMessage(err) {
    if (err && err.userMessage) return err.userMessage;
    const name = err && err.name;
    if (name === 'PasswordException') return 'Este PDF é protegido por senha. Remova a proteção e tente de novo.';
    if (name === 'InvalidPDFException') return 'O arquivo não parece ser um PDF válido ou está corrompido.';
    return 'Não foi possível converter este arquivo. Se for muito grande, tente converter um intervalo de páginas por vez.';
  }

  async function processItem(item) {
    setStatus(item, 'working', 'Convertendo');
    item.el.classList.remove('is-done');
    try {
      const res = item.kind === 'pdf' ? await convertPdf(item) : await convertImage(item);
      item.output = buildOutput(item.file.name, res, item.kind === 'pdf');
      item.before = res.before;
      item.after = textTokens(item.output);
      $('.preview', item.el).value = item.output;
      setStatus(item, 'done', 'Pronto');
      item.el.classList.add('is-done');
      describeDone(item, res);
      $('.item-actions', item.el).hidden = false;
    } catch (err) {
      if (err instanceof StopSignal) {
        setStatus(item, 'stopped', 'Interrompido');
        setProgress(item, 0, 'Conversão interrompida. Solte o arquivo de novo para recomeçar.');
      } else {
        console.error(err);
        setStatus(item, 'error', 'Erro');
        setProgress(item, 0, errorMessage(err));
      }
    }
    updateTotals();
  }

  async function run() {
    if (running) return;
    running = true;
    stopRequested = false;
    refreshControls();
    try {
      let item;
      while (!stopRequested && (item = items.find((i) => i.status === 'queued'))) {
        await processItem(item);
      }
    } finally {
      running = false;
      stopRequested = false;
      refreshControls();
    }
  }

  /* ---------- interface ---------- */

  function showAlert(message) {
    els.alert.textContent = message;
    els.alert.hidden = false;
  }

  function hideAlert() {
    els.alert.hidden = true;
  }

  function setStatus(item, status, label) {
    item.status = status;
    const badge = $('.badge', item.el);
    badge.className = `badge ${status}`;
    badge.textContent = label;
  }

  function setProgress(item, frac, text) {
    $('.bar span', item.el).style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    if (text) $('.detail', item.el).textContent = text;
  }

  function describeDone(item, res) {
    let summary;
    if (item.kind === 'pdf') {
      const n = res.parts.length;
      summary = `${n} ${plural(n, 'página', 'páginas')}`;
      if (n < res.totalPages) summary += ` de ${res.totalPages}`;
      summary += res.ocrCount
        ? (res.ocrCount === n ? ', todas lidas por OCR' : `, ${res.ocrCount} lidas por OCR`)
        : ', com texto já embutido no PDF';
    } else {
      summary = 'Imagem lida por OCR';
    }
    setProgress(item, 1, `${summary}. Estimativa: ≈ ${fmt(item.before)} tokens como imagem, ≈ ${fmt(item.after)} como texto.`);

    const warn = $('.warnline', item.el);
    if (res.low.length) {
      warn.textContent = item.kind === 'pdf'
        ? `Confira ${plural(res.low.length, 'a página', 'as páginas')} ${res.low.join(', ')}: o OCR teve baixa confiança.`
        : 'Confira o texto: o OCR teve baixa confiança nesta imagem.';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  function updateTotals() {
    const done = items.filter((i) => i.status === 'done');
    if (!done.length) {
      els.totals.textContent = '';
      return;
    }
    const before = done.reduce((s, i) => s + i.before, 0);
    const after = done.reduce((s, i) => s + i.after, 0);
    const pct = before > 0 ? Math.max(0, Math.round((1 - after / before) * 100)) : 0;
    els.totals.textContent = `Economia estimada: de ≈ ${fmt(before)} para ≈ ${fmt(after)} tokens (${pct}% a menos).`;
  }

  function refreshControls() {
    const anyDone = items.some((i) => i.status === 'done');
    els.stop.hidden = !running;
    els.stop.disabled = false;
    els.stop.textContent = 'Parar';
    els.joinAll.disabled = !anyDone;
    els.zipAll.disabled = !anyDone;
    els.clear.disabled = running;
  }

  function bindItem(item) {
    const preview = $('.preview', item.el);

    item.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;

      if (act === 'download') {
        downloadText(`${baseName(item.file.name)}.txt`, item.output);
      } else if (act === 'copy') {
        navigator.clipboard.writeText(item.output).then(() => {
          btn.textContent = 'Copiado';
          setTimeout(() => { btn.textContent = 'Copiar texto'; }, 1600);
        }).catch(() => {
          showAlert('Não foi possível copiar automaticamente. Abra "Ver e editar", selecione o texto e copie.');
        });
      } else if (act === 'toggle') {
        const open = preview.hidden;
        preview.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        btn.textContent = open ? 'Fechar texto' : 'Ver e editar';
      }
    });

    preview.addEventListener('input', () => {
      item.output = preview.value;
      item.after = textTokens(item.output);
      updateTotals();
    });
  }

  function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    hideAlert();

    if (!rangeIsValid(els.pages.value)) {
      showAlert('O campo "Páginas do PDF" está num formato que não reconheço. Use algo como 1-5, 9, ou deixe em branco para todas.');
      els.pages.focus();
      return;
    }

    const skipped = [];
    for (const file of files) {
      if (!isPdf(file) && !isImage(file)) {
        skipped.push(file.name);
        continue;
      }
      const el = els.tpl.content.firstElementChild.cloneNode(true);
      const item = {
        id: nextId++,
        file,
        el,
        kind: isPdf(file) ? 'pdf' : 'image',
        status: 'queued',
        output: '',
        before: 0,
        after: 0,
      };
      $('.name', el).textContent = file.name;
      $('.meta', el).textContent = sizeLabel(file.size);
      bindItem(item);
      items.push(item);
      els.list.appendChild(el);
    }

    if (skipped.length) {
      showAlert(`${plural(skipped.length, 'Este arquivo ficou', 'Estes arquivos ficaram')} de fora por estar em formato não suportado: ${skipped.join(', ')}. Use PDF, JPG, PNG ou WEBP.`);
    }
    if (items.length) els.queue.hidden = false;
    refreshControls();
    run();
  }

  /* ---------- downloads ---------- */

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadText(name, text) {
    downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' }));
  }

  function uniqueNames(list) {
    const used = new Map();
    return list.map((i) => {
      const n = baseName(i.file.name);
      const count = (used.get(n) || 0) + 1;
      used.set(n, count);
      return count > 1 ? `${n} (${count}).txt` : `${n}.txt`;
    });
  }

  els.joinAll.addEventListener('click', () => {
    const done = items.filter((i) => i.status === 'done');
    const sep = '\n\n========================================\n\n';
    downloadText('documentos-em-texto.txt', `${done.map((i) => i.output.trim()).join(sep)}\n`);
  });

  els.zipAll.addEventListener('click', async () => {
    if (typeof JSZip === 'undefined') {
      showAlert('O gerador de .zip não carregou. Use "Baixar tudo em um .txt" ou baixe os arquivos um a um.');
      return;
    }
    const done = items.filter((i) => i.status === 'done');
    const names = uniqueNames(done);
    const zip = new JSZip();
    done.forEach((i, k) => zip.file(names[k], i.output));
    els.zipAll.disabled = true;
    try {
      downloadBlob('documentos-em-texto.zip', await zip.generateAsync({ type: 'blob' }));
    } finally {
      els.zipAll.disabled = false;
    }
  });

  els.stop.addEventListener('click', () => {
    stopRequested = true;
    els.stop.disabled = true;
    els.stop.textContent = 'Parando ao fim da página';
  });

  els.clear.addEventListener('click', () => {
    if (running) return;
    items.length = 0;
    els.list.innerHTML = '';
    els.queue.hidden = true;
    updateTotals();
    hideAlert();
  });

  /* ---------- entrada de arquivos ---------- */

  els.drop.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => {
    addFiles(els.file.files);
    els.file.value = '';
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) els.drop.classList.remove('over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    els.drop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  window.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  els.pages.addEventListener('input', () => {
    els.pages.classList.toggle('invalid', !rangeIsValid(els.pages.value));
  });

  window.addEventListener('beforeunload', (e) => {
    if (running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();
