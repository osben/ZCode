-- Golden fixture for the permanent-deletion revision (session_deletion_tests.rs). Loaded by Node's repository functions
-- (scratchpad golden generator) and by node-store's tests: the same rows, so both must give the same revision.
-- Titles are non-ASCII; the artifact ids include a non-ASCII id to exercise the ICU ordering.
insert into session(id,project_id,slug,directory,title,version,time_created,time_updated,task_type,parent_id) values
  ('root','project','root','/work/example','根会话 ü',       '1',1,10,'interactive',null),
  ('child','project','child','/work/example','子代理 café',  '1',2,20,'subagent_child','root'),
  ('fork','project','fork','/work/example','フォーク fork',   '1',3,30,'fork','root'),
  ('other','project','other','/work/example','其他 会话',    '1',4,40,'interactive',null);
insert into message(id,session_id,time_created,time_updated,data) values
  ('m1','other',5,5,'{}'),
  ('m2','fork',6,6,'{}');
insert into part(id,message_id,session_id,time_created,time_updated,data) values
  ('p1','m1','other',5,5,'{"text":"zcode-artifact://child/art1/x and zcode-artifact://child/%C3%A42/y and zcode-artifact://root/%E8%89%BA/z"}'),
  ('p2','m2','fork',6,6,'{"text":"zcode-artifact://child/art1/q"}');
