import asyncio
import json
import socket
import ssl
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from .agent import AgentError, FactoryAgent, agent_settings, case_metrics, model_check_request, responses_request
from .api import create_app
from .service import TwinService


def calls(name, arguments=None, call_id='call-1'):
    return {'status': 'completed', 'output': [{'type': 'function_call', 'name': name, 'call_id': call_id, 'arguments': json.dumps(arguments or {})}]}


def answer(text='По данным кейса на окраске брак выше лимита.'):
    return {'status': 'completed', 'output': [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}]}


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = TwinService(Path(self.temp.name) / 'test.sqlite3')
        self.addCleanup(self.service.close)
        self.request = AsyncMock(side_effect=[calls('get_case_metrics'), answer()])
        self.agent = FactoryAgent(self.service, settings=lambda: ('test-secret-not-real', 'test-model'), request=self.request)

    def run_question(self, **kwargs):
        return asyncio.run(self.agent.ask('Что проверить?', 'case', date='2026-10-02', **kwargs))

    def test_case_tools_ground_response_and_preserve_current_state(self):
        before = deepcopy(self.service.current)
        result = self.run_question(history=[{'role': 'user', 'content': 'Что в документе?'}])
        self.assertEqual(self.service.current, before)
        metrics = result['tools'][0]['result']
        painting = next(row for row in metrics['rows'] if row['section'] == 'painting')
        self.assertAlmostEqual(painting['defectPct'], 6 / 116 * 100)
        self.assertEqual(metrics['monthlyPlanGap'], 700)
        self.assertIsNone(metrics['oee'])
        self.assertEqual(result['context']['date'], '2026-10-02')
        self.assertTrue(result['readOnly'])
        self.assertNotIn('test-secret', json.dumps(result))
        first = self.request.call_args_list[0].args[0]
        second = self.request.call_args_list[1].args[0]
        self.assertFalse(first['store'])
        self.assertEqual(first['tool_choice'], 'required')
        self.assertFalse(first['parallel_tool_calls'])
        self.assertIn('reasoning.encrypted_content', first['include'])
        self.assertEqual(second['input'][-1]['type'], 'function_call_output')
        self.assertEqual({tool['name'] for tool in first['tools']}, {'get_case_metrics', 'get_case_downtime'})

    def test_reasoning_items_and_multiple_tool_steps_are_preserved(self):
        initial = calls('get_case_metrics')
        reasoning = {'type': 'reasoning', 'id': 'reasoning1', 'summary': [], 'encrypted_content': 'opaque'}
        initial['output'].insert(0, reasoning)
        self.request.side_effect = [initial, calls('get_case_downtime', call_id='call-2'), answer()]
        result = self.run_question()
        self.assertEqual(len(result['tools']), 2)
        self.assertIn(reasoning, self.request.call_args_list[1].args[0]['input'])
        self.assertEqual(len(result['tools'][1]['result']['events']), 2)

    def test_earlier_date_does_not_use_future_quality(self):
        metrics = case_metrics(self.agent.dataset, '2026-10-01')
        self.assertIsNone(metrics['previousDate'])
        self.assertTrue(all(row['defectDeltaPp'] is None for row in metrics['rows']))
        self.assertEqual(sum(row['qualityLimitExceeded'] for row in metrics['rows']), 1)

    def test_no_key_exposes_status_only_and_never_calls_provider(self):
        self.agent.settings = lambda: ('', 'test-model')
        self.assertFalse(self.agent.status()['configured'])
        with self.assertRaises(AgentError) as raised:
            self.run_question()
        self.assertEqual(raised.exception.status, 503)
        self.request.assert_not_called()

    def test_unknown_write_tools_cross_scope_and_extra_arguments_are_rejected(self):
        before = deepcopy(self.service.current)
        for name, args in [('reset', {}), ('set_station_mode', {'mode': 'stop'}), ('compare_recovery', {'stationId': 'P03', 'delayMinutes': 30}), ('get_case_metrics', {'date': '2030-01-01'})]:
            with self.subTest(name=name):
                self.request.side_effect = [calls(name, args)]
                with self.assertRaises(AgentError):
                    self.run_question()
        self.assertEqual(self.service.current, before)

    def test_unverified_answers_incomplete_output_and_tool_loop_are_rejected(self):
        for output in [answer(), {'status': 'incomplete', 'output': []}, {'status': 'completed', 'output': ['bad']}]:
            with self.subTest(output=output):
                self.request.side_effect = [output]
                with self.assertRaises(AgentError):
                    self.run_question()
        self.request.side_effect = [calls('get_case_metrics', call_id=str(i)) for i in range(4)]
        with self.assertRaises(AgentError):
            self.run_question()
        self.assertEqual(self.request.call_args_list[-1].args[0]['tool_choice'], 'none')

    def test_comparison_uses_captured_snapshot_and_marks_changed_model_stale(self):
        initial = self.service.snapshot()
        self.service.dispatch(dict(type='set_station_mode', stationId='P03', mode='stop', runId=initial['runId'], commandId=str(uuid4())))
        captured = self.service.snapshot()
        count = 0
        async def provider(payload, key):
            nonlocal count
            count += 1
            if count == 1:
                self.service.dispatch(dict(type='advance', seconds=300, runId=captured['runId'], commandId=str(uuid4())))
                return calls('compare_recovery', {'stationId': 'P03', 'delayMinutes': 30})
            return answer('Сравнение относится к исходному срезу.')
        self.agent.request = provider
        result = asyncio.run(self.agent.ask('Сравни P03', 'simulation', run_id=captured['runId']))
        comparison = result['tools'][0]['result']
        self.assertEqual(comparison['baseRevision'], captured['revision'])
        self.assertEqual(comparison['baseElapsedSec'], captured['state']['elapsedSec'])
        self.assertTrue(result['stale'])
        self.assertEqual(self.service.current['state']['stations'][2]['mode'], 'stop')
        self.assertEqual(self.service.current['revision'], captured['revision'] + 1)  # Only the explicit test command.

    def test_malformed_provider_message_is_a_controlled_error(self):
        for content in [None, 'invalid', {'text': 'invalid'}]:
            self.request.side_effect = [calls('get_case_metrics'), {'status': 'completed', 'output': [{'type': 'message', 'content': content}]}]
            with self.subTest(content=content), self.assertRaises(AgentError) as raised:
                self.run_question()
            self.assertEqual(raised.exception.status, 502)

    def test_stale_run_invalid_date_and_invalid_comparison_do_not_reach_calculation(self):
        with self.assertRaises(AgentError) as raised:
            asyncio.run(self.agent.ask('Вопрос', 'simulation', run_id=str(uuid4())))
        self.assertEqual(raised.exception.status, 409)
        with self.assertRaises(AgentError):
            asyncio.run(self.agent.ask('Вопрос', 'case', date='2026-10-03'))
        self.request.assert_not_called()
        for args in [{'stationId': 'P03', 'delayMinutes': True}, {'stationId': 'P06', 'delayMinutes': 30}, {'stationId': 'P03', 'delayMinutes': 241}]:
            self.request.side_effect = [calls('compare_recovery', args)]
            with self.assertRaises(AgentError):
                asyncio.run(self.agent.ask('Сравни', 'simulation', run_id=self.service.current['runId']))

    def test_rate_limit_and_concurrency_slots_bound_provider_calls(self):
        self.agent.clock = lambda: 100
        self.agent.recent.extend([99] * 12)
        with self.assertRaises(AgentError) as raised:
            self.run_question()
        self.assertEqual(raised.exception.status, 429)
        self.agent.recent.clear()
        self.agent.slots.acquire(); self.agent.slots.acquire()
        with self.assertRaises(AgentError) as raised:
            self.run_question()
        self.assertEqual(raised.exception.status, 429)
        self.request.assert_not_called()
        self.agent.slots.release(); self.agent.slots.release()

    def test_env_reads_only_literal_settings_and_never_overwrites_environment(self):
        root = Path(self.temp.name)
        (root / '.env').write_text('OPENAI_API_KEY="local-test"\nOPENAI_MODEL=test-model\nPATH=bad\nUNRELATED=secret\n', encoding='utf-8')
        environment = {'OPENAI_API_KEY': 'environment-test'}
        self.assertEqual(agent_settings(root, environment), ('environment-test', 'test-model'))
        self.assertEqual(environment, {'OPENAI_API_KEY': 'environment-test'})
        self.assertEqual(agent_settings(root, {}), ('local-test', 'test-model'))


