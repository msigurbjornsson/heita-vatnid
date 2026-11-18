// Exercise production SQL against actual SQLite without a Cloudflare connection.
import {execFileSync} from 'node:child_process';
const PY=`import sys,json,sqlite3
request=json.load(sys.stdin);db=sqlite3.connect(request['path']);db.row_factory=sqlite3.Row;results=[]
try:
 for item in request['statements']:
  before=db.total_changes;c=db.execute(item['sql'],item.get('params',[]));rows=[dict(r) for r in c.fetchall()] if c.description else []
  results.append({'results':rows,'meta':{'changes':db.total_changes-before,'rows_read':len(rows)}})
 db.commit();print(json.dumps(results))
finally:db.close()
`;
export class SQLiteD1 {
 constructor(path){this.path=path;this.trace=[];}
 execute(statements){this.trace.push(...statements.map(s=>s.sql));return JSON.parse(execFileSync('python3',['-c',PY],{input:JSON.stringify({path:this.path,statements}),encoding:'utf8',maxBuffer:20*1024*1024}));}
 prepare(sql){const db=this;return {sql,params:[],bind(...params){this.params=params;return this;},async all(){return db.execute([this])[0];},async run(){return db.execute([this])[0];},async first(){return db.execute([this])[0].results[0]??null;}};}
 async batch(statements){return this.execute(statements);}
}
