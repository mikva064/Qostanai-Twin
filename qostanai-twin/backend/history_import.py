"""Strict single-shift CSV import and retrospective forecasts using past data only."""
import csv
import hashlib
import io
import json
import math
import re
from copy import deepcopy
from datetime import datetime, timezone

from .model import initial_state, advance_in_place, forecast, default_configuration

HEADERS = ['elapsed_sec', 'good', 'rejected'] + [f'P0{i}_mode' for i in range(1, 6)]
SHIFT_SECONDS = 28800
MAX_BYTES = 512 * 1024
MAX_ROWS = 6000
METHOD_VERSION = 'flow-history-v2'


class CsvValidationError(Exception):
    def __init__(self, issues):
        self.issues = issues[:100]
        self.total = len(issues)


def parse_csv(content):
    issues = []
    def issue(row, column, message):
        issues.append(dict(row=row, column=column, message=message))
    if len(content.encode('utf-8')) > MAX_BYTES:
        raise CsvValidationError([dict(row=0, column='file', message='Размер CSV превышает 512 КиБ.')])
    text = content.lstrip('\ufeff')
    if '\x00' in text:
        raise CsvValidationError([dict(row=0, column='file', message='Файл содержит нулевые байты. Нужен текстовый CSV в UTF-8.')])
    first = text.splitlines()[0] if text.splitlines() else ''
    delimiter = ';' if first.count(';') > first.count(',') else ','
    reader = csv.reader(io.StringIO(text, newline=''), delimiter=delimiter, strict=True)
    rows = []
    try:
        header = [s.strip() for s in next(reader, [])]
        if len(header) != len(HEADERS) or set(header) != set(HEADERS):
            raise CsvValidationError([dict(row=1, column='header', message='Нужны ровно 8 уникальных столбцов: ' + ', '.join(HEADERS))])
        for index, cells in enumerate(reader):
            line = reader.line_num
            if index >= MAX_ROWS:
                issue(line, 'file', f'Допустимо не более {MAX_ROWS} строк данных.')
                break
            if len(cells) != len(header):
                issue(line, 'row', 'Число ячеек не совпадает с заголовком. Пустые строки тоже недопустимы.')
                continue
            values = dict(zip(header, [c.strip() for c in cells]))
            valid = True
            for key in HEADERS[:3]:
                raw = values[key]
                limit = SHIFT_SECONDS if key == 'elapsed_sec' else 10_000_000
                if not re.fullmatch(r'[0-9]{1,8}', raw) or int(raw) > limit:
                    issue(line, key, f'Нужно целое число от 0 до {limit}.')
                    valid = False
                else:
                    values[key] = int(raw)
            for key in HEADERS[3:]:
                if values[key] not in ('normal', 'slow', 'stop'):
                    issue(line, key, 'Допустимы normal, slow или stop.')
                    valid = False
            if not valid:
                continue
            row = dict(elapsedSec=values['elapsed_sec'], good=values['good'], rejected=values['rejected'],
                       modes=[values[key] for key in HEADERS[3:]], csvLine=line)
            if rows:
                if row['elapsedSec'] <= rows[-1]['elapsedSec']:
                    issue(line, 'elapsed_sec', 'Время должно строго возрастать, без дубликатов.')
                for key in ('good', 'rejected'):
                    if row[key] < rows[-1][key]:
                        issue(line, key, 'Накопленный счётчик не может уменьшаться в пределах смены.')
            rows.append(row)
    except csv.Error:
        issue(reader.line_num, 'row', 'Ошибка структуры CSV: проверьте кавычки и разделители.')
    if len(rows) < 3:
        issue(0, 'file', 'Нужны минимум 3 записи, включая начало и конец смены.')
    if rows and (rows[0]['elapsedSec'] != 0 or rows[0]['good'] != 0 or rows[0]['rejected'] != 0):
        issue(rows[0]['csvLine'], 'elapsed_sec', 'Первая запись: elapsed_sec=0, good=0, rejected=0.')
    if rows and rows[-1]['elapsedSec'] != SHIFT_SECONDS:
        issue(rows[-1]['csvLine'], 'elapsed_sec', 'Для проверки прогноза нужна полная смена: последняя запись на 28800 с.')
    if issues:
        raise CsvValidationError(issues)
    return rows


def forecasts_from_prefix(rows, cutoff_index, replay_state):
    """No suffix rows, observed final totals, or future modes are read here."""
    current = rows[cutoff_index]
    projected = forecast(replay_state)['goodAtShiftEnd']
    # Keep already-observed production; estimate only the remaining production.
    flow = current['good'] + projected - replay_state['good']
    earlier = [r for r in rows[:cutoff_index] if r['elapsedSec'] <= current['elapsedSec'] - 3600]
    anchor = earlier[-1] if earlier else rows[0]
    window = current['elapsedSec'] - anchor['elapsedSec']
    rate = (current['good'] - anchor['good']) / window
    baseline = current['good'] + math.floor(rate * (SHIFT_SECONDS - current['elapsedSec']) + 0.5)
    return dict(elapsedSec=current['elapsedSec'], observedGood=current['good'], replayGood=replay_state['good'],
                flowForecast=flow, rateForecast=baseline, rateWindowSec=window)


