'use strict';

/* ───────────── Telegram ───────────── */
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
tg?.setHeaderColor?.('#2d3330');
tg?.setBackgroundColor?.('#ffffff');

const $ = selector => document.querySelector(selector);

const installButton = $('#install-shortcut');
const installStatus = $('#install-status');
const homeScreenApiAvailable = Boolean(tg?.isVersionAtLeast?.('8.0') && tg.addToHomeScreen && tg.checkHomeScreenStatus);

if (homeScreenApiAvailable) {
  installButton.hidden = false;
  tg.checkHomeScreenStatus(status => {
    if (status === 'added') {
      installButton.hidden = true;
      installStatus.textContent = 'Ярлык расписания уже добавлен на главный экран.';
    } else if (status === 'missed' || status === 'unknown') {
      installButton.hidden = false;
      installStatus.textContent = status === 'unknown'
        ? 'Нажмите, чтобы Telegram предложил добавить ярлык с логотипом бота.'
        : 'Добавьте расписание на главный экран и открывайте его одним нажатием.';
    } else {
      installButton.hidden = true;
      installStatus.textContent = 'Добавление ярлыка не поддерживается этой версией Telegram или устройством.';
    }
  });
  tg.onEvent?.('homeScreenAdded', () => {
    installButton.hidden = true;
    installStatus.textContent = 'Готово! Ярлык расписания добавлен на главный экран.';
  });
}

installButton.addEventListener('click', () => {
  if (!homeScreenApiAvailable) return;
  installStatus.textContent = 'Telegram откроет системное подтверждение добавления ярлыка.';
  tg.addToHomeScreen();
});

/* ───────────── Константы ───────────── */
const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const dayLong = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const ruDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const ruWeek = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const termStart = new Date(2026, 8, 1);
const termEnd = new Date(2026, 11, 28);
const courseConfigs = {
  '1': { label: '1 курс · 2026/27', file: './data/schedule-source.xlsx' },
  '2': { label: '2 курс · 2026/27', file: './data/schedule-source-2.xlsx' }
};
const localStoragePrefix = 'bntu-local-';
const weekdays = new Map(dayLong.map((day, index) => [day, index]));
const groupCodePattern = /(?<!\d)(1\d{5}(?:25|26))(?!\d)/;
const TIME_SOURCE = String.raw`(?<!\d)(\d{1,2})[.:](\d{2})(?!\d)`;
const timeRegex = () => new RegExp(TIME_SOURCE, 'g');
const weekMarkerRegex = () => /(?<!\d)([12])\s*(?:нед\.?|недел\w*)/gi;
const facultyNames = {
  'АТФ': 'Автотракторный факультет',
  'ФГДИЭ': 'Факультет горного дела и инженерной экологии',
  'МСФ': 'Машиностроительный факультет',
  'МТФ': 'Механико-технологический факультет',
  'ФММП': 'Факультет маркетинга, менеджмента и предпринимательства',
  'ЭФ': 'Энергетический факультет',
  'ФИТР': 'Факультет информационных технологий и робототехники',
  'ФТУГ': 'Факультет технологий управления и гуманитаризации',
  'ИПФ': 'Инженерно-педагогический факультет',
  'ФЭС': 'Факультет энергетического строительства',
  'СФ': 'Строительный факультет',
  'ПСФ': 'Приборостроительный факультет',
  'ФТК': 'Факультет транспортных коммуникаций',
  'СТФ': 'Спортивно-технический факультет'
};

/* ───────────── Состояние ───────────── */
const today = new Date();
let selectedDate = new Date(today >= termStart && today <= termEnd ? today : termStart);
let data = emptyData();
let currentGroup = null;
let savedGroupId = '';
let selectedCourse = '1';
const courseCache = new Map();
const courseGroupPreferences = new Map();
let storageMode = 'browser';
let cloudStorageReady = false;
let cloudWriteQueue = Promise.resolve();
const personalOverrides = new Map();
const personalAdditions = new Map();
const personalCancellations = new Map();
const localOnlyKeys = new Set();
let weekDates = [];
let visibleNow = [];
let editorLesson = null;
let editorKey = '';
let editorMode = 'edit';
let courseLoadRevision = 0;
const telegramCloudStorage = tg?.CloudStorage && (!tg.isVersionAtLeast || tg.isVersionAtLeast('6.9')) ? tg.CloudStorage : null;

function emptyData() {
  return { groups: [], byId: new Map(), byFaculty: new Map() };
}

function buildIndexes(groups) {
  const byId = new Map();
  const byFaculty = new Map();
  for (const group of groups) {
    byId.set(group.id, group);
    if (!byFaculty.has(group.faculty)) byFaculty.set(group.faculty, { name: group.facultyName || group.faculty || 'БНТУ', groups: [] });
    byFaculty.get(group.faculty).groups.push(group);
  }
  for (const faculty of byFaculty.values()) faculty.groups.sort((a, b) => a.id.localeCompare(b.id, 'ru', { numeric: true }));
  return { groups, byId, byFaculty };
}

/* ───────────── Утилиты дат ───────────── */
const atMidnight = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const mondayOf = date => { const result = atMidnight(date); result.setDate(result.getDate() - (result.getDay() + 6) % 7); return result; };
const sameDay = (left, right) => atMidnight(left).getTime() === atMidnight(right).getTime();
const calendarDay = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / (24 * 60 * 60 * 1000);
const academicWeek = date => Math.floor((calendarDay(mondayOf(date)) - calendarDay(mondayOf(termStart))) / 7) + 1;
const alternatingWeek = date => (academicWeek(date) - 1) % 2 + 1;
const dateKeyFor = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const selectedDateKey = () => dateKeyFor(selectedDate);
const dayIndexOf = date => (date.getDay() + 6) % 7;
const shiftedDate = (date, days) => { const result = new Date(date); result.setDate(result.getDate() + days); return result; };

/* ───────────── Хранилище ───────────── */
function personalMapForKey(key) {
  if (key.startsWith('bntu_add_')) return personalAdditions;
  if (key.startsWith('bntu_cancel_')) return personalCancellations;
  return personalOverrides;
}

