#!/usr/bin/env python3
"""Exercise a fresh isolated PhotoSync server; never point at production."""
import argparse, base64, hashlib, json, pathlib, secrets, time, urllib.request, urllib.error
p=argparse.ArgumentParser();p.add_argument('--url',required=True);p.add_argument('--photo',required=True);p.add_argument('--video',required=True);p.add_argument('--result',required=True);p.add_argument('--credentials',required=True);p.add_argument('--isolated-test-server',action='store_true');a=p.parse_args()
if not a.isolated_test_server: p.error('Use only an empty isolated test server and pass --isolated-test-server')
token=None;checks=[]
def req(method,path,obj=None,raw=None,headers=None,expected=None):
 h=dict(headers or {});data=raw
 if obj is not None:data=json.dumps(obj).encode();h['Content-Type']='application/json'
 if token:h['Authorization']='Bearer '+token
 r=urllib.request.Request(a.url+'/api'+path,data=data,headers=h,method=method)
 try:
  with urllib.request.urlopen(r,timeout=120) as x:code=x.status;b=x.read();ct=x.headers.get('Content-Type','')
 except urllib.error.HTTPError as x:code=x.code;b=x.read();ct=x.headers.get('Content-Type','')
 if expected is not None:assert code==expected,(path,code,b[:250])
 elif code>=400:raise RuntimeError((path,code,b[:250]))
 return json.loads(b) if 'json' in ct and b else b

def ok(name):checks.append(name);print('PASS',name,flush=True)
assert req('GET','/server/ping')['res']=='pong';ok('ping')
email='fullstack-'+secrets.token_hex(4)+'@example.invalid';password=secrets.token_urlsafe(24)
req('POST','/auth/admin-sign-up',{'email':email,'password':password,'name':'Isolated fullstack test'})
token=req('POST','/auth/login',{'email':email,'password':password})['accessToken'];ok('admin signup and login')
c=pathlib.Path(a.credentials);c.write_text(json.dumps({'email':email,'password':password}));c.chmod(0o600)
req('GET','/users/me');ok('authenticated user profile')
photo=pathlib.Path(a.photo);blob=photo.read_bytes();sha=hashlib.sha1(blob).digest()
fields={'fileCreatedAt':'2026-10-30T00:00:00.000Z','fileModifiedAt':'2026-10-30T00:00:00.000Z'}
boundary='photosync'+secrets.token_hex(12)
body=b''
for k,v in fields.items():body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
body+=f'--{boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="{photo.name}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()+blob+f'\r\n--{boundary}--\r\n'.encode()
h={'Content-Type':'multipart/form-data; boundary='+boundary,'x-immich-checksum':base64.b64encode(sha).decode()}
r=req('POST','/assets',raw=body,headers=h);pid=r['id'];ok('multipart photo upload')
r=req('POST','/assets',raw=body,headers=h);assert r['id']==pid and r['status']=='duplicate',r;ok('same account duplicate photo rejected')
assert hashlib.sha1(req('GET',f'/assets/{pid}/original')).digest()==sha;ok('original photo download checksum')
album=req('POST','/albums',{'albumName':'Fullstack validation','assetIds':[pid]});assert req('GET','/albums/'+album['id'])['assetCount']==1;ok('album create and asset listing')
video=pathlib.Path(a.video);digest=hashlib.file_digest(video.open('rb'),'sha1').digest();size=video.stat().st_size
meta=dict(fields,filename=video.name)
s=req('POST','/assets/resumable',{'filename':video.name,'fileSize':size,'checksum':base64.b64encode(digest).decode(),'metadata':meta});sid=s['id'];offset=0;chunk_size=4*1024*1024
with video.open('rb') as f:
 while chunk:=f.read(chunk_size):
  r=req('PATCH','/assets/resumable/'+sid,raw=chunk,headers={'Content-Type':'application/offset+octet-stream','Upload-Offset':str(offset)})
  offset+=len(chunk);assert r['offset']==offset
  if offset==chunk_size:
   req('POST','/assets/resumable/'+sid+'/complete',expected=409);ok('incomplete session completion rejected')
   req('PATCH','/assets/resumable/'+sid,raw=chunk,headers={'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},expected=409);ok('incorrect chunk offset rejected')
   assert req('GET','/assets/resumable/'+sid)['offset']==offset;ok('reconnect recovers saved upload offset')
  if offset%(64*1024*1024)==0:print('video bytes',offset,'/',size,flush=True)
r=req('POST','/assets/resumable/'+sid+'/complete');vid=r['id'];ok('large video chunk upload and completion')
assert hashlib.sha1(req('GET',f'/assets/{vid}/original')).digest()==digest;ok('large video download checksum')
r=req('POST','/assets/resumable',{'filename':video.name,'fileSize':size,'checksum':base64.b64encode(digest).decode(),'metadata':meta});assert r.get('assetId')==vid and r['status']=='duplicate';ok('completed video duplicate detection')
req('GET','/assets/resumable/'+sid,expected=404);ok('completed upload session removed')
# A deliberately wrong checksum must never create an asset.
s=req('POST','/assets/resumable',{'filename':'bad-checksum.jpg','fileSize':len(blob),'checksum':base64.b64encode(b'x'*20).decode(),'metadata':meta})
req('PATCH','/assets/resumable/'+s['id'],raw=blob,headers={'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'})
req('POST','/assets/resumable/'+s['id']+'/complete',expected=422);ok('corrupted upload checksum rejected')
pathlib.Path(a.result).write_text(json.dumps({'passed':checks,'photo_id':pid,'video_id':vid,'video_bytes':size},indent=2));print('ALL',len(checks),'PASSED',flush=True)
