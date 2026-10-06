import asyncio
import json
import unittest
from unittest.mock import AsyncMock

from backend.agent import AgentError, FactoryAgent
from scripts.evaluate_agent import check_answer_numbers, check_evidence, evaluate, load_cases


class AgentEvaluationTests(unittest.TestCase):
    def factory(self, configured=True, request=None):
        return lambda service: FactoryAgent(service, settings=lambda: ('test-only' if configured else '', 'test-model'), request=request)

    def test_all_reference_numbers_are_reproducible_without_a_model_call(self):
        request = AsyncMock()
        report = asyncio.run(evaluate(load_cases(), agent_factory=self.factory(request=request)))
        self.assertEqual(report['status'], 'references_ready_no_model_call')
        self.assertEqual(report['referenceChecksPassed'], 7)
        self.assertEqual(report['apiCalls'], 0)
        self.assertFalse(report['liveCallVerified'])
        self.assertTrue(all(row['status'] == 'not_run' for row in report['rows']))
        request.assert_not_called()

    def test_missing_key_is_reported_without_calls_or_fake_answers(self):
        request = AsyncMock()
        report = asyncio.run(evaluate(load_cases(), live=True, agent_factory=self.factory(False, request)))
        self.assertEqual(report['status'], 'blocked_missing_key')
        self.assertEqual(report['apiCalls'], 0)
        self.assertFalse(report['liveCallVerified'])
        request.assert_not_called()

    def test_numeric_matching_handles_russian_format_but_flags_wrong_values(self):
        plan = load_cases('plan')[0]
        self.assertEqual(check_answer_numbers(plan, '4 800 / 5\u202f500; разница 700 автомобилей.'), [])
        self.assertTrue(check_answer_numbers(plan, '4800, 5500 и разница 600.'))
        quality = load_cases('quality')[0]
        self.assertEqual(check_answer_numbers(quality, 'Брак 5,17%, лимит 2%.'), [])
        self.assertTrue(check_answer_numbers(quality, 'Брак 5,7%, лимит 2%.'))
        self.assertTrue(check_evidence(plan, []))

    def test_provider_error_stops_the_suite_without_automatic_retries(self):
        request = AsyncMock(side_effect=AgentError(429, 'Лимит API'))
        report = asyncio.run(evaluate(load_cases(), live=True, agent_factory=self.factory(request=request)))
        self.assertEqual(report['status'], 'needs_attention')
        self.assertEqual(report['apiCalls'], 1)
        self.assertEqual(report['notRun'], 6)
        self.assertEqual(report['rows'][0]['status'], 'provider_error')
        self.assertFalse(report['liveCallVerified'])
        self.assertTrue(report['stateUnchanged'])

    def test_live_checks_require_human_review_even_when_values_and_tools_match(self):
        request = AsyncMock(side_effect=[
            dict(status='completed', output=[dict(type='function_call', name='get_case_metrics', call_id='c1', arguments='{}')]),
            dict(status='completed', output=[dict(type='message', content=[dict(type='output_text', text='4800, 5500, разница 700. Неверная причина может остаться в тексте.')])]),
        ])
        report = asyncio.run(evaluate(load_cases('plan'), live=True, agent_factory=self.factory(request=request)))
        self.assertEqual(report['status'], 'needs_human_review')
        self.assertTrue(report['humanReviewRequired'])
        self.assertEqual(report['rows'][0]['humanReview'], 'pending')
        self.assertTrue(report['stateUnchanged'])
        self.assertEqual(report['apiCalls'], 2)
        self.assertNotIn('test-only', json.dumps(report))


if __name__ == '__main__':
    unittest.main()