function clean(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function cloudCall(method, ...args) {
  return new Promise((resolve, reject) => {
    telegramCloudStorage[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
}

function queueCloudWrite(operation) {
  const pending = cloudWriteQueue.then(operation);
  cloudWriteQueue = pending.catch(() => {});
  return pending;
}

function safeLocalGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeLocalRemove(key) {
  try { localStorage.removeItem(key); } catch { /* storage may be unavailable */ }
}

function updateStorageNote() {
  const note = $('#storage-note');
  if (note) note.textContent = storageMode === 'telegram'
    ? localOnlyKeys.size
      ? 'Некоторые правки пока сохранены только в этом браузере.'
      : 'Личные правки сохраняются в вашем Telegram и видны только вам.'
    : telegramCloudStorage
      ? 'Telegram-хранилище недоступно: правки сохраняются в этом браузере.'
      : 'Вне Telegram правки сохраняются только в этом браузере.';
  const intro = $('.editor-intro');
  if (intro) {
    const scope = editorMode === 'addition'
      ? 'Добавленная пара будет действовать только на выбранную дату.'
      : 'Изменение применится ко всем появлениям этой пары в расписании.';
    const storage = storageMode === 'telegram'
      ? localOnlyKeys.size ? 'Некоторые изменения пока сохранены только в этом браузере.' : 'Изменения сохраняются в вашем Telegram.'
      : 'Изменения сохраняются в этом браузере.';
    intro.textContent = `${scope} ${storage}`;
  }
}

function parseStoredOverride(value) {
  try { return JSON.parse(value); } catch { return null; }
}

const isPersonalKey = key => key.startsWith('bntu_edit_') || key.startsWith('bntu_add_') || key.startsWith('bntu_cancel_');

async function loadPersonalData() {
  let cloudValues = {};
  if (telegramCloudStorage) {
    try {
      const keys = await cloudCall('getKeys');
      const relevant = (keys || []).filter(key => key === 'bntu_course' || key === 'bntu_group' || /^bntu_group_[12]$/.test(key) || isPersonalKey(key));
      cloudValues = relevant.length ? await cloudCall('getItems', relevant) : {};
      cloudStorageReady = true;
    } catch {
      cloudStorageReady = false;
    }
  }
  const localCourseOverride = safeLocalGet(`${localStoragePrefix}bntu_course`);
  const legacyCourse = safeLocalGet('bntu-course');
  selectedCourse = [localCourseOverride, cloudValues.bntu_course, legacyCourse].find(value => value && courseConfigs[value]) || '1';
  $('#course-picker').value = selectedCourse;
  if (localCourseOverride !== null) localOnlyKeys.add('bntu_course');

  const preferenceMigrations = [];
  for (const courseId of Object.keys(courseConfigs)) {
    const key = `bntu_group_${courseId}`;
    const localSpecific = safeLocalGet(`${localStoragePrefix}${key}`);
    const legacyLocal = courseId === '1' ? safeLocalGet(`${localStoragePrefix}bntu_group`) : null;
    const legacyGroup = courseId === '1' ? safeLocalGet('bntu-group') : null;
    const cloudSpecific = cloudValues[key];
    const legacyCloud = courseId === '1' ? cloudValues.bntu_group : null;
    const storedGroup = [localSpecific, legacyLocal, cloudSpecific, legacyCloud, legacyGroup].find(value => value !== null && value !== undefined);
    courseGroupPreferences.set(courseId, storedGroup || '');
    if (localSpecific !== null) {
      localOnlyKeys.add(key);
      preferenceMigrations.push({ key, value: localSpecific });
    } else if (legacyLocal !== null) {
      localOnlyKeys.add(key);
      preferenceMigrations.push({ key, value: legacyLocal });
    }
  }
  savedGroupId = courseGroupPreferences.get(selectedCourse) || '';
  if (localCourseOverride !== null) preferenceMigrations.push({ key: 'bntu_course', value: localCourseOverride });

  const localOverrides = [];
  for (const [key, value] of Object.entries(cloudValues)) {
    if (!isPersonalKey(key)) continue;
    const parsed = parseStoredOverride(value);
    const map = personalMapForKey(key);
    if (parsed?._deleted) map.delete(key);
    else if (parsed) map.set(key, key.startsWith('bntu_add_') ? { ...parsed, personalKey: key } : parsed);
  }
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const localKey = localStorage.key(index);
      if (!localKey?.startsWith(localStoragePrefix) || !isPersonalKey(localKey.slice(localStoragePrefix.length))) continue;
      const key = localKey.slice(localStoragePrefix.length);
      const parsed = parseStoredOverride(localStorage.getItem(localKey));
      if (parsed) {
        const map = personalMapForKey(key);
        if (parsed._deleted) map.delete(key);
        else map.set(key, key.startsWith('bntu_add_') ? { ...parsed, personalKey: key } : parsed);
        localOnlyKeys.add(key);
        localOverrides.push({ localKey, key, value: parsed });
      }
    }
  } catch { /* local storage may be unavailable */ }
  if (cloudStorageReady) {
    try {
      for (const { localKey, key, value } of localOverrides) {
        if (value._deleted) {
          await queueCloudWrite(() => cloudCall('removeItem', key));
          personalMapForKey(key).delete(key);
        } else await queueCloudWrite(() => cloudCall('setItem', key, JSON.stringify(value)));
        safeLocalRemove(localKey);
        localOnlyKeys.delete(key);
      }
      for (const { key, value } of preferenceMigrations) {
        if (value) await queueCloudWrite(() => cloudCall('setItem', key, value));
        else await queueCloudWrite(() => cloudCall('removeItem', key));
        safeLocalRemove(`${localStoragePrefix}${key}`);
        localOnlyKeys.delete(key);
      }
    } catch { cloudStorageReady = false; }
  }
  storageMode = cloudStorageReady ? 'telegram' : 'browser';
  updateStorageNote();
}

/** Записывает строковое значение (или удаляет при null) в облако Telegram с запасным localStorage. */
async function persistValue(key, value) {
  if (telegramCloudStorage) {
    try {
      if (value != null && value !== '') await queueCloudWrite(() => cloudCall('setItem', key, value));
      else await queueCloudWrite(() => cloudCall('removeItem', key));
      safeLocalRemove(`${localStoragePrefix}${key}`);
      localOnlyKeys.delete(key);
      cloudStorageReady = true;
      storageMode = 'telegram';
      return;
    } catch {
      cloudStorageReady = false;
      storageMode = 'browser';
    }
  } else storageMode = 'browser';
  // Запасной вариант: локальная копия (или «надгробие» для удаления).
  if (key.startsWith('bntu_') && isPersonalKey(key)) {
    if (value == null) safeLocalSet(`${localStoragePrefix}${key}`, JSON.stringify({ _deleted: true }));
    else safeLocalSet(`${localStoragePrefix}${key}`, value);
    localOnlyKeys.add(key);
  } else {
    safeLocalSet(`${localStoragePrefix}${key}`, value || '');
    localOnlyKeys.add(key);
  }
}

async function saveGroupPreference(groupId) {
  const value = groupId || '';
  courseGroupPreferences.set(selectedCourse, value);
  savedGroupId = value;
  await persistValue(`bntu_group_${selectedCourse}`, value);
  updateStorageNote();
}

async function saveCoursePreference(courseId) {
  await persistValue('bntu_course', courseId);
  updateStorageNote();
}

function applyPersonalToMemory(key, override) {
  const storedValue = override && key.startsWith('bntu_add_') ? { ...override, personalKey: key } : override;
  const map = personalMapForKey(key);
  if (storedValue) map.set(key, storedValue); else map.delete(key);
  return storedValue;
}

/** Одиночное сохранение: мгновенная перерисовка, запись — в фоне. */
async function savePersonalOverride(key, override) {
  const storedValue = applyPersonalToMemory(key, override);
  render();
  await persistValue(key, storedValue ? JSON.stringify(storedValue) : null);
  updateStorageNote();
}

/** Пакетное сохранение: одна перерисовка на весь набор. */
async function savePersonalBatch(entries) {
  if (!entries.length) return;
  const stored = entries.map(([key, override]) => [key, applyPersonalToMemory(key, override)]);
  render();
  for (const [key, value] of stored) await persistValue(key, value ? JSON.stringify(value) : null);
  updateStorageNote();
}

/* ───────────── Ключи пар (формат и хэш сохранены для совместимости) ───────────── */
function hashStorageKey(prefix, identity) {
  let hash = 14695981039346656037n;
  for (let index = 0; index < identity.length; index++) {
    hash ^= BigInt(identity.charCodeAt(index));
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return `${prefix}${hash.toString(16).padStart(16, '0')}`;
}

function lessonStorageKey(lesson) {
  if (lesson.personalKey) return lesson.personalKey;
  if (lesson._key) return lesson._key;
  const identity = JSON.stringify([currentGroup?.id, lesson.day, lesson.start, lesson.end, lesson.sourceCells, lesson.title, lesson.type]);
  // Ключ зависит только от самой пары и группы — кэшируем, чтобы не считать BigInt-хэш при каждой отрисовке.
  Object.defineProperty(lesson, '_key', { value: hashStorageKey('bntu_edit_', identity), enumerable: false });
  return lesson._key;
}

function legacyLessonStorageKey(lesson, dateKey) {
  const identity = JSON.stringify([currentGroup?.id, dateKey, lesson.day, lesson.start, lesson.end, lesson.sourceCells, lesson.title, lesson.type]);
  return hashStorageKey('bntu_edit_', identity);
}

function lessonCancellationKey(lesson, dateKey = selectedDateKey()) {
  const identity = JSON.stringify([currentGroup?.id, dateKey, lesson.day, lesson.start, lesson.end, lesson.sourceCells, lesson.title, lesson.type]);
  return hashStorageKey('bntu_cancel_', identity);
}

function overrideForLesson(lesson) {
  const key = lessonStorageKey(lesson);
  const override = (lesson.personalKey ? personalAdditions : personalOverrides).get(key);
  return override?._deleted ? null : override || null;
}

function isLessonCancelled(lesson) {
  if (lesson.personalKey) return Boolean(personalAdditions.get(lesson.personalKey)?.cancelled);
  return Boolean(personalCancellations.get(lessonCancellationKey(lesson))?.cancelled);
}

/* ───────────── Парсер Excel ───────────── */
function collapseSpacedLetters(value) {
  const pieces = String(value || '').trim().split(/(\s+)/);
  let result = '';
  let run = '';
  for (const piece of pieces) {
    if (!piece) continue;
    if (/^\s+$/.test(piece)) {
      if (piece.length >= 4) {
        result += run;
        run = '';
        result += ' ';
      }
    } else if (piece.length === 1 && /[A-Za-zА-Яа-яЁё]/.test(piece)) {
      run += piece;
    } else {
      result += run;
      run = '';
      result += piece;
    }
  }
  result += run;
  return result.replace(/\s+/g, ' ').trim();
}

function cellValue(sheet, row, column) {
  const cell = sheet[XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })];
  return cell ? (cell.w ?? cell.v) : '';
}

function rawCellValue(sheet, row, column) {
  const cell = sheet[XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })];
  return cell ? cell.v : '';
}

