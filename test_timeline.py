"""Timeline data integrity and offline HTML regression tests."""

from copy import deepcopy
import io
import json
from pathlib import Path
import re
import shutil
import unittest
import uuid
from contextlib import chdir, redirect_stderr, redirect_stdout

import generate_timeline as timeline
from test_learning_review import review


class TimelineTests(unittest.TestCase):
    def setUp(self):
        self.folder=Path.cwd()/('.timeline-test-'+uuid.uuid4().hex)
        self.folder.mkdir()
        self.payload={'status':'complete','start_time':'2026-11-01T00:00:00+08:00',
                      'end_time':'2026-11-01T12:00:00+08:00','event_count':3,'errors':[],
                      'profiles':[{'profile':'Default','event_count':3}],
                      'visits':[
                          {'profile':'Default','visit_id':1,'url':'https://user:secret@example.test/watch?v=one&token=private#part',
                           'title':'</script><img src="https://unwanted.test">','visit_time':'2026-11-01T09:00:00+08:00'},
                          {'profile':'Default','visit_id':2,'url':'https://user:secret@example.test/watch?v=one&token=private#other',
                           'title':'Repeated page','visit_time':'2026-11-01T11:00:00+08:00'},
                          {'profile':'Default','visit_id':3,'url':'https://example.test/watch?v=two',
                           'title':'Another page','visit_time':'2026-11-01T10:00:00+08:00'}]}

    def tearDown(self):
        shutil.rmtree(self.folder)

    def test_events_preserved_and_page_identity_is_not_redacted_url(self):
        data=timeline.prepare(self.payload)
        self.assertEqual(data['event_count'],3)
        first,second,third=data['events']
        self.assertEqual(first['page_key'],second['page_key'])
        self.assertNotEqual(first['page_key'],third['page_key'])
        self.assertEqual({e['url'] for e in data['events']},{'https://example.test/watch'})
        self.assertNotIn('private',json.dumps(data))
        self.assertNotIn('user:secret',json.dumps(data))
        self.assertNotIn('activity_seconds',data)
        self.assertNotIn('learning_seconds',data)

    def test_safe_embedded_json_roundtrips_and_document_has_no_remote_dependencies(self):
        source=self.folder/'input.json';source.write_text(json.dumps(self.payload),encoding='utf-8')
        output=self.folder/'timeline.html';timeline.build(source,output)
        html=output.read_text(encoding='utf-8')
        embedded=re.search(r'<script id="timeline-data" type="application/json">(.*?)</script>',html,re.S).group(1)
        data=json.loads(embedded)
        self.assertEqual(data['events'][0]['title'],self.payload['visits'][0]['title'])
        self.assertNotIn('</script><img',html)
        self.assertNotRegex(html,r'<(?:script|link|img)[^>]+(?:src|href)=[\'"]https?://')
        self.assertIn("connect-src 'none'",html)
        self.assertNotIn('<!--TIMELINE_DATA-->',html)
        self.assertNotIn('/*TIMELINE_THEME*/',html)
        self.assertIn('<style id="timeline-theme">',html)

    def test_source_document_is_a_valid_offline_import_preview(self):
        assets=Path(__file__).resolve().parent/'skills/edge-learning-review/assets'
        html=(assets/'edge_history_timeline.template.html').read_text(encoding='utf-8')
        embedded=re.search(r'<script id="timeline-data" type="application/json">(.*?)</script>',html,re.S).group(1)
        self.assertEqual(json.loads(embedded),{'dataset_kind':'preview'})
        self.assertNotIn('<!--TIMELINE_DATA-->',html)
        self.assertNotIn('/*TIMELINE_THEME*/',html)
        self.assertNotRegex(html,r'<(?:script|link)[^>]+(?:src|href)=')

    def test_invalid_times_counts_duplicates_and_status_are_rejected(self):
        bads=[]
        bad=deepcopy(self.payload);bad['visits'][0]['visit_time']='2026-11-01T09:00:00';bads.append(bad)
        bad=deepcopy(self.payload);bad['visits'][0]['visit_time']='2026-10-31T23:59:59+08:00';bads.append(bad)
        bad=deepcopy(self.payload);bad['event_count']=99;bads.append(bad)
        bad=deepcopy(self.payload);bad['visits'][1]['visit_id']=1;bads.append(bad)
        bad=deepcopy(self.payload);bad['status']='failed';bads.append(bad)
        for bad in bads:
            with self.assertRaises(ValueError):timeline.prepare(bad)

    def test_executable_urls_and_missing_urls_are_not_links(self):
        self.payload['visits'][0]['url']='javascript:alert(1)'
        self.payload['visits'][1]['url']=None
        data=timeline.prepare(self.payload)
        self.assertEqual(data['events'][0]['url'],'')
        self.assertEqual(data['events'][1]['url'],'')
        self.assertNotEqual(data['events'][0]['page_key'],data['events'][1]['page_key'])

    def test_pipeline_produces_webpage_and_preserves_evidence(self):
        # Supply an ordinary, valid history export to exercise the complete pipeline.
        self.payload['visits'][0]['title']='StellaVLA paper'
        source=review.save(self.folder/'source.json',self.payload)
        output=self.folder/'out'
        with redirect_stdout(io.StringIO()):
            code=review.main(['run','--input',str(source),'--output-dir',str(output)])
        self.assertEqual(code,0)
        html=(output/'edge_history_timeline.html').read_text(encoding='utf-8')
        embedded=json.loads(re.search(r'<script id="timeline-data" type="application/json">(.*?)</script>',html,re.S).group(1))
        self.assertEqual({(e['profile'],e['visit_id']) for e in embedded['events']},{('Default',1),('Default',2),('Default',3)})
        self.assertEqual(embedded['event_count'],3)

    def test_empty_day_does_not_invent_spans(self):
        self.payload.update(event_count=0,visits=[],profiles=[{'profile':'Default','event_count':0}])
        self.assertEqual(timeline.prepare(self.payload)['events'],[])

    def save_export(self, relative, payload):
        path=self.folder/relative
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(payload),encoding='utf-8')
        return path

    def test_default_entry_uses_newer_dated_export_instead_of_old_root_data(self):
        old=deepcopy(self.payload)
        old['start_time']=old['start_time'].replace('2026-11-01','2026-10-20')
        old['end_time']=old['end_time'].replace('2026-11-01','2026-10-20')
        for visit in old['visits']:
            visit['visit_time']=visit['visit_time'].replace('2026-11-01','2026-10-20')
        self.save_export('output/2026-11-01/edge_history_2026-11-01.json',self.payload)
        self.save_export('output/learning_classified.json',old)
        # Unrelated JSON and arbitrary nested directories are not export sources.
        for relative in ['output/demo_history.json','output/backups/learning_classified.json',
                         'output/2026-99-99/learning_classified.json']:
            path=self.folder/relative;path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text('not an export',encoding='utf-8')
        with chdir(self.folder),redirect_stdout(io.StringIO()):
            self.assertEqual(timeline.main([]),0)
        html=(self.folder/'output/edge_history_timeline.html').read_text(encoding='utf-8')
        data=json.loads(re.search(r'<script id="timeline-data" type="application/json">(.*?)</script>',html,re.S)[1])
        self.assertEqual(data['end_time'],self.payload['end_time'])
        self.assertEqual(data['event_count'],3)

    def test_default_entry_prefers_classified_at_equal_coverage(self):
        classified=deepcopy(self.payload)
        for visit in classified['visits']:
            visit.update(topic_id='reviewed',topic_label='Reviewed topic',kind='learning')
        self.save_export('output/2026-11-01/learning_classified.json',classified)
        self.save_export('output/2026-11-01/edge_history_today.json',self.payload)
        with chdir(self.folder),redirect_stdout(io.StringIO()):
            self.assertEqual(timeline.main([]),0)
        html=(self.folder/'output/edge_history_timeline.html').read_text(encoding='utf-8')
        data=json.loads(re.search(r'<script id="timeline-data" type="application/json">(.*?)</script>',html,re.S)[1])
        self.assertEqual({event['topic_id'] for event in data['events']},{'reviewed'})

    def test_default_entry_names_invalid_export_and_keeps_previous_report(self):
        self.save_export('output/edge_history_today.json',self.payload)
        broken=self.save_export('output/2026-11-01/learning_classified.json',{'end_time':'invalid'})
        report=self.folder/'output/edge_history_timeline.html'
        report.write_text('Existing report',encoding='utf-8')
        diagnostic=io.StringIO()
        with chdir(self.folder),redirect_stdout(io.StringIO()),redirect_stderr(diagnostic):
            self.assertEqual(timeline.main([]),1)
        self.assertIn(broken.name,diagnostic.getvalue())
        self.assertIn('2026-11-01',diagnostic.getvalue())
        self.assertEqual(report.read_text(encoding='utf-8'),'Existing report')

    def test_explicit_input_bypasses_default_discovery(self):
        chosen=self.save_export('chosen.json',self.payload)
        self.save_export('output/2026-11-01/learning_classified.json',{'end_time':'invalid'})
        with chdir(self.folder),redirect_stdout(io.StringIO()):
            self.assertEqual(timeline.main(['--input',str(chosen)]),0)
        html=(self.folder/'output/edge_history_timeline.html').read_text(encoding='utf-8')
        data=json.loads(re.search(r'<script id="timeline-data" type="application/json">(.*?)</script>',html,re.S)[1])
        self.assertEqual(data['event_count'],3)

    def test_public_demo_is_labeled_and_contains_only_synthetic_sources(self):
        source=Path(__file__).resolve().parent/'examples/demo_history.json'
        data=timeline.prepare(json.loads(source.read_text(encoding='utf-8')))
        self.assertEqual(data['dataset_kind'],'demo')
        self.assertEqual(data['event_count'],27)
        self.assertEqual({e['profile'] for e in data['events']},{'Demo'})
        self.assertEqual({e['domain'] for e in data['events']},
                         {'arxiv.org','kyutai.org','github.com','gitee.com','chatgpt.com','www.bing.com','www.feishu.cn','www.bilibili.com'})
        self.assertEqual(timeline.prepare(self.payload)['dataset_kind'],'personal')
        entry=(Path(__file__).resolve().parent/'index.html').read_text(encoding='utf-8')
        entry_data=json.loads(re.search(r'<script id="timeline-data" type="application/json">(.*?)</script>',entry,re.S).group(1))
        self.assertEqual(entry_data,data)

    def test_official_icons_are_bundled_rasters_and_build_stays_offline(self):
        source=self.folder/'input.json';source.write_text(json.dumps(self.payload),encoding='utf-8')
        output=self.folder/'timeline.html';timeline.build(source,output)
        html=output.read_text(encoding='utf-8')
        catalog=json.loads(re.search(r'<script id="site-icons" type="application/json">(.*?)</script>',html,re.S).group(1))
        self.assertIn('github.com',catalog['icons'])
        self.assertIn('arxiv.org',catalog['icons'])
        for icon in catalog['icons'].values():
            self.assertRegex(icon['data_url'],r'^data:image/(png|x-icon|vnd.microsoft.icon|jpeg|webp);base64,')
        self.assertNotIn('fetch(',html)
        self.assertNotIn('google.com/s2/favicons',html)
        self.assertNotIn('favicon.yandex',html)


if __name__=='__main__':
    unittest.main()
