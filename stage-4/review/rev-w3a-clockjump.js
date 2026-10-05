// Reviewer repro (W3a rev 4b6bc73, F1): importing a REAL stage-2 export holding a seeded 'expired' hold with a future expires_at drags the stage-3 clock ~2 h ahead, surviving reset. Needs stage-3 on :19090, stage-2 on :19092.
const U=(h,b)=>({id:'u_'+h,email:h+'@example.com',password:'correct horse',display_name:h,handle:h,balance:b});
const j=async(base,m,p,b,h={})=>{const r=await fetch(base+p,{method:m,headers:h,body:b===undefined?undefined:JSON.stringify(b)});const t=await r.text();return t?JSON.parse(t):null};
const S3='http://127.0.0.1:19090',S2='http://127.0.0.1:19092';
(async()=>{
const far=new Date(Date.now()+2*3600e3).toISOString().replace('Z','+00:00');
await j(S2,'POST','/_test/reset',{currency:'EUR',minor_units:2,users:[U('ada',100),U('bob',0)],authorizations:[{id:'a1',from_user_id:'u_ada',to_user_id:'u_bob',amount:5,status:'expired',expires_at:far}]});
const ex=await j(S2,'GET','/_test/export');
console.log('import', (await fetch(S3+'/_test/import',{method:'POST',body:JSON.stringify(ex)})).status);
await fetch(S3+'/_test/reset',{method:'POST',body:JSON.stringify({currency:'EUR',minor_units:2,users:[U('ada',100),U('bob',0)]})});
const t=(await j(S3,'POST','/auth/login',{email:'ada@example.com',password:'correct horse'})).token;
const p=await j(S3,'POST','/payments',{to_handle:'bob',amount:1},{authorization:'Bearer '+t,'idempotency-key':'z'});
console.log('after stage-2 import + fresh reset: created_at',p.created_at,'wall',new Date().toISOString());
const a=await j(S3,'POST','/authorizations',{to_handle:'bob',amount:1},{authorization:'Bearer '+t,'idempotency-key':'y'});
console.log('new hold created_at',a.created_at,'expires_at',a.expires_at);
})();