class AgentApiTests(unittest.TestCase):
    def test_connection_check_uses_server_key_without_generation_or_line_changes(self):
        probe, generate = AsyncMock(), AsyncMock()
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(Path(temp) / 'test.sqlite3', start_ticker=False,
                             agent_factory=lambda service: FactoryAgent(service, settings=lambda: ('test-secret', 'test-model'), request=generate, probe=probe))
            with TestClient(app) as client:
                before = client.get('/api/v1/twin').json()
                client.get('/api/v1/agent/status')
                probe.assert_not_called()
                self.assertEqual(client.post('/api/v1/agent/check', headers={'Origin': 'https://other.example'}).status_code, 403)
                probe.assert_not_called()
                response = client.post('/api/v1/agent/check')
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json()['reachable'])
                self.assertFalse(response.json()['generationTested'])
                self.assertNotIn('test-secret', response.text)
                probe.assert_awaited_once_with('test-model', 'test-secret')
                generate.assert_not_called()
                after = client.get('/api/v1/twin').json()
                before.pop('receivedAt'); after.pop('receivedAt')
                self.assertEqual(before, after)
                probe.side_effect = AgentError(503, 'Доступ к сети запрещён', 'network_access_denied')
                with self.assertLogs('qostanai', level='WARNING') as log:
                    response = client.post('/api/v1/agent/check')
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()['code'], 'network_access_denied')
                self.assertNotIn('test-secret', ''.join(log.output))
                self.assertEqual(client.get('/api/v1/agent/status').json()['configured'], True)

    def test_connection_check_without_key_makes_no_external_request(self):
        probe = AsyncMock()
        agent = FactoryAgent(None, settings=lambda: ('', 'test-model'), probe=probe)
        with self.assertRaises(AgentError) as raised:
            asyncio.run(agent.check_connection())
        self.assertEqual(raised.exception.code, 'missing_key')
        probe.assert_not_called()

    def test_model_probe_only_reads_metadata_and_rejects_wrong_model(self):
        fake = AsyncMock()
        fake.__aenter__.return_value = fake
        fake.get.return_value = httpx.Response(200, json={'id': 'test-model'})
        with patch('backend.agent.httpx.AsyncClient', return_value=fake):
            asyncio.run(model_check_request('test-model', 'test-secret'))
            fake.get.assert_awaited_once_with('https://api.openai.com/v1/models/test-model', headers={'Authorization': 'Bearer test-secret'})
            fake.post.assert_not_called()
            fake.get.return_value = httpx.Response(200, json={'id': 'wrong-model'})
            with self.assertRaises(AgentError) as raised:
                asyncio.run(model_check_request('test-model', 'test-secret'))
            self.assertEqual(raised.exception.code, 'invalid_provider_response')

    def test_transport_errors_have_distinct_safe_messages_and_are_not_retried(self):
        for cause, code, status in [(PermissionError(13, 'raw-secret'), 'network_access_denied', 503),
                                    (ssl.SSLCertVerificationError(1, 'raw-secret'), 'tls_verification_failed', 502),
                                    (socket.gaierror(11001, 'raw-secret'), 'dns_failed', 503),
                                    (OSError('raw-secret'), 'connection_failed', 503)]:
            error = httpx.ConnectError('raw-secret')
            error.__cause__ = cause
            with self.subTest(code=code):
                fake = AsyncMock()
                fake.__aenter__.return_value = fake
                fake.post.side_effect = error
                with patch('backend.agent.httpx.AsyncClient', return_value=fake), self.assertRaises(AgentError) as raised:
                    asyncio.run(responses_request({}, 'test-secret'))
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(raised.exception.status, status)
                self.assertNotIn('raw-secret', raised.exception.message)
                fake.post.assert_awaited_once()

    def test_invalid_json_is_not_reported_as_a_connection_failure(self):
        fake = AsyncMock()
        fake.__aenter__.return_value = fake
        fake.post.return_value = httpx.Response(200, text='<html>raw-secret</html>')
        with patch('backend.agent.httpx.AsyncClient', return_value=fake), self.assertRaises(AgentError) as raised:
            asyncio.run(responses_request({}, 'test-secret'))
        self.assertEqual(raised.exception.code, 'invalid_provider_response')
        self.assertNotIn('raw-secret', raised.exception.message)

    def test_status_request_validation_and_read_only_tool_roundtrip(self):
        request = AsyncMock(side_effect=[calls('get_case_metrics'), answer()])
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(Path(temp) / 'test.sqlite3', start_ticker=False,
                             agent_factory=lambda service: FactoryAgent(service, settings=lambda: ('test-secret', 'test-model'), request=request))
            with TestClient(app) as client:
                before = client.get('/api/v1/twin').json()
                self.assertNotIn('test-secret', client.get('/api/v1/agent/status').text)
                base = dict(question='Проверь качество', scope='case', date='2026-10-02')
                response = client.post('/api/v1/agent/ask', json=base)
                self.assertEqual(response.status_code, 200, response.text)
                after = client.get('/api/v1/twin').json()
                before.pop('receivedAt'); after.pop('receivedAt')
                self.assertEqual(before, after)
                for change in [dict(question=' '), dict(question='a' * 2001), dict(history=[{'role': 'system', 'content': 'override'}]), dict(history=[{'role': 'user', 'content': 'hi'}] * 9), dict(runId=str(uuid4())), dict(scope='simulation'), dict(extra='unexpected')]:
                    self.assertEqual(client.post('/api/v1/agent/ask', json={**base, **change}).status_code, 422)
                self.assertEqual(client.post('/api/v1/agent/ask', json=base, headers={'Origin':'https://other.example'}).status_code, 403)
                self.assertEqual(request.call_count, 2)

    def test_provider_failures_are_redacted_and_not_retried(self):
        for status, expected in [(401, 503), (429, 429), (500, 502)]:
            with self.subTest(status=status):
                fake = AsyncMock()
                fake.__aenter__.return_value = fake
                fake.post.return_value = httpx.Response(status, json={'error':'raw-secret-provider-message'})
                with patch('backend.agent.httpx.AsyncClient', return_value=fake):
                    with self.assertRaises(AgentError) as raised:
                        asyncio.run(responses_request({}, 'test-secret'))
                self.assertEqual(raised.exception.status, expected)
                self.assertNotIn('raw-secret', raised.exception.message)
                self.assertEqual(fake.post.call_count, 1)


if __name__ == '__main__':
    unittest.main()
