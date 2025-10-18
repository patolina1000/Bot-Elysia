const tokenInput = document.getElementById('admin-token');
const slugInput = document.getElementById('shots-bot-slug');
const loadBtn = document.getElementById('btn-load-shots');
const reloadBtn = document.getElementById('btn-reload-shots');
const newShotBtn = document.getElementById('btn-new-shot');
const shotsGrid = document.getElementById('shots-grid');
const placeholderEl = document.getElementById('shots-placeholder');
const toastEl = document.getElementById('toast');
const shotModal = document.getElementById('shot-modal');
const shotForm = document.getElementById('shot-form');
const shotModalTitle = document.getElementById('shot-modal-title');
const shotTargetInput = document.getElementById('shot-target');
const shotTitleInput = document.getElementById('shot-title');
const shotCopyTextarea = document.getElementById('shot-copy');
const shotCopyCount = document.getElementById('shot-copy-count');
const shotCopyWarning = document.getElementById('shot-copy-warning');
const shotMediaTypeSelect = document.getElementById('shot-media-type');
const shotMediaUrlInput = document.getElementById('shot-media-url');
const shotScheduledInput = document.getElementById('shot-scheduled-at');
const shotDatepickerPanel = document.getElementById('shot-datepicker');
const shotDatepickerContainer = shotDatepickerPanel?.querySelector('[data-datepicker="shot"]') ?? null;
const shotTimeInput = document.getElementById('shot-time');
const scheduleModal = document.getElementById('schedule-modal');
const scheduleForm = document.getElementById('schedule-form');
const scheduleDatepickerContainer = document.getElementById('schedule-datepicker');
const scheduleTimeInput = document.getElementById('schedule-time');

const state = {
  botSlug: '',
  shots: [],
  loading: false,
  editingShot: null,
  scheduleContext: null,
  shotPicker: null,
  schedulePicker: null,
  shotScheduledDate: null,
};

let ADMIN_TOKEN = localStorage.getItem('admin_token') || '';
let SAVED_SHOT_SLUG = localStorage.getItem('shots_bot_slug') || '';
let toastTimer = null;

if (tokenInput && ADMIN_TOKEN) {
  tokenInput.value = ADMIN_TOKEN;
}

if (slugInput && SAVED_SHOT_SLUG) {
  slugInput.value = SAVED_SHOT_SLUG;
  state.botSlug = SAVED_SHOT_SLUG;
}

function setBotSlug(value) {
  const normalized = (value || '').trim();
  state.botSlug = normalized;
  if (normalized) {
    localStorage.setItem('shots_bot_slug', normalized);
  } else {
    localStorage.removeItem('shots_bot_slug');
  }
}

function getAdminToken() {
  return (ADMIN_TOKEN || '').trim();
}

function setAdminToken(value) {
  ADMIN_TOKEN = (value || '').trim();
  if (ADMIN_TOKEN) {
    localStorage.setItem('admin_token', ADMIN_TOKEN);
  } else {
    localStorage.removeItem('admin_token');
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message) {
  if (!message) {
    return;
  }
  if (!toastEl) {
    alert(message);
    return;
  }
  toastEl.textContent = message;
  toastEl.classList.add('show');
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3200);
}

async function fetchJSON(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAdminToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const isBodyProvided = options.body && !(options.body instanceof FormData);
  if (isBodyProvided && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const errorMessage = data?.error || data?.message || `Falha na requisição (${response.status}).`;
    throw new Error(errorMessage);
  }
  return data;
}

function renderPlaceholder(message, options = {}) {
  if (!placeholderEl) {
    return;
  }
  placeholderEl.textContent = message;
  placeholderEl.classList.remove('hidden');
  placeholderEl.dataset.state = options.state || 'idle';
  if (shotsGrid) {
    shotsGrid.innerHTML = '';
  }
}

function hidePlaceholder() {
  if (placeholderEl) {
    placeholderEl.classList.add('hidden');
  }
}

