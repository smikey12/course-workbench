import tempfile
import unittest
import sqlite3
from contextlib import closing
from pathlib import Path
import platform_preferences as prefs

class PreferencesTests(unittest.TestCase):
 def test_fresh_persist_empty_and_invalid(self):
  with tempfile.TemporaryDirectory() as f:
   p=Path(f)/'state.sqlite3'
   self.assertEqual(prefs.read(p),{'configured':False,'selected':[]})
   self.assertEqual(prefs.save(p,['pta','cx'])['selected'],['cx','pta'])
   self.assertEqual(prefs.read(p)['selected'],['cx','pta'])
   for bad in (None,'pta',['bad'],['pta','pta'],[[]]):
    with self.assertRaises(ValueError):prefs.save(p,bad)
   self.assertEqual(prefs.read(p)['selected'],['cx','pta'])
   prefs.save(p,[])
   self.assertEqual(prefs.read(p),{'configured':True,'selected':[]})
 def test_legacy_preserved_and_cancel_keeps_data(self):
  with tempfile.TemporaryDirectory() as f:
   p=Path(f)/'state.sqlite3'
   with closing(sqlite3.connect(p)) as c, c:
    c.execute('create table courses(id text)');c.execute("insert into courses values('old')")
   self.assertEqual(prefs.read(p)['selected'],['rain','cx','mooc'])
   prefs.save(p,[])
   with closing(sqlite3.connect(p)) as c, c:self.assertEqual(c.execute('select id from courses').fetchone()[0],'old')
