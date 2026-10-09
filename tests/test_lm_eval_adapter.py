import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('adapter',Path(__file__).resolve().parents[1]/'templates/tester-benchmark/lm-eval-adapter.py')
adapter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
class AdapterTest(unittest.TestCase):
    def test_native_scores_and_full_observations(self):
        raw=adapter.convert({'acc,none':.5},[{'doc_id':0,'acc':1,'resps':[['prediction']]},{'doc_id':1,'acc':0}],{'accuracy':{'aggregate':'acc,none','sample':'acc'}},'a'*64)
        self.assertEqual(raw['metrics'],{'accuracy':.5})
        self.assertEqual([s['metrics']['accuracy'] for s in raw['samples']],[1,0])
        self.assertEqual([s['id'] for s in raw['samples']],['0','1'])
        self.assertEqual(raw['artifact_sha256'],'a'*64)
    def test_missing_sample_score_is_not_silently_dropped(self):
        with self.assertRaises(KeyError):
            adapter.convert({'acc,none':.5},[{'doc_id':1}],{'accuracy':{'aggregate':'acc,none','sample':'acc'}},'a'*64)
if __name__=='__main__': unittest.main()
