/**
 * PDF 印章/签名贴图工具 - 核心逻辑
 * 纯前端实现，数据不上传服务器
 */

/* ========== 全局状态 ========== */
const AppState = {
  // 图片相关
  originalImage: null,        // 原始 Image 对象
  originalImageName: '',      // 原始图片文件名（不含扩展名）
  transparentImageData: null, // 去背景后的 ImageData
  transparentCanvas: null,    // 去背景后的离屏 canvas

  // PDF 相关
  pdfDoc: null,               // pdf.js 加载的文档
  pdfBytes: null,             // 原始 PDF 的 ArrayBuffer
  pdfFileName: '',            // 原始 PDF 文件名（不含扩展名）
  currentPage: 1,
  totalPages: 0,
  pdfRenderScale: 1.0,        // pdf.js 渲染倍率（较小值使 PDF 显示更紧凑）

  // 贴图状态
  stamp: {
    x: 100,
    y: 100,
    scale: 1.0,
    rotation: 0,
    width: 0,
    height: 0,
    dragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
  },

  // 当前步骤
  currentStep: 1,
};

/* ========== DOM 元素缓存 ========== */
const DOM = {};

function cacheDOMElements() {
  DOM.imageUploadZone = document.getElementById('image-upload-zone');
  DOM.imageInput = document.getElementById('image-input');
  DOM.imagePreviewArea = document.getElementById('image-preview-area');
  DOM.originalImageCanvas = document.getElementById('original-image-canvas');
  DOM.step1Btns = document.getElementById('step1-btns');

  DOM.bgOriginalCanvas = document.getElementById('bg-original-canvas');
  DOM.bgResultCanvas = document.getElementById('bg-result-canvas');
  DOM.thresholdGroup = document.getElementById('threshold-group');
  DOM.thresholdSlider = document.getElementById('threshold-slider');
  DOM.thresholdValue = document.getElementById('threshold-value');

  DOM.pdfUploadZone = document.getElementById('pdf-upload-zone');
  DOM.pdfInput = document.getElementById('pdf-input');
  DOM.pdfEditorArea = document.getElementById('pdf-editor-area');
  DOM.pdfCanvasContainer = document.getElementById('pdf-canvas-container');
  DOM.pdfCanvas = document.getElementById('pdf-canvas');
  DOM.stampOverlayCanvas = document.getElementById('stamp-overlay-canvas');
  DOM.pageNumberInput = document.getElementById('page-number-input');
  DOM.totalPagesSpan = document.getElementById('total-pages');
  DOM.scaleSlider = document.getElementById('scale-slider');
  DOM.scaleValue = document.getElementById('scale-value');
  DOM.rotateSlider = document.getElementById('rotate-slider');
  DOM.rotateValue = document.getElementById('rotate-value');

  DOM.finalPreviewCanvas = document.getElementById('final-preview-canvas');
}

/* ========== 步骤导航 ========== */
// 记录每个步骤是否曾经到达过（用于判断是否允许点击跳转）
const stepReached = { 1: true, 2: false, 3: false, 4: false };

function goToStep(stepNumber) {
  AppState.currentStep = stepNumber;
  stepReached[stepNumber] = true;

  document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('active-panel'));
  document.getElementById(`step${stepNumber}-panel`).classList.add('active-panel');

  document.querySelectorAll('.step').forEach(stepEl => {
    const stepNum = parseInt(stepEl.dataset.step);
    stepEl.classList.remove('active', 'completed');
    if (stepNum === stepNumber) {
      stepEl.classList.add('active');
    } else if (stepNum < stepNumber) {
      stepEl.classList.add('completed');
    }
  });
}

function initStepClickNavigation() {
  document.querySelectorAll('.step').forEach(stepEl => {
    stepEl.addEventListener('click', () => {
      const targetStep = parseInt(stepEl.dataset.step);
      // 只允许跳转到已经到达过的步骤，或当前步骤之前的步骤
      if (stepReached[targetStep] || targetStep < AppState.currentStep) {
        goToStep(targetStep);
      }
    });
  });
}