def analyze_history(content, file_name, plan, demo_content=None, configuration=None):
    config = deepcopy(configuration) if configuration is not None else default_configuration()
    if configuration is not None and config['shiftPlan'] != plan:
        raise ValueError('План конфигурации должен совпадать с планом импортируемой смены')
    config['shiftPlan'] = plan
    rows = parse_csv(content)
    # Checkpoints are historical observations at or immediately before 2h, 4h and 6h.
    indices = sorted({max(i for i, r in enumerate(rows) if r['elapsedSec'] <= t)
                      for t in (7200, 14400, 21600)})
    indices = [i for i in indices if 0 < rows[i]['elapsedSec'] < SHIFT_SECONDS]
    state = initial_state(warmup_seconds=0, configuration=config)
    checkpoints = []
    observations = []
    for i, row in enumerate(rows):
        advance_in_place(state, row['elapsedSec'] - state['elapsedSec'], record_history=False)
        for station, mode in zip(state['stations'], row['modes']):
            station['mode'] = mode
        observations.append(dict(**row, replayGood=state['good'], replayRejected=state['rejected']))
        if i in indices:
            checkpoints.append(forecasts_from_prefix(rows, i, deepcopy(state)))
    actual = rows[-1]['good']
    for point in checkpoints:
        point.update(actualGood=actual, flowError=point['flowForecast'] - actual,
                     rateError=point['rateForecast'] - actual)
    gaps = [b['elapsedSec'] - a['elapsedSec'] for a, b in zip(rows, rows[1:])]
    warnings = []
    if max(gaps) > 900:
        warnings.append('Между некоторыми записями больше 15 минут. Короткие остановки и изменения режима могут быть пропущены.')
    if len(checkpoints) < 3:
        warnings.append('Недостаточно различных промежуточных срезов: часть контрольных моментов пропущена.')
    if not actual:
        warnings.append('Годный выпуск равен нулю. Относительная ошибка не рассчитывается; ошибки в изделиях остаются доступны.')
    canonical = content.lstrip('\ufeff').replace('\r\n', '\n')
    parameters = json.dumps(config, sort_keys=True, separators=(',', ':'))
    digest = hashlib.sha256((METHOD_VERSION + '\n' + parameters + '\n' + canonical).encode('utf-8')).hexdigest()
    synthetic = demo_content is not None and canonical == demo_content.lstrip('\ufeff').replace('\r\n', '\n')
    total = actual + rows[-1]['rejected']
    return dict(schemaVersion=2, methodVersion=METHOD_VERSION, configuration=config, importId=digest,
                createdAt=datetime.now(timezone.utc).isoformat(), fileName=file_name,
                source='synthetic_example' if synthetic else 'user_csv', shiftDurationSec=SHIFT_SECONDS, plan=plan,
                quality=dict(rowCount=len(rows), maxGapSec=max(gaps), warnings=warnings),
                summary=dict(good=actual, rejected=rows[-1]['rejected'], planDelta=actual-plan,
                             rejectPct=round(100*rows[-1]['rejected']/total, 2) if total else None,
                             replayGood=state['good'], checkpointCount=len(checkpoints),
                             flowMae=round(sum(abs(p['flowError']) for p in checkpoints)/len(checkpoints), 2) if checkpoints else None,
                             rateMae=round(sum(abs(p['rateError']) for p in checkpoints)/len(checkpoints), 2) if checkpoints else None),
                observations=observations, checkpoints=checkpoints,
                assumptions=[
                    'Учебный пример синтетический. Для пользовательского CSV происхождение и достоверность данных не подтверждаются автоматически.',
                    'Одна последовательная линия из пяти постов, смена 8 часов, старт без изделий в работе; счётчики обнуляются в начале смены.',
                    'Режим из строки действует с её времени до следующей записи. Все изменения режима должны быть включены в файл отдельными строками.',
                    f"Модель: циклы {'/'.join(map(str, config['stationCyclesSec']))} с, подача {config['arrivalIntervalSec']} с, буферы {'/'.join(map(str, config['bufferCapacities']))} мест; каждое 25-е изделие бракуется. Параметры сохранены в отчёте и автоматически не подгоняются под файл.",
                    'Прогноз модели = наблюдаемый годный выпуск на срезе + расчёт оставшегося выпуска. Очереди восстановлены моделью по прошлым режимам и могут отличаться от фактических.',
                    'Для прогноза на срезе режимы сохраняются до конца смены. Будущие строки не используются. Известные после смены ремонты не подставляются в прошлый прогноз.',
                    'Базовый прогноз продолжает средний темп за последний час; при редких записях берётся ближайшая более ранняя точка, окно указано в таблице.',
                    'MAE — средняя абсолютная ошибка в изделиях по доступным срезам около 2/4/6 часов. Это проверка одной смены, не доказательство точности на заводе.',
                ])
