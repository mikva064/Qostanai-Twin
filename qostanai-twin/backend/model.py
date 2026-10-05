"""Deterministic finite-buffer line. No I/O, clocks or database access here."""
from copy import deepcopy


def cycle_sec(station):
    return station['nominalCycleSec'] * (2 if station['mode'] == 'slow' else 1)


def default_configuration():
    return dict(shiftPlan=410, arrivalIntervalSec=65,
                stationCyclesSec=[48, 52, 58, 50, 55], bufferCapacities=[6, 6, 6, 6])


def configuration_from_state(state):
    return dict(shiftPlan=state['shiftPlan'], arrivalIntervalSec=state['arrivalIntervalSec'],
                stationCyclesSec=[s['nominalCycleSec'] for s in state['stations']],
                bufferCapacities=[b['capacity'] for b in state['buffers']])


def initial_state(warmup_seconds=2700, configuration=None):
    config = default_configuration() if configuration is None else deepcopy(configuration)
    specs = [
        ('Подача', 'Подача комплектующих', 48),
        ('Сборка', 'Основная сборочная операция', 52),
        ('Установка', 'Установка узла', 58),
        ('Проверка', 'Проверка комплектности', 50),
        ('Выход', 'Приёмка готового изделия', 55),
    ]
    state = {
        'schemaVersion': 1, 'source': 'simulation', 'elapsedSec': 0,
        'shiftDurationSec': 28800, 'shiftPlan': config['shiftPlan'], 'arrivalIntervalSec': config['arrivalIntervalSec'],
        'nextArrivalSec': 0, 'released': 0, 'good': 0, 'rejected': 0, 'eventSequence': 1,
        'stations': [dict(id=f'P0{i+1}', name=name, operation=operation,
                          nominalCycleSec=config['stationCyclesSec'][i], mode='normal', remainingWorkSec=None,
                          completed=0, busySec=0, downtimeSec=0)
                     for i, (name, operation, cycle) in enumerate(specs)],
        'buffers': [dict(id=f'B0{i}', **{'from': f'P0{i}'}, to=f'P0{i+1}', count=0, capacity=config['bufferCapacities'][i-1])
                    for i in range(1, 5)],
        'incidents': [dict(id='event-1', stationId=None, title='Смена запущена',
                           detail=f"Демонстрационная линия · подача каждые {config['arrivalIntervalSec']} секунд",
                           severity='info', startedAtSec=0, resolvedAtSec=0, acknowledged=False)],
        'history': [dict(elapsedSec=0, good=0, rejected=0)],
    }
    advance_in_place(state, warmup_seconds)
    return state


def advance_in_place(state, seconds, record_history=True):
    count = min(max(0, int(seconds)), state['shiftDurationSec'] - state['elapsedSec'])
    stations, buffers = state['stations'], state['buffers']
    for _ in range(count):
        state['elapsedSec'] += 1
        for s in stations:
            if s['mode'] == 'stop':
                s['downtimeSec'] += 1
            elif s['remainingWorkSec'] is not None and s['remainingWorkSec'] > 0:
                s['busySec'] += 1
                s['remainingWorkSec'] = max(0, s['remainingWorkSec'] - (0.5 if s['mode'] == 'slow' else 1))
        for i in range(len(stations) - 1, -1, -1):
            s = stations[i]
            if s['mode'] == 'stop' or s['remainingWorkSec'] != 0:
                continue
            if i == len(stations) - 1:
                s['completed'] += 1
                state['rejected' if s['completed'] % 25 == 0 else 'good'] += 1
                s['remainingWorkSec'] = None
            elif buffers[i]['count'] < buffers[i]['capacity']:
                buffers[i]['count'] += 1
                s['completed'] += 1
                s['remainingWorkSec'] = None
        for i in range(len(stations) - 1, -1, -1):
            s = stations[i]
            if s['mode'] == 'stop' or s['remainingWorkSec'] is not None:
                continue
            if i == 0 and state['elapsedSec'] >= state['nextArrivalSec']:
                s['remainingWorkSec'] = s['nominalCycleSec']
                state['released'] += 1
                state['nextArrivalSec'] = state['elapsedSec'] + state['arrivalIntervalSec']
            elif i > 0 and buffers[i - 1]['count'] > 0:
                buffers[i - 1]['count'] -= 1
                s['remainingWorkSec'] = s['nominalCycleSec']
        if record_history and (state['elapsedSec'] % 120 == 0 or state['elapsedSec'] == state['shiftDurationSec']):
            state['history'].append(dict(elapsedSec=state['elapsedSec'], good=state['good'], rejected=state['rejected']))