/* ========== 步骤1：图片上传 ========== */
function initImageUpload() {
  const zone = DOM.imageUploadZone;
  const input = DOM.imageInput;

  zone.addEventListener('click', () => input.click());

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragover');
    const file = event.dataTransfer.files[0];
    if (file) handleImageFile(file);
  });

  input.addEventListener('change', () => {
    if (input.files[0]) handleImageFile(input.files[0]);
  });
}

function handleImageFile(file) {
  const validTypes = ['image/png', 'image/jpeg', 'image/jpg'];
  if (!validTypes.includes(file.type)) {
    alert('仅支持 PNG / JPG / JPEG 格式的图片');
    return;
  }

  // 保存原始文件名（去掉扩展名）
  AppState.originalImageName = file.name.replace(/\.[^.]+$/, '');

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      AppState.originalImage = img;
      drawImageToCanvas(img, DOM.originalImageCanvas, 400);
      DOM.imagePreviewArea.style.display = 'block';
      DOM.step1Btns.style.display = 'flex';
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function drawImageToCanvas(img, canvas, maxSize) {
  let width = img.width;
  let height = img.height;
  const ratio = Math.min(maxSize / width, maxSize / height, 1);
  width = Math.round(width * ratio);
  height = Math.round(height * ratio);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
}

/* ========== 步骤2：去除背景 ========== */
function initBgRemoval() {
  const radios = document.querySelectorAll('input[name="bg-mode"]');
  radios.forEach(radio => {
    radio.addEventListener('change', () => {
      DOM.thresholdGroup.style.display = radio.value === 'custom' ? 'block' : 'none';
    });
  });

  DOM.thresholdSlider.addEventListener('input', () => {
    DOM.thresholdValue.textContent = DOM.thresholdSlider.value;
  });

  document.getElementById('btn-apply-bg').addEventListener('click', applyBgRemoval);
  document.getElementById('btn-export-image').addEventListener('click', exportTransparentImage);
}

/**
 * 导出去背景后的透明图片为 PNG
 */
function exportTransparentImage() {
  const stampCanvas = AppState.transparentCanvas;
  if (!stampCanvas) return;

  stampCanvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const exportName = AppState.originalImageName || 'transparent_image';
    link.download = exportName + '_transparent.png';
    link.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

function applyBgRemoval() {
  const img = AppState.originalImage;
  if (!img) return;

  // 绘制原图到对比区
  drawImageToCanvas(img, DOM.bgOriginalCanvas, 400);

  // 在离屏 canvas 上做全尺寸处理
  const offscreen = document.createElement('canvas');
  offscreen.width = img.width;
  offscreen.height = img.height;
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const pixels = imageData.data;

  const mode = document.querySelector('input[name="bg-mode"]:checked').value;
  const threshold = parseInt(DOM.thresholdSlider.value);

  switch (mode) {
    case 'white':
      removeWhiteBackground(pixels, 240);
      break;
    case 'red':
      extractRedStamp(pixels);
      break;
    case 'custom':
      removeWhiteBackground(pixels, threshold);
      break;
  }

  ctx.putImageData(imageData, 0, 0);

  // 保存去背景结果
  AppState.transparentCanvas = offscreen;
  AppState.transparentImageData = imageData;

  // 绘制到对比区的结果 canvas
  const resultCanvas = DOM.bgResultCanvas;
  let displayWidth = img.width;
  let displayHeight = img.height;
  const ratio = Math.min(400 / displayWidth, 400 / displayHeight, 1);
  displayWidth = Math.round(displayWidth * ratio);
  displayHeight = Math.round(displayHeight * ratio);
  resultCanvas.width = displayWidth;
  resultCanvas.height = displayHeight;
  const resultCtx = resultCanvas.getContext('2d');
  resultCtx.clearRect(0, 0, displayWidth, displayHeight);
  resultCtx.drawImage(offscreen, 0, 0, displayWidth, displayHeight);

  document.getElementById('btn-to-step3').disabled = false;
  document.getElementById('btn-export-image').disabled = false;
}

/**
 * 白底去除（smooth 模式）
 * 灰度高于阈值的像素变透明，线条部分用灰度反转作为 alpha
 */
function removeWhiteBackground(pixels, threshold) {
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i];
    const green = pixels[i + 1];
    const blue = pixels[i + 2];
    const grayscale = 0.299 * red + 0.587 * green + 0.114 * blue;

    if (grayscale > threshold) {
      pixels[i + 3] = 0; // 完全透明
    } else {
      // 平滑过渡：越黑越不透明
      let alpha = 255 - grayscale;
      alpha = Math.min(alpha * 1.5, 255);
      pixels[i + 3] = Math.round(alpha);
      // 线条颜色保持原色
    }
  }
}

