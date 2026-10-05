import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configurationForReport, HistorySource, HistoryError } from '../src/history-source.ts';
import { defaultConfiguration } from '../src/configuration.ts';

const report=JSON.parse(readFileSync(new URL('../docs/history.example.json',import.meta.url),'utf8'));
const csv=readFileSync(new URL('../public/examples/demo-shift.csv',import.meta.url),'utf8');

test('imports CSV with its plan and accepts a real historical report',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(url,init)=>{
      assert.equal(url,'/api/v1/history/import');
      assert.equal(init?.method,'POST');
      assert.deepEqual(JSON.parse(String(init?.body)),{fileName:'demo-shift.csv',csvText:csv,shiftPlan:410});
      return Response.json(report);
    };
    const result=await new HistorySource().import('demo-shift.csv',csv,410);
    assert.equal(result.summary.good,390);
    assert.equal(result.summary.flowMae,134.67);
  } finally {globalThis.fetch=original;}
});

test('validation keeps server line numbers and refuses silent retry',async()=>{
  const original=globalThis.fetch;
  let calls=0;
  try {
    globalThis.fetch=async()=>{calls++;return Response.json({detail:'CSV не импортирован',issues:[{row:5,column:'P03_mode',message:'Неизвестный режим'}],totalIssues:1},{status:422});};
    await assert.rejects(new HistorySource().import('bad.csv',csv,410),(e:Error)=>e instanceof HistoryError && e.issues[0].row===5);
    assert.equal(calls,1);
  } finally {globalThis.fetch=original;}
});

test('rejects inconsistent history totals, errors, scores and response identity',async()=>{
  const original=globalThis.fetch;
  try {
    for(const change of [
      (r:typeof report)=>{r.summary.good++;},
      (r:typeof report)=>{r.summary.flowMae=0;},
      (r:typeof report)=>{r.checkpoints[0].flowError=0;},
      (r:typeof report)=>{r.observations[3].elapsedSec=0;},
      (r:typeof report)=>{r.observations[3].modes=['normal'];},
      (r:typeof report)=>{r.importId='a'.repeat(64);},
    ]) {
      const broken=structuredClone(report);change(broken);
      globalThis.fetch=async()=>Response.json(broken);
      await assert.rejects(new HistorySource().load(report.importId),/несовместимый/);
    }
  } finally {globalThis.fetch=original;}
});

test('restores a saved import and explains an older server',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>Response.json({imports:[report]});
    assert.equal((await new HistorySource().list())[0].importId,report.importId);
    globalThis.fetch=async()=>Response.json(report);
    assert.equal((await new HistorySource().load(report.importId)).summary.good,390);
    globalThis.fetch=async()=>Response.json({detail:'Not Found'},{status:404});
    await assert.rejects(new HistorySource().list(),/актуальный сервер/);
  } finally {globalThis.fetch=original;}
});

const configured=JSON.parse(readFileSync(new URL('../docs/history.configured.example.json',import.meta.url),'utf8'));

test('imports and restores an actual configured report with an exact parameter snapshot',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(url,init)=>{
      assert.equal(url,'/api/v1/history/import');
      assert.deepEqual(JSON.parse(String(init?.body)),{fileName:'demo.csv',csvText:csv,shiftPlan:275,configuration:configured.configuration});
      return Response.json(configured);
    };
    const result=await new HistorySource().import('demo.csv',csv,275,configured.configuration);
    assert.deepEqual(result.configuration,configured.configuration);
    globalThis.fetch=async()=>Response.json(configured);
    assert.deepEqual(await new HistorySource().load(configured.importId),configured);
    globalThis.fetch=async()=>Response.json({imports:[configured,report]});
    assert.equal((await new HistorySource().list()).length,2);
  } finally {globalThis.fetch=original;}
});

test('rejects corrupt configuration and incompatible schema in saved reports and listings',async()=>{
  const original=globalThis.fetch;
  try {
    for (const change of [
      (r:typeof configured)=>{delete r.configuration;},
      (r:typeof configured)=>{r.configuration.shiftPlan++;},
      (r:typeof configured)=>{r.configuration.arrivalIntervalSec=4;},
      (r:typeof configured)=>{r.configuration.stationCyclesSec=[48,52];},
      (r:typeof configured)=>{r.configuration.stationCyclesSec[0]=true;},
      (r:typeof configured)=>{r.configuration.bufferCapacities[0]=101;},
      (r:typeof configured)=>{r.configuration.bufferCapacities[0]=1.5;},
      (r:typeof configured)=>{r.methodVersion='flow-history-v1';},
      (r:typeof configured)=>{r.schemaVersion=1;},
    ]) {
      const broken=structuredClone(configured); change(broken);
      globalThis.fetch=async()=>Response.json(broken);
      await assert.rejects(new HistorySource().load(configured.importId),/несовместимый/);
      globalThis.fetch=async()=>Response.json({imports:[broken]});
      await assert.rejects(new HistorySource().list(),/Несовместимый/);
    }
  } finally {globalThis.fetch=original;}
});

test('refuses silently ignored or substituted parameters from the server',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>Response.json(report);
    await assert.rejects(new HistorySource().import('demo.csv',csv,410,defaultConfiguration()),/не подтвердил/);
    const changed=structuredClone(configured); changed.configuration.stationCyclesSec[0]++;
    globalThis.fetch=async()=>Response.json(changed);
    await assert.rejects(new HistorySource().import('demo.csv',csv,275,configured.configuration),/не подтвердил/);
  } finally {globalThis.fetch=original;}
});

test('catches plan conflicts before sending an import',async()=>{
  const original=globalThis.fetch;
  let calls=0;
  try {
    globalThis.fetch=async()=>{calls++;return Response.json(configured);};
    await assert.rejects(new HistorySource().import('demo.csv',csv,410,configured.configuration),/план конфигурации/);
    assert.equal(calls,0);
  } finally {globalThis.fetch=original;}
});

test('reusing modern and legacy report parameters cannot mutate the saved report',()=>{
  const copied=configurationForReport(configured);
  assert.deepEqual(copied,configured.configuration);
  copied.stationCyclesSec[0]=999; copied.bufferCapacities[0]=99;
  assert.equal(configured.configuration.stationCyclesSec[0],45);
  assert.equal(configured.configuration.bufferCapacities[0],2);
  const old=structuredClone(report); old.plan=500;
  assert.deepEqual(configurationForReport(old),{...defaultConfiguration(),shiftPlan:500});
  assert.equal(old.configuration,undefined);
});