function formatAbsoluteDate(value) {
  if (!value) {
    return 'Sem agendamento';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Sem agendamento';
  }
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function formatRelativeDate(value) {
  if (!value) {
    return '';
  }
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) {
    return '';
  }
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  const diffSeconds = Math.round(diffMs / 1000);
  const diffMinutes = Math.round(diffSeconds / 60);
  const diffHours = Math.round(diffMinutes / 60);
  const diffDays = Math.round(diffHours / 24);

  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  if (Math.abs(diffSeconds) < 60) {
    return rtf.format(diffSeconds, 'second');
  }
  if (Math.abs(diffMinutes) < 60) {
    return rtf.format(diffMinutes, 'minute');
  }
  if (Math.abs(diffHours) < 24) {
    return rtf.format(diffHours, 'hour');
  }
  return rtf.format(diffDays, 'day');
}

function updateRelativeLabels() {
  if (!shotsGrid) {
    return;
  }
  const elements = shotsGrid.querySelectorAll('[data-timestamp]');
  const now = Date.now();
  elements.forEach((element) => {
    const timestamp = element.getAttribute('data-timestamp');
    if (!timestamp) {
      return;
    }
    const absolute = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(absolute)) {
      element.textContent = '';
      return;
    }
    const diff = formatRelativeDate(new Date(absolute));
    const absoluteLabel = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(absolute));
    element.textContent = diff ? `${diff} · ${absoluteLabel}` : absoluteLabel;
    element.dataset.now = String(now);
  });
}

function buildStatsBadges(shot) {
  const stats = shot?.stats || shot;
  const items = [
    { label: 'Fila', value: Number(stats?.queued ?? stats?.queue ?? 0), className: 'badge--neutral' },
    { label: 'Processando', value: Number(stats?.processing ?? 0), className: 'badge--warning' },
    { label: 'Sucesso', value: Number(stats?.success ?? stats?.sent ?? 0), className: 'badge--success' },
    { label: 'Erro', value: Number(stats?.error ?? stats?.failed ?? 0), className: 'badge--error' },
  ];
  return items
    .filter((item) => Number.isFinite(item.value))
    .map((item) => {
      return `<span class="badge ${item.className}">${escapeHtml(item.label)}: ${escapeHtml(item.value)}</span>`;
    })
    .join('');
}

function renderShots(items) {
  if (!shotsGrid || !placeholderEl) {
    return;
  }

  shotsGrid.innerHTML = '';

  if (!Array.isArray(items) || items.length === 0) {
    renderPlaceholder('Nenhum disparo encontrado para este bot.', { state: 'empty' });
    return;
  }

  hidePlaceholder();

  const fragments = document.createDocumentFragment();
  items.forEach((shot) => {
    const card = document.createElement('article');
    card.className = 'shot-card';
    card.dataset.shotId = shot?.id ?? '';
    const title = escapeHtml(shot?.title || 'Sem título');
    const target = escapeHtml(shot?.target || '—');
    const scheduledAt = shot?.scheduled_at || shot?.scheduledAt || null;
    const scheduledDate = scheduledAt ? new Date(scheduledAt) : null;
    const scheduledTimestamp = scheduledDate ? scheduledDate.getTime() : null;
    const relative = scheduledTimestamp ? formatRelativeDate(scheduledDate) : '';
    const absolute = scheduledTimestamp
      ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(scheduledDate)
      : 'Sem agendamento';
    const statusBadges = buildStatsBadges(shot);

    card.innerHTML = `
      <div class="shot-card__header">
        <h3 class="shot-card__title">${title}</h3>
        <span class="badge">${target}</span>
      </div>
      <div class="shot-card__meta">
        <div>
          <strong>Agendado:</strong>
          <span class="shot-card__scheduled" data-timestamp="${scheduledTimestamp ?? ''}">${
            scheduledTimestamp ? `${escapeHtml(relative)} · ${escapeHtml(absolute)}` : 'Sem agendamento'
          }</span>
        </div>
      </div>
      <div class="shot-card__stats">${statusBadges}</div>
      <div class="shot-card__actions">
        <button type="button" class="btn btn--ghost" data-action="edit" data-id="${escapeHtml(shot?.id ?? '')}">Editar</button>
        <button type="button" class="btn" data-action="duplicate" data-id="${escapeHtml(shot?.id ?? '')}">Duplicar</button>
        <button type="button" class="btn" data-action="delete" data-id="${escapeHtml(shot?.id ?? '')}">Excluir</button>
        <button type="button" class="btn btn--primary" data-action="trigger-now" data-id="${escapeHtml(
          shot?.id ?? '',
        )}">Disparar agora</button>
        <button type="button" class="btn" data-action="schedule" data-id="${escapeHtml(shot?.id ?? '')}">Agendar</button>
      </div>
    `;

    fragments.appendChild(card);
  });

  shotsGrid.appendChild(fragments);
  updateRelativeLabels();
}