/**
 * 红章提取：保留红色像素，其他变透明
 * 判断条件：R通道远大于G和B
 */
function extractRedStamp(pixels) {
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i];
    const green = pixels[i + 1];
    const blue = pixels[i + 2];

    // 红色判断：R 较大，且 R 明显大于 G 和 B
    const isRed = red > 80 && red > green * 1.4 && red > blue * 1.4;
    // 深红/暗红也保留
    const isDarkRed = red > 60 && green < 80 && blue < 80 && red > green && red > blue;

    if (isRed || isDarkRed) {
      // 保留，alpha 根据红色纯度计算
      const redPurity = red / (green + blue + 1);
      const alpha = Math.min(Math.round(redPurity * 100), 255);
      pixels[i + 3] = Math.max(alpha, 150); // 至少 150 的不透明度
    } else {
      pixels[i + 3] = 0; // 非红色区域透明
    }
  }
}

/* ========== 步骤3：PDF 上传与渲染 ========== */
function initPdfUpload() {
  const zone = DOM.pdfUploadZone;
  const input = DOM.pdfInput;

  zone.addEventListener('click', () => input.click());

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragover');
    const file = event.dataTransfer.files[0];
    if (file) handlePdfFile(file);
  });

  input.addEventListener('change', () => {
    if (input.files[0]) handlePdfFile(input.files[0]);
  });
}

