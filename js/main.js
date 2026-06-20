/* ===== 访客统计（自有 Redis）===== */
(function () {
  var totalEl = document.getElementById('visitor-total');
  var todayEl = document.getElementById('visitor-today');
  if (!totalEl) return;

  fetch('/api/visitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (data) {
      totalEl.textContent = data.total || 0;
      var daily = data.daily || [];
      var today = daily.length ? daily[daily.length - 1][1] : 0;
      if (todayEl) todayEl.textContent = today;
    })
    .catch(function () {
      totalEl.textContent = '-';
      if (todayEl) todayEl.textContent = '-';
    });
})();

/* ===== Toast 通知 ===== */
var toastTimer = null;

function showToast(message, type) {
  var toast = document.getElementById('toast');
  clearTimeout(toastTimer);

  toast.textContent = message;
  toast.className = 'toast ' + type + ' show';

  toastTimer = setTimeout(function () {
    toast.classList.remove('show');
  }, 2600);
}

/* ===== 建议反馈弹窗 ===== */
(function () {
  var modal = document.getElementById('feedback-modal');
  var trigger = document.getElementById('btn-feedback');
  var closeBtn = document.getElementById('btn-modal-close');
  var textarea = document.getElementById('feedback-text');
  var submitBtn = document.getElementById('btn-submit-feedback');

  function open() {
    modal.setAttribute('aria-hidden', 'false');
    textarea.value = '';
    submitBtn.disabled = true;
    setTimeout(function () { textarea.focus(); }, 200);
  }

  function close() {
    modal.setAttribute('aria-hidden', 'true');
  }

  trigger.addEventListener('click', open);
  trigger.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  textarea.addEventListener('input', function () {
    submitBtn.disabled = this.value.trim().length === 0;
  });

  submitBtn.addEventListener('click', function () {
    var text = textarea.value.trim();
    if (!text) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '发送中…';
    close();

    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, page: location.href })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          showToast('谢谢你的反馈！', 'success');
          textarea.value = '';
        } else {
          showToast(data.error || '发送失败，请稍后重试', 'error');
        }
      })
      .catch(function () {
        showToast('网络异常，请稍后重试', 'error');
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = '发送';
      });
  });
})();
