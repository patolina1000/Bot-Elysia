import { maskBRL, toCents, fromCents, parseDateTimeLocal } from './utils.js';

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
const plansSection = document.getElementById('shot-plans-section');
const plansList = document.getElementById('shot-plans-list');
const planAddButton = document.getElementById('shot-plan-add');
const planReorderButton = document.getElementById('shot-plan-reorder');
const plansHelper = document.getElementById('shot-plans-helper');
const previewButton = document.getElementById('shot-preview');
const previewContainer = document.getElementById('shot-preview-result');
const previewEmpty = document.getElementById('shot-preview-empty');

const state = {
  botSlug: '',
  shots: [],
  loading: false,
  editingShot: null,
  plans: [],
  planOrderDirty: false,
  scheduleContext: null,
  shotPicker: null,
  schedulePicker: null,
  shotScheduledDate: null,
  previewLoading: false,
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
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.shots)
      ? data.shots
      : Array.isArray(data?.items)
      ? data.items
      : [];
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
  state.editingShot = null;
  shotForm.reset();
  shotForm.dataset.shotId = '';
  shotForm.dataset.scheduledAt = '';
  state.shotScheduledDate = null;
  state.plans = [];
  state.planOrderDirty = false;
  state.previewLoading = false;
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
  if (plansList) {
    plansList.innerHTML = '';
  }
  clearPreview();
  updatePlanControls();
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
  const [hours = '00', minutes = '00'] = (timeString || '').split(':');
  const localValue = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(
    2,
    '0'
  )}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return parseDateTimeLocal(localValue);
}

function generateTempId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePlan(plan, index) {
  const priceCents = Number.isFinite(plan?.price_cents) ? Math.max(0, Number(plan.price_cents)) : 0;
  return {
    id: plan?.id ?? null,
    tempId: plan?.id ? `plan-${plan.id}` : generateTempId(),
    name: plan?.name ?? '',
    price_cents: priceCents,
    description: plan?.description ?? '',
    sort_order: Number.isFinite(plan?.sort_order) ? Number(plan.sort_order) : index ?? 0,
    isNew: !(plan?.id > 0),
  };
}

function setPlans(plans = []) {
  const normalized = Array.isArray(plans) ? plans.map((plan, index) => normalizePlan(plan, index)) : [];
  normalized.sort((a, b) => {
    if (a.sort_order !== b.sort_order) {
      return a.sort_order - b.sort_order;
    }
    return (a.id ?? 0) - (b.id ?? 0);
  });
  state.plans = normalized;
  state.planOrderDirty = false;
  renderPlanList();
  updatePlanControls();
}