async function loadShots(options = {}) {
  if (!state.botSlug) {
    renderPlaceholder('Informe o slug do bot para carregar os disparos.', { state: 'idle' });
    return;
  }
  if (state.loading) {
    return;
  }
  state.loading = true;
  if (!options?.silent) {
    renderPlaceholder('Carregando disparos...', { state: 'loading' });
  }
  try {
    const data = await fetchJSON(`/api/shots?bot_slug=${encodeURIComponent(state.botSlug)}`);
    const list = Array.isArray(data) ? data : Array.isArray(data?.shots) ? data.shots : [];
    state.shots = list;
    renderShots(list);
  } catch (error) {
    console.error('[shots] erro ao carregar lista', error);
    renderPlaceholder(error instanceof Error ? error.message : 'Falha ao carregar disparos.', { state: 'error' });
  } finally {
    state.loading = false;
  }
}

function closeDialog(dialog) {
  if (dialog && typeof dialog.close === 'function') {
    dialog.close();
  }
}

function openDialog(dialog) {
  if (dialog && typeof dialog.showModal === 'function') {
    dialog.showModal();
  }
}

function resetShotForm() {
  if (!shotForm) {
    return;
  }
  shotForm.reset();
  shotForm.dataset.shotId = '';
  shotForm.dataset.scheduledAt = '';
  state.shotScheduledDate = null;
  if (shotScheduledInput) {
    shotScheduledInput.value = '';
    shotScheduledInput.placeholder = 'Sem agendamento';
  }
  if (shotTimeInput) {
    shotTimeInput.value = '';
  }
  if (shotCopyCount) {
    shotCopyCount.textContent = '0';
  }
  if (shotCopyWarning) {
    shotCopyWarning.hidden = true;
  }
  hideShotDatepicker();
}

function formatInputDateLabel(date, timeString) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Sem agendamento';
  }
  const [hours = '00', minutes = '00'] = (timeString || '').split(':');
  const labelDate = new Date(date);
  labelDate.setHours(Number.parseInt(hours, 10) || 0, Number.parseInt(minutes, 10) || 0, 0, 0);
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(labelDate);
}

function combineDateAndTime(date, timeString) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  const [hours, minutes] = (timeString || '').split(':');
  const combined = new Date(date);
  combined.setHours(Number.parseInt(hours ?? '0', 10) || 0, Number.parseInt(minutes ?? '0', 10) || 0, 0, 0);
  return combined;
}

function setShotScheduled(date, timeString) {
  state.shotScheduledDate = date instanceof Date ? new Date(date) : null;
  const combined = date ? combineDateAndTime(date, timeString) : null;
  if (shotForm) {
    shotForm.dataset.scheduledAt = combined ? combined.toISOString() : '';
  }
  if (shotScheduledInput) {
    shotScheduledInput.value = combined ? formatInputDateLabel(date, timeString) : '';
  }
  if (shotTimeInput) {
    shotTimeInput.value = timeString || '';
  }
}

