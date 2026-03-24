import { Component, AfterViewChecked, ChangeDetectorRef, NgZone, ApplicationRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { createWorker, Worker as TessWorker } from 'tesseract.js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

interface PageData {
  numbers: string[];
  rendered: boolean;
}

interface PageGroup {
  baseNumbers: string[]; // base 3 numbers for this page pattern
  pages: PageData[];     // all incremented versions
}

// Number positions on the template (from PSD analysis)
const NUMBER_POSITIONS = [
  { x: 1185, y: 155 }, { x: 1943, y: 159 },   // Receipt 1
  { x: 1168, y: 1110 }, { x: 1969, y: 1114 },  // Receipt 2
  { x: 1174, y: 2061 }, { x: 1986, y: 2058 },  // Receipt 3
];

const TEMPLATE_WIDTH = 2489;
const TEMPLATE_HEIGHT = 3393;
const FONT_SIZE = 125;
const H_SCALE = 0.8;
const V_SCALE = 0.6;
const LETTER_SPACING = 12;

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements AfterViewChecked {
  inputMode: 'manual' | 'image' = 'manual';
  manualNumbers = '';
  extractedNumbers = '';
  uploadedImage: string | null = null;
  imageZoom = false;

  incrementCount = 100;
  pageGroups: PageGroup[] = [];
  previewPages: PageData[] = [];
  isGenerating = false;
  generateProgress = 0;
  totalImages = 0;
  isOcrProcessing = false;
  ocrStatus = '';

  private templateImg: HTMLImageElement | null = null;
  private templateLoaded = false;
  private fontLoaded = false;
  private pendingRender = false;

  constructor(
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private appRef: ApplicationRef,
  ) {
    this.loadResources();
  }

  private async loadResources() {
    try {
      const font = new FontFace('Andalus', 'url(/Andalus.ttf)');
      const loaded = await font.load();
      document.fonts.add(loaded);
      this.fontLoaded = true;
    } catch {
      this.fontLoaded = true;
    }

    this.templateImg = new Image();
    this.templateImg.onload = () => {
      this.templateLoaded = true;
      if (this.pendingRender) {
        this.renderPreviewPages();
        this.pendingRender = false;
        this.cdr.detectChanges();
      }
    };
    this.templateImg.src = 'template.png';
  }

  ngAfterViewChecked() {
    if (!this.templateLoaded || !this.fontLoaded) return;
    for (let i = 0; i < this.previewPages.length; i++) {
      if (!this.previewPages[i].rendered) {
        this.renderPageToCanvas('canvas-' + i, this.previewPages[i].numbers);
        this.previewPages[i].rendered = true;
      }
    }
  }

  processManualInput() {
    this.ngZone.run(() => {
      const el = document.querySelector('.manual-input textarea') as HTMLTextAreaElement;
      const text = el?.value || this.manualNumbers;
      this.manualNumbers = text;

      const incEl = document.querySelector('.increment-input input') as HTMLInputElement;
      if (incEl) this.incrementCount = parseInt(incEl.value) || 100;

      const numbers = this.parseNumbers(text);
      if (numbers.length === 0) return;
      this.generateAll(numbers);
    });
  }

  processExtractedNumbers() {
    this.ngZone.run(() => {
      const el = document.querySelector('.numbers-panel textarea') as HTMLTextAreaElement;
      const text = el?.value || this.extractedNumbers;
      this.extractedNumbers = text;

      const incEl = document.querySelector('.increment-input input') as HTMLInputElement;
      if (incEl) this.incrementCount = parseInt(incEl.value) || 100;

      const numbers = this.parseNumbers(text);
      if (numbers.length === 0) return;
      this.generateAll(numbers);
    });
  }

  private parseNumbers(text: string): string[] {
    return text
      .split(/[\n,،\s]+/)
      .map((n) => n.trim().replace(/[^\d٠-٩]/g, ''))
      .filter((n) => n.length > 0)
      .map((n) => this.convertArabicNumerals(n));
  }

  private convertArabicNumerals(s: string): string {
    return s.replace(/[٠-٩]/g, (d) =>
      String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48)
    );
  }

  private toEasternArabic(s: string): string {
    return s.replace(/[0-9]/g, (d) =>
      String.fromCharCode(d.charCodeAt(0) - 48 + 0x0660)
    );
  }

  private incrementNumber(num: string, inc: number): string {
    const n = parseInt(num) + inc;
    return n.toString().padStart(num.length, '0');
  }

  private generateAll(baseNumbers: string[]) {
    this.pageGroups = [];
    this.previewPages = [];

    // Group base numbers into pages of 3
    const basePages: string[][] = [];
    for (let i = 0; i < baseNumbers.length; i += 3) {
      basePages.push(baseNumbers.slice(i, Math.min(i + 3, baseNumbers.length)));
    }

    // For each base page, generate all incremented versions
    for (const baseNums of basePages) {
      const group: PageGroup = {
        baseNumbers: baseNums,
        pages: [],
      };

      for (let inc = 0; inc < this.incrementCount; inc++) {
        const nums = baseNums.map((n) => this.incrementNumber(n, inc));
        group.pages.push({ numbers: nums, rendered: false });
      }

      this.pageGroups.push(group);
    }

    // Preview: show first version of each page group
    this.previewPages = this.pageGroups.map((g) => ({
      numbers: g.pages[0].numbers,
      rendered: false,
    }));

    this.totalImages = this.pageGroups.length * this.incrementCount;

    if (!this.templateLoaded || !this.fontLoaded) {
      this.pendingRender = true;
    }
    this.cdr.detectChanges();
    this.appRef.tick();
  }

  private renderPreviewPages() {
    for (let i = 0; i < this.previewPages.length; i++) {
      this.renderPageToCanvas('canvas-' + i, this.previewPages[i].numbers);
      this.previewPages[i].rendered = true;
    }
  }

  private renderPageToCanvas(canvasId: string, numbers: string[]): HTMLCanvasElement | null {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas || !this.templateImg) return null;
    this.drawOnCanvas(canvas, numbers);
    return canvas;
  }

  private drawOnCanvas(canvas: HTMLCanvasElement, numbers: string[]) {
    canvas.width = TEMPLATE_WIDTH;
    canvas.height = TEMPLATE_HEIGHT;

    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(this.templateImg!, 0, 0);

    ctx.fillStyle = '#fa3827';
    ctx.font = `bold ${FONT_SIZE}px Andalus, Arial`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';

    for (let i = 0; i < numbers.length; i++) {
      const num = this.toEasternArabic(numbers[i]);
      const pos1 = NUMBER_POSITIONS[i * 2];
      const pos2 = NUMBER_POSITIONS[i * 2 + 1];

      for (const pos of [pos1, pos2]) {
        if (!pos) continue;
        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.scale(H_SCALE, V_SCALE);
        // Draw each character individually with spacing (RTL for Arabic)
        const chars = [...num];
        let xOffset = 0;
        for (let c = 0; c < chars.length; c++) {
          const charWidth = ctx.measureText(chars[c]).width;
          ctx.fillText(chars[c], xOffset, 0);
          xOffset -= (charWidth + LETTER_SPACING);
        }
        ctx.restore();
      }
    }
  }

  private renderToBlob(numbers: string[]): Promise<Blob> {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      this.drawOnCanvas(canvas, numbers);
      canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.92);
    });
  }

  downloadPage(groupIndex: number) {
    const canvas = document.getElementById('canvas-' + groupIndex) as HTMLCanvasElement;
    if (!canvas) return;

    canvas.toBlob((blob) => {
      if (!blob) return;
      const nums = this.previewPages[groupIndex].numbers.join('-');
      saveAs(blob, `receipt-${nums}.jpg`);
    }, 'image/jpeg', 0.92);
  }

  async downloadAll() {
    this.isGenerating = true;
    this.generateProgress = 0;
    this.cdr.detectChanges();

    const zip = new JSZip();
    let done = 0;
    const total = this.totalImages;

    for (let g = 0; g < this.pageGroups.length; g++) {
      const group = this.pageGroups[g];
      const folderName = `page-${g + 1}_${group.baseNumbers.join('-')}`;
      const folder = zip.folder(folderName)!;

      for (let inc = 0; inc < group.pages.length; inc++) {
        const page = group.pages[inc];
        const blob = await this.renderToBlob(page.numbers);
        const fileName = `${inc + 1}.jpg`;
        folder.file(fileName, blob);

        done++;
        this.generateProgress = Math.round((done / total) * 100);
        this.cdr.detectChanges();

        // Yield to UI every 5 images
        if (done % 5 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 },
    });
    saveAs(zipBlob, 'receipts.zip');

    this.isGenerating = false;
    this.cdr.detectChanges();
  }

  // --- Image upload ---

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    this.handleImageFile(input.files[0]);
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer?.files;
    if (files?.length) {
      this.handleImageFile(files[0]);
    }
  }

  private handleImageFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      this.ngZone.run(() => {
        this.uploadedImage = e.target?.result as string;
        this.extractedNumbers = '';
        this.imageZoom = false;
        this.cdr.detectChanges();
        this.runOCR();
      });
    };
    reader.readAsDataURL(file);
  }

  toggleZoom() {
    this.imageZoom = !this.imageZoom;
  }

  removeImage() {
    this.uploadedImage = null;
    this.extractedNumbers = '';
    this.imageZoom = false;
  }

  private preprocessImage(imgSrc: string): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          const contrast = 1.8;
          const adjusted = ((gray / 255 - 0.5) * contrast + 0.5) * 255;
          const val = adjusted < 140 ? 0 : 255;
          data[i] = val;
          data[i + 1] = val;
          data[i + 2] = val;
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = imgSrc;
    });
  }

  private async runOCR() {
    if (!this.uploadedImage) return;

    this.isOcrProcessing = true;
    this.ocrStatus = 'جارٍ تجهيز الصورة...';
    this.cdr.detectChanges();

    try {
      // Try both with and without preprocessing
      const processedImage = await this.preprocessImage(this.uploadedImage);

      this.ocrStatus = 'جارٍ تحميل محرك التعرف على النص...';
      this.cdr.detectChanges();

      // Try Arabic first, then English as fallback
      let allNumbers: string[] = [];

      for (const lang of ['ara', 'eng']) {
        this.ocrStatus = lang === 'ara'
          ? 'جارٍ قراءة الأرقام العربية...'
          : 'جارٍ المحاولة بالإنجليزية...';
        this.cdr.detectChanges();

        const imgToUse = lang === 'ara' ? this.uploadedImage! : processedImage;

        try {
          const worker = await createWorker(lang, undefined, {
            logger: (m: { status: string; progress: number }) => {
              if (m.status === 'recognizing text') {
                this.ocrStatus = `جارٍ القراءة (${lang})... ${Math.round(m.progress * 100)}%`;
                this.cdr.detectChanges();
              }
            },
          });

          const { data: { text } } = await worker.recognize(imgToUse);
          await worker.terminate();

          console.log(`OCR [${lang}] raw:`, text);

          // Extract anything that looks like a number
          const numbers = text
            .split(/[\n\r]+/)
            .flatMap((line: string) => line.split(/[\s,،.|\-_:;/\\()\[\]{}]+/))
            .map((s: string) => s.replace(/[^\d٠-٩]/g, ''))
            .filter((s: string) => s.length >= 4 && s.length <= 8)
            .map((s: string) => this.convertArabicNumerals(s));

          allNumbers.push(...numbers);
        } catch (e) {
          console.warn(`OCR ${lang} failed:`, e);
        }

        if (allNumbers.length > 10) break; // got enough from first try
      }

      const unique = [...new Set(allNumbers)];

      this.ngZone.run(() => {
        this.extractedNumbers = unique.length > 0
          ? unique.join('\n')
          : 'لم يتم التعرف على الأرقام تلقائياً\nاكتبها يدوياً من الصورة';
        this.isOcrProcessing = false;
        this.cdr.detectChanges();
      });
    } catch (err) {
      console.error('OCR Error:', err);
      this.ngZone.run(() => {
        this.extractedNumbers = 'حدث خطأ - اكتب الأرقام يدوياً';
        this.isOcrProcessing = false;
        this.cdr.detectChanges();
      });
    }
  }
}