def set_station_mode(state, station_id, mode):
    s = next(s for s in state['stations'] if s['id'] == station_id)
    if s['mode'] == mode:
        return
    for event in state['incidents']:
        if event['stationId'] == station_id and event['resolvedAtSec'] is None:
            event['resolvedAtSec'] = state['elapsedSec']
    s['mode'] = mode
    state['eventSequence'] += 1
    state['incidents'].insert(0, dict(
        id=f"event-{state['eventSequence']}", stationId=station_id,
        title={'stop': 'Пост остановлен', 'slow': 'Время цикла увеличено', 'normal': 'Нормальный режим восстановлен'}[mode],
        detail=(f"{s['id']} · цикл {s['nominalCycleSec']} → {cycle_sec(s)} с" if mode == 'slow' else f"{s['id']} · {s['operation']}"),
        severity={'stop': 'critical', 'slow': 'warning', 'normal': 'info'}[mode],
        startedAtSec=state['elapsedSec'], resolvedAtSec=state['elapsedSec'] if mode == 'normal' else None,
        acknowledged=False,
    ))


def forecast(state):
    projected = deepcopy(state)
    advance_in_place(projected, state['shiftDurationSec'] - state['elapsedSec'], False)
    bottleneck, buffer_id, minutes = None, None, None
    explanation = f"При текущем режиме линия обеспечивает план. Ограничение потока — интервал подачи {state['arrivalIntervalSec']} с."
    stopped = [s for s in state['stations'] if s['mode'] == 'stop']
    slower = sorted((s for s in state['stations'] if cycle_sec(s) > state['arrivalIntervalSec']), key=cycle_sec, reverse=True)
    constrained = (stopped or slower or [None])[0]
    if constrained:
        bottleneck = constrained['id']
        index = state['stations'].index(constrained)
        if index > 0:
            buffer = state['buffers'][index - 1]
            upstream = state['stations'][:index]
            inflow = 0 if any(s['mode'] == 'stop' for s in upstream) else 60 / max(state['arrivalIntervalSec'], *(cycle_sec(s) for s in upstream))
            outflow = 0 if constrained['mode'] == 'stop' else 60 / cycle_sec(constrained)
            if inflow > outflow:
                buffer_id = buffer['id']
                minutes = (buffer['capacity'] - buffer['count']) / (inflow - outflow)
        explanation = (f"{bottleneck} остановлен. Изделия перед ним накапливаются; следующие посты исчерпывают запас."
                       if constrained['mode'] == 'stop' else
                       f"{bottleneck}: цикл {cycle_sec(constrained)} с при подаче каждые {state['arrivalIntervalSec']} с. Перед постом растёт очередь.")
    elif projected['good'] < state['shiftPlan']:
        explanation = 'При текущих параметрах и режиме прогноз ниже плана. Проверьте план, интервал подачи и накопленные потери.'
    return dict(goodAtShiftEnd=projected['good'], planDelta=projected['good'] - state['shiftPlan'],
                bottleneckId=bottleneck, fillBufferId=buffer_id, minutesToFill=minutes,
                explanation=explanation, calculatedAtSec=state['elapsedSec'],
                assumption='Расчёт модели при сохранении текущих режимов до 16:00. Время заполнения буфера — оценка по средним скоростям.')
