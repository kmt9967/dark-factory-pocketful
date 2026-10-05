// Reviewer edge repro for W2a (rev ba85eef): F1 zero-amount capture from seeded open hold with nothing remaining; F2 import accepting holds > balance. Run: node stage-2/review/rev-w2a-edge.js (service on :19090)
const B='http://127.0.0.1:19090';
const U=(h,b)=>({id:'u_'+h,email:h+'@example.com',password:'correct horse',display_name:h,handle:h,balance:b});
const j=async(m,p,b,h={})=>{const r=await fetch(B+p,{method:m,headers:h,body:b===undefined?undefined:JSON.stringify(b)});const t=await r.text();return [r.status,p==="/_test/export"?t:t.slice(0,300)]};
const iso=(ms)=>new Date(ms).toISOString().replace('Z','+00:00');
(async()=>{
const exp=iso(Date.now()+7200e3);
console.log('reset open fully captured', await j('POST','/_test/reset',{currency:'EUR',minor_units:2,users:[U('ada',100),U('bob',0)],authorizations:[{id:'a1',from_user_id:'u_ada',to_user_id:'u_bob',amount:50,status:'open',captured_amount:50,expires_at:exp}]}));
const bob=JSON.parse((await j('POST','/auth/login',{email:'bob@example.com',password:'correct horse'}))[1]).token;
console.log('capture {} on zero remainder', await j('POST','/authorizations/a1/capture',{},{authorization:'Bearer '+bob,'idempotency-key':'z'}));
console.log('activity', await j('GET','/activity',undefined,{authorization:'Bearer '+bob}));
// import with holds exceeding balance
await j('POST','/_test/reset',{currency:'EUR',minor_units:2,users:[U('ada',100),U('bob',0)]});
const ex=JSON.parse((await j('GET','/_test/export'))[1]);
ex.state.authorizations=[{id:'a9',from_user_id:'u_ada',to_user_id:'u_bob',amount:5000,captured_amount:0,payment_ids:[],note:'',visibility:'public',status:'open',expires_at:exp,created_at:iso(Date.now())}];
console.log('import over-held', await j('POST','/_test/import',ex));
const ada=JSON.parse((await j('POST','/auth/login',{email:'ada@example.com',password:'correct horse'}))[1]).token;
console.log('me', await j('GET','/me',undefined,{authorization:'Bearer '+ada}));
})();