function facultyName(sheet, column, sheetName) {
  for (const row of [10, 11]) {
    const candidates = [];
    for (let col = 3; col <= column; col++) {
      const value = cellValue(sheet, row, col);
      if (value !== '' && value != null) candidates.push(collapseSpacedLetters(value));
    }
    const matches = candidates.filter(item => !['дни', 'часы'].includes(item.toLowerCase()) && item.toLowerCase().includes('факультет'));
    if (matches.length) return matches[matches.length - 1];
  }
  return clean(sheetName).replace(/\s*\d+\s*курс.*$/i, '').trim();
}

function lessonFields(rawParts, week = null) {
  rawParts = [...new Set(rawParts.map(clean).filter(Boolean))];
  const text = rawParts.join('\n');
  const low = text.toLowerCase();
  let type = null;
  for (const [pattern, label] of [[/лекцион/, 'Лекция'], [/практическ/, 'Практика'], [/лабораторн|лаб\.занят/, 'Лабораторная'], [/семинар/, 'Семинар']]) {
    if (pattern.test(low)) { type = label; break; }
  }
  const weeks = week ? [week] : [...new Set([...low.matchAll(/(?<!\d)([12])\s*(?:нед\.?|недел\w*)/g)].map(match => Number(match[1])))].sort();
  const dates = [...text.matchAll(/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/g)].map(match => match[0]);
  const teacherPattern = /(?<![A-Za-zА-Яа-яЁё])(?:ст\s*\.\s*пр\.?|доц\.?|проф\.?|преп\.?|пр\.)(?=\s*[А-ЯЁ])/i;
  const teacherMatch = teacherPattern.exec(text);
  let teacher = teacherMatch ? clean(text.slice(teacherMatch.index)) : '';
  const roomPattern = /(?<![A-Za-zА-Яа-яЁё])(?:ауд(?:итория)?\.?\s*|а\.?\s*|лаб\.?\s*)\d{1,4}[А-ЯЁа-яё]?(?:\s*к\.?\s*\d{1,2})?/i;
  const roomMatch = roomPattern.exec(text);
  const room = roomMatch ? clean(roomMatch[0]) : '';
  if (teacherMatch && roomMatch && roomMatch.index > teacherMatch.index) teacher = clean(text.slice(teacherMatch.index, roomMatch.index));
  const subjects = [];
  for (const part of rawParts) {
    let subject = part.replace(/^\s*[12]\s*(?:нед\.?|недел\w*)\s*/i, '')
      .replace(/\([^)]*(?:лекцион|практическ|лабораторн|оиз)[^)]*\)\s*/i, '')
      .replace(/^\s*\([^)]*\)\s*/, '').replace(/^\s*\d{1,2}[.:]\d{2}\s*/, '')
      .replace(/^\s*(?:\d{1,2}[./]\d{1,2}\s*;?\s*)+/, '');
    const partRoom = roomPattern.exec(subject);
    const partTeacher = teacherPattern.exec(subject);
    const cuts = [partRoom, partTeacher].filter(Boolean).map(match => match.index);
    if (cuts.length) subject = subject.slice(0, Math.min(...cuts));
    subject = clean(subject.replace(/(?<!\d)[12]\s*(?:нед\.?|недел\w*)/gi, '')).replace(/^[ .,:;–—-]+|[ .,:;–—-]+$/g, '');
    if (/[А-ЯЁа-яёA-Za-z]{3}/.test(subject) && !/^(?:аудитория|практическое занятие|лекционное занятие|лабораторное занятие)$/i.test(subject)) subjects.push(subject);
  }
  const roomParts = room ? [room] : [];
  for (const part of rawParts) {
    if (/^\d{2,4}[А-ЯЁа-яё]?$/i.test(part) || /^\d{2,4}(?:\s*,\s*\d{2,4})+$/.test(part)) roomParts.push(part);
    else if (/^к\.?\s*\d{1,2}$/i.test(part)) roomParts.push(part.replace(/\s+/g, ' '));
  }
  return {
    title: subjects.sort((a, b) => b.length - a.length)[0] || rawParts.find(part => /[А-ЯЁа-яёA-Za-z]{3}/.test(part)) || text,
    type,
    weeks,
    dates,
    room: [...new Set(roomParts)].join(', '),
    teacher,
    details: rawParts
  };
}

