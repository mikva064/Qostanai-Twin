import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal, Union
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from .service import CommandError, TwinService
from .history_import import analyze_history, CsvValidationError
from .agent import AgentError, FactoryAgent

ROOT = Path(__file__).resolve().parents[1]
LOG = logging.getLogger('qostanai')


class BaseCommand(BaseModel):
    model_config = ConfigDict(extra='forbid')
    commandId: UUID
    runId: UUID


class StationCommand(BaseCommand):
    type: Literal['set_station_mode']
    stationId: Literal['P01', 'P02', 'P03', 'P04', 'P05']
    mode: Literal['normal', 'slow', 'stop']


class AdvanceCommand(BaseCommand):
    type: Literal['advance']
    seconds: Annotated[int, Field(strict=True, ge=1, le=3600)]


class AcknowledgeCommand(BaseCommand):
    type: Literal['acknowledge_incident']
    incidentId: Annotated[str, Field(pattern=r'^event-[1-9][0-9]*$', max_length=40)]


class PlaybackCommand(BaseCommand):
    type: Literal['set_playback']
    paused: StrictBool | None = None
    speed: Annotated[int, Field(strict=True)] | None = None

    @model_validator(mode='after')
    def valid_playback(self):
        if self.paused is None and self.speed is None:
            raise ValueError('Нужен параметр paused или speed')
        if self.speed is not None and self.speed not in (20, 60, 120):
            raise ValueError('Скорость должна быть 20, 60 или 120')
        return self


class ResetCommand(BaseCommand):
    type: Literal['reset']


CycleSeconds = Annotated[int, Field(strict=True, ge=5, le=3600)]
BufferCapacity = Annotated[int, Field(strict=True, ge=1, le=100)]


class LineConfiguration(BaseModel):
    model_config = ConfigDict(extra='forbid')
    shiftPlan: Annotated[int, Field(strict=True, ge=1, le=100000)]
    arrivalIntervalSec: CycleSeconds
    stationCyclesSec: Annotated[list[CycleSeconds], Field(min_length=5, max_length=5)]
    bufferCapacities: Annotated[list[BufferCapacity], Field(min_length=4, max_length=4)]


class ConfigureLineCommand(BaseCommand):
    type: Literal['configure_line']
    configuration: LineConfiguration


class ComparisonRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    runId: UUID
    stationId: Literal['P01', 'P02', 'P03', 'P04', 'P05']
    delayMinutes: Annotated[int, Field(strict=True, ge=0, le=240)]


class HistoryImportRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    fileName: Annotated[str, Field(min_length=1, max_length=180)]
    csvText: Annotated[str, Field(min_length=1, max_length=524288)]
    shiftPlan: Annotated[int, Field(strict=True, ge=1, le=100000)] = 410
    configuration: LineConfiguration | None = None

    @model_validator(mode='after')
    def consistent_plan(self):
        if self.configuration is not None:
            if 'shiftPlan' in self.model_fields_set and self.shiftPlan != self.configuration.shiftPlan:
                raise ValueError('План смены и план конфигурации должны совпадать')
            self.shiftPlan = self.configuration.shiftPlan
        return self


Command = Annotated[Union[StationCommand, AdvanceCommand, AcknowledgeCommand, PlaybackCommand, ResetCommand, ConfigureLineCommand], Field(discriminator='type')]


class AgentHistoryMessage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['user', 'assistant']
    content: Annotated[str, Field(min_length=1, max_length=4000)]


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    question: Annotated[str, Field(min_length=1, max_length=2000)]
    scope: Literal['case', 'simulation']
    date: Annotated[str, Field(pattern=r'^\d{4}-\d{2}-\d{2}$')] | None = None
    runId: UUID | None = None
    history: Annotated[list[AgentHistoryMessage], Field(max_length=8)] = Field(default_factory=list)

    @model_validator(mode='after')
    def scoped_context(self):
        if self.scope == 'case' and (self.date is None or self.runId is not None):
            raise ValueError('Для кейса нужна дата без runId')
        if self.scope == 'simulation' and (self.runId is None or self.date is not None):
            raise ValueError('Для симулятора нужен runId без даты кейса')
        return self


