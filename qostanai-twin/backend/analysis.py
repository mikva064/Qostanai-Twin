"""Read-only counterfactuals on independent copies of one consistent snapshot."""
from copy import deepcopy
from datetime import datetime, timezone

from .model import advance_in_place


def compare_scenarios(snapshot, station_id, delay_minutes):
    base = snapshot['state']
    selected = next(s for s in base['stations'] if s['id'] == station_id)
    start, end = base['elapsedSec'], base['shiftDurationSec']
    results = []
    options = [('baseline', 'Текущий режим', None),
               ('restore_now', 'Восстановить сейчас', start),
               ('restore_later', f'Восстановить через {delay_minutes} мин', start + delay_minutes * 60)]
    for scenario_id, title, recovery in options:
        state = deepcopy(base)
        station = next(s for s in state['stations'] if s['id'] == station_id)
        # Completion at/after shift end cannot influence this shift's production.
        effective = recovery if recovery is not None and recovery < end else None
        series = [dict(elapsedSec=start, good=state['good'], rejected=state['rejected'])]
        if effective == start:
            station['mode'] = 'normal'
        boundaries = set(range(start + 300, end, 300)) | {end}
        if effective is not None and effective > start:
            boundaries.add(effective)
        for target in sorted(boundaries):
            if target <= state['elapsedSec']:
                continue
            advance_in_place(state, target - state['elapsedSec'], record_history=False)
            if target == effective:
                station['mode'] = 'normal'
            series.append(dict(elapsedSec=target, good=state['good'], rejected=state['rejected']))
        results.append(dict(id=scenario_id, title=title, recoveryAtSec=effective,
                            recoveryWithinShift=effective is not None,
                            good=state['good'], rejected=state['rejected'],
                            planDelta=state['good'] - base['shiftPlan'],
                            planFulfillmentPct=round(100 * state['good'] / base['shiftPlan'], 1),
                            gainVsBaseline=0,
                            additionalDowntimeSec=station['downtimeSec'] - selected['downtimeSec'],
                            series=series))
    for result in results:
        result['gainVsBaseline'] = result['good'] - results[0]['good']
    best = max(r['good'] for r in results)
    return dict(
        schemaVersion=1, source=base['source'], runId=snapshot['runId'],
        baseRevision=snapshot['revision'], calculatedAt=datetime.now(timezone.utc).isoformat(),
        baseElapsedSec=start, shiftDurationSec=end, plan=base['shiftPlan'],
        stationId=station_id, stationName=selected['name'], stationMode=selected['mode'],
        nominalCycleSec=selected['nominalCycleSec'], delayMinutes=delay_minutes,
        initialGood=base['good'], initialRejected=base['rejected'],
        stationModes=[dict(id=s['id'], mode=s['mode']) for s in base['stations']],
        results=results,
        summary=dict(bestScenarioIds=[r['id'] for r in results if r['good'] == best],
                     maxGain=best - results[0]['good'], delayLoss=results[1]['good'] - results[2]['good']),
        assumptions=[
            'Расчёт на условных демонстрационных данных; это результат модели, а не оценка ИИ.',
            'Все варианты стартуют из одного состояния линии, включая изделия в работе и очереди.',
            'Восстановление означает мгновенный возврат выбранного поста к нормативному циклу. '
            'Задержка — время до завершения восстановления, а не предсказанная длительность ремонта.',
            'Режимы остальных постов, интервал подачи и правило брака остаются неизменными до конца смены.',
            'Дефектным считается каждое 25-е изделие на выходе; отказы и сменные перерывы не моделируются.',
            'Эффект выражен в годных изделиях. Стоимость ремонта, персонал и денежная выгода не оценивались.',
        ])
