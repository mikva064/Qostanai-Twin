import json
import threading
import time
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from .model import initial_state, advance_in_place, set_station_mode, forecast, configuration_from_state
from .storage import Store, encode
from .analysis import compare_scenarios


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class CommandError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class TwinService:
    def __init__(self, db_path, clock=time.monotonic):
        self.lock = threading.RLock()
        self.store = Store(db_path)
        self.clock = clock
        self.last_wall = clock()
        self.fraction = 0.0
        self.fault = None
        self.current = self.store.load()
        if self.current is None:
            self.current = self.new_run(0)
            self.store.save(self.current)

    @staticmethod
    def new_run(revision, configuration=None):
        state = initial_state(configuration=configuration)
        return dict(schemaVersion=2, source='simulation', runId=str(uuid4()), revision=revision,
                    savedAt=utc_now(), controls=dict(paused=True, speed=20), state=state, forecast=forecast(state))

    def snapshot(self):
        with self.lock:
            if self.fault:
                raise CommandError(503, 'Сервер временно не может сохранить состояние. Показаны последние данные.')
            result = deepcopy(self.current)
            result['receivedAt'] = utc_now()
            result['capabilities'] = ['configure_line', 'history_configuration']
            return result

    def compare(self, run_id, station_id, delay_minutes):
        # snapshot() holds the lock only while copying. Forecasts do not stop the ticker.
        base = self.snapshot()
        if run_id != base['runId']:
            raise CommandError(409, 'Сценарий уже изменён. Обновите данные и повторите расчёт.')
        return compare_scenarios(base, station_id, delay_minutes)

    def _commit(self, next_snapshot, command=None):
        next_snapshot['revision'] = self.current['revision'] + 1
        next_snapshot['savedAt'] = utc_now()
        self.store.save(next_snapshot, command)
        self.current = next_snapshot
        self.fault = None

    def tick(self):
        with self.lock:
            now = self.clock()
            control = self.current['controls']
            if control['paused']:
                self.last_wall = now
                return
            seconds_float = max(0, now - self.last_wall) * control['speed'] + self.fraction
            seconds = int(seconds_float)
            if seconds < 1:
                return
            next_snapshot = deepcopy(self.current)
            advance_in_place(next_snapshot['state'], seconds)
            if (next_snapshot['state']['elapsedSec'] - next_snapshot['forecast']['calculatedAtSec'] >= 60
                    or next_snapshot['state']['elapsedSec'] == next_snapshot['state']['shiftDurationSec']):
                next_snapshot['forecast'] = forecast(next_snapshot['state'])
            if next_snapshot['state']['elapsedSec'] == next_snapshot['state']['shiftDurationSec']:
                next_snapshot['controls']['paused'] = True
            self._commit(next_snapshot)
            self.last_wall = now
            self.fraction = seconds_float - seconds

    def dispatch(self, command):
        with self.lock:
            previous = self.store.command(command['commandId'])
            if previous:
                if previous['request'] != encode(command):
                    raise CommandError(409, 'Идентификатор команды уже использован с другими параметрами.')
                response = json.loads(previous['response'])
                response['receivedAt'] = utc_now()
                response['capabilities'] = ['configure_line', 'history_configuration']
                return response
            if command['runId'] != self.current['runId']:
                raise CommandError(409, 'Сценарий уже изменён в другой вкладке. Данные обновлены; повторите действие.')
            self.tick()
            kind = command['type']
            next_snapshot = deepcopy(self.current)
            state = next_snapshot['state']
            if kind in ('set_station_mode', 'advance') and state['elapsedSec'] == state['shiftDurationSec']:
                raise CommandError(409, 'Смена завершена. Начните новый сценарий.')
            if kind == 'set_station_mode':
                set_station_mode(state, command['stationId'], command['mode'])
            elif kind == 'advance':
                advance_in_place(state, command['seconds'])
            elif kind == 'acknowledge_incident':
                event = next((e for e in state['incidents'] if e['id'] == command['incidentId']), None)
                if event is None:
                    raise CommandError(404, 'Инцидент не найден в текущем сценарии.')
                event['acknowledged'] = True
            elif kind == 'set_playback':
                next_snapshot['controls'].update({k: command[k] for k in ('paused', 'speed') if k in command and command[k] is not None})
                if state['elapsedSec'] == state['shiftDurationSec']:
                    next_snapshot['controls']['paused'] = True
            elif kind == 'reset':
                next_snapshot = self.new_run(self.current['revision'], configuration_from_state(state))
            elif kind == 'configure_line':
                next_snapshot = self.new_run(self.current['revision'], command['configuration'])
            if kind in ('set_station_mode', 'advance'):
                next_snapshot['forecast'] = forecast(state)
            if next_snapshot['state']['elapsedSec'] == next_snapshot['state']['shiftDurationSec']:
                next_snapshot['controls']['paused'] = True
            self._commit(next_snapshot, command)
            self.last_wall = self.clock()
            if kind in ('reset', 'configure_line'):
                self.fraction = 0.0
            return self.snapshot()

    def close(self):
        with self.lock:
            self.store.close()
