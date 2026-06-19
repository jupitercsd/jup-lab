/* ===== any2pdf — 文档转 PDF ===== */
(function () {
  'use strict';

  /* ---------- DOM 引用 ---------- */
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  var uploadZone = document.getElementById('upload-zone');
  var fileInput = document.getElementById('file-input');
  var fileInfo = document.getElementById('file-info');
  var fileIcon = document.getElementById('file-icon');
  var fileName = document.getElementById('file-name');
  var fileSize = document.getElementById('file-size');
  var btnClear = document.getElementById('btn-clear-file');
  var actionRow = document.getElementById('action-row');
  var btnConvert = document.getElementById('btn-convert');
  var statusArea = document.getElementById('status-area');
  var statusBar = document.getElementById('status-bar');
  var statusText = document.getElementById('status-text');
  var resultArea = document.getElementById('result-area');
  var btnDownload = document.getElementById('btn-download');

  var selectedFile = null;
  var resultBlob = null;
  var resultFilename = null;
  var MAX_FILE_BYTES = 10 * 1024 * 1024;

  /* ---------- Toast ---------- */
  function showToast(message, type) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = 'toast ' + type + ' show';
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2800);
  }

  /* ---------- 工具函数 ---------- */
  var ICON_MAP = {
    doc: '📝', docx: '📝',
    xls: '📊', xlsx: '📊',
    ppt: '📽️', pptx: '📽️',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', bmp: '🖼️', gif: '🖼️', tiff: '🖼️', tif: '🖼️',
    txt: '📃', rtf: '📃',
  };

  var ALLOWED_TYPES = [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg',
    'image/png',
    'image/bmp',
    'image/gif',
    'image/tiff',
    'text/plain',
    'application/rtf',
  ];

  function getExt(filename) {
    return (filename.split('.').pop() || '').toLowerCase();
  }

  function getIcon(filename) {
    return ICON_MAP[getExt(filename)] || '📎';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function filenameFromDisposition(disposition) {
    var utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch (e) {
        return utf8Match[1];
      }
    }

    var nameMatch = disposition.match(/filename="?([^";]+)"?/i);
    return nameMatch ? nameMatch[1] : null;
  }

  function responseError(resp) {
    return resp.text().then(function (body) {
      try {
        var data = JSON.parse(body);
        return Promise.reject(new Error(data.error || '转换失败 (' + resp.status + ')'));
      } catch (e) {
        if (e instanceof SyntaxError) {
          return Promise.reject(new Error(body || '转换失败 (' + resp.status + ')'));
        }
        return Promise.reject(e);
      }
    });
  }

  /* ---------- 上传事件 ---------- */
  function handleFile(file) {
    if (!file) return;

    var ext = getExt(file.name);
    var mimeOk = ALLOWED_TYPES.indexOf(file.type) !== -1;
    var extOk = Object.keys(ICON_MAP).indexOf(ext) !== -1;

    if (!mimeOk && !extOk) {
      alert('不支持的文件格式，请上传 Word / Excel / PPT / 图片 / TXT / RTF 文件');
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      alert('文件过大，请上传 10 MB 以内的文件');
      return;
    }

    selectedFile = file;
    resultBlob = null;
    resultFilename = null;
    btnConvert.disabled = false;

    fileIcon.textContent = getIcon(file.name);
    fileName.textContent = file.name;
    fileSize.textContent = formatSize(file.size);

    fileInfo.style.display = 'block';
    actionRow.style.display = 'flex';
    statusArea.style.display = 'none';
    resultArea.style.display = 'none';
    uploadZone.style.display = 'none';
  }

  function clearFile() {
    selectedFile = null;
    resultBlob = null;
    resultFilename = null;
    btnConvert.disabled = false;

    fileInfo.style.display = 'none';
    actionRow.style.display = 'none';
    statusArea.style.display = 'none';
    resultArea.style.display = 'none';
    uploadZone.style.display = 'block';
    fileInput.value = '';

    statusBar.className = 'status-bar';
    statusBar.style.width = '0%';
  }

  /* ---------- 状态条 ---------- */
  function setStatus(phase, message) {
    statusArea.style.display = 'block';
    actionRow.style.display = 'none';
    resultArea.style.display = 'none';

    statusText.textContent = message;
    statusBar.className = 'status-bar';
    statusBar.style.width = '0%';

    if (phase === 'uploading') {
      statusBar.classList.add('indeterminate');
    } else if (phase === 'converting') {
      statusBar.classList.add('indeterminate');
      statusText.textContent = message;
    } else if (phase === 'success') {
      statusBar.classList.add('success');
    } else if (phase === 'error') {
      statusBar.classList.add('error');
    }
  }

  /* ---------- 转换 ---------- */
  function doConvert() {
    if (!selectedFile) return;

    setStatus('uploading', '正在上传文件…');
    btnConvert.disabled = true;

    var formData = new FormData();
    formData.append('file', selectedFile);

    fetch('/api/convert', {
      method: 'POST',
      body: formData,
    })
      .then(function (resp) {
        if (!resp.ok) {
          if (resp.status === 429) {
            return resp.json().then(function (data) {
              throw { rateLimited: true, message: data.error };
            });
          }
          return responseError(resp);
        }

        var disposition = resp.headers.get('Content-Disposition') || '';
        resultFilename = filenameFromDisposition(disposition) || selectedFile.name.replace(/\.[^.]+$/, '.pdf');

        return resp.blob();
      })
      .then(function (blob) {
        resultBlob = blob;
        setStatus('success', '转换完成！');
        statusArea.style.display = 'none';

        resultArea.style.display = 'block';
      })
      .catch(function (err) {
        if (err.rateLimited) {
          showToast(err.message, 'error');
          // 恢复按钮
          statusArea.style.display = 'none';
          actionRow.style.display = 'flex';
          btnConvert.disabled = false;
          return;
        }
        setStatus('error', err.message);
        // 恢复按钮
        actionRow.style.display = 'flex';
        btnConvert.disabled = false;
      });
  }

  /* ---------- 下载 ---------- */
  function doDownload() {
    if (!resultBlob) return;

    var url = URL.createObjectURL(resultBlob);
    var a = document.createElement('a');
    a.href = url;
    a.download = resultFilename || 'converted.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ---------- 事件绑定 ---------- */
  uploadZone.addEventListener('click', function () { fileInput.click(); });

  fileInput.addEventListener('change', function () {
    handleFile(fileInput.files[0]);
  });

  uploadZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });

  uploadZone.addEventListener('dragleave', function () {
    uploadZone.classList.remove('dragover');
  });

  uploadZone.addEventListener('drop', function (e) {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    handleFile(e.dataTransfer.files[0]);
  });

  btnClear.addEventListener('click', clearFile);

  btnConvert.addEventListener('click', doConvert);

  btnDownload.addEventListener('click', doDownload);
})();