function parseScheduleWorkbook(workbook) {
  const result = new Map();
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
    const mergesByRow = new Map();
    const timeMergesByStartRow = new Map();
    for (const merge of sheet['!merges'] || []) {
      const row = merge.s.r + 1;
      if (!mergesByRow.has(row)) mergesByRow.set(row, []);
      mergesByRow.get(row).push(merge);
      if (merge.s.c <= 1 && merge.e.c >= 1) timeMergesByStartRow.set(row, merge);
    }
    const headers = [];
    for (let row = 1; row <= Math.min(15, range.e.r + 1); row++) {
      for (let column = 1; column <= range.e.c + 1; column++) {
        const value = rawCellValue(sheet, row, column);
        let id = '';
        let label = '';
        if (typeof value === 'number' && Math.trunc(value) >= 10000000) id = label = String(Math.trunc(value));
        else if (typeof value === 'string') {
          const match = value.match(groupCodePattern);
          if (!match) continue;
          id = match[1];
          label = clean(value);
        } else continue;
        const faculty = clean(sheetName).replace(/\s*\d+\s*курс.*$/i, '').trim();
        headers.push({ id, label, column, faculty, facultyName: facultyNames[faculty] || facultyName(sheet, column, sheetName) });
      }
    }
    const uniqueHeaders = [...new Map(headers.map(header => [`${header.id}:${header.column}`, header])).values()];
    let currentDay = null;
    const slots = [];
    for (let row = 1; row <= range.e.r + 1; row++) {
      const dayText = clean(cellValue(sheet, row, 1)).toLowerCase();
      if (weekdays.has(dayText)) currentDay = weekdays.get(dayText);
      const timeText = clean(cellValue(sheet, row, 2));
      const times = [...timeText.matchAll(timeRegex())];
      if (times.length && currentDay !== null) {
        const norm = match => `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
        const periods = [];
        for (let index = 0; index + 1 < times.length; index += 2) periods.push({ start: norm(times[index]), end: norm(times[index + 1]) });
        const timeMerge = timeMergesByStartRow.get(row);
        const rowSpan = timeMerge ? timeMerge.e.r - timeMerge.s.r + 1 : periods.length > 1 ? periods.length * 2 : 1;
        const rowsPerPeriod = periods.length > 1 && rowSpan % periods.length === 0 ? rowSpan / periods.length : null;
        slots.push({ row, day: currentDay, timeText, periods, rowSpan, rowsPerPeriod, start: periods[0].start, end: periods[periods.length - 1].end });
      }
    }
    for (const header of uniqueHeaders) {
      if (!result.has(header.id)) result.set(header.id, { id: header.id, label: header.label, faculty: header.faculty, facultyName: header.facultyName, lessons: [], seen: new Set() });
      const target = result.get(header.id);
      for (const slot of slots) {
        const endRow = Math.min(range.e.r + 1, slot.row + Math.max(3, slot.rowSpan - 1));
        const entries = [];
        const seenCells = new Set();
        for (let row = slot.row; row <= endRow; row++) {
          for (let column = header.column; column <= Math.min(range.e.c + 1, header.column + 3); column++) {
            const raw = clean(cellValue(sheet, row, column));
            if (!raw || row < 15 || /^с 0?1\.09/i.test(raw) || weekdays.has(raw.toLowerCase()) || raw.toLowerCase().includes('учебных занятий студентов')) continue;
            const coordinate = XLSX.utils.encode_cell({ r: row - 1, c: column - 1 });
            entries.push({ row, column, raw, coordinate });
            seenCells.add(coordinate);
          }
          for (const merge of mergesByRow.get(row) || []) {
            const firstColumn = merge.s.c + 1;
            const lastColumn = merge.e.c + 1;
            const groupFirstColumn = header.column;
            const groupLastColumn = Math.min(range.e.c + 1, header.column + 3);
            if (lastColumn < groupFirstColumn || firstColumn > groupLastColumn) continue;
            const coordinate = XLSX.utils.encode_cell(merge.s);
            if (seenCells.has(coordinate)) continue;
            const raw = clean(cellValue(sheet, row, firstColumn));
            if (!raw || row < 15 || /^с 0?1\.09/i.test(raw) || weekdays.has(raw.toLowerCase()) || raw.toLowerCase().includes('учебных занятий студентов')) continue;
            entries.push({ row, column: firstColumn, raw, coordinate });
            seenCells.add(coordinate);
          }
        }
        entries.sort((a, b) => a.row - b.row || a.column - b.column);
        if (!entries.length) continue;
        let periodEntries = [entries];
        if (slot.periods.length === 2 && slot.rowsPerPeriod) {
          const groupedByPeriod = slot.periods.map((_, periodIndex) => entries.filter(entry =>
            Math.min(slot.periods.length - 1, Math.floor((entry.row - slot.row) / slot.rowsPerPeriod)) === periodIndex
          ));
          const hasLessonInEachPeriod = groupedByPeriod.every(group => group.some(entry => /лекцион|практическ|лабораторн|семинар|оиз/i.test(entry.raw)));
          const periodLessons = groupedByPeriod.map(group => lessonFields(group.map(entry => entry.raw)));
          const explicitWeeks = groupedByPeriod.map(group => new Set(group.flatMap(entry =>
            [...entry.raw.matchAll(weekMarkerRegex())].map(match => Number(match[1]))
          )));
          const explicitlyDifferentWeeks = explicitWeeks.every(weeks => weeks.size === 1)
            && [...explicitWeeks[0]][0] !== [...explicitWeeks[1]][0];
          const sameLessonContinues = periodLessons.length === 2
            && periodLessons[0].type === periodLessons[1].type
            && clean(periodLessons[0].title).toLocaleLowerCase('ru-RU') === clean(periodLessons[1].title).toLocaleLowerCase('ru-RU')
            && !explicitlyDifferentWeeks;
          if (hasLessonInEachPeriod && !sameLessonContinues) periodEntries = groupedByPeriod;
        }
        const periodMarkers = periodEntries.map(group => new Set(group.flatMap(entry =>
          [...entry.raw.matchAll(weekMarkerRegex())].map(match => Number(match[1]))
        )));
        const inferAlternatingWeeks = periodEntries.length === 2 && periodEntries.every(group => group.length) && periodMarkers.some(markers => markers.size === 1);
        for (let periodIndex = 0; periodIndex < periodEntries.length; periodIndex++) {
          const segmentEntries = periodEntries[periodIndex];
          const parts = segmentEntries.map(entry => entry.raw);
          const weekSpecific = { 1: [], 2: [] };
          const common = [];
          let activeWeek = null;
          for (const raw of parts) {
            const marked = [...new Set([...raw.matchAll(weekMarkerRegex())].map(match => Number(match[1])))];
            if (marked.length) {
              marked.forEach(week => weekSpecific[week].push(raw));
              activeWeek = marked.length === 1 ? marked[0] : null;
            } else if (activeWeek) weekSpecific[activeWeek].push(raw);
            else common.push(raw);
          }
          const segmentMarker = periodMarkers[periodIndex];
          let inferredWeek = segmentMarker.size === 1 ? [...segmentMarker][0] : null;
          if (!inferredWeek && inferAlternatingWeeks) {
            const otherMarker = periodMarkers[1 - periodIndex];
            inferredWeek = otherMarker.size === 1 ? 3 - [...otherMarker][0] : periodIndex + 1;
          }
          const variants = (weekSpecific[1].length || weekSpecific[2].length)
            ? [1, 2].filter(week => weekSpecific[week].length).map(week => [week, [...new Set([...common, ...weekSpecific[week]])]])
            : [[inferredWeek, [...new Set(common)]]];
          for (const [week, variantParts] of variants) {
            const fields = lessonFields(variantParts, week);
            const groupTime = variantParts.map(part => timeRegex().exec(part)).find(Boolean);
            const hasExplicitTime = variantParts.some(part => /^\s*\d{1,2}[.:]\d{2}/.test(part));
            const segmentedPeriod = periodEntries.length > 1 ? slot.periods[periodIndex] : null;
            const lesson = {
              day: slot.day,
              start: groupTime && hasExplicitTime ? `${String(Number(groupTime[1])).padStart(2, '0')}:${groupTime[2]}` : segmentedPeriod?.start || slot.start,
              end: groupTime && hasExplicitTime ? null : segmentedPeriod?.end || slot.end,
              timeLabel: slot.timeText,
              sourceRow: segmentEntries[0]?.row ?? slot.row,
              sourceCells: segmentEntries.filter(entry => variantParts.includes(entry.raw)).map(entry => entry.coordinate),
              ...fields
            };
            const identity = JSON.stringify([lesson.day, lesson.start, lesson.end, lesson.sourceCells, lesson.details]);
            if (!target.seen.has(identity)) {
              target.seen.add(identity);
              target.lessons.push(lesson);
            }
          }
        }
      }
    }
  }
  const groups = [...result.values()].map(group => {
    delete group.seen;
    group.lessons.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.sourceRow - b.sourceRow || a.sourceCells.join(',').localeCompare(b.sourceCells.join(',')));
    // Заранее раскладываем по дням — потом не нужно фильтровать весь список при каждой отрисовке.
    group.byDay = Array.from({ length: 7 }, () => []);
    for (const lesson of group.lessons) group.byDay[lesson.day]?.push(lesson);
    return group;
  });
  return groups;
}

/* ───────────── Отрисовка ───────────── */
function addText(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function setGroupCount(value) {
  const counter = $('#group-count');
  if (counter) counter.textContent = value;
}

function getWeekDates() {
  const start = mondayOf(selectedDate);
  return Array.from({ length: 7 }, (_, index) => shiftedDate(start, index));
}

function visibleLessons(dayIndex) {
  if (!currentGroup) return [];
  const weekNo = alternatingWeek(selectedDate);
  const scheduled = (currentGroup.byDay?.[dayIndex] || [])
    .filter(lesson => !lesson.weeks?.length || lesson.weeks.includes(weekNo));
  const dateKey = selectedDateKey();
  const additions = [...personalAdditions.values()]
    .filter(lesson => lesson.groupId === currentGroup.id && lesson.date === dateKey && lesson.day === dayIndex);
  return [...scheduled, ...additions].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
}

function renderDays() {
  const host = $('#days');
  weekDates = getWeekDates();
  const fragment = document.createDocumentFragment();
  weekDates.forEach((date, index) => {
    const button = document.createElement('button');
    const active = sameDay(date, selectedDate);
    button.type = 'button';
    button.className = `day${active ? ' active' : ''}${sameDay(date, today) ? ' today' : ''}`;
    button.dataset.index = String(index);
    button.disabled = date < termStart || date > termEnd;
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', `${dayLong[index]}, ${ruDate.format(date)}`);
    button.append(addText('span', 'day-name', dayNames[index]), addText('span', 'day-date', String(date.getDate())));
    fragment.append(button);
  });
  host.replaceChildren(fragment);
  $('#week-label').textContent = `${alternatingWeek(selectedDate)}-я неделя · ${ruWeek.format(weekDates[0])} — ${ruWeek.format(weekDates[6])}`;
  $('#prev-week').disabled = shiftedDate(selectedDate, -7) < termStart;
  $('#next-week').disabled = shiftedDate(selectedDate, 7) > termEnd;
}

function makeMeta(icon, value) {
  const item = document.createElement('span');
  item.className = 'meta-item';
  item.append(addText('span', 'meta-icon', icon), addText('span', '', value));
  return item;
}

function renderLesson(lesson, index) {
  const override = overrideForLesson(lesson);
  const shown = { ...lesson, ...(override || {}), cancelled: isLessonCancelled(lesson) };
  const row = document.createElement('article');
  row.className = `lesson${shown.cancelled ? ' cancelled' : ''}`;
  const time = document.createElement('div');
  time.className = 'time-col';
  time.append(addText('span', 'time-start', shown.start || '—'));
  if (shown.end) time.append(addText('span', 'time-end', shown.end));
  row.append(time);

  const card = document.createElement('div');
  card.className = 'lesson-card';
  const top = document.createElement('div'); top.className = 'lesson-top';
  if (shown.type) top.append(addText('span', 'lesson-kind', shown.type));
  for (const week of lesson.weeks || []) top.append(addText('span', 'week-chip', `${week}-я неделя`));
  if (lesson.personalKey) top.append(addText('span', 'week-chip', 'Добавлена вами'));
  if (shown.cancelled) top.append(addText('span', 'cancelled-chip', 'Отменена вами'));
  if (top.childNodes.length) card.append(top);
  card.append(addText('h3', 'lesson-title', shown.title || 'Занятие'));
  const meta = document.createElement('div'); meta.className = 'lesson-meta';
  if (shown.room) meta.append(makeMeta('⌖', shown.room));
  if (shown.teacher) meta.append(makeMeta('◷', shown.teacher));
  if (lesson.dates?.length) meta.append(makeMeta('▦', lesson.dates.join(', ')));
  if (meta.childNodes.length) card.append(meta);

  const details = (lesson.details || []).filter(text => text && text !== lesson.title);
  if (details.length) {
    const disclosure = document.createElement('details'); disclosure.className = 'details';
    disclosure.append(addText('summary', '', 'Примечания из исходного расписания'));
    const list = document.createElement('ul'); list.className = 'details-list';
    details.forEach(text => list.append(addText('li', '', text)));
    disclosure.append(list); card.append(disclosure);
  }
  const actions = document.createElement('div');
  actions.className = 'lesson-actions';
  const editButton = addText('button', 'lesson-action', lesson.personalKey ? 'Изменить добавленную пару' : 'Изменить в расписании');
  editButton.type = 'button';
  editButton.dataset.action = 'edit';
  editButton.dataset.index = String(index);
  const cancelButton = addText('button', 'lesson-action cancel', shown.cancelled ? 'Вернуть на эту дату' : 'Отменить на эту дату');
  cancelButton.type = 'button';
  cancelButton.dataset.action = 'cancel';
  cancelButton.dataset.index = String(index);
  actions.append(editButton, cancelButton);
  card.append(actions);
  row.append(card);
  return row;
}

function toggleCancel(lesson) {
  if (lesson.personalKey) {
    const key = lesson.personalKey;
    const current = personalAdditions.get(key);
    if (!current) return;
    savePersonalOverride(key, { ...current, cancelled: !current.cancelled });
  } else {
    const key = lessonCancellationKey(lesson);
    if (personalCancellations.get(key)?.cancelled) savePersonalOverride(key, null);
    else savePersonalOverride(key, { cancelled: true });
  }
}

function openLessonEditor(lesson) {
  editorLesson = lesson;
  editorKey = lessonStorageKey(lesson);
  editorMode = lesson.personalKey ? 'addition' : 'edit';
  const override = overrideForLesson(lesson) || {};
  const shown = { ...lesson, ...override };
  $('#editor-title').textContent = editorMode === 'addition' ? 'Изменить добавленную пару' : 'Изменить пару';
  $('#reset-edit').textContent = editorMode === 'addition' ? 'Удалить эту пару' : 'Сбросить мои правки';
  $('#reset-edit').hidden = false;
  $('#edit-title').value = shown.title || '';
  $('#edit-room').value = shown.room || '';
  $('#edit-start').value = shown.start || '';
  $('#edit-end').value = shown.end || '';
  $('#edit-teacher').value = shown.teacher || '';
  const typePicker = $('#edit-type');
  const other = typePicker.options[typePicker.options.length - 1];
  if (other) { other.value = 'Другое'; other.textContent = 'Другое'; }
  const existingType = [...typePicker.options].some(option => option.value === (shown.type || ''));
  if (shown.type && !existingType && other) { other.value = shown.type; other.textContent = shown.type; }
  typePicker.value = shown.type || 'Другое';
  updateStorageNote();
  $('#lesson-editor').showModal();
}

function openNewLessonEditor() {
  if (!currentGroup) return;
  editorLesson = null;
  editorKey = `bntu_add_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  editorMode = 'addition';
  $('#editor-title').textContent = 'Добавить пару';
  $('#reset-edit').hidden = true;
  $('#edit-title').value = '';
  $('#edit-type').value = '';
  $('#edit-room').value = '';
  $('#edit-start').value = '';
  $('#edit-end').value = '';
  $('#edit-teacher').value = '';
  updateStorageNote();
  $('#lesson-editor').showModal();
}

function renderSchedule() {
  const dayIndex = dayIndexOf(selectedDate);
  visibleNow = visibleLessons(dayIndex);
  $('#add-lesson').hidden = !currentGroup;
  $('#day-title').textContent = `${dayLong[dayIndex][0].toUpperCase()}${dayLong[dayIndex].slice(1)}`;
  $('#date-label').textContent = ruDate.format(selectedDate);
  const selectedFaculty = $('#faculty-picker').value;
  $('#lesson-count').textContent = !currentGroup
    ? selectedFaculty ? 'Выберите группу' : 'Выберите факультет'
    : visibleNow.length ? `${visibleNow.length} ${visibleNow.length === 1 ? 'пара' : 'пар'}` : 'Выходной';
  const host = $('#schedule');
  if (!visibleNow.length) {
    host.replaceChildren(addText('div', 'empty', currentGroup
      ? 'На этот день занятий нет.'
      : 'Сначала выберите факультет, затем учебную группу.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  visibleNow.forEach((lesson, index) => fragment.append(renderLesson(lesson, index)));
  host.replaceChildren(fragment);
}

function render() {
  renderDays();
  renderSchedule();
}

/* ───────────── Курсы, факультеты, группы ───────────── */
async function loadCourseSchedule(courseId) {
  const config = courseConfigs[courseId];
  if (!config) return;
  const revision = ++courseLoadRevision;
  const facultyPicker = $('#faculty-picker');
  const groupPicker = $('#group-picker');
  try {
    selectedCourse = courseId;
    $('#course-picker').value = courseId;
    $('#course-season').textContent = config.label;
    savedGroupId = courseGroupPreferences.get(courseId) || '';
    currentGroup = null;
    setGroupCount('');

    if (courseCache.has(courseId)) {
      data = courseCache.get(courseId);
    } else {
      data = emptyData();
      facultyPicker.disabled = true;
      facultyPicker.replaceChildren(addText('option', '', 'Загружаю список…'));
      groupPicker.disabled = true;
      groupPicker.replaceChildren(addText('option', '', 'Сначала выберите факультет'));
      updateGroupMeta();
      $('#schedule').replaceChildren(addText('div', 'loading', `Загружаю расписание ${courseId}-го курса…`));
      const response = await fetch(config.file);
      if (!response.ok) throw new Error(`Не удалось загрузить Excel-файл ${courseId}-го курса.`);
      const buffer = await response.arrayBuffer();
      if (revision !== courseLoadRevision) return;
      if (!window.XLSX) throw new Error('Не загрузился модуль чтения Excel. Проверьте подключение к интернету и обновите страницу.');
      // Даём браузеру отрисовать «Загружаю…» перед тяжёлым парсингом.
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (revision !== courseLoadRevision) return;
      const workbook = XLSX.read(buffer, { cellDates: false });
      const groups = parseScheduleWorkbook(workbook);
      if (!groups.length) throw new Error(`В Excel-файле ${courseId}-го курса не найдены группы расписания.`);
      data = buildIndexes(groups);
      courseCache.set(courseId, data);
    }
    if (revision !== courseLoadRevision) return;
    populateFaculties();
    migrateLegacyOverridesForCurrentGroup();
    render();
  } catch (error) {
    if (revision !== courseLoadRevision) return;
    facultyPicker.disabled = true;
    groupPicker.disabled = true;
    const openedAsLocalFile = window.location.protocol === 'file:';
    $('#faculty-name').textContent = openedAsLocalFile
      ? 'Браузер блокирует чтение Excel при открытии через file://'
      : error.message;
    $('#schedule').replaceChildren(addText('div', 'error', openedAsLocalFile
      ? 'Откройте приложение через GitHub Pages или локальный HTTP-сервер. Excel-книги должны лежать в папке data рядом с index.html.'
      : 'Не удалось прочитать Excel-файл курса. Проверьте, что исходный файл находится в папке data, и откройте приложение через GitHub Pages или локальный веб-сервер.'));
  }
}

function facultyCountText(faculty) {
  return faculty
    ? `${data.byFaculty.get(faculty)?.groups.length || 0} групп на факультете`
    : `${data.groups.length} групп · ${data.byFaculty.size} факультетов`;
}

function populateFaculties() {
  const facultyPicker = $('#faculty-picker');
  const previous = savedGroupId;
  const placeholder = addText('option', '', 'Выберите факультет…');
  placeholder.value = '';
  const fragment = document.createDocumentFragment();
  fragment.append(placeholder);
  [...data.byFaculty.entries()]
    .sort(([, a], [, b]) => a.name.localeCompare(b.name, 'ru'))
    .forEach(([code, faculty]) => {
      const option = addText('option', '', faculty.name);
      option.value = code;
      fragment.append(option);
    });
  facultyPicker.replaceChildren(fragment);
  facultyPicker.disabled = false;
  const savedGroup = data.byId.get(previous);
  facultyPicker.value = savedGroup?.faculty || '';
  currentGroup = savedGroup || null;
  populateGroupPicker(facultyPicker.value, savedGroup?.id || '');
  updateGroupMeta();
  setGroupCount(facultyCountText(facultyPicker.value));
}

function populateGroupPicker(faculty, selectedGroup = '') {
  const picker = $('#group-picker');
  const placeholder = addText('option', '', faculty ? 'Выберите группу…' : 'Сначала выберите факультет');
  placeholder.value = '';
  const fragment = document.createDocumentFragment();
  fragment.append(placeholder);
  const facultyGroups = data.byFaculty.get(faculty)?.groups || [];
  for (const group of facultyGroups) {
    const option = addText('option', '', group.label && group.label !== group.id ? `${group.id} · ${group.label}` : group.id);
    option.value = group.id;
    fragment.append(option);
  }
  picker.replaceChildren(fragment);
  picker.disabled = !faculty;
  picker.value = facultyGroups.some(group => group.id === selectedGroup) ? selectedGroup : '';
}

function handleFacultyPick() {
  const faculty = $('#faculty-picker').value;
  currentGroup = null;
  saveGroupPreference('');
  populateGroupPicker(faculty);
  setGroupCount(facultyCountText(faculty));
  updateGroupMeta();
  render();
}

async function handleCoursePick() {
  const courseId = $('#course-picker').value;
  if (!courseConfigs[courseId]) return;
  selectedCourse = courseId;
  // Загрузку расписания не блокируем записью в облако.
  const saving = saveCoursePreference(courseId);
  await loadCourseSchedule(courseId);
  await saving;
}

function handleGroupPick() {
  currentGroup = data.byId.get($('#group-picker').value) || null;
  saveGroupPreference(currentGroup?.id || '');
  migrateLegacyOverridesForCurrentGroup();
  updateGroupMeta();
  render();
}

function updateGroupMeta() {
  const meta = $('#faculty-name');
  const facultyPicker = $('#faculty-picker');
  if (!meta) return;
  const name = facultyPicker?.selectedOptions[0]?.textContent;
  meta.classList.remove('invalid');
  meta.textContent = currentGroup
    ? currentGroup.facultyName || currentGroup.faculty || 'БНТУ'
    : facultyPicker?.value ? `Выберите группу факультета «${name}»` : 'Сначала выберите факультет';
}

/**
 * Перенос старых правок (ключи с датой) в новый формат.
 * Выполняется один раз на группу и только если у пользователя вообще есть сохранённые правки.
 */
function migrateLegacyOverridesForCurrentGroup() {
  if (!currentGroup || !personalOverrides.size) return;
  const flag = `bntu-migrated-v2-${currentGroup.id}`;
  if (safeLocalGet(flag)) return;

  const migratedEdits = new Map();
  const migratedCancellations = new Map();
  const legacyKeys = new Set();
  const chosenDate = selectedDateKey();
  const date = new Date(termStart);
  for (; date <= termEnd; date.setDate(date.getDate() + 1)) {
    const dayIndex = dayIndexOf(date);
    const week = alternatingWeek(date);
    const dayKey = dateKeyFor(date);
    for (const lesson of currentGroup.byDay[dayIndex] || []) {
      if (lesson.weeks?.length && !lesson.weeks.includes(week)) continue;
      const oldKey = legacyLessonStorageKey(lesson, dayKey);
      if (oldKey === lessonStorageKey(lesson)) continue;
      const oldValue = personalOverrides.get(oldKey);
      if (!oldValue) continue;
      legacyKeys.add(oldKey);
      const fields = Object.fromEntries(['title', 'type', 'start', 'end', 'room', 'teacher']
        .filter(field => Object.hasOwn(oldValue, field)).map(field => [field, oldValue[field]]));
      if (Object.keys(fields).length) {
        const key = lessonStorageKey(lesson);
        const previous = migratedEdits.get(key);
        if (!personalOverrides.has(key) && (!previous || dayKey === chosenDate)) migratedEdits.set(key, fields);
      }
      if (oldValue.cancelled) {
        const key = lessonCancellationKey(lesson, dayKey);
        if (!personalCancellations.has(key)) migratedCancellations.set(key, { cancelled: true });
      }
    }
  }
  const entries = [
    ...[...migratedEdits].map(([key, value]) => [key, value]),
    ...[...migratedCancellations].map(([key, value]) => [key, value]),
    ...[...legacyKeys].map(key => [key, null])
  ];
  safeLocalSet(flag, '1');
  if (entries.length) savePersonalBatch(entries);
}

/* ───────────── Обработчики (навешиваются один раз) ───────────── */
$('#days').addEventListener('click', event => {
  const button = event.target.closest('.day');
  if (!button || button.disabled) return;
  selectedDate = new Date(weekDates[Number(button.dataset.index)]);
  render();
});

$('#schedule').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const lesson = visibleNow[Number(button.dataset.index)];
  if (!lesson) return;
  if (button.dataset.action === 'edit') openLessonEditor(lesson);
  else toggleCancel(lesson);
});

$('#prev-week').addEventListener('click', () => {
  if ($('#prev-week').disabled) return;
  selectedDate = shiftedDate(selectedDate, -7);
  render();
});
$('#next-week').addEventListener('click', () => {
  if ($('#next-week').disabled) return;
  selectedDate = shiftedDate(selectedDate, 7);
  render();
});
$('#today-btn').addEventListener('click', () => {
  const now = new Date();
  selectedDate = new Date(now >= termStart && now <= termEnd ? now : termStart);
  render();
});

$('#faculty-picker').addEventListener('change', handleFacultyPick);
$('#group-picker').addEventListener('change', handleGroupPick);
$('#course-picker').addEventListener('change', handleCoursePick);

$('#add-lesson').addEventListener('click', openNewLessonEditor);
$('#close-editor').addEventListener('click', () => $('#lesson-editor').close());
$('#lesson-editor').addEventListener('click', event => {
  // Клик по затемнённому фону закрывает диалог.
  if (event.target === event.currentTarget) event.currentTarget.close();
});

$('#editor-form').addEventListener('submit', event => {
  event.preventDefault();
  const fields = {
    title: clean($('#edit-title').value) || editorLesson?.title || '',
    type: clean($('#edit-type').value),
    start: $('#edit-start').value || editorLesson?.start || '',
    end: $('#edit-end').value,
    room: clean($('#edit-room').value),
    teacher: clean($('#edit-teacher').value)
  };
  let next;
  if (editorMode === 'addition') {
    const current = personalAdditions.get(editorKey);
    next = {
      ...(current || {}), ...fields,
      custom: true,
      personalKey: editorKey,
      groupId: currentGroup.id,
      date: selectedDateKey(),
      day: dayIndexOf(selectedDate),
      weeks: [],
      details: []
    };
    if (current?.cancelled) next.cancelled = true;
  } else {
    if (!editorLesson) return;
    const current = personalOverrides.get(editorKey);
    next = { ...fields, title: fields.title || editorLesson.title, start: fields.start || editorLesson.start };
    if (current && !current._deleted && current.cancelled) next.cancelled = true;
  }
  $('#lesson-editor').close();
  savePersonalOverride(editorKey, next);
});

$('#reset-edit').addEventListener('click', () => {
  if (!editorKey) return;
  $('#lesson-editor').close();
  savePersonalOverride(editorKey, null);
});

/* ───────────── Старт ───────────── */
$('#course-picker').disabled = true;
loadPersonalData()
  .then(() => {
    $('#course-picker').disabled = false;
    return loadCourseSchedule(selectedCourse);
  })
  .catch(error => {
    $('#course-picker').disabled = false;
    $('#faculty-picker').disabled = true;
    $('#group-picker').disabled = true;
    $('#faculty-name').textContent = error.message;
    $('#schedule').replaceChildren(addText('div', 'error', 'Не удалось загрузить данные приложения. Обновите страницу и попробуйте снова.'));
  });