function openShotModal(shot = null) {
  resetShotForm();
  state.editingShot = shot;
  if (shotModalTitle) {
    shotModalTitle.textContent = shot ? 'Editar disparo' : 'Novo disparo';
  }
  if (shotTargetInput) {
    shotTargetInput.value = shot?.target ?? '';
  }
  if (shotTitleInput) {
    shotTitleInput.value = shot?.title ?? '';
  }
  if (shotCopyTextarea) {
    shotCopyTextarea.value = shot?.copy ?? '';
    updateCopyCounter();
  }
  if (shotMediaTypeSelect) {
    shotMediaTypeSelect.value = shot?.media_type ?? shot?.mediaType ?? '';
  }
  if (shotMediaUrlInput) {
    shotMediaUrlInput.value = shot?.media_url ?? shot?.mediaUrl ?? '';
  }
  if (shotForm) {
    shotForm.dataset.shotId = shot?.id ?? '';
  }
  const scheduledAt = shot?.scheduled_at ?? shot?.scheduledAt ?? '';
  if (scheduledAt) {
    const date = new Date(scheduledAt);
    if (!Number.isNaN(date.getTime())) {
      const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      if (shotTimeInput) {
        shotTimeInput.value = time;
      }
      if (shotScheduledInput) {
        shotScheduledInput.value = formatInputDateLabel(date, time);
      }
      if (shotForm) {
        shotForm.dataset.scheduledAt = date.toISOString();
      }
      state.shotScheduledDate = date;
      if (state.shotPicker) {
        state.shotPicker.setSelected(date);
      }
    }
  }
  openDialog(shotModal);
}

function hideShotDatepicker() {
  if (shotDatepickerPanel) {
    shotDatepickerPanel.classList.add('hidden');
  }
}

function toggleShotDatepicker(forceOpen) {
  if (!shotDatepickerPanel) {
    return;
  }
  const shouldShow = typeof forceOpen === 'boolean' ? forceOpen : shotDatepickerPanel.classList.contains('hidden');
  shotDatepickerPanel.classList.toggle('hidden', !shouldShow);
  if (shouldShow && state.shotPicker) {
    const baseDate = state.shotScheduledDate instanceof Date ? state.shotScheduledDate : new Date();
    state.shotPicker.setView(baseDate);
    state.shotPicker.setSelected(state.shotScheduledDate);
  }
}

function setupDatepicker(root, options = {}) {
  if (!root) {
    return null;
  }
  const locale = 'pt-BR';
  const weekdays = Array.from({ length: 7 }).map((_, index) => {
    const date = new Date(Date.UTC(2021, 5, index + 6)); // start on Sunday
    return new Intl.DateTimeFormat(locale, { weekday: 'short' })
      .format(date)
      .replace('.', '')
      .replace(/\b([a-z])/giu, (match) => match.toUpperCase());
  });
  const minDate = options.minDate instanceof Date ? startOfDay(options.minDate) : startOfDay(new Date());
  const state = {
    selected: options.initialDate instanceof Date ? options.initialDate : null,
    viewDate: options.initialDate instanceof Date ? options.initialDate : new Date(),
    minDate,
  };

  root.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'datepicker__header';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'btn btn--ghost';
  prevBtn.textContent = '‹';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn btn--ghost';
  nextBtn.textContent = '›';
  const title = document.createElement('h3');
  header.append(prevBtn, title, nextBtn);

  const weekdaysRow = document.createElement('div');
  weekdaysRow.className = 'datepicker__grid';
  weekdays.forEach((weekday) => {
    const cell = document.createElement('div');
    cell.className = 'datepicker__weekday';
    cell.textContent = weekday;
    weekdaysRow.appendChild(cell);
  });

  const daysGrid = document.createElement('div');
  daysGrid.className = 'datepicker__grid';

  root.append(header, weekdaysRow, daysGrid);

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function isPast(date) {
    return startOfDay(date).getTime() < state.minDate.getTime();
  }

  function setView(date) {
    if (!(date instanceof Date)) {
      return;
    }
    state.viewDate = new Date(date.getFullYear(), date.getMonth(), 1);
    render();
  }

  function setSelected(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      state.selected = null;
    } else {
      state.selected = new Date(date);
      state.viewDate = new Date(date.getFullYear(), date.getMonth(), 1);
    }
    render();
  }

  function setMinDate(date) {
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      state.minDate = startOfDay(date);
      render();
    }
  }

  function render() {
    const formatter = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
    title.textContent = formatter.format(state.viewDate);
    daysGrid.innerHTML = '';
    const firstDayOfMonth = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth(), 1);
    const startWeekday = firstDayOfMonth.getDay();
    const totalDays = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 0).getDate();

    for (let i = 0; i < startWeekday; i += 1) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'datepicker__day';
      emptyCell.setAttribute('aria-hidden', 'true');
      emptyCell.style.visibility = 'hidden';
      daysGrid.appendChild(emptyCell);
    }

    for (let day = 1; day <= totalDays; day += 1) {
      const cellDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth(), day);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'datepicker__day';
      button.textContent = String(day);
      const isToday = startOfDay(cellDate).getTime() === startOfDay(new Date()).getTime();
      if (isToday) {
        button.classList.add('datepicker__day--today');
      }
      if (state.selected && startOfDay(state.selected).getTime() === startOfDay(cellDate).getTime()) {
        button.classList.add('datepicker__day--selected');
      }
      if (isPast(cellDate)) {
        button.disabled = true;
      }
      button.addEventListener('click', () => {
        state.selected = new Date(cellDate);
        render();
        options.onSelect?.(new Date(cellDate));
      });
      daysGrid.appendChild(button);
    }
  }

  prevBtn.addEventListener('click', () => {
    const newDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() - 1, 1);
    setView(newDate);
  });

  nextBtn.addEventListener('click', () => {
    const newDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 1);
    setView(newDate);
  });

  render();

  return {
    setSelected,
    getSelected() {
      return state.selected ? new Date(state.selected) : null;
    },
    setView,
    setMinDate,
  };
}

