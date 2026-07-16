import {
  getDocument,
  GlobalWorkerOptions,
} from './vendor/pdfjs/pdf.mjs';
import { normalizePdfBinary } from './pdf_reader_utils.js';

GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).toString();

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const ZOOM_STEP = 1.2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class PdfReader {
  constructor(elements, { onPageChange } = {}) {
    this.elements = elements;
    this.onPageChange = onPageChange || (() => {});
    this.document = null;
    this.loadingTask = null;
    this.renderTask = null;
    this.entryId = null;
    this.pageNumber = 1;
    this.scale = 1;
    this.fitWidth = true;
    this.textCache = new Map();
    this.searchQuery = '';
    this.searchPage = 0;
    this.renderRequestId = 0;
    this.resizeTimer = null;
    this.bindControls();

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.document || !this.fitWidth || this.elements.view.classList.contains('hidden')) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.renderPage(), 100);
    });
    this.resizeObserver.observe(this.elements.stage);
  }

  bindControls() {
    const el = this.elements;
    el.previous.addEventListener('click', () => this.goToPage(this.pageNumber - 1));
    el.next.addEventListener('click', () => this.goToPage(this.pageNumber + 1));
    el.pageInput.addEventListener('change', () => this.goToPage(Number(el.pageInput.value)));
    el.pageInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.pageInput.blur();
      }
    });
    el.zoomOut.addEventListener('click', () => this.zoomBy(1 / ZOOM_STEP));
    el.zoomIn.addEventListener('click', () => this.zoomBy(ZOOM_STEP));
    el.fitWidth.addEventListener('click', () => {
      this.fitWidth = true;
      this.renderPage();
    });
    el.searchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.findNext();
      }
    });
    el.searchNext.addEventListener('click', () => this.findNext());
  }

  async load(binary, { entryId, page = 1 } = {}) {
    await this.destroyDocument();
    this.entryId = entryId ?? null;
    this.pageNumber = Math.max(1, Number(page) || 1);
    this.scale = 1;
    this.fitWidth = true;
    this.textCache.clear();
    this.searchQuery = '';
    this.searchPage = 0;
    this.elements.searchInput.value = '';
    this.setSearchStatus('');
    this.setStatus('正在载入 PDF…', 'loading');
    this.setControlsDisabled(true);

    const data = normalizePdfBinary(binary);
    this.loadingTask = getDocument({
      data,
      useSystemFonts: true,
      useWasm: false,
      isEvalSupported: false,
    });
    this.document = await this.loadingTask.promise;
    this.pageNumber = clamp(this.pageNumber, 1, this.document.numPages);
    this.elements.pageCount.textContent = `/ ${this.document.numPages}`;
    this.setControlsDisabled(false);
    await this.renderPage();
  }

  async destroyDocument() {
    this.renderRequestId += 1;
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
    if (this.loadingTask) {
      try { await this.loadingTask.destroy(); } catch {}
      this.loadingTask = null;
    } else if (this.document) {
      try { await this.document.destroy(); } catch {}
    }
    this.document = null;
    this.textCache.clear();
    this.elements.canvas.width = 1;
    this.elements.canvas.height = 1;
  }

  async renderPage() {
    if (!this.document) return;
    const requestId = ++this.renderRequestId;
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }

    this.setStatus(`正在渲染第 ${this.pageNumber} 页…`, 'loading');
    try {
      const page = await this.document.getPage(this.pageNumber);
      if (requestId !== this.renderRequestId) return;
      const baseViewport = page.getViewport({ scale: 1 });
      if (this.fitWidth) {
        const availableWidth = Math.max(280, this.elements.stage.clientWidth - 32);
        this.scale = clamp(availableWidth / baseViewport.width, MIN_SCALE, MAX_SCALE);
      }
      const viewport = page.getViewport({ scale: this.scale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = this.elements.canvas;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext('2d', { alpha: false });
      this.renderTask = page.render({
        canvasContext: context,
        canvas,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
        background: '#ffffff',
      });
      await this.renderTask.promise;
      if (requestId !== this.renderRequestId) return;
      this.renderTask = null;
      this.elements.pageInput.value = String(this.pageNumber);
      this.elements.previous.disabled = this.pageNumber <= 1;
      this.elements.next.disabled = this.pageNumber >= this.document.numPages;
      this.elements.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
      this.elements.fitWidth.classList.toggle('active', this.fitWidth);
      this.setStatus('', 'ready');
      this.onPageChange(this.entryId, this.pageNumber);
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') return;
      this.renderTask = null;
      this.setStatus(`PDF 页面渲染失败：${error?.message || error}`, 'error');
    }
  }

  goToPage(value) {
    if (!this.document) return;
    const nextPage = clamp(Math.round(Number(value) || 1), 1, this.document.numPages);
    if (nextPage === this.pageNumber) {
      this.elements.pageInput.value = String(this.pageNumber);
      return;
    }
    this.pageNumber = nextPage;
    this.renderPage();
  }

  zoomBy(factor) {
    if (!this.document) return;
    this.fitWidth = false;
    this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    this.renderPage();
  }

  async pageText(pageNumber) {
    if (this.textCache.has(pageNumber)) return this.textCache.get(pageNumber);
    const page = await this.document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str || '').join(' ').toLocaleLowerCase();
    this.textCache.set(pageNumber, text);
    return text;
  }

  async findNext() {
    if (!this.document) return;
    const query = this.elements.searchInput.value.trim().toLocaleLowerCase();
    if (!query) {
      this.setSearchStatus('请输入关键词');
      this.elements.searchInput.focus();
      return;
    }
    const isNewQuery = query !== this.searchQuery;
    this.searchQuery = query;
    const startPage = isNewQuery ? this.pageNumber : (this.searchPage % this.document.numPages) + 1;
    this.setSearchStatus('正在搜索…');
    this.elements.searchNext.disabled = true;
    try {
      for (let offset = 0; offset < this.document.numPages; offset += 1) {
        const pageNumber = ((startPage - 1 + offset) % this.document.numPages) + 1;
        if ((await this.pageText(pageNumber)).includes(query)) {
          this.searchPage = pageNumber;
          this.setSearchStatus(`第 ${pageNumber} 页`);
          this.goToPage(pageNumber);
          return;
        }
      }
      this.setSearchStatus('未找到');
    } catch (error) {
      this.setSearchStatus(`搜索失败：${error?.message || error}`);
    } finally {
      this.elements.searchNext.disabled = false;
    }
  }

  setControlsDisabled(disabled) {
    const el = this.elements;
    [el.previous, el.next, el.pageInput, el.zoomOut, el.zoomIn, el.fitWidth, el.searchInput, el.searchNext]
      .forEach(control => { control.disabled = disabled; });
  }

  setStatus(message, state) {
    this.elements.status.textContent = message;
    this.elements.status.className = `detail-pdf-status ${state || ''}`.trim();
    this.elements.canvas.classList.toggle('hidden', state === 'loading' || state === 'error');
  }

  setSearchStatus(message) {
    this.elements.searchStatus.textContent = message;
  }
}