function handlePdfFile(file) {
  if (file.type !== 'application/pdf') {
    alert('仅支持 PDF 格式的文件');
    return;
  }

  // 保存原始 PDF 文件名（去掉扩展名）
  AppState.pdfFileName = file.name.replace(/\.[^.]+$/, '');

  const reader = new FileReader();
  reader.onload = async (event) => {
    const arrayBuffer = event.target.result;
    AppState.pdfBytes = arrayBuffer.slice(0); // 保存副本供 pdf-lib 使用

    try {
      const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      AppState.pdfDoc = pdfDoc;
      AppState.totalPages = pdfDoc.numPages;
      AppState.currentPage = pdfDoc.numPages; // 默认最后一页

      DOM.totalPagesSpan.textContent = pdfDoc.numPages;
      DOM.pageNumberInput.value = pdfDoc.numPages;
      DOM.pageNumberInput.max = pdfDoc.numPages;

      DOM.pdfUploadZone.style.display = 'none';
      DOM.pdfEditorArea.style.display = 'flex';

      // 先渲染 PDF 页面，再根据页面尺寸初始化印章位置
      await renderCurrentPage();
      initStampOnPdf();
      drawStampOverlay();
    } catch (error) {
      alert('PDF 加载失败：' + error.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function initStampOnPdf() {
  const stampCanvas = AppState.transparentCanvas;
  if (!stampCanvas) return;

  AppState.stamp.width = stampCanvas.width;
  AppState.stamp.height = stampCanvas.height;
  AppState.stamp.rotation = 0;

  // 根据 PDF 渲染尺寸自动计算初始缩放，使印章约占页面宽度的 25%
  const pdfCanvas = DOM.pdfCanvas;
  if (pdfCanvas.width > 0) {
    const targetWidth = pdfCanvas.width * 0.25;
    const autoScale = Math.min(targetWidth / stampCanvas.width, 1.0);
    AppState.stamp.scale = autoScale;
    const scalePercent = Math.round(autoScale * 100);
    DOM.scaleSlider.value = scalePercent;
    DOM.scaleValue.textContent = String(scalePercent);
  } else {
    AppState.stamp.scale = 1.0;
    DOM.scaleSlider.value = 100;
    DOM.scaleValue.textContent = '100';
  }

  // 印章默认放在页面右下角偏上位置
  const scaledWidth = AppState.stamp.width * AppState.stamp.scale;
  const scaledHeight = AppState.stamp.height * AppState.stamp.scale;
  AppState.stamp.x = (pdfCanvas.width || 600) - scaledWidth - 60;
  AppState.stamp.y = (pdfCanvas.height || 800) - scaledHeight - 80;

  DOM.rotateSlider.value = 0;
  DOM.rotateValue.textContent = '0';
}

async function renderCurrentPage() {
  const pdfDoc = AppState.pdfDoc;
  if (!pdfDoc) return;

  const page = await pdfDoc.getPage(AppState.currentPage);
  const viewport = page.getViewport({ scale: AppState.pdfRenderScale });

  const pdfCanvas = DOM.pdfCanvas;
  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  const ctx = pdfCanvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport: viewport }).promise;

  // 同步 overlay canvas 尺寸
  const overlayCanvas = DOM.stampOverlayCanvas;
  overlayCanvas.width = viewport.width;
  overlayCanvas.height = viewport.height;

  drawStampOverlay();
}

function drawStampOverlay() {
  const canvas = DOM.stampOverlayCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const stampCanvas = AppState.transparentCanvas;
  if (!stampCanvas) return;

  const stamp = AppState.stamp;
  const scaledWidth = stamp.width * stamp.scale;
  const scaledHeight = stamp.height * stamp.scale;

  ctx.save();
  ctx.translate(stamp.x + scaledWidth / 2, stamp.y + scaledHeight / 2);
  ctx.rotate((stamp.rotation * Math.PI) / 180);
  ctx.drawImage(stampCanvas, -scaledWidth / 2, -scaledHeight / 2, scaledWidth, scaledHeight);

  // 绘制边框指示
  ctx.strokeStyle = 'rgba(79, 70, 229, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(-scaledWidth / 2, -scaledHeight / 2, scaledWidth, scaledHeight);

  ctx.restore();
}

/* ========== 印章拖拽交互 ========== */
function initStampDrag() {
  const canvas = DOM.stampOverlayCanvas;

  canvas.addEventListener('mousedown', onStampMouseDown);
  canvas.addEventListener('mousemove', onStampMouseMove);
  canvas.addEventListener('mouseup', onStampMouseUp);
  canvas.addEventListener('mouseleave', onStampMouseUp);

  // 触屏支持
  canvas.addEventListener('touchstart', onStampTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onStampTouchMove, { passive: false });
  canvas.addEventListener('touchend', onStampTouchEnd);
}

function isInsideStamp(mouseX, mouseY) {
  const stamp = AppState.stamp;
  const scaledWidth = stamp.width * stamp.scale;
  const scaledHeight = stamp.height * stamp.scale;
  return (
    mouseX >= stamp.x &&
    mouseX <= stamp.x + scaledWidth &&
    mouseY >= stamp.y &&
    mouseY <= stamp.y + scaledHeight
  );
}

function getCanvasCoords(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function onStampMouseDown(event) {
  const coords = getCanvasCoords(DOM.stampOverlayCanvas, event);
  if (isInsideStamp(coords.x, coords.y)) {
    AppState.stamp.dragging = true;
    AppState.stamp.dragOffsetX = coords.x - AppState.stamp.x;
    AppState.stamp.dragOffsetY = coords.y - AppState.stamp.y;
    event.preventDefault();
  }
}

function onStampMouseMove(event) {
  if (!AppState.stamp.dragging) return;
  const coords = getCanvasCoords(DOM.stampOverlayCanvas, event);
  AppState.stamp.x = coords.x - AppState.stamp.dragOffsetX;
  AppState.stamp.y = coords.y - AppState.stamp.dragOffsetY;
  drawStampOverlay();
}

function onStampMouseUp() {
  AppState.stamp.dragging = false;
}

function onStampTouchStart(event) {
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} };
  const coords = getCanvasCoords(DOM.stampOverlayCanvas, fakeEvent);
  if (isInsideStamp(coords.x, coords.y)) {
    AppState.stamp.dragging = true;
    AppState.stamp.dragOffsetX = coords.x - AppState.stamp.x;
    AppState.stamp.dragOffsetY = coords.y - AppState.stamp.y;
    event.preventDefault();
  }
}

function onStampTouchMove(event) {
  if (!AppState.stamp.dragging || event.touches.length !== 1) return;
  event.preventDefault();
  const touch = event.touches[0];
  const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
  const coords = getCanvasCoords(DOM.stampOverlayCanvas, fakeEvent);
  AppState.stamp.x = coords.x - AppState.stamp.dragOffsetX;
  AppState.stamp.y = coords.y - AppState.stamp.dragOffsetY;
  drawStampOverlay();
}

function onStampTouchEnd() {
  AppState.stamp.dragging = false;
}

/* ========== 页码导航 ========== */
function initPageNavigation() {
  document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (AppState.currentPage > 1) {
      AppState.currentPage--;
      DOM.pageNumberInput.value = AppState.currentPage;
      renderCurrentPage();
    }
  });

  document.getElementById('btn-next-page').addEventListener('click', () => {
    if (AppState.currentPage < AppState.totalPages) {
      AppState.currentPage++;
      DOM.pageNumberInput.value = AppState.currentPage;
      renderCurrentPage();
    }
  });

  DOM.pageNumberInput.addEventListener('change', () => {
    let page = parseInt(DOM.pageNumberInput.value);
    page = Math.max(1, Math.min(page, AppState.totalPages));
    AppState.currentPage = page;
    DOM.pageNumberInput.value = page;
    renderCurrentPage();
  });

  // 在 PDF 区域滚轮翻页
  DOM.pdfCanvasContainer.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (event.deltaY > 0 && AppState.currentPage < AppState.totalPages) {
      AppState.currentPage++;
    } else if (event.deltaY < 0 && AppState.currentPage > 1) {
      AppState.currentPage--;
    }
    DOM.pageNumberInput.value = AppState.currentPage;
    renderCurrentPage();
  }, { passive: false });
}