function renderPlanList(options = {}) {
  if (!plansList) {
    return;
  }
  const hasShot = Boolean(state.editingShot?.id);
  plansList.innerHTML = '';
  if (!hasShot) {
    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent = 'Salve o disparo antes de adicionar planos.';
    plansList.appendChild(helper);
    return;
  }
  if (!Array.isArray(state.plans) || state.plans.length === 0) {
    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent = 'Nenhum plano cadastrado para este disparo.';
    plansList.appendChild(helper);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.plans.forEach((plan, index) => {
    plan.sort_order = index;
    const item = document.createElement('article');
    item.className = 'plan-item';
    item.dataset.planId = plan.tempId;
    if (!plan.id) {
      item.dataset.planNew = 'true';
    }

    const grid = document.createElement('div');
    grid.className = 'plan-item__grid';

    const nameField = document.createElement('div');
    nameField.className = 'field';
    const nameLabel = document.createElement('label');
    const nameInputId = `plan-name-${plan.tempId}`;
    nameLabel.htmlFor = nameInputId;
    nameLabel.textContent = 'Nome';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.name = 'plan-name';
    nameInput.id = nameInputId;
    nameInput.placeholder = 'Plano premium';
    nameInput.value = plan.name;
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);

    const priceField = document.createElement('div');
    priceField.className = 'field';
    const priceLabel = document.createElement('label');
    const priceInputId = `plan-price-${plan.tempId}`;
    priceLabel.htmlFor = priceInputId;
    priceLabel.textContent = 'Preço (R$)';
    const priceInput = document.createElement('input');
    priceInput.type = 'text';
    priceInput.name = 'plan-price';
    priceInput.id = priceInputId;
    priceInput.inputMode = 'numeric';
    priceInput.placeholder = 'R$ 0,00';
    priceInput.value = plan.price_cents > 0 ? fromCents(plan.price_cents) : plan.id ? fromCents(0) : '';
    priceField.appendChild(priceLabel);
    priceField.appendChild(priceInput);

    const descriptionField = document.createElement('div');
    descriptionField.className = 'field field--full';
    const descriptionLabel = document.createElement('label');
    const descriptionId = `plan-description-${plan.tempId}`;
    descriptionLabel.htmlFor = descriptionId;
    descriptionLabel.textContent = 'Descrição';
    const descriptionInput = document.createElement('textarea');
    descriptionInput.name = 'plan-description';
    descriptionInput.id = descriptionId;
    descriptionInput.rows = 2;
    descriptionInput.placeholder = 'Destaques do plano';
    descriptionInput.value = plan.description ?? '';
    descriptionField.appendChild(descriptionLabel);
    descriptionField.appendChild(descriptionInput);

    grid.appendChild(nameField);
    grid.appendChild(priceField);
    grid.appendChild(descriptionField);

    const footer = document.createElement('div');
    footer.className = 'plan-item__footer';

    const reorderGroup = document.createElement('div');
    reorderGroup.className = 'plan-item__reorder';
    const upButton = document.createElement('button');
    upButton.type = 'button';
    upButton.className = 'btn btn--ghost';
    upButton.dataset.action = 'plan-up';
    upButton.title = 'Mover para cima';
    upButton.textContent = '↑';
    upButton.disabled = index === 0;
    const downButton = document.createElement('button');
    downButton.type = 'button';
    downButton.className = 'btn btn--ghost';
    downButton.dataset.action = 'plan-down';
    downButton.title = 'Mover para baixo';
    downButton.textContent = '↓';
    downButton.disabled = index === state.plans.length - 1;
    reorderGroup.appendChild(upButton);
    reorderGroup.appendChild(downButton);

    const actions = document.createElement('div');
    actions.className = 'plan-item__actions';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'btn btn--primary';
    saveButton.dataset.action = 'plan-save';
    saveButton.textContent = plan.id ? 'Salvar' : 'Criar';
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'btn';
    removeButton.dataset.action = 'plan-remove';
    removeButton.textContent = 'Remover';
    actions.appendChild(saveButton);
    actions.appendChild(removeButton);

    footer.appendChild(reorderGroup);
    footer.appendChild(actions);

    item.appendChild(grid);
    item.appendChild(footer);

    fragment.appendChild(item);
  });

  plansList.appendChild(fragment);

  if (options.focusPlanId) {
    const targetPlan = plansList.querySelector(`[data-plan-id="${options.focusPlanId}"]`);
    if (targetPlan) {
      const focusSelector = options.focusField ? `[name="${options.focusField}"]` : 'input[name="plan-name"]';
      const focusElement = targetPlan.querySelector(focusSelector);
      if (focusElement instanceof HTMLElement) {
        focusElement.focus();
        if (focusElement instanceof HTMLInputElement || focusElement instanceof HTMLTextAreaElement) {
          const length = focusElement.value.length;
          focusElement.setSelectionRange?.(length, length);
        }
      }
    }
  }
}

function updatePlanControls() {
  const hasShot = Boolean(state.editingShot?.id);
  const hasUnsaved = state.plans.some((plan) => !plan.id);
  if (planAddButton) {
    planAddButton.disabled = !hasShot;
  }
  if (planReorderButton) {
    const shouldDisable = !hasShot || !state.planOrderDirty || state.plans.length < 2 || hasUnsaved;
    planReorderButton.disabled = shouldDisable;
    planReorderButton.title = hasShot
      ? hasUnsaved
        ? 'Salve todos os planos antes de reordenar.'
        : 'Aplicar nova ordem dos planos.'
      : 'Disponível após salvar o disparo.';
  }
  if (plansSection) {
    plansSection.classList.toggle('plans-section--disabled', !hasShot);
  }
  if (plansHelper) {
    plansHelper.hidden = hasShot;
  }
  if (previewButton) {
    previewButton.disabled = !hasShot || state.previewLoading;
  }
}

function clearPreview() {
  if (previewContainer) {
    previewContainer.innerHTML = '';
  }
  if (previewEmpty) {
    previewEmpty.hidden = false;
  }
}

