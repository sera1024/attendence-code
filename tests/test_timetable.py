import importlib.util
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('importer',Path(__file__).parents[1]/'scripts/import-timetable.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
HEADER=','.join(m.FIELDS)+'\n'
ROW='2026-2,서울,TEST101,01,테스트 과목,교수,월,09:00,10:15,2026-09-01,2026-12-21,https://sugang.korea.ac.kr/p/v/lectList\n'
class ImportTests(unittest.TestCase):
    def test_valid(self):
        result=m.convert(HEADER+ROW)
        self.assertIn("'01'",result); self.assertIn("'1','09:00'",result)
        self.assertTrue(result.endswith('commit;\n'))
    def test_invalid_rows(self):
        for bad in [ROW.replace('09:00','25:00'),ROW.replace('10:15','08:00'),ROW.replace('월','8'),ROW.replace('09:00','1교시'),ROW.replace('2026-12-21','2026-08-01'),ROW.replace('https://sugang.korea.ac.kr','https://fake.example')]:
            with self.subTest(bad=bad),self.assertRaises(ValueError):m.convert(HEADER+bad)
    def test_duplicate(self):
        with self.assertRaises(ValueError):m.convert(HEADER+ROW+ROW)
    def test_empty(self):
        with self.assertRaises(ValueError):m.convert(HEADER)
    def test_escaping(self):self.assertIn("O''Brien",m.convert(HEADER+ROW.replace('교수',"O'Brien")))
    def test_bom(self):self.assertIn('insert into',m.convert('\ufeff'+HEADER+ROW))
if __name__=='__main__': unittest.main()