function setupShotPicker() {
  if (!shotDatepickerContainer) {
    return;
  }
  state.shotPicker = setupDatepicker(shotDatepickerContainer, {
    onSelect(date) {
      if (shotTimeInput && !shotTimeInput.value) {
        const now = new Date();
        shotTimeInput.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      }
      setShotScheduled(date, shotTimeInput?.value || '');
    },
  });
}

function setupSchedulePicker() {
  if (!scheduleDatepickerContainer) {
    return;
  }
  state.schedulePicker = setupDatepicker(scheduleDatepickerContainer, {
    onSelect(date) {
      if (scheduleTimeInput && !scheduleTimeInput.value) {
        const now = new Date();
        scheduleTimeInput.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      }
    },
  });
}

function updateCopyCounter() {
  if (!shotCopyTextarea) {
    return;
  }
  const length = shotCopyTextarea.value.length;
  if (shotCopyCount) {
    shotCopyCount.textContent = String(length);
  }
  if (shotCopyWarning) {
    shotCopyWarning.hidden = length <= 1024;
  }
}

function getShotPayloadFromForm() {
  const payload = {
    target: shotTargetInput?.value?.trim() || '',
    title: shotTitleInput?.value?.trim() || '',
    copy: shotCopyTextarea?.value || '',
    media_type: shotMediaTypeSelect?.value || '',
    media_url: shotMediaUrlInput?.value?.trim() || '',
    scheduled_at: shotForm?.dataset?.scheduledAt || null,
    bot_slug: state.botSlug,
  };
  if (!payload.target) {
    throw new Error('Informe o target do disparo.');
  }
  if (!payload.title) {
    throw new Error('Informe o título do disparo.');
  }
  if (!payload.copy) {
    throw new Error('Informe a mensagem do disparo.');
  }
  if (payload.media_url && !/^https?:\/\//i.test(payload.media_url)) {
    throw new Error('Informe uma URL de mídia válida (http/https).');
  }
  if (!state.botSlug) {
    throw new Error('Informe o slug do bot antes de salvar.');
  }
  return payload;
}

async function saveShot(event) {
  event.preventDefault();
  try {
    const payload = getShotPayloadFromForm();
    const shotId = shotForm?.dataset?.shotId;
    const method = shotId ? 'PUT' : 'POST';
    const url = shotId ? `/api/shots/${encodeURIComponent(shotId)}` : '/api/shots';
    await fetchJSON(url, {
      method,
      body: JSON.stringify(payload),
    });
    closeDialog(shotModal);
    showToast(shotId ? 'Disparo atualizado!' : 'Disparo criado!');
    await loadShots({ silent: true });
  } catch (error) {
    console.error('[shots] erro ao salvar', error);
    alert(error instanceof Error ? error.message : 'Erro ao salvar disparo.');
  }
}