function renderPreview(preview) {
  if (!previewContainer) {
    return;
  }
  previewContainer.innerHTML = '';
  let hasContent = false;
  if (previewEmpty) {
    previewEmpty.hidden = true;
  }

  if (Array.isArray(preview?.textParts) && preview.textParts.length > 0) {
    const messagesWrapper = document.createElement('div');
    messagesWrapper.className = 'preview__messages';
    preview.textParts.forEach((part, index) => {
      const message = document.createElement('article');
      message.className = 'preview__message';
      message.innerHTML = part;
      message.setAttribute('data-preview-index', String(index));
      messagesWrapper.appendChild(message);
    });
    previewContainer.appendChild(messagesWrapper);
    hasContent = true;
  }

  if (Array.isArray(preview?.keyboard) && preview.keyboard.length > 0) {
    const table = document.createElement('table');
    table.className = 'preview__keyboard';
    preview.keyboard.forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((button) => {
        const td = document.createElement('td');
        td.textContent = button?.text ?? '';
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    previewContainer.appendChild(table);
    hasContent = true;
  }

  if (preview?.media) {
    const mediaWrapper = document.createElement('div');
    mediaWrapper.className = 'preview__media';
    const iconMap = {
      photo: '🖼️',
      video: '🎬',
      audio: '🎧',
      document: '📄',
    };
    const icon = iconMap[preview.media.type] ?? '📎';
    const title = document.createElement('strong');
    title.textContent = `${icon} ${preview.media.type}`;
    const link = document.createElement('a');
    link.href = preview.media.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Abrir mídia';
    mediaWrapper.appendChild(title);
    mediaWrapper.appendChild(link);
    if (preview.media.caption) {
      const caption = document.createElement('p');
      caption.className = 'preview__caption';
      caption.innerHTML = preview.media.caption;
      mediaWrapper.appendChild(caption);
    }
    previewContainer.appendChild(mediaWrapper);
    hasContent = true;
  }

  if (!hasContent) {
    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent = 'Nenhum conteúdo para pré-visualizar.';
    previewContainer.appendChild(helper);
  }
}

function collectPlanDrafts() {
  return state.plans.map((plan) => ({
    name: plan.name?.trim() ?? '',
    price_cents: Math.max(0, Math.trunc(plan.price_cents ?? 0)),
    description: plan.description?.trim() ? plan.description.trim() : null,
  }));
}

function handleAddPlan() {
  if (!state.editingShot?.id) {
    alert('Salve o disparo antes de adicionar planos.');
    return;
  }
  const plan = normalizePlan({ id: null, name: '', price_cents: 0, description: '', sort_order: state.plans.length }, state.plans.length);
  state.plans.push(plan);
  renderPlanList({ focusPlanId: plan.tempId });
  updatePlanControls();
}

function handlePlanInputChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const container = target.closest('[data-plan-id]');
  if (!container) {
    return;
  }
  const planId = container.getAttribute('data-plan-id');
  if (!planId) {
    return;
  }
  const plan = state.plans.find((item) => item.tempId === planId);
  if (!plan) {
    return;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    switch (target.name) {
      case 'plan-name':
        plan.name = target.value;
        break;
      case 'plan-price': {
        const masked = maskBRL(target.value);
        target.value = masked;
        plan.price_cents = toCents(masked);
        break;
      }
      case 'plan-description':
        plan.description = target.value;
        break;
      default:
        break;
    }
  }
}

async function handlePlanSave(plan) {
  if (!state.editingShot?.id) {
    alert('Salve o disparo antes de gerenciar planos.');
    return;
  }
  const payload = {
    name: plan.name?.trim() || '',
    price_cents: Math.max(0, Math.trunc(plan.price_cents ?? 0)),
    description: plan.description?.trim() ? plan.description.trim() : null,
  };
  if (!payload.name) {
    alert('Informe o nome do plano.');
    return;
  }
  try {
    if (plan.id) {
      const response = await fetchJSON(`/api/shots/${encodeURIComponent(state.editingShot.id)}/plans/${plan.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const updated = response?.plan ?? null;
      if (updated) {
        Object.assign(plan, normalizePlan(updated, plan.sort_order));
      }
      showToast('Plano atualizado!');
    } else {
      const response = await fetchJSON(`/api/shots/${encodeURIComponent(state.editingShot.id)}/plans`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const created = response?.plan ?? null;
      if (created) {
        Object.assign(plan, normalizePlan(created, plan.sort_order));
      }
      showToast('Plano criado!');
    }
    renderPlanList({ focusPlanId: plan.tempId });
    updatePlanControls();
  } catch (error) {
    console.error('[shots] erro ao salvar plano', error);
    alert(error instanceof Error ? error.message : 'Erro ao salvar plano.');
  }
}

async function handlePlanRemove(plan) {
  if (!state.editingShot?.id) {
    alert('Salve o disparo antes de gerenciar planos.');
    return;
  }
  if (!plan.id) {
    state.plans = state.plans.filter((item) => item.tempId !== plan.tempId);
    renderPlanList();
    updatePlanControls();
    return;
  }
  const confirmed = window.confirm('Deseja realmente remover este plano?');
  if (!confirmed) {
    return;
  }
  try {
    await fetchJSON(`/api/shots/${encodeURIComponent(state.editingShot.id)}/plans/${plan.id}`, {
      method: 'DELETE',
    });
    state.plans = state.plans.filter((item) => item.tempId !== plan.tempId);
    showToast('Plano removido.');
    renderPlanList();
    updatePlanControls();
  } catch (error) {
    console.error('[shots] erro ao remover plano', error);
    alert(error instanceof Error ? error.message : 'Erro ao remover plano.');
  }
}

function movePlan(planId, direction) {
  const index = state.plans.findIndex((plan) => plan.tempId === planId);
  if (index < 0) {
    return;
  }
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= state.plans.length) {
    return;
  }
  const [plan] = state.plans.splice(index, 1);
  state.plans.splice(newIndex, 0, plan);
  state.planOrderDirty = true;
  const activeElement = document.activeElement;
  let focusField = null;
  if (activeElement instanceof HTMLElement) {
    const parentPlan = activeElement.closest('[data-plan-id]');
    if (parentPlan && parentPlan.getAttribute('data-plan-id') === planId) {
      focusField = activeElement.getAttribute('name');
    }
  }
  renderPlanList({ focusPlanId: plan.tempId, focusField: focusField || undefined });
  updatePlanControls();
}

function handlePlanListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action = target.dataset.action;
  if (!action) {
    return;
  }
  const container = target.closest('[data-plan-id]');
  if (!container) {
    return;
  }
  const planId = container.getAttribute('data-plan-id');
  const plan = state.plans.find((item) => item.tempId === planId);
  if (!plan) {
    return;
  }
  switch (action) {
    case 'plan-save':
      void handlePlanSave(plan);
      break;
    case 'plan-remove':
      void handlePlanRemove(plan);
      break;
    case 'plan-up':
      movePlan(plan.tempId, -1);
      break;
    case 'plan-down':
      movePlan(plan.tempId, 1);
      break;
    default:
      break;
  }
}

async function handlePlanReorder() {
  if (!state.editingShot?.id) {
    alert('Salve o disparo antes de reordenar planos.');
    return;
  }
  if (state.plans.some((plan) => !plan.id)) {
    alert('Salve todos os planos antes de atualizar a ordenação.');
    return;
  }
  try {
    const order = state.plans.map((plan) => plan.id);
    const response = await fetchJSON(`/api/shots/${encodeURIComponent(state.editingShot.id)}/plans/reorder`, {
      method: 'POST',
      body: JSON.stringify({ order }),
    });
    const plans = Array.isArray(response?.plans) ? response.plans : state.plans;
    setPlans(plans);
    showToast('Ordenação salva!');
  } catch (error) {
    console.error('[shots] erro ao reordenar planos', error);
    alert(error instanceof Error ? error.message : 'Erro ao reordenar planos.');
  }
}

async function loadPlansForShot(shotId) {
  if (!shotId) {
    setPlans([]);
    return;
  }
  if (plansList) {
    plansList.innerHTML = '';
    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent = 'Carregando planos...';
    plansList.appendChild(helper);
  }
  try {
    const response = await fetchJSON(`/api/shots/${encodeURIComponent(shotId)}/plans`);
    const plans = Array.isArray(response?.plans) ? response.plans : [];
    setPlans(plans);
  } catch (error) {
    console.error('[shots] erro ao carregar planos', error);
    if (plansList) {
      plansList.innerHTML = '';
      const helper = document.createElement('p');
      helper.className = 'helper helper--error';
      helper.textContent = error instanceof Error ? error.message : 'Erro ao carregar planos.';
      plansList.appendChild(helper);
    }
    updatePlanControls();
  }
}

async function handlePreviewClick() {
  if (!state.editingShot?.id) {
    alert('Salve o disparo antes de gerar a pré-visualização.');
    return;
  }
  if (state.previewLoading) {
    return;
  }
  const payload = {};
  if (shotTitleInput) {
    payload.title = shotTitleInput.value.trim();
  }
  if (shotCopyTextarea) {
    payload.copy = shotCopyTextarea.value;
  }
  if (shotMediaTypeSelect) {
    payload.media_type = shotMediaTypeSelect.value || 'none';
  }
  if (shotMediaUrlInput) {
    const mediaUrl = shotMediaUrlInput.value.trim();
    payload.media_url = mediaUrl || null;
  }
  const plans = collectPlanDrafts();
  if (plans.length > 0) {
    payload.plans = plans;
  }
  if (previewContainer) {
    previewContainer.innerHTML = '';
    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent = 'Gerando pré-visualização...';
    previewContainer.appendChild(helper);
  }
  if (previewEmpty) {
    previewEmpty.hidden = true;
  }
  state.previewLoading = true;
  updatePlanControls();
  try {
    const response = await fetchJSON(`/api/shots/${encodeURIComponent(state.editingShot.id)}/preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    renderPreview(response?.preview ?? null);
  } catch (error) {
    console.error('[shots] erro ao gerar preview', error);
    if (previewContainer) {
      previewContainer.innerHTML = '';
      const helper = document.createElement('p');
      helper.className = 'helper helper--error';
      helper.textContent = error instanceof Error ? error.message : 'Erro ao gerar pré-visualização.';
      previewContainer.appendChild(helper);
    }
  } finally {
    state.previewLoading = false;
    updatePlanControls();
  }
}

async function openShotModalForEdit(shotId) {
  if (!shotId) {
    return;
  }
  const fallback = state.shots.find((item) => String(item?.id) === String(shotId)) || null;
  try {
    const response = await fetchJSON(`/api/shots/${encodeURIComponent(shotId)}`);
    const shot = response?.shot ?? fallback ?? null;
    if (!shot) {
      throw new Error('Disparo não encontrado.');
    }
    const plans = Array.isArray(response?.plans) ? response.plans : [];
    const index = state.shots.findIndex((item) => String(item?.id) === String(shot.id));
    if (index >= 0) {
      state.shots[index] = { ...state.shots[index], ...shot };
    }
    openShotModal(shot, plans);
  } catch (error) {
    console.error('[shots] erro ao carregar disparo', error);
    if (fallback) {
      openShotModal(fallback, []);
      alert(error instanceof Error ? error.message : 'Erro ao carregar planos do disparo.');
    } else {
      alert(error instanceof Error ? error.message : 'Erro ao carregar disparo.');
    }
  }
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

function openShotModal(shot = null, plans = null) {
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
  if (plans !== null) {
    setPlans(plans);
  } else if (shot?.id) {
    void loadPlansForShot(shot.id);
  } else {
    setPlans([]);
  }
  clearPreview();
  openDialog(shotModal);
  queueMicrotask(() => {
    if (shotTargetInput && typeof shotTargetInput.focus === 'function') {
      try {
        shotTargetInput.focus({ preventScroll: true });
      } catch (error) {
        shotTargetInput.focus();
      }
    }
  });
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
      void openShotModalForEdit(shotId);
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

function handleShotFormKeydown(event) {
  if (event.isComposing) {
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    hideShotDatepicker();
    closeDialog(shotModal);
    return;
  }

  if (event.key !== 'Enter') {
    return;
  }
  if (event.defaultPrevented) {
    return;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (target.tagName === 'TEXTAREA') {
    return;
  }
  if (target.closest('#shot-plans-section')) {
    return;
  }
  event.preventDefault();
  shotForm?.requestSubmit();
}

function handleScheduleFormKeydown(event) {
  if (event.isComposing) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog(scheduleModal);
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
  shotForm.addEventListener('keydown', handleShotFormKeydown);
}

if (shotModal) {
  shotModal.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog(shotModal);
  });
  shotModal.addEventListener('close', () => {
    hideShotDatepicker();
  });
  shotModal.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.action === 'close') {
      closeDialog(shotModal);
    }
  });
}

if (planAddButton) {
  planAddButton.addEventListener('click', handleAddPlan);
}

if (planReorderButton) {
  planReorderButton.addEventListener('click', handlePlanReorder);
}

if (plansList) {
  plansList.addEventListener('input', handlePlanInputChange);
  plansList.addEventListener('click', handlePlanListClick);
}

if (previewButton) {
  previewButton.addEventListener('click', handlePreviewClick);
}

if (scheduleForm) {
  scheduleForm.addEventListener('submit', handleScheduleSubmit);
  scheduleForm.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.action === 'close') {
      closeDialog(scheduleModal);
    }
  });
  scheduleForm.addEventListener('keydown', handleScheduleFormKeydown);
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

updatePlanControls();

setupShotPicker();
setupSchedulePicker();

if (state.botSlug) {
  void loadShots({ silent: false });
}

setInterval(updateRelativeLabels, 30_000);

document.addEventListener('click', handleDocumentClick);
