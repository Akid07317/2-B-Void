import argparse
import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

from .domain import TZ, DomainError, stamp
from .scheduler import plan
from .store import Store

STATIC=Path(__file__).parent/'static'


def make_handler(store):
    proposals={}
    mutex=Lock()
    class Handler(BaseHTTPRequestHandler):
        def send(self,status,body,content_type='application/json; charset=utf-8'):
            raw=json.dumps(body,ensure_ascii=False).encode() if not isinstance(body,bytes) else body
            self.send_response(status)
            self.send_header('Content-Type',content_type)
            self.send_header('Content-Length',str(len(raw)))
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
            self.end_headers();self.wfile.write(raw)

        def valid_host(self):
            host=self.headers.get('Host','')
            return host in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}')

        def do_GET(self):
            if not self.valid_host():return self.send(403,{'error':'不允许的主机。'})
            route=urlparse(self.path).path
            if route=='/api/state':return self.send(200,{'state':store.read(),'now':stamp(datetime.now(TZ))})
            if route=='/api/export':return self.send(200,{'format':'planner.snapshot.v1','state':store.read()})
            routes={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/day.js':'day.js','/day.css':'day.css','/console.css':'console.css','/console.js':'console.js','/time.js':'time.js'}
            if route not in routes:return self.send(404,{'error':'未找到。'})
            file=STATIC/routes[route]
            ctype={'html':'text/html','js':'text/javascript','css':'text/css'}[file.suffix[1:]]
            self.send(200,file.read_bytes(),ctype+'; charset=utf-8')

        def do_POST(self):
            if not self.valid_host():return self.send(403,{'error':'不允许的主机。'})
            origin=self.headers.get('Origin')
            if origin and origin not in (f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'):
                return self.send(403,{'error':'不允许跨站请求。'})
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':
                return self.send(415,{'error':'需要 JSON 请求。'})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=1_000_000:raise DomainError('请求体大小无效。')
                data=json.loads(self.rfile.read(size))
                now=datetime.now(TZ)
                route=urlparse(self.path).path
                if route=='/api/preview':
                    if not isinstance(data.get('adjust_near',False),bool) or not isinstance(data.get('release_manual',[]),list):
                        raise DomainError('调整选项无效。')
                    proposal=plan(store.read(),now,data.get('adjust_near',False),data.get('release_manual',[]))
                    with mutex:
                        if len(proposals)>100:proposals.clear()
                        proposals[proposal['id']]=proposal
                    return self.send(200,proposal)
                if route=='/api/action':
                    with mutex:
                        proposal=proposals.get(data.get('data',{}).get('proposal_id'))
                    return self.send(200,store.write(data,now,proposal))
                return self.send(404,{'error':'未找到。'})
            except DomainError as exc:
                self.send(409 if exc.code in ('STALE_REVISION','STALE_TIME','IDEMPOTENCY_CONFLICT') else 400,{'error':str(exc),'code':exc.code})
            except (ValueError,KeyError,TypeError,AttributeError) as exc:
                self.send(400,{'error':'请求字段格式不正确。','code':'INVALID_INPUT'})
            except Exception:
                import traceback
                traceback.print_exc()
                self.send(500,{'error':'服务内部错误；本次事务没有保存。'})
    return Handler


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--db',default='data/planner.sqlite3')
    args=parser.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),make_handler(Store(args.db)))
    print(f'个人规划器：http://127.0.0.1:{args.port}  数据：{Path(args.db).resolve()}',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()

if __name__=='__main__':main()
