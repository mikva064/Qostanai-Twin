"""Reference checks and explicit, bounded live evaluations on an isolated factory state."""
import argparse
import asyncio
import json
import math
import re
import tempfile
import time
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from backend.agent import AgentError, FactoryAgent, case_metrics
from backend.analysis import compare_scenarios
from backend.service import TwinService

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / 'docs/agent-eval-cases.json'


def load_cases(case_id=None):
    cases = json.loads(CASES.read_text(encoding='utf-8'))
    selected = [item for item in cases if not case_id or item['id'] == case_id]
    if not selected:
        raise ValueError('Неизвестная проверка: ' + str(case_id))
    return selected


def equal(actual, expected, tolerance=0):
    if type(expected) in (int, float):
        return type(actual) in (int, float) and math.isfinite(actual) and abs(actual - expected) <= tolerance
    return type(actual) is type(expected) and actual == expected


def at_path(data, path):
    for key in path:
        data = data[key]
    return data


def check_evidence(case, trace):
    failures = []
    for name in case['requiredTools']:
        candidates = [entry['result'] for entry in trace if entry['name'] == name]
        expectations = [item for item in case['evidence'] if item['tool'] == name]
        def matches(result):
            try:
                return all(equal(at_path(result, item['path']), item['value'], item.get('tolerance', 0)) for item in expectations)
            except (KeyError, IndexError, TypeError):
                return False
        if not any(matches(result) for result in candidates):
            failures.append('Не подтверждены эталонные данные инструмента ' + name)
    return failures


def check_answer_numbers(case, answer):
    # This only flags absent values; it cannot establish the correctness of prose.
    tokens = re.findall(r'(?<!\w)\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?(?!\w)', answer)
    values = [float(re.sub(r'[ \u00a0\u202f]', '', token).replace(',', '.')) for token in tokens]
    return ['В тексте не найдено ожидаемое число ' + str(item['value'])
            for item in case['answerNumbers']
            if not any(equal(value, item['value'], item.get('tolerance', 0)) for value in values)]


def prepare_service(path):
    service = TwinService(path)
    try:
        for command in [dict(type='set_station_mode', stationId='P03', mode='stop'), dict(type='advance', seconds=900)]:
            service.dispatch(dict(**command, runId=service.current['runId'], commandId=str(uuid4())))
    except Exception:
        service.close()
        raise
    return service


def reference_trace(agent, case):
    snapshot = agent.service.snapshot()
    results = {}
    if case['scope'] == 'case':
        results['get_case_metrics'] = case_metrics(agent.dataset, case['date'])
        results['get_case_downtime'] = dict(events=[row for row in agent.dataset['downtime'] if row['date'] == case['date']])
    else:
        results['get_twin_snapshot'] = dict(state=snapshot['state'])
        if 'compare_recovery' in case['requiredTools']:
            results['compare_recovery'] = compare_scenarios(snapshot, 'P03', 30)
    return [dict(name=name, result=results[name]) for name in case['requiredTools']]


async def evaluate(cases, live=False, agent_factory=FactoryAgent, progress=None):
    report = dict(schemaVersion=1, createdAt=datetime.now(timezone.utc).isoformat(), mode='live' if live else 'reference',
                  liveCallVerified=False, humanReviewRequired=True, rows=[], apiCalls=0,
                  note='Автопроверка чисел и инструментов не заменяет оценку смысла, причин и рекомендаций человеком.')
    with tempfile.TemporaryDirectory(prefix='qostanai-agent-eval-') as directory:
        service = prepare_service(Path(directory) / 'evaluation.sqlite3')
        try:
            agent = agent_factory(service)
            status = agent.status()
            report['model'] = status['model']
            request = agent.request
            async def tracked_request(payload, key):
                report['apiCalls'] += 1
                return await request(payload, key)
            agent.request = tracked_request
            before = deepcopy(service.current)
            for case in cases:
                problems = check_evidence(case, reference_trace(agent, case))
                if problems:
                    report['rows'].append(dict(id=case['id'], status='reference_failed', failures=problems))
            if report['rows']:
                report['status'] = 'reference_failed'
                return report
            report['referenceChecksPassed'] = len(cases)
            if not live:
                report['status'] = 'references_ready_no_model_call'
                report['rows'] = [dict(id=case['id'], title=case['title'], question=case['question'], status='not_run',
                                       expected=case['evidence'], review=case['review']) for case in cases]
                return report
            if not status['configured']:
                report['status'] = 'blocked_missing_key'
                report['message'] = 'Добавьте OPENAI_API_KEY в локальный .env. Ключ в отчёт не записывается.'
                return report
            for case in cases:
                if progress:
                    progress('Проверка ' + case['id'] + '…')
                row = dict(id=case['id'], title=case['title'], question=case['question'], review=case['review'], humanReview='pending')
                start = time.monotonic()
                try:
                    reply = await agent.ask(case['question'], case['scope'], date=case.get('date'),
                                            run_id=service.current['runId'] if case['scope'] == 'simulation' else None)
                    report['liveCallVerified'] = True
                    problems = check_evidence(case, reply['tools']) + check_answer_numbers(case, reply['answer'])
                    if service.current != before:
                        problems.append('Состояние изолированной линии изменилось во время ответа агента.')
                    row.update(status='checks_failed' if problems else 'checks_passed_needs_review', failures=problems, response=reply)
                except AgentError as error:
                    row.update(status='provider_error', error=error.message, httpStatus=error.status)
                row['seconds'] = round(time.monotonic() - start, 2)
                report['rows'].append(row)
                if row['status'] == 'provider_error' or service.current != before:
                    break  # No cost-bearing retries after provider or integrity failure.
            report['stateUnchanged'] = service.current == before
            report['checksPassed'] = sum(row['status'] == 'checks_passed_needs_review' for row in report['rows'])
            report['notRun'] = len(cases) - len(report['rows'])
            report['status'] = 'needs_human_review' if report['checksPassed'] == len(cases) else 'needs_attention'
            return report
        finally:
            service.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Проверка агента на 7 контрольных вопросах; рабочая линия не меняется.')
    parser.add_argument('--live', action='store_true', help='Обращаться к OpenAI: до 4 запросов на вопрос, используются средства API.')
    parser.add_argument('--case', choices=[item['id'] for item in load_cases()], help='Только один контрольный вопрос.')
    parser.add_argument('--output', type=Path, help='Новый JSON-файл отчёта; существующий файл не перезаписывается.')
    args = parser.parse_args(argv)
    output = args.output or ROOT / 'data/agent-evals' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Reserve the output before a live request, so an existing file never causes a paid rerun.
    with output.open('x', encoding='utf-8') as file:
        try:
            report = asyncio.run(evaluate(load_cases(args.case), args.live, progress=lambda message: print(message, flush=True)))
        except AgentError as error:
            report = dict(status='configuration_error', liveCallVerified=False, message=error.message)
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write('\n')
    print(json.dumps(dict(status=report['status'], model=report.get('model'), apiCalls=report.get('apiCalls', 0),
                          referenceChecksPassed=report.get('referenceChecksPassed', 0), checksPassed=report.get('checksPassed'),
                          liveCallVerified=report['liveCallVerified'], report=str(output)), ensure_ascii=False))
    return 2 if report['status'] in ('blocked_missing_key', 'configuration_error') else 1 if report['status'] in ('needs_attention', 'reference_failed') else 0


if __name__ == '__main__':
    raise SystemExit(main())