/* ========== 缩放与旋转控件 ========== */
function initTransformControls() {
  DOM.scaleSlider.addEventListener('input', () => {
    const scalePercent = parseInt(DOM.scaleSlider.value);
    DOM.scaleValue.textContent = scalePercent;
    AppState.stamp.scale = scalePercent / 100;
    drawStampOverlay();
  });

  DOM.rotateSlider.addEventListener('input', () => {
    const rotation = parseInt(DOM.rotateSlider.value);
    DOM.rotateValue.textContent = rotation;
    AppState.stamp.rotation = rotation;
    drawStampOverlay();
  });

  document.getElementById('btn-reset-transform').addEventListener('click', () => {
    AppState.stamp.scale = 1.0;
    AppState.stamp.rotation = 0;
    DOM.scaleSlider.value = 100;
    DOM.scaleValue.textContent = '100';
    DOM.rotateSlider.value = 0;
    DOM.rotateValue.textContent = '0';
    drawStampOverlay();
  });
}

/* ========== 步骤4：预览与导出 ========== */
function renderFinalPreview() {
  const pdfCanvas = DOM.pdfCanvas;
  const previewCanvas = DOM.finalPreviewCanvas;
  previewCanvas.width = pdfCanvas.width;
  previewCanvas.height = pdfCanvas.height;
  const ctx = previewCanvas.getContext('2d');

  // 先画 PDF
  ctx.drawImage(pdfCanvas, 0, 0);

  // 再画印章（不带虚线边框）
  const stampCanvas = AppState.transparentCanvas;
  if (!stampCanvas) return;

  const stamp = AppState.stamp;
  const scaledWidth = stamp.width * stamp.scale;
  const scaledHeight = stamp.height * stamp.scale;

  ctx.save();
  ctx.translate(stamp.x + scaledWidth / 2, stamp.y + scaledHeight / 2);
  ctx.rotate((stamp.rotation * Math.PI) / 180);
  ctx.drawImage(stampCanvas, -scaledWidth / 2, -scaledHeight / 2, scaledWidth, scaledHeight);
  ctx.restore();
}