def create_app(db_path=None, start_ticker=True, clock=None, agent_factory=None):
    database = Path(db_path or os.getenv('QOSTANAI_DB', str(ROOT / 'data' / 'twin.sqlite3')))

    @asynccontextmanager
    async def lifespan(app):
        service = TwinService(database, **({'clock': clock} if clock else {}))
        app.state.twin = service
        try:
            app.state.agent = (agent_factory or FactoryAgent)(service)
        except Exception:
            service.close()
            raise
        stop = asyncio.Event()

        async def ticker():
            while not stop.is_set():
                try:
                    await asyncio.to_thread(service.tick)
                except Exception:
                    service.fault = 'storage'
                    LOG.exception('Simulation tick failed')
                try:
                    await asyncio.wait_for(stop.wait(), timeout=0.5)
                except TimeoutError:
                    pass

        task = asyncio.create_task(ticker()) if start_ticker else None
        try:
            yield
        finally:
            stop.set()
            if task:
                await task
            service.close()

    app = FastAPI(title='Zauyt AI API', version='0.8.0', lifespan=lifespan)

    @app.middleware('http')
    async def local_requests(request: Request, call_next):
        # No open CORS. Browser writes must come from this local UI or Vite dev UI.
        host = request.headers.get('host', '').split(':')[0]
        if host not in ('127.0.0.1', 'localhost', 'testserver'):
            return JSONResponse({'detail': 'Недопустимый адрес сервера'}, status_code=400)
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            origin = request.headers.get('origin')
            allowed = {f'http://{h}:{p}' for h in ('127.0.0.1', 'localhost') for p in (4173, 5173)}
            if origin and origin not in allowed:
                return JSONResponse({'detail': 'Команда с другого сайта отклонена'}, status_code=403)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.exception_handler(CommandError)
    async def command_error(request, error):
        return JSONResponse({'detail': error.message}, status_code=error.status)

    @app.exception_handler(AgentError)
    async def agent_error(request, error):
        LOG.warning('Agent request failed: %s (HTTP %s)', error.code, error.status)
        return JSONResponse({'detail': error.message, 'code': error.code}, status_code=error.status)

    @app.get('/api/v1/agent/status')
    def agent_status(request: Request):
        return request.app.state.agent.status()

    @app.post('/api/v1/agent/check')
    async def agent_check(request: Request):
        return await request.app.state.agent.check_connection()

    @app.post('/api/v1/agent/ask')
    async def agent_ask(payload: AgentRequest, request: Request):
        return await request.app.state.agent.ask(payload.question, payload.scope, payload.date,
                                                  str(payload.runId) if payload.runId else None,
                                                  [item.model_dump() for item in payload.history])

    @app.get('/api/v1/health')
    def health(request: Request):
        snapshot = request.app.state.twin.snapshot()
        return dict(status='ok', storage='sqlite', source='simulation', runId=snapshot['runId'], revision=snapshot['revision'])

    @app.get('/api/v1/twin')
    def get_twin(request: Request):
        return request.app.state.twin.snapshot()

    @app.post('/api/v1/commands')
    def command(payload: Command, request: Request):
        return request.app.state.twin.dispatch(payload.model_dump(mode='json', exclude_none=True))

    @app.get('/api/v1/runs')
    def runs(request: Request):
        service = request.app.state.twin
        with service.lock:
            return dict(currentRunId=service.current['runId'], runs=service.store.run_list())

    @app.post('/api/v1/analysis/compare')
    def compare(payload: ComparisonRequest, request: Request):
        return request.app.state.twin.compare(str(payload.runId), payload.stationId, payload.delayMinutes)

    @app.get('/api/v1/runs/{run_id}')
    def archived_run(run_id: UUID, request: Request):
        service = request.app.state.twin
        with service.lock:
            result = service.store.archived(str(run_id))
            if result is None:
                raise HTTPException(404, 'Сценарий не найден')
            return result

    @app.get('/api/v1/history/example.csv')
    def history_example():
        return FileResponse(ROOT / 'public' / 'examples' / 'demo-shift.csv',
                            media_type='text/csv; charset=utf-8', filename='demo-shift.csv')

    @app.post('/api/v1/history/import')
    def history_import(payload: HistoryImportRequest, request: Request):
        demo = (ROOT / 'public' / 'examples' / 'demo-shift.csv').read_text(encoding='utf-8')
        try:
            report = analyze_history(payload.csvText, payload.fileName, payload.shiftPlan, demo,
                                     payload.configuration.model_dump() if payload.configuration is not None else None)
        except CsvValidationError as error:
            return JSONResponse(dict(detail='CSV не импортирован. Исправьте ошибки в файле.',
                                     issues=error.issues, totalIssues=error.total), status_code=422)
        service = request.app.state.twin
        with service.lock:
            return service.store.save_import(report, payload.csvText)

    @app.get('/api/v1/history/imports')
    def history_imports(request: Request):
        service = request.app.state.twin
        with service.lock:
            return dict(imports=service.store.import_list())

    @app.get('/api/v1/history/imports/{import_id}')
    def history_report(import_id: Annotated[str, Field(pattern=r'^[a-f0-9]{64}$')], request: Request):
        service = request.app.state.twin
        with service.lock:
            report = service.store.import_report(import_id)
        if report is None:
            raise HTTPException(404, 'Импорт не найден')
        return report

    @app.get('/')
    def index():
        if not (ROOT / 'dist' / 'index.html').exists():
            raise HTTPException(503, 'Сначала соберите интерфейс: npm run build')
        return FileResponse(ROOT / 'dist' / 'index.html')

    @app.get('/favicon.svg')
    def favicon():
        return FileResponse(ROOT / 'public' / 'favicon.svg')

    app.mount('/assets', StaticFiles(directory=ROOT / 'dist' / 'assets', check_dir=False), name='assets')
    return app


app = create_app()