async function deleteShot(id) {
  if (!id) {
    return;
  }
  const confirmed = window.confirm('Deseja realmente excluir este disparo?');
  if (!confirmed) {
    return;
  }
  try {
    await fetchJSON(`/api/shots/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Disparo excluído.');
    await loadShots({ silent: true });
  } catch (error) {
    console.error('[shots] erro ao excluir', error);
    alert(error instanceof Error ? error.message : 'Erro ao excluir disparo.');
  }
}

async function duplicateShot(id) {
  if (!id) {
    return;
  }
  try {
    await fetchJSON(`/api/shots/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
    showToast('Disparo duplicado.');
    await loadShots({ silent: true });
  } catch (error) {
    console.error('[shots] erro ao duplicar', error);
    alert(error instanceof Error ? error.message : 'Erro ao duplicar disparo.');
  }
}

function formatTriggerStats(stats = {}) {
  const cand = Number(stats?.cand ?? stats?.candidates ?? 0);
  const ins = Number(stats?.ins ?? stats?.inserted ?? 0);
  const dup = Number(stats?.dup ?? stats?.duplicates ?? 0);
  return `cand: ${cand} · ins: ${ins} · dup: ${dup}`;
}

async function triggerShot(id, mode, scheduledAt = null) {
  if (!id) {
    return;
  }
  try {
    const body = { mode };
    if (scheduledAt) {
      body.scheduled_at = scheduledAt;
    }
    const result = await fetchJSON(`/api/shots/${encodeURIComponent(id)}/trigger`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const statsLabel = formatTriggerStats(result?.stats || result);
    if (mode === 'schedule') {
      showToast(`Disparo agendado (${statsLabel}).`);
    } else {
      showToast(`Disparo enviado (${statsLabel}).`);
    }
    await loadShots({ silent: true });
  } catch (error) {
    console.error('[shots] erro ao disparar', error);
    alert(error instanceof Error ? error.message : 'Erro ao acionar disparo.');
  }
}

function openScheduleModalForShot(shotId) {
  if (!state.schedulePicker) {
    return;
  }
  const baseDate = new Date();
  state.schedulePicker.setMinDate(baseDate);
  state.schedulePicker.setSelected(baseDate);
  if (scheduleTimeInput) {
    const now = new Date();
    scheduleTimeInput.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
  state.scheduleContext = { shotId };
  openDialog(scheduleModal);
}

function validateScheduleSelection(date, timeString) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Selecione um dia válido.');
  }
  if (!timeString) {
    throw new Error('Informe um horário.');
  }
  const combined = combineDateAndTime(date, timeString);
  if (!combined || Number.isNaN(combined.getTime())) {
    throw new Error('Data ou horário inválidos.');
  }
  if (combined.getTime() <= Date.now()) {
    throw new Error('Escolha um horário futuro para o agendamento.');
  }
  return combined;
}

async function handleScheduleSubmit(event) {
  event.preventDefault();
  try {
    const date = state.schedulePicker?.getSelected();
    const time = scheduleTimeInput?.value || '';
    const combined = validateScheduleSelection(date, time);
    const shotId = state.scheduleContext?.shotId;
    if (!shotId) {
      throw new Error('Nenhum disparo selecionado para agendamento.');
    }
    await triggerShot(shotId, 'schedule', combined.toISOString());
    closeDialog(scheduleModal);
  } catch (error) {
    console.error('[shots] erro ao agendar', error);
    alert(error instanceof Error ? error.message : 'Erro ao agendar disparo.');
  }
}

function handleShotActions(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action = target.getAttribute('data-action');
  if (!action) {
    return;
  }
  const shotId = target.getAttribute('data-id');
  switch (action) {
    case 'edit': {
      const shot = state.shots.find((item) => String(item?.id) === String(shotId));
      openShotModal(shot || null);
      break;
    }
    case 'delete':
      void deleteShot(shotId);
      break;
    case 'duplicate':
      void duplicateShot(shotId);
      break;
    case 'trigger-now':
      void triggerShot(shotId, 'now');
      break;
    case 'schedule':
      openScheduleModalForShot(shotId);
      break;
    default:
      break;
  }
}

function handleShotDatepickerClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action = target.getAttribute('data-action');
  if (!action) {
    return;
  }
  switch (action) {
    case 'open-datepicker':
      toggleShotDatepicker(true);
      break;
    case 'apply-date': {
      const selected = state.shotPicker?.getSelected();
      const time = shotTimeInput?.value || '';
      if (!selected) {
        alert('Selecione um dia para agendar.');
        return;
      }
      if (!time) {
        alert('Informe um horário para agendar.');
        return;
      }
      const combined = combineDateAndTime(selected, time);
      if (!combined || combined.getTime() <= Date.now()) {
        alert('Escolha um horário futuro para o agendamento.');
        return;
      }
      setShotScheduled(selected, time);
      hideShotDatepicker();
      break;
    }
    case 'clear-date':
      setShotScheduled(null, '');
      hideShotDatepicker();
      break;
    case 'close':
      hideShotDatepicker();
      break;
    default:
      break;
  }
}