async function exportPdf() {
  try {
    const { PDFDocument } = PDFLib;

    // 加载原始 PDF
    const pdfDoc = await PDFDocument.load(AppState.pdfBytes);
    const pages = pdfDoc.getPages();
    const targetPage = pages[AppState.currentPage - 1];

    // 获取页面尺寸（PDF 点单位）
    const { width: pageWidth, height: pageHeight } = targetPage.getSize();

    // 计算渲染坐标到 PDF 坐标的缩放比
    const renderCanvas = DOM.pdfCanvas;
    const scaleX = pageWidth / renderCanvas.width;
    const scaleY = pageHeight / renderCanvas.height;

    // 将去背景的印章转为 PNG bytes
    const stampCanvas = AppState.transparentCanvas;
    const stampBlob = await new Promise(resolve => stampCanvas.toBlob(resolve, 'image/png'));
    const stampArrayBuffer = await stampBlob.arrayBuffer();
    const stampImage = await pdfDoc.embedPng(new Uint8Array(stampArrayBuffer));

    // 计算印章在 PDF 坐标系中的位置和大小
    const stamp = AppState.stamp;
    const scaledWidth = stamp.width * stamp.scale;
    const scaledHeight = stamp.height * stamp.scale;

    // PDF 坐标系 y 轴向上，所以需要翻转
    const pdfStampX = stamp.x * scaleX;
    const pdfStampY = pageHeight - (stamp.y + scaledHeight) * scaleY;
    const pdfStampWidth = scaledWidth * scaleX;
    const pdfStampHeight = scaledHeight * scaleY;

    // 处理旋转
    if (stamp.rotation !== 0) {
      // 带旋转的嵌入：先移到中心，旋转，再画
      const centerX = pdfStampX + pdfStampWidth / 2;
      const centerY = pdfStampY + pdfStampHeight / 2;
      const radians = (-stamp.rotation * Math.PI) / 180; // PDF 坐标系旋转方向相反

      targetPage.drawImage(stampImage, {
        x: centerX - pdfStampWidth / 2,
        y: centerY - pdfStampHeight / 2,
        width: pdfStampWidth,
        height: pdfStampHeight,
        rotate: PDFLib.degrees(-stamp.rotation),
      });
    } else {
      targetPage.drawImage(stampImage, {
        x: pdfStampX,
        y: pdfStampY,
        width: pdfStampWidth,
        height: pdfStampHeight,
      });
    }

    // 导出
    const modifiedPdfBytes = await pdfDoc.save();
    const blob = new Blob([modifiedPdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    const pdfExportName = AppState.pdfFileName || 'stamped_output';
    downloadLink.download = pdfExportName + '_stamped.pdf';
    downloadLink.click();
    URL.revokeObjectURL(url);

  } catch (error) {
    alert('导出失败：' + error.message);
    console.error('Export error:', error);
  }
}

/* ========== 步骤切换按钮绑定 ========== */
function initStepNavigation() {
  document.getElementById('btn-to-step2').addEventListener('click', () => {
    // 进入步骤2时自动在对比区绘制原图
    drawImageToCanvas(AppState.originalImage, DOM.bgOriginalCanvas, 400);
    goToStep(2);
  });

  document.getElementById('btn-back-step1').addEventListener('click', () => goToStep(1));

  document.getElementById('btn-to-step3').addEventListener('click', () => goToStep(3));

  document.getElementById('btn-back-step2').addEventListener('click', () => goToStep(2));

  document.getElementById('btn-to-step4').addEventListener('click', () => {
    renderFinalPreview();
    goToStep(4);
  });

  document.getElementById('btn-back-step3').addEventListener('click', () => {
    goToStep(3);
  });

  document.getElementById('btn-export').addEventListener('click', exportPdf);
}

/* ========== 初始化 ========== */
function init() {
  cacheDOMElements();
  initImageUpload();
  initBgRemoval();
  initPdfUpload();
  initStampDrag();
  initPageNavigation();
  initTransformControls();
  initStepNavigation();
  initStepClickNavigation();
}

document.addEventListener('DOMContentLoaded', init);
