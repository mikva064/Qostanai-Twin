"""Convert the supplied four DOCX tables to a versioned dataset, without executing content."""
import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
HEADERS = [
    ['Дата', 'Линия', 'План', 'Факт', 'Время работы, ч', 'Загрузка, %'],
    ['Дата', 'Участок', 'Оборудование', 'Причина', 'Длительность, мин'],
    ['Модель', 'План на месяц'],
    ['Дата', 'Участок', 'Выпущено', 'Брак', '% брака'],
]
SECTIONS = {'Сварка': 'welding', 'Окраска': 'painting', 'Сборка': 'assembly'}
TOPOLOGY = ['Склад комплектующих', 'Сварка', 'Окраска', 'Сборка', 'Контроль качества', 'Склад готовой продукции']
RULE_TEXT = {
    'Производство работает в 2 смены по 8 часов.': ('schedule', {'shiftsPerDay': 2, 'hoursPerShift': 8}),
    'Целевой показатель OEE - не менее 85%.': ('oeeTargetPct', 85),
    'Допустимый уровень брака - не более 2%.': ('maxDefectPct', 2),
    'Максимально допустимый простой критического оборудования - 60 минут в сутки.': ('criticalDowntimeMinutesPerDay', 60),
    'План выпуска - не менее 5 500 автомобилей в месяц.': ('monthlyTarget', 5500),
}


def extract(path):
    path = Path(path)
    with ZipFile(path) as archive:
        xml = ET.fromstring(archive.read('word/document.xml'))
    text = lambda element: ''.join(t.text or '' for t in element.findall('.//w:t', NS)).strip()
    tables = [[[text(cell) for cell in row.findall('w:tc', NS)] for row in table.findall('w:tr', NS)] for table in xml.findall('.//w:tbl', NS)]
    paragraphs = [text(p) for p in xml.findall('w:body/w:p', NS)]
    if len(tables) != 4 or any(table[0] != header for table, header in zip(tables, HEADERS)):
        raise ValueError('Ожидаются четыре таблицы с исходными заголовками. Нужна явная проверка нового формата.')
    if xml.findall('.//w:ins', NS) or xml.findall('.//w:del', NS):
        raise ValueError('В документе есть исправления: сначала уточните окончательные значения.')
    rules = {}
    for phrase, (key, value) in RULE_TEXT.items():
        if phrase not in paragraphs:
            raise ValueError('Не найдена исходная вводная: ' + phrase)
        rules[key] = value
    if ' → '.join(TOPOLOGY) not in paragraphs:
        raise ValueError('Схема участков отличается от ожидаемой.')
    number = lambda value: float(value.replace(',', '.'))
    day = lambda value: datetime.strptime(value, '%d.%m.%Y').date().isoformat()
    production = []
    for date, line, plan, actual, hours, utilization in tables[0][1:]:
        section = SECTIONS[line.removesuffix('-1')]
        production.append(dict(date=day(date), section=section, line=line, plan=int(plan), actual=int(actual), operatingHours=number(hours), utilizationPct=number(utilization)))
    downtime = [dict(date=day(date), section=SECTIONS[section], equipment=equipment, reason=reason, minutes=int(minutes), critical=None)
                for date, section, equipment, reason, minutes in tables[1][1:]]
    plans = [dict(model=model, plan=int(plan)) for model, plan in tables[2][1:]]
    quality = [dict(date=day(date), section=SECTIONS[section], produced=int(produced), rejected=int(rejected), reportedDefectPct=number(rate))
               for date, section, produced, rejected, rate in tables[3][1:]]
    return dict(schemaVersion=1, provenance=dict(kind='provided-test-data', fileName=path.name, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                title=paragraphs[0], productionPeriod='unspecified', monthlyPlanPeriod='unspecified'),
                production=production, downtime=downtime, monthlyPlans=plans, quality=quality, topology=TOPOLOGY, rules=rules)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    dataset = extract(args.document)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: len(dataset[key]) for key in ('production', 'downtime', 'monthlyPlans', 'quality')}))
