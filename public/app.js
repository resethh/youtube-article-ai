/* YT 语镜前端：SSE 消费、轻量 Markdown 渲染、章节 5W1H 交互 */
(function () {
  'use strict';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const videoUrl = $('videoUrl');
  const reqToggle = $('reqToggle');
  const reqWrap = $('reqWrap');
  const reqText = $('reqText');
  const chipRow = $('chipRow');
  const generateBtn = $('generateBtn');
  const statusBadge = $('statusBadge');
  const statusText = $('statusText');
  const articlePanel = $('articlePanel');
  const emptyState = $('emptyState');
  const videoTitleEl = $('videoTitle');
  const fallbackBadge = $('fallbackBadge');
  const toc = $('toc');
  const articleBody = $('articleBody');
  const cursorLine = $('cursorLine');
  const articleFoot = $('articleFoot');
  const copyBtn = $('copyBtn');
  const retryBtn = $('retryBtn');
  const overlay = $('overlay');
  const modalClose = $('modalClose');
  const modalTitle = $('modalTitle');
  const modalSub = $('modalSub');
  const w5hGrid = $('w5hGrid');
  const modalLoading = $('modalLoading');
  const modalError = $('modalError');
  const urlHint = $('urlHint');

  // ---------- 状态 ----------
  let sessionId = null;
  let chapters = [];
  let rawMarkdown = '';
  let generating = false;

  // ---------- 生成要求面板 ----------
  reqToggle.addEventListener('click', () => {
    const open = reqToggle.getAttribute('aria-expanded') === 'true';
    reqToggle.setAttribute('aria-expanded', String(!open));
    reqWrap.hidden = open;
  });

  // 快捷维度：点击后拼入自然语言要求
  const dimMap = {
    taskType: '任务类型',
    outputStyle: '输出风格',
    audience: '目标受众',
    constraints: '约束条件',
  };
  chipRow.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    chip.classList.toggle('active');
    const dim = dimMap[chip.dataset.dim];
    const has = reqText.value.includes(dim);
    reqText.value = has
      ? reqText.value.replace(new RegExp(`【${dim}】[^\\n]*\\n?`), '').trim()
      : (reqText.value ? reqText.value.trimEnd() + '\n' : '') + `【${dim}】`;
    reqText.dispatchEvent(new Event('input'));
  });

  // ---------- 生成 ----------
  generateBtn.addEventListener('click', startGenerate);
  retryBtn.addEventListener('click', () => {
    location.reload();
  });

  async function startGenerate() {
    const url = videoUrl.value.trim();
    if (!url) {
      flashHint('请输入 YouTube 链接');
      videoUrl.focus();
      return;
    }
    const requirement = reqText.value.trim();

    setGenerating(true);
    resetArticle();

    try {
      const resp = await fetch('/api/article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, requirement }),
      });
      if (!resp.ok || !resp.body) {
        const err = await resp.text().catch(() => '');
        throw new Error(resp.ok ? '响应异常' : `服务端错误 ${resp.status}: ${err.slice(0, 200)}`);
      }
      await consumeStream(resp.body);
      finishStream();
    } catch (e) {
      setStatus('error', '生成失败');
      if (!rawMarkdown) {
        renderError(String(e && e.message ? e.message : e));
      }
    } finally {
      setGenerating(false);
    }
  }

  // ---------- SSE 消费 ----------
  async function consumeStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleEvent(rawEvent);
      }
    }
    if (buf.trim()) handleEvent(buf);
  }

  function handleEvent(raw) {
    const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) return;
    let ev;
    try {
      ev = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    switch (ev.type) {
      case 'delta':
        appendDelta(ev.text || '');
        break;
      case 'chapter':
        chapters.push({ index: ev.index, title: ev.title });
        renderToc();
        break;
      case 'meta':
        sessionId = ev.sessionId;
        if (ev.title) videoTitleEl.textContent = ev.title;
        if (ev.fallbackReason || ev.source === 'demo') {
          showFallbackBadge(ev.fallbackReason, ev.source);
        }
        if (Array.isArray(ev.chapters)) {
          chapters = ev.chapters;
          renderToc();
        }
        renderFoot();
        break;
      case 'error':
        throwMarkdownError(ev.message);
        break;
    }
  }

  // ---------- 增量渲染 ----------
  function appendDelta(text) {
    rawMarkdown += text;
    // 保持解析：将全文重新渲染会破坏流式性能，改为只追加块
    // 简单起见：定期全量重渲（delta 频率下可接受）
    renderMarkdown();
  }

  // ---------- Markdown 渲染（轻量） ----------
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inlineMd(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function renderMarkdown() {
    const lines = rawMarkdown.split('\n');
    let html = '';
    let inList = false;
    let chapterIdx = 0;

    const closeList = () => {
      if (inList) { html += '</ul>'; inList = false; }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { closeList(); continue; }

      // 章节标题
      if (/^##\s+/.test(trimmed)) {
        closeList();
        const title = trimmed.replace(/^##\s+/, '');
        html += `<div class="section-head"><h2><span class="sec-no">${chapterIdx + 1}</span><span>${inlineMd(escapeHtml(title))}</span></h2>
          <button class="w5h-btn" data-chapter="${chapterIdx}" title="该章节 5W1H 总结">[5W1H]</button></div>`;
        chapterIdx++;
        continue;
      }
      if (/^#\s+/.test(trimmed)) {
        closeList();
        html += `<h1>${inlineMd(escapeHtml(trimmed.replace(/^#\s+/, '')))}</h1>`;
        continue;
      }
      // 引用
      if (/^>\s?/.test(trimmed)) {
        closeList();
        html += `<blockquote>${inlineMd(escapeHtml(trimmed.replace(/^>\s?/, '')))}</blockquote>`;
        continue;
      }
      // 列表
      if (/^[-*]\s+/.test(trimmed)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inlineMd(escapeHtml(trimmed.replace(/^[-*]\s+/, '')))}</li>`;
        continue;
      }
      closeList();
      html += `<p>${inlineMd(escapeHtml(trimmed))}</p>`;
    }
    closeList();

    articleBody.innerHTML = html;

    // 绑定 5W1H 按钮
    articleBody.querySelectorAll('.w5h-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => openFiveW1H(Number(btn.dataset.chapter)));
    });
  }

  function throwMarkdownError(message) {
    renderError(message);
  }

  function renderError(message) {
    articleBody.innerHTML = `<div class="modal-error">生成失败：${escapeHtml(message)}</div>`;
  }

  // ---------- 目录 ----------
  function renderToc() {
    if (chapters.length === 0) return;
    toc.hidden = false;
    toc.innerHTML = chapters.map((c) => `<a href="#sec-${c.index}">${escapeHtml(c.title)}</a>`).join('');
  }

  // ---------- 降级徽章 ----------
  const reasonText = {
    youtube_empty_body: 'YouTube 返回空响应（可能被反爬拦截）',
    youtube_invalid_json: 'YouTube 返回内容无法解析',
    youtube_playability_error: '视频不可播放',
    youtube_no_caption_tracks: '该视频未提供字幕轨',
    timedtext_empty_body: '字幕轨内容为空',
    youtube_captcha: '触发 YouTube 验证码',
    youtube_rate_limited: '触发 YouTube 限流',
    youtube_network_error: 'YouTube 网络请求失败',
    proxy_failed: '代理通道不可用',
    no_captions_available: '未找到可用字幕',
  };
  function showFallbackBadge(reason, source) {
    fallbackBadge.hidden = false;
    const demoNote = source === 'demo' ? '（当前展示内置演示数据）' : '';
    fallbackBadge.textContent = `${reasonText[reason] || reason} ${demoNote}`.trim();
  }

  // ---------- 5W1H ----------
  const W5H_LABELS = ['Who', 'What', 'When', 'Where', 'Why', 'How'];
  const W5H_CN = { Who: '主体', What: '内容', When: '时间', Where: '场景', Why: '原因', How: '方式' };

  async function openFiveW1H(index) {
    if (!sessionId) {
      alert('会话未建立，请先完成生成');
      return;
    }
    openModal(index);
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/chapters/${index}/5w1h`, { method: 'POST' });
      if (resp.status === 410) {
        throw new Error('会话已过期，请重新生成');
      }
      if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        throw new Error(`5W1H 请求失败 ${resp.status}: ${err.slice(0, 160)}`);
      }
      const data = await resp.json();
      renderFiveW1H(data);
    } catch (e) {
      showModalError(e.message);
    }
  }

  function openModal(index) {
    overlay.hidden = false;
    const ch = chapters[index];
    modalTitle.textContent = '章节 5W1H 总结';
    modalSub.textContent = ch ? ch.title : `章节 ${index + 1}`;
    modalLoading.style.display = 'flex';
    modalError.hidden = true;
    w5hGrid.innerHTML = '';
  }

  function renderFiveW1H(data) {
    modalLoading.style.display = 'none';
    if (!data || typeof data !== 'object') {
      showModalError('返回数据格式异常');
      return;
    }
    const items = W5H_LABELS.map((k) => {
      const v = data[k];
      return v ? `<div class="w5h-item" data-k="${k}"><div class="k">${k} · ${W5H_CN[k]}</div><div class="v">${escapeHtml(v)}</div></div>` : '';
    }).join('');
    w5hGrid.innerHTML = items;
  }

  function showModalError(message) {
    modalLoading.style.display = 'none';
    modalError.hidden = false;
    modalError.textContent = message;
  }

  modalClose.addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });

  // ---------- 复制 ----------
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rawMarkdown);
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => { copyBtn.textContent = '复制全文'; }, 1600);
    } catch {
      copyBtn.textContent = '复制失败';
    }
  });

  // ---------- 工具 ----------
  function setGenerating(on) {
    generating = on;
    generateBtn.disabled = on;
    generateBtn.querySelector('.btn-label').textContent = on ? '正在生成…' : '生成中文对话文章';
  }

  function resetArticle() {
    rawMarkdown = '';
    chapters = [];
    sessionId = null;
    articleBody.innerHTML = '';
    toc.hidden = true;
    articleFoot.hidden = true;
    fallbackBadge.hidden = true;
    videoTitleEl.textContent = '';
    articlePanel.hidden = false;
    emptyState.hidden = true;
  }

  function finishStream() {
    setStatus('done', '生成完成');
    cursorLine.style.display = 'none';
  }

  function setStatus(state, text) {
    statusBadge.className = 'status-badge ' + state;
    statusText.textContent = text;
  }

  function flashHint(msg) {
    urlHint.textContent = msg;
    urlHint.style.color = 'var(--danger)';
    setTimeout(() => {
      urlHint.textContent = '示例：xRh2sVcNXQ8 · 需要视频本身带字幕（含自动生成字幕）';
      urlHint.style.color = '';
    }, 2200);
  }

  function renderFoot() {
    articleFoot.hidden = false;
    cursorLine.style.display = 'none';
  }

  // 空态入场
  setStatus('idle', '待命');
})();