function handleDocumentClick(event) {
  if (!shotDatepickerPanel || shotDatepickerPanel.classList.contains('hidden')) {
    return;
  }
  if (!shotDatepickerPanel.contains(event.target) && event.target !== shotScheduledInput) {
    const button = shotForm?.querySelector('[data-action="open-datepicker"]');
    if (event.target !== button) {
      hideShotDatepicker();
    }
  }
}

if (tokenInput) {
  tokenInput.addEventListener('input', (event) => {
    setAdminToken(event.target.value);
  });
}

if (slugInput) {
  slugInput.addEventListener('input', (event) => {
    setBotSlug(event.target.value);
  });
}

if (loadBtn) {
  loadBtn.addEventListener('click', () => {
    setBotSlug(slugInput?.value || '');
    void loadShots();
  });
}

if (reloadBtn) {
  reloadBtn.addEventListener('click', () => {
    void loadShots({ silent: false });
  });
}

if (newShotBtn) {
  newShotBtn.addEventListener('click', () => {
    if (!state.botSlug) {
      alert('Informe o slug do bot antes de criar um disparo.');
      return;
    }
    openShotModal();
  });
}

if (shotsGrid) {
  shotsGrid.addEventListener('click', handleShotActions);
}

if (shotForm) {
  shotForm.addEventListener('submit', saveShot);
  shotForm.addEventListener('click', handleShotDatepickerClick);
}

if (shotModal) {
  shotModal.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.action === 'close') {
      closeDialog(shotModal);
    }
  });
}

if (scheduleForm) {
  scheduleForm.addEventListener('submit', handleScheduleSubmit);
  scheduleForm.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.action === 'close') {
      closeDialog(scheduleModal);
    }
  });
}

if (shotCopyTextarea) {
  ['input', 'change'].forEach((type) => {
    shotCopyTextarea.addEventListener(type, updateCopyCounter);
  });
}

if (shotTimeInput) {
  shotTimeInput.addEventListener('change', () => {
    const selected = state.shotPicker?.getSelected();
    if (selected) {
      setShotScheduled(selected, shotTimeInput.value);
    }
  });
}

if (scheduleTimeInput) {
  scheduleTimeInput.addEventListener('change', () => {
    // just ensure leading zeros when user leaves field empty
    const [hours = '00', minutes = '00'] = (scheduleTimeInput.value || '').split(':');
    scheduleTimeInput.value = `${String(Number.parseInt(hours, 10) || 0).padStart(2, '0')}:${String(
      Number.parseInt(minutes, 10) || 0,
    ).padStart(2, '0')}`;
  });
}

setupShotPicker();
setupSchedulePicker();

if (state.botSlug) {
  void loadShots({ silent: false });
}

setInterval(updateRelativeLabels, 30_000);

document.addEventListener('click', handleDocumentClick);
